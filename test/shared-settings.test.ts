import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { BIBLE_PRESETS, serializeBible, parseBible } from "../src/bible.ts";
import { InputError } from "../src/errors.ts";
import { coreExtension } from "../src/extensions/core.ts";
import type { Generator } from "../src/generators/generator.ts";
import { checkKindSchemas, validateKindSpec } from "../src/kind-schemas.ts";
import { validateProfile } from "../src/profile.ts";
import { settingsBlockIn } from "../src/shared-settings.ts";
import type { AssetSpec } from "../src/types.ts";

const still = coreExtension.kinds!.find((k) => k.kind === "still")!;
const spec = (extra: Record<string, unknown>): AssetSpec =>
  ({ kind: "still", assetId: "a", subject: "a lamp", ...extra }) as unknown as AssetSpec;
const PROFILE = "assetgrove-target-profile/1";
const refused = (where: RegExp) => (e: unknown) =>
  e instanceof InputError &&
  where.test(e.message) &&
  /only in the developer settings/.test(e.message);

test("a target profile holding extensionSettings or provider settings is refused, naming where", () => {
  assert.throws(
    () =>
      validateProfile(
        { format: PROFILE, extensionSettings: { "assetgrove-pack": { tier: "fast" } } },
        "p.json",
      ),
    refused(/target profile p\.json holds "extensionSettings"/),
  );
  assert.throws(
    () =>
      validateProfile(
        { format: PROFILE, kinds: { "pixel:tile": { values: { providers: { x: {} } } } } },
        "p.json",
      ),
    refused(/holds "kinds\.pixel:tile\.values\.providers"/),
  );
  assert.doesNotThrow(() =>
    validateProfile({ format: PROFILE, kinds: { "pixel:tile": { values: { a: 1 } } } }, "p.json"),
  );
});

test("a style bible whose front matter holds extensionSettings is refused", () => {
  const bible = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  const source = serializeBible(bible, "\n## Do's and Don'ts\n\n- Do keep it cozy.\n");
  assert.doesNotThrow(() => parseBible(source));
  const tainted = source.replace(
    /^---\n/,
    "---\nextensionSettings:\n  assetgrove-pack:\n    tier: fast\n",
  );
  assert.throws(() => parseBible(tainted), refused(/style bible holds "extensionSettings"/));
});

test("a spec holding extensionSettings or providers is refused, even for a kind with a loose schema", () => {
  assert.throws(
    () => validateKindSpec(still, spec({ extensionSettings: { pack: { tier: "fast" } } })),
    refused(/the still spec holds "extensionSettings"/),
  );
  assert.throws(
    () => validateKindSpec(still, spec({ fields: { providers: { x: { baseURL: "https://e" } } } })),
    refused(/holds "fields\.providers"/),
  );
  assert.doesNotThrow(() => validateKindSpec(still, spec({ fields: { mood: "calm" } })));
});

test("a kind schema may not declare extensionSettings", () => {
  const kind = {
    kind: "pixel:tile",
    specSchema: z.looseObject({ extensionSettings: z.record(z.string(), z.unknown()).optional() }),
  } as unknown as Generator;
  assert.throws(
    () => checkKindSchemas(kind, (why) => new InputError(why)),
    /declares "extensionSettings", a routing field/,
  );
});

test("settingsBlockIn matches any case and separator, through arrays", () => {
  assert.equal(settingsBlockIn({ a: [{ Extension_Settings: 1 }] }), "a.0.Extension_Settings");
  assert.equal(settingsBlockIn({ provider: "x", model: "m" }), undefined);
});
