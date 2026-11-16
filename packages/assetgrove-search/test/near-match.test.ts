import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { nearMatchesWith, searchSlot } from "../src/extension.ts";
import { ScriptedEmbedder } from "../src/scripted.ts";
import { cleanup } from "./helpers/fixture.ts";
import { makeProject, type Project } from "./helpers/project.ts";

const addr = (name: string) => `asset://g/pick/${name}`;

async function put(
  p: Project,
  name: string,
  caption: string,
  card: Record<string, unknown>,
): Promise<void> {
  const abs = join(p.root, `pick/${name}.png`);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, caption);
  await writeFile(abs.replace(/\.png$/, ".card.json"), JSON.stringify(card));
}

describe("near matches by rank", () => {
  let p: Project;
  before(async () => {
    p = await makeProject();
    await put(p, "garden-lantern", "red lantern glowing beside a wooden door", {
      kind: "sprite",
      subject: "garden lantern",
      title: "Garden lantern",
      text: "A red lantern glowing beside a door.",
    });
    await put(p, "oak", "green oak tree", {
      kind: "sprite",
      subject: "oak",
      title: "Oak",
      text: "A green oak tree.",
    });
    for (const [name, words] of [
      ["boulder", "grey mossy boulder"],
      ["well", "stone water well"],
      ["fence", "white picket fence"],
    ]) {
      await put(p, name as string, words as string, {
        kind: "sprite",
        subject: name,
        title: name,
        text: `A ${words}.`,
      });
    }
    await put(p, "lantern-tile", "red lantern glowing beside a wooden door", {
      kind: "tile",
      subject: "porch lantern",
      title: "Lantern tile",
      text: "A red lantern glowing beside a door.",
    });
  });
  after(() => cleanup(p.root, p.stateDir));

  const query = (over: Record<string, unknown> = {}) => ({
    kind: "sprite",
    subject: "porch lantern",
    references: [] as Uint8Array[],
    limit: 3,
    ...over,
  });
  const lanterns = new Set([addr("lantern"), addr("garden-lantern")]);
  const addresses = (r: { hits: { address: string }[] }) => r.hits.map((h) => h.address);

  it("lists a pick of another subject that ranks close", async () => {
    const r = await nearMatchesWith(query(), p.context(), { paid: false });
    // Six sprite picks against a limit of three: the garden lantern is listed by its rank.
    assert.equal(r.hits.length, 3);
    assert.ok(addresses(r).slice(0, 2).includes(addr("garden-lantern")));
    assert.deepEqual(
      r.hits.map((h) => h.rank),
      r.hits.map((_, i) => i + 1),
    );
  });

  it("never lists another kind", async () => {
    const r = await nearMatchesWith(query({ limit: 10 }), p.context(), { paid: false });
    assert.ok(!addresses(r).includes(addr("lantern-tile")));
    assert.ok(!addresses(r).includes(addr("bridge")));
  });

  it("is a method of the slot", () => {
    assert.equal(typeof searchSlot.nearMatch, "function");
  });

  it("uses the brief as words", async () => {
    const r = await nearMatchesWith(
      query({ subject: "thing", brief: "green oak tree" }),
      p.context(),
      {
        paid: false,
      },
    );
    assert.equal(r.hits[0]?.address, addr("oak"));
  });

  it("ranks the pick a reference image matches above one that only shares the words", async () => {
    const words = query({ subject: "glowing lantern", brief: "tree" });
    const pos = (r: { hits: { address: string }[] }) => addresses(r).indexOf(addr("oak"));
    const without = await nearMatchesWith({ ...words, limit: 10 }, p.context(), { paid: false });
    assert.ok(pos(without) > 0, "without the reference a lantern ranks above the oak");
    const r = await nearMatchesWith(
      { ...words, references: [Buffer.from("green oak tree")] },
      p.context(),
      { paid: false },
    );
    assert.equal(r.hits[0]?.address, addr("oak"));
  });

  describe("with a paid embedder", () => {
    it("embeds nothing on a fresh project: no refresh, reported not fresh", async () => {
      const fresh = await makeProject();
      await put(fresh, "garden-lantern", "red lantern glowing beside a wooden door", {
        kind: "sprite",
        subject: "garden lantern",
        title: "Garden lantern",
        text: "A red lantern glowing beside a door.",
      });
      const texts = mock.method(ScriptedEmbedder.prototype, "embedTexts");
      const images = mock.method(ScriptedEmbedder.prototype, "embedImages");
      try {
        const r = await nearMatchesWith(
          query({ references: [Buffer.from("green oak tree")] }),
          fresh.context(),
          { paid: true },
        );
        assert.equal(texts.mock.callCount(), 0);
        assert.equal(images.mock.callCount(), 0);
        assert.equal(r.fresh, false);
      } finally {
        texts.mock.restore();
        images.mock.restore();
        await cleanup(fresh.root, fresh.stateDir);
      }
    });

    it("embeds nothing about the request and still ranks by full text", async () => {
      const ctx = p.context();
      // An index built beforehand, as `search index` or an unpaid plan step builds it.
      await searchSlot.index({}, ctx);
      const texts = mock.method(ScriptedEmbedder.prototype, "embedTexts");
      const images = mock.method(ScriptedEmbedder.prototype, "embedImages");
      try {
        const r = await nearMatchesWith(
          query({ references: [Buffer.from("green oak tree")] }),
          ctx,
          { paid: true },
        );
        assert.equal(texts.mock.callCount(), 0);
        assert.equal(images.mock.callCount(), 0);
        assert.ok(lanterns.has(r.hits[0]?.address as string));
      } finally {
        texts.mock.restore();
        images.mock.restore();
      }
    });

    it("ranks first the pick whose file bytes a reference equals", async () => {
      const r = await nearMatchesWith(
        query({ subject: "thing", references: [Buffer.from("green oak tree")] }),
        p.context(),
        { paid: true },
      );
      assert.equal(r.hits[0]?.address, addr("oak"));
    });

    it("skips a reference that is not indexed", async () => {
      const r = await nearMatchesWith(
        query({ references: [Buffer.from("never indexed bytes")] }),
        p.context(),
        { paid: true },
      );
      assert.ok(lanterns.has(r.hits[0]?.address as string));
    });
  });
});

describe("a library whose assets share one subject", () => {
  let p: Project;
  before(async () => {
    p = await makeProject();
    const hero = (title: string, text: string) => ({
      kind: "sprite",
      subject: "hero",
      title,
      text,
    });
    await put(p, "h1", "hero with iron sword", hero("Sword hero", "iron sword"));
    await put(p, "h2", "hero with wooden shield", hero("Shield hero", "wooden shield"));
    await put(p, "h3", "hero riding a horse", hero("Rider hero", "riding horse"));
    await put(p, "h4", "hero asleep", hero("Sleeper", "asleep"));
    await put(p, "h5", "hero eating soup", hero("Eater", "eating soup"));
    await put(p, "h6", "hero juggling", hero("Juggler", "juggling"));
    // A paid embedder searches the index as it stands: build it first.
    await searchSlot.index({}, p.context());
  });
  after(() => cleanup(p.root, p.stateDir));

  it("lists the three closest to the brief, in order", async () => {
    const r = await nearMatchesWith(
      {
        kind: "sprite",
        subject: "hero",
        brief: "riding horse iron sword shield",
        references: [],
        limit: 3,
      },
      p.context(),
      { paid: true },
    );
    const top = r.hits.map((h) => h.address);
    assert.equal(top.length, 3);
    assert.deepEqual(top.slice(0, 2).sort(), [addr("h1"), addr("h3")]);
    assert.equal(top[2], addr("h2"));
  });

  it("does the same with the embedder", async () => {
    const r = await nearMatchesWith(
      {
        kind: "sprite",
        subject: "hero",
        brief: "hero riding a horse",
        references: [],
        limit: 3,
      },
      p.context(),
      { paid: false },
    );
    // The scripted embedder is deterministic: the brief's own sprite first, then the next two
    // by its similarity, and none of the other three that share the subject.
    assert.deepEqual(
      r.hits.map((h) => [h.address, h.rank]),
      [
        [addr("h3"), 1],
        [addr("h4"), 2],
        [addr("h1"), 3],
      ],
    );
  });
});
