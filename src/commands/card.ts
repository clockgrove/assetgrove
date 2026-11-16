/**
 * `card edit` (tool `card_edit`, design sections 3.1 and 3.3): a person changes a card's person
 * fields (title, description, tags, the body and fields Assetgrove does not own). Naming a machine
 * field exits 2 `card_field_owned`. The edit is recorded as a `describing` annotation, or `tagging`
 * when only the tags change, with `ag:action: "card-edit"`, and logged; the card text reaches a
 * tool result only under `sharedText`.
 */
import { InputError } from "../errors.ts";
import {
  loadAsset,
  locateAsset,
  newest,
  selectVersion,
  withLibraryLock,
  writeAsset,
} from "../library/actions.ts";
import { CardFieldOwnedError, MACHINE_FIELDS, setPersonFields } from "../library/card.ts";
import { appendAnnotation, nextStamp } from "../library/review.ts";
import type { AnnotationInput } from "../library/review.ts";
import type { SharedText } from "../request.ts";
import { annotationFields } from "./review.ts";
import { defineCommand } from "./types.ts";

interface CardEditArgs {
  address: string;
  title?: string;
  description?: string;
  tag?: string[];
  body?: string;
  field?: string[];
}

/** The person fields an edit sets, by name; a machine field throws `CardFieldOwnedError`. */
function editedFields(args: CardEditArgs): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const entry of args.field ?? []) {
    const at = entry.indexOf("=");
    const name = at === -1 ? entry : entry.slice(0, at);
    if ((MACHINE_FIELDS as readonly string[]).includes(name)) throw new CardFieldOwnedError(name);
    if (at <= 0 || !/^[A-Za-z_][\w-]*$/.test(name)) {
      throw new InputError(`--field "${entry}" is not name=value`);
    }
    values[name] = entry.slice(at + 1);
  }
  if (args.title !== undefined) values["title"] = args.title;
  if (args.description !== undefined) values["description"] = args.description;
  if (args.tag !== undefined) values["tags"] = [...args.tag];
  // A card keeps a title, whether --title or --field title= sets it.
  const title = values["title"];
  if (typeof title === "string" && title.trim() === "") {
    throw new InputError("a card's title cannot be empty (--title or --field title=)");
  }
  return values;
}

export const cardEditCommand = defineCommand<CardEditArgs>({
  name: "card edit",
  tool: "card_edit",
  summary: "edit a card's person fields: title, description, tags, body and other fields",
  details: `Changes the person fields of a picked asset's card (docs/library.md): --title, --description,
--tag (repeated; replaces the tags), --body (the Markdown after the front matter) and --field
<name=value> for a field Assetgrove does not own. Naming a machine field (type, format, resource,
generated, verified, sources, kind, subject, state, version, bible, license, lock) exits 2
card_field_owned before anything is written. The address is the asset's card, media or review
record. Appends a describing annotation (tagging when only the tags change) with ag:action
card-edit naming the fields changed, rewrites the card, the folder indexes and logs one line. No
confirmation. The card's text is returned only under sharedText.`,
  input: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "the asset's card, media or review record",
        placeholder: "<address>",
      },
      title: { type: "string", description: "the card's new title", placeholder: "<text>" },
      description: {
        type: "string",
        description: "the card's new description",
        placeholder: "<text>",
      },
      tag: {
        type: "array",
        items: { type: "string" },
        description: "a tag; the tags given replace the card's tags",
        placeholder: "<tag>",
      },
      body: {
        type: "string",
        description: "the card's new body, the Markdown after its front matter",
        placeholder: "<markdown>",
      },
      field: {
        type: "array",
        items: { type: "string" },
        description: "another person field, as name=value",
        placeholder: "<name=value>",
      },
    },
    required: ["address"],
    additionalProperties: false,
  },
  positionals: [{ name: "address" }],
  effect: { readOnly: false, spends: "never", writes: "target" },
  async run(args, ctx) {
    // A machine field refuses before anything is read or written.
    const values = editedFields(args);
    const changed = [...Object.keys(values), ...(args.body !== undefined ? ["body"] : [])];
    if (changed.length === 0) {
      throw new InputError(
        "card edit needs --title, --description, --tag, --body or --field <name=value>",
      );
    }
    const location = locateAsset(args.address);
    return withLibraryLock(location, ctx.settings.stateDir, async () => {
      const asset = await loadAsset(location);
      const card = setPersonFields(asset.card, values, args.body, asset.cardPath);
      const version = selectVersion(asset.record);
      const input: AnnotationInput = {
        type: "Annotation",
        motivation: changed.length === 1 && changed[0] === "tags" ? "tagging" : "describing",
        created: nextStamp(asset.record),
        body: [{ type: "TextualBody", purpose: "describing", value: changed.join(", ") }],
        target: { source: asset.resource, "ag:version": version.sha256 },
        "ag:action": "card-edit",
      };
      const record = appendAnnotation(asset.record, input);
      const annotation = newest(record, input);
      const written = await writeAsset({ ...asset, card }, record, { card });
      const sharedText: SharedText[] = [];
      for (const [name, value] of Object.entries(values)) {
        for (const text of [value].flat())
          if (typeof text === "string" && text !== "")
            sharedText.push({ source: `card.${name}`, text });
      }
      if (args.body !== undefined && args.body !== "")
        sharedText.push({ source: "card.body", text: args.body });
      return {
        exitCode: 0,
        fields: {
          asset: asset.assetId,
          changed,
          annotation: annotationFields(annotation),
          files: written.files,
          sharedText,
        },
        human: [
          `edited ${changed.join(", ")} of ${asset.assetId}`,
          ...written.files.map((f) => `wrote ${f}`),
        ].join("\n"),
      };
    });
  },
});
