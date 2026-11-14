import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PNG } from "pngjs";

type Answer = { action: "accept" | "decline"; content?: { approve: boolean; choice: string } };

let answer: Answer = { action: "accept", content: { approve: true, choice: "green" } };
let client: Client;
let stderr = "";

/** Waits for the probe's stderr log to match, since stderr is a separate pipe from the result. */
async function logged(from: number, pattern: RegExp): Promise<boolean> {
  for (let waited = 0; waited < 2000; waited += 20) {
    if (pattern.test(stderr.slice(from))) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return pattern.test(stderr.slice(from));
}

before(async () => {
  client = new Client(
    { name: "host-probe-test", version: "0.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  );
  client.setRequestHandler("elicitation/create", () => answer);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["scripts/host-probe.ts"],
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  await client.connect(transport);
});

after(async () => {
  await client.close();
});

test("probe is listed as requiring user interaction", async () => {
  const { tools } = await client.listTools();
  const probe = tools.find((tool) => tool.name === "probe");
  assert.equal(probe?._meta?.["anthropic/requiresUserInteraction"], true);
});

test("accepting the form returns the chosen value, declining is an error", async () => {
  answer = { action: "accept", content: { approve: true, choice: "green" } };
  const accepted = await client.callTool({
    name: "probe",
    arguments: { intervalSeconds: 0.1, durationSeconds: 0.1 },
  });
  assert.ok(!accepted.isError);
  assert.deepEqual(accepted.content[0], { type: "text", text: "choice: green" });

  answer = { action: "decline" };
  const declined = await client.callTool({ name: "probe", arguments: {} });
  assert.equal(declined.isError, true);
  assert.deepEqual(declined.content[0], { type: "text", text: "probe: decline" });
});

test("progress arrives while the probe runs and the result carries a PNG", async () => {
  answer = { action: "accept", content: { approve: true, choice: "blue" } };
  const progress: { progress: number; total?: number }[] = [];
  const logStart = stderr.length;
  const result = await client.callTool(
    { name: "probe", arguments: { intervalSeconds: 0.2, durationSeconds: 1 } },
    { onprogress: (update) => progress.push(update) },
  );
  assert.ok(!result.isError);
  // The client receives the ticks sent at each interval across the run.
  assert.ok(progress.length > 1, `expected several progress ticks, got ${progress.length}`);
  assert.ok(progress.every((update) => update.total === 1));
  const values = progress.map((update) => update.progress);
  assert.deepEqual(
    values,
    values.toSorted((a, b) => a - b),
  );
  const last = values.at(-1) ?? 0;
  assert.ok(last >= 0.8, `last tick ${last} is short of the run`);
  // The official client dispatches a notification a microtask after a response
  // that arrived in the same stdio chunk, so it can drop the final tick; the
  // probe's own log shows it sent the final tick at the total.
  assert.ok(await logged(logStart, /tick 1\.0s of 1s/), stderr.slice(logStart));
  const image = result.content.find((block) => block.type === "image");
  assert.equal(image?.mimeType, "image/png");
  const png = PNG.sync.read(Buffer.from(image.data, "base64"));
  assert.equal(png.width, 64);
  assert.deepEqual([...png.data.subarray(0, 4)], [0, 0, 255, 255]);
});

test("an accepted form without approval names the reason", async () => {
  answer = { action: "accept", content: { approve: false, choice: "red" } };
  const result = await client.callTool({ name: "probe", arguments: {} });
  assert.equal(result.isError, true);
  assert.deepEqual(result.content[0], { type: "text", text: "probe: not approved" });
});
