/**
 * `review` and `approve` (design section 3.3). `review` appends a comment, a reply, a resolution or
 * a rejection to a version's record or a candidate's; `approve` is the only way to approve a
 * version and needs a person's pick confirmation, whose digest covers the asset id, the version's
 * sha256 and the record's head, so a stored confirmation no longer applies once the record changes.
 * Headless settings never approve. Annotation text reaches a tool result only under `sharedText`.
 */
import { confirmationPath, digestOf, requireConfirmation } from "../confirm/index.ts";
import type { KindRequest } from "../confirm/index.ts";
import { InputError } from "../errors.ts";
import {
  annotateCandidate,
  loadAsset,
  locateAsset,
  locateCandidate,
  newest,
  selectVersion,
  withLibraryLock,
  writeAsset,
} from "../library/actions.ts";
import type { LoadedAsset } from "../library/actions.ts";
import {
  appendAnnotation,
  nextStamp,
  recordHead,
  versionNumber,
  versionStatus,
} from "../library/review.ts";
import type { Annotation, AnnotationInput, ReviewRecord, Version } from "../library/review.ts";
import { PlanChangedError } from "../planning.ts";
import type { SharedText } from "../request.ts";
import type { ConfirmationRecord } from "../types.ts";
import type { Outcome, RunContext } from "./types.ts";
import { defineCommand } from "./types.ts";

/** An annotation as a tool result names it: by id, motivation and action, never its text. */
export function annotationFields(annotation: Annotation): Record<string, unknown> {
  const target = annotation.target;
  return {
    id: annotation.id,
    motivation: annotation.motivation,
    ...(annotation["ag:action"] !== undefined && { action: annotation["ag:action"] }),
    ...(annotation["ag:resolves"] !== undefined && { resolves: annotation["ag:resolves"] }),
    ...(typeof target === "string"
      ? { target }
      : target["ag:version"] !== undefined && { version: target["ag:version"] }),
  };
}

/** The annotation's text bodies, as the `sharedText` of a tool result (design section 3.3). */
export function annotationText(annotation: Annotation): SharedText[] {
  const body = annotation.body === undefined ? [] : [annotation.body].flat();
  return body.flatMap((part, i) =>
    part.type === "TextualBody" && part.value !== ""
      ? [{ source: `annotation ${annotation.id} body[${i}]`, text: part.value }]
      : [],
  );
}

function textBody(value: string, purpose: string): AnnotationInput["body"] {
  return [{ type: "TextualBody", purpose, value }];
}

function requireAnnotation(record: ReviewRecord, id: string, option: string): string {
  const ref = id.startsWith("#") ? id : `#${id}`;
  if (!record.annotations.some((a) => a.id === ref)) {
    throw new InputError(`${option} ${id}: the record has no annotation with that id`);
  }
  return ref;
}

interface ReviewArgs {
  address: string;
  candidate?: string;
  version?: string;
  comment?: string;
  reply?: string;
  resolve?: string;
  reject?: string;
}

/** The annotation a review's options ask for, against `target` (the version or the candidate). */
function reviewAnnotation(
  args: ReviewArgs,
  record: ReviewRecord,
  target: { source: string; "ag:version": string },
  created: string,
): AnnotationInput {
  const actions = [args.reply, args.resolve, args.reject].filter((v) => v !== undefined);
  if (actions.length > 1 || (args.reject !== undefined && args.comment !== undefined)) {
    throw new InputError(
      "review takes one of --comment, --reply <id> --comment <text>, --resolve <id> or --reject <reason>",
    );
  }
  if (args.reject !== undefined) {
    if (args.reject.trim() === "") throw new InputError("--reject needs a reason");
    return {
      type: "Annotation",
      motivation: "assessing",
      created,
      body: textBody(args.reject, "assessing"),
      target,
      "ag:action": "reject",
    };
  }
  if (args.resolve !== undefined) {
    const resolves = requireAnnotation(record, args.resolve, "--resolve");
    return {
      type: "Annotation",
      motivation: "moderating",
      created,
      ...(args.comment !== undefined &&
        args.comment !== "" && { body: textBody(args.comment, "commenting") }),
      target: resolves,
      "ag:action": "resolve",
      "ag:resolves": resolves,
    };
  }
  if (args.comment === undefined || args.comment.trim() === "") {
    throw new InputError(
      args.reply !== undefined
        ? "--reply needs its text in --comment"
        : "review needs --comment, --reply, --resolve or --reject",
    );
  }
  if (args.reply !== undefined) {
    return {
      type: "Annotation",
      motivation: "replying",
      created,
      body: textBody(args.comment, "replying"),
      target: requireAnnotation(record, args.reply, "--reply"),
    };
  }
  return {
    type: "Annotation",
    motivation: "commenting",
    created,
    body: textBody(args.comment, "commenting"),
    target,
  };
}

function versionTarget(asset: LoadedAsset, version: Version) {
  return { source: asset.resource, "ag:version": version.sha256 };
}

export const reviewCommand = defineCommand<ReviewArgs>({
  name: "review",
  tool: "review",
  summary: "comment on, reply to, resolve or reject a version or a candidate",
  details: `Appends one annotation to a review record (docs/library.md): for a version, the asset's
<assetId>.review.json (the address is its card, media or review record; --version names the version
by number or sha256, the current one by default); for a candidate, <run>/reviews/<candidate>.review.json
(the address is the run directory, with --candidate). --comment <text> comments; --reply <id> with
--comment <text> replies to an annotation; --resolve <id> closes a request (--comment is its note);
--reject <reason> rejects. Existing lines never change. For a version it then rewrites the card's
state, the folder indexes and log.md. No confirmation. The text is returned only under sharedText.`,
  input: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "the asset's card, media or review record, or a run directory",
        placeholder: "<address>",
      },
      candidate: {
        type: "string",
        description: "the candidate of the run directory to review",
        placeholder: "<id>",
      },
      version: {
        type: "string",
        description: "the version to review, by number or sha256; the current one by default",
        placeholder: "<n|sha256>",
      },
      comment: { type: "string", description: "the comment's text", placeholder: "<text>" },
      reply: {
        type: "string",
        description: "the annotation id to reply to, with --comment",
        placeholder: "<id>",
      },
      resolve: {
        type: "string",
        description: "the annotation id of the request to resolve",
        placeholder: "<id>",
      },
      reject: { type: "string", description: "reject, with this reason", placeholder: "<reason>" },
    },
    required: ["address"],
    additionalProperties: false,
  },
  positionals: [{ name: "address" }],
  effect: { readOnly: false, spends: "never", writes: "target" },
  async run(args, ctx) {
    if (args.candidate !== undefined) {
      if (args.version !== undefined)
        throw new InputError("--version names a version, not a candidate");
      const location = await locateCandidate(args.address, args.candidate);
      const { annotation } = await annotateCandidate(location, (record) =>
        reviewAnnotation(
          args,
          record,
          { source: `../${location.file}`, "ag:version": location.sha256 },
          nextStamp(record),
        ),
      );
      return {
        exitCode: 0,
        fields: {
          run: location.runDir,
          candidate: location.candidate,
          record: location.reviewPath,
          annotation: annotationFields(annotation),
          files: [location.reviewPath],
          sharedText: annotationText(annotation),
        },
        human: `${annotation.motivation} ${annotation.id} on candidate ${location.candidate} of run ${location.runId}\nwrote ${location.reviewPath}`,
      };
    }
    const location = locateAsset(args.address);
    return withLibraryLock(location, ctx.settings.stateDir, async () => {
      const asset = await loadAsset(location);
      const version = selectVersion(asset.record, args.version);
      const input = reviewAnnotation(
        args,
        asset.record,
        versionTarget(asset, version),
        nextStamp(asset.record),
      );
      const record = appendAnnotation(asset.record, input);
      const annotation = newest(record, input);
      const written = await writeAsset(asset, record);
      const number = versionNumber(record, version.sha256)!;
      return {
        exitCode: 0,
        fields: {
          asset: asset.assetId,
          version: number,
          sha256: version.sha256,
          state: versionStatus(record, version.sha256),
          cardState: written.state,
          annotation: annotationFields(annotation),
          files: written.files,
          sharedText: annotationText(annotation),
        },
        human: [
          `${annotation.motivation} ${annotation.id} on version ${number} of ${asset.assetId}`,
          ...written.files.map((f) => `wrote ${f}`),
        ].join("\n"),
      };
    });
  },
});

interface ApproveArgs {
  address: string;
  version?: string;
}

/**
 * The approve request: a pick confirmation whose digest covers the asset id, the version's sha256
 * and the record's head (its last annotation's id and the hash of its item lines).
 */
export function approveRequest(asset: LoadedAsset, version: Version): KindRequest {
  const head = recordHead(asset.record);
  const number = versionNumber(asset.record, version.sha256)!;
  const body = {
    command: "approve",
    asset: asset.assetId,
    card: asset.cardPath,
    candidate: version.sha256,
    version: version.sha256,
    head,
  };
  const id = digestOf(body);
  return {
    kind: "pick",
    id,
    summary: `approve version ${number} of ${asset.assetId} (sha256 ${version.sha256})`,
    details: {
      asset: asset.assetId,
      card: asset.cardPath,
      version: number,
      sha256: version.sha256,
      state: versionStatus(asset.record, version.sha256),
      lastAnnotation: head.last,
      digest: id,
    },
    body,
    choices: [version.sha256],
  };
}

/** Rebuilds a pending approve request from its body; undefined when the body names none. */
export async function rebuildApproveRequest(
  body: Record<string, unknown>,
): Promise<KindRequest | undefined> {
  if (typeof body["card"] !== "string" || typeof body["version"] !== "string") return undefined;
  const asset = await loadAsset(locateAsset(body["card"]));
  return approveRequest(asset, selectVersion(asset.record, body["version"]));
}

/**
 * Exit 8 `confirmation_required` under headless settings, before anything is written: no score,
 * run or operator setting approves or adopts (design section 3.3).
 */
export function headlessRefusal(
  request: KindRequest,
  fields: Record<string, unknown>,
  what: string,
): Outcome {
  const message = `${request.summary}: headless settings never ${what}; a person runs it with attended settings`;
  return {
    exitCode: 8,
    fields: { ...fields, digest: request.id },
    human: message,
    error: { code: "confirmation_required", message },
  };
}

/** The confirmation of a request, refusing headless settings first. */
export async function personConfirms(
  request: KindRequest,
  ctx: RunContext,
): Promise<ConfirmationRecord> {
  return requireConfirmation(request, {
    settings: ctx.settings,
    ...(ctx.prompt && { prompt: ctx.prompt }),
  });
}

/** Exit 2 `plan_changed` when the request rebuilt under the lock is not the one confirmed. */
export function requireSameRequest(confirmed: KindRequest, now: KindRequest): void {
  if (now.id !== confirmed.id) {
    throw new PlanChangedError(
      `the review record of ${String(now.body["asset"])} changed after the confirmation (was ${confirmed.id}, now ${now.id}); run it again`,
    );
  }
}

export const approveCommand = defineCommand<ApproveArgs>({
  name: "approve",
  tool: "approve",
  summary: "approve a version of a picked asset, with a person's confirmation",
  details: `The only way to approve (design section 3.3). The address is the asset's card, media or
review record; --version names the version by number or sha256, the current one by default. A person
confirms the approval like a pick: a record at <configDir>/confirmations/<hex>.json for its digest,
an MCP client's form, the TTY, or exit 8 confirmation_required and \`assetgrove confirm <hex>\`. The
digest covers the asset id, the version's sha256 and the review record's head (its last annotation's
id and a sha256 of its item lines), so a stored confirmation no longer applies after a reject, a pull
or a merge adds a line: approve asks again. Under headless settings it exits 8 confirmation_required
and writes nothing. Then appends an assessing annotation (ag:action approve) with the confirmation
method and digest, sets the card's state to approved, rewrites its lock and logs a line. The
manifest's review field stays at pending.`,
  input: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "the asset's card, media or review record",
        placeholder: "<address>",
      },
      version: {
        type: "string",
        description: "the version to approve, by number or sha256; the current one by default",
        placeholder: "<n|sha256>",
      },
    },
    required: ["address"],
    additionalProperties: false,
  },
  positionals: [{ name: "address" }],
  effect: { readOnly: false, spends: "never", writes: "target" },
  confirm: "pick",
  async run(args, ctx) {
    const location = locateAsset(args.address);
    const before = await loadAsset(location);
    const request = approveRequest(before, selectVersion(before.record, args.version));
    const sha256 = String(request.body["version"]);
    if (ctx.settings.mode === "headless") {
      return headlessRefusal(request, { asset: before.assetId, sha256 }, "approve");
    }
    const confirmation = await personConfirms(request, ctx);
    return withLibraryLock(location, ctx.settings.stateDir, async () => {
      const asset = await loadAsset(location);
      const version = selectVersion(asset.record, sha256);
      requireSameRequest(request, approveRequest(asset, version));
      const input: AnnotationInput = {
        type: "Annotation",
        motivation: "assessing",
        created: nextStamp(asset.record),
        target: versionTarget(asset, version),
        "ag:action": "approve",
        "ag:confirmation": { method: confirmation.method, digest: confirmation.digest },
      };
      const record = appendAnnotation(asset.record, input);
      const annotation = newest(record, input);
      const written = await writeAsset(asset, record);
      const number = versionNumber(record, version.sha256)!;
      return {
        exitCode: 0,
        fields: {
          asset: asset.assetId,
          version: number,
          sha256: version.sha256,
          state: versionStatus(record, version.sha256),
          cardState: written.state,
          annotation: annotationFields(annotation),
          confirmation,
          confirmationRecord: confirmationPath(ctx.settings.configDir, confirmation.digest),
          files: written.files,
        },
        human: [
          `approved version ${number} of ${asset.assetId} (${confirmation.method})`,
          ...written.files.map((f) => `wrote ${f}`),
        ].join("\n"),
      };
    });
  },
});
