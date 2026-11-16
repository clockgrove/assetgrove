import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import extension, { searchSlot, storageOptions } from "../src/extension.ts";
import { SearchError } from "../src/errors.ts";
import { LanceStore } from "../src/lance-store.ts";
import { ScriptedEmbedder } from "../src/scripted.ts";
import { cleanup, snapshot, tempDir } from "./helpers/fixture.ts";
import { makeProject, type Project } from "./helpers/project.ts";

void extension;

describe("a shared remote store (a local folder URI)", () => {
  let p: Project;
  let remoteDir: string;
  let uri: string;
  const tree = createHash("sha256").update("game:demo\0origin:root-1").digest("hex");
  before(async () => {
    p = await makeProject();
    remoteDir = join(await tempDir("remote"), "remote");
    uri = pathToFileURL(remoteDir).href;
  });
  after(() => cleanup(p.root, p.stateDir, remoteDir, join(remoteDir, "..")));

  const settings = (writer: boolean) => ({
    store: { uri, options: {}, writer },
  });

  it("refuses to build from uncommitted changes and writes nothing", async () => {
    const ctx = p.context(settings(true), { head: "head-1", clean: false });
    await assert.rejects(
      searchSlot.index({}, ctx),
      (e) =>
        e instanceof SearchError &&
        e.code === "invalid_input" &&
        /uncommitted changes under the library root/.test(e.message),
    );
    await assert.rejects(snapshot(remoteDir), { code: "ENOENT" });
  });

  it("writes only pick and reference rows; candidates and folders stay local", async () => {
    const ctx = p.context(settings(true));
    const r = (await searchSlot.index({}, ctx)) as { remote: { written: boolean } };
    assert.equal(r.remote.written, true);

    const remote = await LanceStore.open(remoteDir, { embedder: new ScriptedEmbedder() });
    const rows = await remote.query({ filter: [], limit: 100 });
    remote.close();
    assert.ok(rows.length > 0);
    assert.deepEqual(new Set(rows.map((h) => h.row.source)), new Set(["pick", "reference"]));
    assert.ok(rows.every((h) => h.row.tree === tree));
    assert.equal(
      rows.some((h) => h.row.imageVec === undefined),
      false,
    );

    const local = await searchSlot.find({ limit: 20 }, ctx);
    assert.deepEqual(
      new Set(local.hits.map((h) => h.source)),
      new Set(["pick", "reference", "candidate", "folder"]),
    );
  });

  it("fuses both stores in one query", async () => {
    const ctx = p.context(settings(true));
    const r = await searchSlot.find({ words: "lantern lamp", limit: 5 }, ctx);
    const got = new Map(r.hits.map((h) => [h.address, h.source]));
    assert.equal(got.get("asset://g/pick/lantern"), "pick");
    assert.equal(got.get("asset://g/candidate/lamp"), "candidate");
    assert.equal(r.fresh, true);
    assert.equal(r.builtFrom?.head, "head-1");
    const like = await searchSlot.find(
      { like: { address: "asset://g/pick/bridge" }, limit: 2 },
      ctx,
    );
    assert.equal(like.hits[0]?.address, "asset://g/pick/bridge");
  });

  it("a reader never writes the remote and reports freshness against builtFrom", async () => {
    const same = { head: "head-1", clean: true };
    const reader = p.context(settings(false), same);
    const before = await snapshot(remoteDir);
    const idx = (await searchSlot.index({}, reader)) as { remote: { written: boolean } };
    assert.equal(idx.remote.written, false);
    assert.equal((await searchSlot.find({ words: "lantern", limit: 3 }, reader)).fresh, true);

    const moved = p.context(settings(false), { head: "head-2", clean: true });
    const r = await searchSlot.find({ words: "lantern", limit: 3 }, moved);
    assert.equal(r.fresh, false);
    assert.equal(r.builtFrom?.head, "head-1");
    const st = await searchSlot.status(moved);
    assert.equal((st.remote as { fresh: boolean }).fresh, false);
    assert.deepEqual(await snapshot(remoteDir), before);
  });

  it("names a missing credential variable, never a value", async () => {
    const ctx = p.context({
      store: {
        uri: "s3://bucket/search",
        options: { region: "r" },
        credentialsEnv: { accessKeyId: "AG_KEY", secretAccessKey: "AG_SECRET" },
        writer: false,
      },
    });
    ctx.env = { AG_SECRET: "super-secret-value" };
    await assert.rejects(
      searchSlot.find({ words: "x", limit: 1 }, ctx),
      (e) =>
        e instanceof SearchError &&
        e.code === "settings_invalid" &&
        e.message.includes("AG_KEY") &&
        !e.message.includes("super-secret-value"),
    );
  });

  it("hands each scheme's named credentials to Lance under that scheme's keys, and only those", () => {
    const env = {
      K: "k",
      S: "s",
      T: "t",
      G: "{json}",
      N: "acct",
      A: "key",
      AWS_ACCESS_KEY_ID: "no",
    };
    const store = (uri: string, credentialsEnv?: Record<string, string>) => ({
      uri,
      options: { region: "auto" },
      ...(credentialsEnv && { credentialsEnv }),
      writer: false,
    });
    assert.deepEqual(
      storageOptions(
        store("s3://b/p", { accessKeyId: "K", secretAccessKey: "S", sessionToken: "T" }),
        env,
      ),
      {
        region: "auto",
        aws_access_key_id: "k",
        aws_secret_access_key: "s",
        aws_session_token: "t",
      },
    );
    assert.deepEqual(storageOptions(store("gs://b/p", { serviceAccountKey: "G" }), env), {
      region: "auto",
      google_service_account_key: "{json}",
    });
    assert.deepEqual(
      storageOptions(store("az://b/p", { accountName: "N", accountKey: "A" }), env),
      {
        region: "auto",
        azure_storage_account_name: "acct",
        azure_storage_account_key: "key",
      },
    );
    for (const s of [
      store("s3://b/p"),
      store("gs://b/p", { accessKeyId: "K", secretAccessKey: "S" }),
      store("az://b/p", { accountName: "N" }),
    ]) {
      assert.throws(
        () => storageOptions(s, env),
        (e) =>
          e instanceof SearchError &&
          e.code === "settings_invalid" &&
          /never opened without explicit credentials/.test(e.message),
      );
    }
  });

  it("refuses to open a remote store with no credentials named", async () => {
    const ctx = p.context({ store: { uri: "gs://bucket/search", options: {}, writer: false } });
    await assert.rejects(
      searchSlot.find({ words: "x", limit: 1 }, ctx),
      (e) => e instanceof SearchError && e.code === "settings_invalid",
    );
  });

  it("keys shared rows by game and repository: another repository with the same game id shares nothing", async () => {
    const other = p.context(settings(true), { head: "other-1", clean: true, origin: "root-2" });
    const r = await searchSlot.find({ words: "lantern", limit: 5 }, other);
    assert.equal(r.builtFrom, null, "the other repository sees no shared build");
    assert.ok(r.hits.every((h) => h.source !== "pick" && h.source !== "reference"));
    const st = await searchSlot.status(other);
    assert.equal((st.remote as { builtFrom: unknown }).builtFrom, null);

    const shallow = p.context(settings(false), { head: "head-1", clean: true, origin: "" });
    await assert.rejects(
      searchSlot.find({ words: "lantern", limit: 1 }, shallow),
      (e) => e instanceof SearchError && /root commit/.test(e.message),
    );
  });
});
