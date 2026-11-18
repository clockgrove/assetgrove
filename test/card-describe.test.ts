/**
 * `card describe` (#432): a vision model writes a card's description and tags, recorded as
 * machine-written in `verified`, never over a person's words. A paid command: plan step, forecast
 * and confirmation, and every call reaches the spend ledger.
 */
import "./fixtures/env.ts";
import { approve, ledgerPath, useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SUMMARY } from "./fixtures/describe-script.ts";
import { fixtureLibrary } from "./fixtures/library.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./fixtures/describe-script.ts", import.meta.url));
approve(script);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env["AI_GATEWAY_API_KEY"];
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

const doc = (r: Result): Doc => JSON.parse(r.stdout) as Doc;
const visionCalls = () =>
  existsSync(ledgerPath)
    ? readFileSync(ledgerPath, "utf8")
        .split("\n")
        .filter((l) => l.includes(":vision:") && l.includes('"reserve"')).length
    : 0;

const libs: string[] = [];
function library() {
  const lib = fixtureLibrary();
  libs.push(lib.dir);
  const run = (...args: string[]) =>
    cli([
      "card",
      "describe",
      ...args,
      "--target",
      lib.dir,
      "--runs",
      join(lib.dir, ".assetgrove", "runs"),
      "--provider-script",
      script,
      "--json",
    ]);
  return { lib, run, card: (id: string) => join(lib.root, `${id}.md`) };
}
after(() => Promise.all(libs.map((d) => rm(d, { recursive: true, force: true }))));

test("card describe <address> writes the description, tags and a machine-written verified entry", async () => {
  const { run, card } = library();
  const result = await run(card("rock"));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const out = doc(result);
  assert.deepEqual(
    out["described"].map((d: Doc) => d.asset),
    ["rock"],
  );
  assert.deepEqual(out["skipped"], []);
  assert.ok(
    out["sharedText"].some(
      (s: Doc) => s.source === "card.description" && s.text === SUMMARY.description,
    ),
  );
  const text = readFileSync(card("rock"), "utf8");
  assert.match(text, /A brass porch lantern with amber glass/);
  assert.match(text, /- lantern/);
  assert.match(text, /process:assetgrove-summary:vision:/);
  assert.equal(visionCalls(), 1);
});

test("--missing describes every card with no description and leaves a described one untouched", async () => {
  const { run, card } = library();
  const before = readFileSync(card("lantern"), "utf8");
  const result = await run("--missing");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const out = doc(result);
  assert.deepEqual(out["described"].map((d: Doc) => d.asset).sort(), ["big", "rock"]);
  assert.equal(readFileSync(card("lantern"), "utf8"), before);
  const reasons = Object.fromEntries(out["skipped"].map((s: Doc) => [s.asset, s.reason]));
  assert.match(reasons["fern"], /tags were written by a person/);
  assert.equal(reasons["lantern"], undefined);
  assert.match(readFileSync(card("big"), "utf8"), /process:assetgrove-summary:vision:/);
});

test("a person's description is skipped and listed, and card edit drops the summary entry", async () => {
  const { run, card } = library();
  assert.equal((await run(card("rock"))).code, 0);
  // A person's own description over a described card: the summary entry goes.
  const edited = await cli(["card", "edit", card("rock"), "--description", "My rock.", "--json"]);
  assert.equal(edited.code, 0, edited.stdout + edited.stderr);
  const text = readFileSync(card("rock"), "utf8");
  assert.doesNotMatch(text, /assetgrove-summary/);
  assert.match(text, /My rock\./);
  const calls = visionCalls();
  const again = doc(await run(card("rock")));
  assert.deepEqual(again["described"], []);
  assert.deepEqual(
    again["skipped"].map((s: Doc) => [s.asset, s.reason]),
    [["rock", "its description was written by a person"]],
  );
  assert.equal(readFileSync(card("rock"), "utf8"), text);
  assert.equal(visionCalls(), calls, "no call for a card a person wrote");
});

test("--dry-run forecasts one vision job per card and writes nothing; a declined confirmation spends nothing", async () => {
  const { run, card } = library();
  const before = readFileSync(card("rock"), "utf8");
  const calls = visionCalls();
  const dry = doc(await run("--missing", "--dry-run"));
  assert.deepEqual(
    dry["jobs"].map((j: Doc) => [j.operation, j.count]),
    [["vision", 2]],
  );
  assert.equal(visionCalls(), calls);
  assert.equal(readFileSync(card("rock"), "utf8"), before);

  useAttended();
  const refused = await run("--missing");
  assert.equal(refused.code, 8, refused.stdout + refused.stderr);
  assert.equal(visionCalls(), calls);
  assert.equal(readFileSync(card("rock"), "utf8"), before);
});

test("an audio asset has no image view: it is skipped and listed, and no call is made", async () => {
  const { lib, run, card } = library();
  writeFileSync(join(lib.root, "sound.wav"), Buffer.from("RIFF\0\0\0\0WAVEfmt "));
  copyFileSync(join(lib.root, "rock.review.json"), join(lib.root, "sound.review.json"));
  writeFileSync(
    card("sound"),
    readFileSync(card("rock"), "utf8")
      .replaceAll("rock.png", "sound.wav")
      .replaceAll("rock.review.json", "sound.review.json"),
  );
  const calls = visionCalls();
  const out = doc(await run(card("sound")));
  assert.deepEqual(out["described"], []);
  assert.deepEqual(out["skipped"], [{ asset: "sound", reason: "no image view" }]);
  assert.equal(visionCalls(), calls);
});

test("give an address or --missing, not both and not neither", async () => {
  const { run, card } = library();
  assert.equal((await run()).code, 2);
  assert.equal((await run(card("rock"), "--missing")).code, 2);
});
