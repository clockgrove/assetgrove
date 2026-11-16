import { approvalPath, verifiedIdentity, writeApproval } from "../approvals.ts";
import {
  confirmationPath,
  recordOf,
  verifiedRequest,
  writeConfirmation,
} from "../confirm/index.ts";
import type { KindRequest } from "../confirm/index.ts";
import { readPending, removePending } from "../confirm/pending.ts";
import { describeRequest } from "../confirm/prompt.ts";
import type { ConfirmRequest } from "../confirm/prompt.ts";
import { spendShown } from "../runs/execute.ts";
import type { WorkPlan } from "../runs/plan.ts";
import { pickRequest } from "./pick.ts";
import { rebuildApproveRequest } from "./review.ts";
import { applySettingsChange, rebuiltSettingsRequest } from "../settings-write.ts";
import { refusal } from "./result.ts";
import { defineCommand } from "./types.ts";
import { writeRequest } from "./write-families.ts";
import { rebuildAdoptRequest } from "../library/adopt.ts";

/**
 * A pending spend, pick or write request as a person is shown it, rebuilt from what its id hashes
 * and never from the saved summary, details or choices: a spend's from its verified body; a
 * pick's and a write's by making the request again from its body (the run's candidates, the
 * import and the grouping; an approve's or adopt's card) and requiring the same id. Undefined when the request does not hold.
 */
async function shownRequest(request: ConfirmRequest): Promise<KindRequest | undefined> {
  if (!verifiedRequest(request)) return undefined;
  const { body } = request;
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  try {
    if (request.kind === "spend") {
      const command = text(body["command"]);
      const { jobs, forecastUsd, capUsd } = body;
      if (
        command === undefined ||
        !Array.isArray(jobs) ||
        typeof forecastUsd !== "number" ||
        typeof capUsd !== "number"
      )
        return undefined;
      const shown = spendShown(request.id, {
        command,
        jobs: jobs as WorkPlan["jobs"],
        forecastUsd,
        capUsd,
      });
      return { kind: "spend", id: request.id, body, ...shown };
    }
    let rebuilt: KindRequest;
    if (
      request.kind === "pick" &&
      (body["command"] === "approve" || body["command"] === "library adopt")
    ) {
      const again =
        body["command"] === "approve"
          ? await rebuildApproveRequest(body)
          : await rebuildAdoptRequest(body);
      if (again === undefined) return undefined;
      rebuilt = again;
    } else if (request.kind === "pick") {
      const run = text(body["run"]);
      const target = text(body["target"]);
      const candidate = text(body["candidate"]);
      if (run === undefined || target === undefined) return undefined;
      rebuilt = await pickRequest({
        run,
        target,
        ...(candidate !== undefined && { candidate }),
      });
    } else {
      const importDir = text(body["import"]);
      const targetDir = text(body["target"]);
      const jitterBoundPx = body["jitterBound"];
      if (importDir === undefined || targetDir === undefined || typeof jitterBoundPx !== "number")
        return undefined;
      rebuilt = await writeRequest({
        importDir,
        grouping: request.grouping,
        targetDir,
        jitterBoundPx,
      });
    }
    return rebuilt.id === request.id ? rebuilt : undefined;
  } catch {
    return undefined;
  }
}

interface ConfirmArgs {
  id: string;
}

export const confirmCommand = defineCommand<ConfirmArgs>({
  name: "confirm",
  tool: null,
  summary: "confirm a pending spend, pick, write, command or settings request at a terminal",
  details: `Shows the request a command saved to <stateDir>/pending/<id>.json when it exited 8
confirmation_required, and asks at the terminal. A spend, pick or write request (id its digest)
writes <configDir>/confirmations/<id>.json (method terminal); a pick that names no candidate asks
which one (or none). It shows what the id hashes, rebuilt from the saved body (a spend) or by
making the pick or write request again from its run, import and grouping. A command a file names (kind command, id its hash) writes
<configDir>/approvals/<id>.json. A settings change (kind settings, id its digest) writes its fields
and their confirmedBy entries (method terminal) into the settings file it names. The request runs on the next try. CLI only; exits 2 without a TTY
on stdin and stderr, with no pending request of that id, or when the saved request (or its run,
import or grouping) no longer makes that id. Declining exits 8 confirmation_declined.`,
  input: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "the confirmation id (a request digest or command hash) from error.confirmation.id",
        placeholder: "<hex>",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  positionals: [{ name: "id" }],
  effect: { readOnly: false, spends: "never", writes: "settings" },
  async run(args, ctx) {
    if (!ctx.prompt) {
      return refusal(
        "invalid_input",
        "assetgrove confirm asks a person: run it at a terminal (stdin and stderr a TTY)",
        { id: args.id },
        "",
      );
    }
    const { stateDir, configDir } = ctx.settings;
    const pending = await readPending(stateDir, args.id);
    const decline = (request: ConfirmRequest, fields: Record<string, unknown>) =>
      refusal(
        "confirmation_declined",
        `confirmation ${request.id} was declined`,
        fields,
        describeRequest(request),
      );
    if (pending.kind === "settings") {
      const request = rebuiltSettingsRequest(pending);
      if (request === undefined) {
        return refusal(
          "invalid_input",
          `pending request ${args.id} does not describe the settings change its id hashes; rerun settings change to save it again`,
          { id: pending.id, kind: pending.kind },
          "",
        );
      }
      if (request.body.settings !== ctx.settings.path) {
        return refusal(
          "invalid_input",
          `pending settings change ${args.id} is for ${request.body.settings}, but the settings loaded are ${ctx.settings.path}`,
          { id: request.id, kind: request.kind },
          "",
        );
      }
      const fields = { id: request.id, kind: request.kind, request: request.details };
      if (!(await ctx.prompt.confirm(request))) return decline(request, fields);
      const result = await applySettingsChange(ctx.settings, request.body.change, {
        method: "terminal",
      });
      await removePending(stateDir, request.id);
      return {
        exitCode: 0,
        fields: { ...fields, confirmed: true, method: "terminal", ...result },
        human: `confirmed ${request.id}: wrote ${result.written.join(", ") || "nothing"} to ${result.path}`,
      };
    }
    if (pending.kind !== "command") {
      const request = await shownRequest(pending);
      if (request === undefined) {
        return refusal(
          "invalid_input",
          `pending request ${args.id} does not describe the request its id hashes; rerun the command to save it again`,
          { id: pending.id, kind: pending.kind },
          "",
        );
      }
      const fields = { id: request.id, kind: request.kind, request: request.details };
      let choice: string | undefined;
      if (request.kind === "pick" && typeof request.body["candidate"] !== "string") {
        if (!ctx.prompt.choose)
          return refusal("invalid_input", "this terminal cannot choose a candidate", fields, "");
        choice = await ctx.prompt.choose(request);
        if (choice === undefined || choice === "none") return decline(request, fields);
      } else if (!(await ctx.prompt.confirm(request))) return decline(request, fields);
      const record = recordOf(request, "terminal", choice === undefined ? {} : { choice });
      const path = await writeConfirmation(configDir, record);
      await removePending(stateDir, request.id);
      return {
        exitCode: 0,
        fields: {
          ...fields,
          confirmed: true,
          method: "terminal",
          record: path,
          confirmation: record,
        },
        human: `confirmed ${request.id}: wrote ${confirmationPath(configDir, request.id)}`,
      };
    }
    const request = pending;
    const fields = { id: request.id, kind: request.kind, request: request.details };
    const identity = verifiedIdentity(request.details, request.id);
    if (identity === undefined) {
      return refusal(
        "invalid_input",
        `pending request ${args.id} does not describe the command its id hashes; rerun the command to save it again`,
        { id: request.id, kind: request.kind },
        "",
      );
    }
    if (!(await ctx.prompt.confirm(request))) return decline(request, fields);
    const path = await writeApproval(configDir, identity, "terminal");
    await removePending(stateDir, request.id);
    return {
      exitCode: 0,
      fields: { ...fields, approved: true, method: "terminal", approval: path },
      human: `approved ${request.id}: wrote ${approvalPath(configDir, request.id)}`,
    };
  },
});
