import { approvalPath, verifiedIdentity, writeApproval } from "../approvals.ts";
import {
  confirmationPath,
  recordOf,
  verifiedRequest,
  writeConfirmation,
} from "../confirm/index.ts";
import { readPending, removePending } from "../confirm/pending.ts";
import { describeRequest } from "../confirm/prompt.ts";
import { refusal } from "./result.ts";
import { defineCommand } from "./types.ts";

interface ConfirmArgs {
  id: string;
}

export const confirmCommand = defineCommand<ConfirmArgs>({
  name: "confirm",
  tool: null,
  summary: "confirm a pending spend, pick, write or command request at a terminal",
  details: `Shows the request a command saved to <stateDir>/pending/<id>.json when it exited 8
confirmation_required, and asks at the terminal. A spend, pick or write request (id its digest)
writes <configDir>/confirmations/<id>.json (method terminal); a pick that names no candidate asks
which one (or none). A command a file names (kind command, id its hash) writes
<configDir>/approvals/<id>.json. The request runs on the next try. CLI only; exits 2 without a TTY
on stdin and stderr, with no pending request of that id, or when the saved request does not hash
to that id. Declining exits 8 confirmation_declined.`,
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
    const request = await readPending(stateDir, args.id);
    const fields = { id: request.id, kind: request.kind, request: request.details };
    const decline = () =>
      refusal(
        "confirmation_declined",
        `confirmation ${request.id} was declined`,
        fields,
        describeRequest(request),
      );
    if (request.kind !== "command") {
      if (!verifiedRequest(request)) {
        return refusal(
          "invalid_input",
          `pending request ${args.id} does not describe the request its id hashes; rerun the command to save it again`,
          fields,
          "",
        );
      }
      let choice: string | undefined;
      if (request.kind === "pick" && typeof request.body["candidate"] !== "string") {
        if (!ctx.prompt.choose)
          return refusal("invalid_input", "this terminal cannot choose a candidate", fields, "");
        choice = await ctx.prompt.choose(request);
        if (choice === undefined || choice === "none") return decline();
      } else if (!(await ctx.prompt.confirm(request))) return decline();
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
    const identity = verifiedIdentity(request.details, request.id);
    if (identity === undefined) {
      return refusal(
        "invalid_input",
        `pending request ${args.id} does not describe the command its id hashes; rerun the command to save it again`,
        fields,
        "",
      );
    }
    if (!(await ctx.prompt.confirm(request))) return decline();
    const path = await writeApproval(configDir, identity, "terminal");
    await removePending(stateDir, request.id);
    return {
      exitCode: 0,
      fields: { ...fields, approved: true, method: "terminal", approval: path },
      human: `approved ${request.id}: wrote ${approvalPath(configDir, request.id)}`,
    };
  },
});
