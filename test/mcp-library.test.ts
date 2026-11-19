import "./fixtures/env.ts";
import { approve, useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { commands } from "../src/commands/registry.ts";
import { pickRequest } from "../src/commands/pick.ts";
import { CORE_REGISTRY } from "../src/extensions/registry.ts";
import { digestOf } from "../src/confirm/records.ts";
import { fixtureLibrary, GAME, RUN_ID, sha256 } from "./fixtures/library.ts";
import { gitTarget } from "./fixtures/git.ts";
import { shelterSpec, syntheticWorld, writeStyleBible } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
approve(script);
const clients: Client[] = [];
const dirs: string[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
type Answer = (form: ElicitRequest["params"]) => Promise<ElicitResult>;
async function connect(target: string, readOnly = false, answer?: Answer) {
  const client = new Client(
    { name: "library-test", version: "0" },
    {
      ...(answer && { capabilities: { elicitation: { form: {} } } }),
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  if (answer) client.setRequestHandler("elicitation/create", (request) => answer(request.params));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env["AI_GATEWAY_API_KEY"];
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "src/cli.ts",
        "mcp",
        "--target",
        target,
        "--provider-script",
        script,
        ...(readOnly ? ["--read-only"] : []),
      ],
      cwd: root,
      env,
      stderr: "pipe",
    }),
  );
  clients.push(client);
  return client;
}

test("read-only stdio mount lists discovery tools and resources but refuses direct edit, spend and pick", async () => {
  const lib = fixtureLibrary();
  dirs.push(lib.dir);
  gitTarget(lib.dir);
  const client = await connect(lib.dir, true);
  const { tools } = await client.listTools();
  const expected = commands
    .filter(
      (s) =>
        s.tool !== null &&
        s.requires !== "search" &&
        s.effect.readOnly &&
        s.effect.spends === "never" &&
        (s.effect.writes === "none" || s.tool === "cat"),
    )
    .map((s) => s.tool)
    .sort();
  assert.deepEqual(tools.map((t) => t.name).sort(), expected);
  assert.ok(tools.some((t) => t.name === "ls"));
  assert.ok(tools.some((t) => t.name === "cat"));
  const card = join(lib.root, "lantern.md");
  const beforeCard = await readFile(card, "utf8");
  await assert.rejects(
    client.callTool({
      name: "card_edit",
      arguments: { address: card, title: "Should not be written" },
    }),
    /Tool card_edit not found/,
  );
  assert.equal(await readFile(card, "utf8"), beforeCard);
  for (const name of ["stage", "pick", "settings_change", "confirm"]) {
    await assert.rejects(
      client.callTool({ name, arguments: {} }),
      new RegExp(`Tool ${name} not found`),
    );
  }
  const { resources } = await client.listResources();
  assert.ok(resources.some((r) => r.uri === `asset://${GAME}/`));
  assert.ok(resources.some((r) => r.uri === "assetgrove-library://facets"));
  const { contents } = await client.readResource({ uri: `asset://${GAME}/` });
  assert.equal(JSON.parse((contents[0] as { text: string }).text).kind, "folder");
  const original = await readFile(join(lib.runsDir, RUN_ID, "run.json"), "utf8");
  await assert.rejects(
    client.callTool({
      name: "pick",
      arguments: { run: join(lib.runsDir, RUN_ID), candidate: "c1", target: lib.dir },
    }),
    /Tool pick not found/,
  );
  assert.equal(await readFile(join(lib.runsDir, RUN_ID, "run.json"), "utf8"), original);
});

test("facets resource counts fixture cards by every supported kind and canonical label", async () => {
  const lib = fixtureLibrary({ bulk: 2 });
  dirs.push(lib.dir);
  gitTarget(lib.dir);
  await writeFile(
    join(lib.dir, ".assetgrove", "labels.json"),
    JSON.stringify({
      format: "assetgrove-labels/1",
      labels: [{ name: "Prop", aliases: ["prop"] }],
    }),
  );
  const cardPath = join(lib.root, "lantern.md");
  const card = await readFile(cardPath, "utf8");
  await writeFile(cardPath, card.replace("- prop", "- prop\n  - Prop"));
  const client = await connect(lib.dir, true);
  const { contents } = await client.readResource({ uri: "assetgrove-library://facets" });
  assert.deepEqual(JSON.parse((contents[0] as { text: string }).text), {
    game: GAME,
    total: 9,
    kinds: Object.fromEntries(
      CORE_REGISTRY.kinds.map((k) => [
        k.kind,
        k.kind === "still" ? 7 : k.kind === "sprite-strip" || k.kind === "model-3d" ? 1 : 0,
      ]),
    ),
    labels: { bulk: 2, character: 1, light: 1, plant: 1, Prop: 2 },
  });
  const listed = (await client.listResources()).resources.find((r) =>
    r.uri.startsWith("assetgrove-candidate://"),
  )!;
  const media = await client.readResource({ uri: listed.uri });
  assert.equal(
    sha256(Buffer.from((media.contents[0] as { blob: string }).blob, "base64")),
    lib.versions["lantern"]![0],
  );
  await writeFile(join(lib.runsDir, RUN_ID, "c1.png"), "changed");
  await assert.rejects(client.readResource({ uri: listed.uri }), /bytes changed/);
  await assert.rejects(
    client.readResource({ uri: `asset://${GAME}/runs/${RUN_ID}/c1` }),
    /bytes changed/,
  );
});

test("pick form links resolve the staged bytes covered by its sealed confirmation and unsupported clients keep terminal fallback", async () => {
  const world = await syntheticWorld();
  dirs.push(world.dir);
  gitTarget(world.targetDir);
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "BIBLE.md");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeStyleBible(bible, world.bible);
  await writeFile(profile, JSON.stringify(world.profile));
  const client = await connect(world.targetDir);
  const staged = await client.callTool({
    name: "stage",
    arguments: { spec, bible, profile, runs: world.runsDir, candidates: 1 },
  });
  assert.equal(
    (staged.structuredContent as Record<string, unknown>)["ok"],
    true,
    JSON.stringify(staged),
  );
  useAttended();
  const runDir = (staged.structuredContent as Record<string, unknown>)["runDir"] as string;
  const links = (staged.content as Array<{ type: string; uri?: string }>).filter(
    (c) => c.type === "resource_link",
  );
  assert.equal(links.length, 1);
  const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  const bytes = (await client.readResource({ uri: links[0]!.uri! })).contents[0] as {
    blob: string;
  };
  assert.equal(sha256(Buffer.from(bytes.blob, "base64")), run.candidates[0].sha256);
  const args = { run: runDir, target: world.targetDir, candidate: "c1" };
  const request = await pickRequest(args);
  assert.equal(
    request.body["inputs"] && (request.body["inputs"] as { candidates: string }).candidates,
    digestOf(
      run.candidates.map((c: { id: string; sha256: string }) => ({ id: c.id, sha256: c.sha256 })),
    ),
  );
  const fallback = await client.callTool({ name: "pick", arguments: args });
  const error = (fallback.structuredContent as Record<string, unknown>)["error"] as {
    code: string;
    confirmation: { how: string };
  };
  assert.equal(error.code, "confirmation_required");
  assert.match(JSON.stringify(error), /assetgrove confirm/);
  let inspected = false;
  const formClient = await connect(world.targetDir, false, async (form) => {
    assert.match(form.message, new RegExp(request.id));
    const line = form.message.split("\n").find((l) => l.trim().startsWith("candidateResources:"))!;
    const resources = JSON.parse(line.slice(line.indexOf(":") + 1));
    const content = (await formClient.readResource({ uri: resources[0].uri })).contents[0] as {
      blob: string;
    };
    assert.equal(sha256(Buffer.from(content.blob, "base64")), run.candidates[0].sha256);
    inspected = true;
    return { action: "accept", content: { candidate: "none" } };
  });
  const declined = await formClient.callTool({ name: "pick", arguments: args });
  assert.equal(inspected, true);
  assert.equal(
    ((declined.structuredContent as Record<string, unknown>)["error"] as { code: string }).code,
    "confirmation_declined",
  );
});
