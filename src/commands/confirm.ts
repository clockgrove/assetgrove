import { approvalPath, writeApproval } from "../approvals.ts";
import type { CommandIdentity } from "../approvals.ts";
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
  summary: "approve a pending confirmation request at a terminal",
  details: `Shows the request a command saved to <stateDir>/pending/<id>.json when it exited 8
confirmation_required, and asks at the terminal. For a command a file names (kind command, id its
hash), an accept writes <configDir>/approvals/<id>.json (method terminal), and the command runs on
the next try. CLI only; exits 2 without a TTY on stdin and stderr, or with no pending request of
that id. Declining exits 8 confirmation_declined.`,
  input: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "the confirmation id (a command's hash) from error.confirmation.id",
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
    if (!(await ctx.prompt.confirm(request))) {
      return refusal(
        "confirmation_declined",
        `confirmation ${request.id} was declined`,
        fields,
        describeRequest(request),
      );
    }
    const d = request.details as Omit<CommandIdentity, "hash">;
    const path = await writeApproval(
      configDir,
      { kind: d.kind, argv: d.argv, cwd: d.cwd, files: d.files, hash: request.id },
      "terminal",
    );
    await removePending(stateDir, request.id);
    return {
      exitCode: 0,
      fields: { ...fields, approved: true, method: "terminal", approval: path },
      human: `approved ${request.id}: wrote ${approvalPath(configDir, request.id)}`,
    };
  },
});
