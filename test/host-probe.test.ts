import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

type Answer = { action: "accept" | "decline"; content?: { approve: boolean; choice: string } };

let answer: Answer = { action: "accept", content: { approve: true, choice: "green" } };
let client: Client;

before(async () => {
  client = new Client(
    { name: "host-probe-test", version: "0.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  );
  client.setRequestHandler("elicitation/create", () => answer);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["scripts/host-probe.ts"],
      stderr: "ignore",
    }),
  );
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
  const progress: number[] = [];
  const result = await client.callTool(
    { name: "probe", arguments: { intervalSeconds: 0.2, durationSeconds: 1 } },
    { onprogress: (update) => progress.push(update.progress) },
  );
  assert.ok(progress.length >= 1);
  const image = result.content.find((block) => block.type === "image");
  assert.equal(image?.mimeType, "image/png");
});
