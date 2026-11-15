import { describeForPerson, hashIdentity, writeApproval } from "../approvals.ts";
import type { CommandIdentity } from "../approvals.ts";
import { processTty } from "../confirm/prompt.ts";
import { readPending, removePending } from "../confirm/pending.ts";
import { InputError } from "../errors.ts";
import { refusal } from "./result.ts";
import { defineCommand } from "./types.ts";

interface ConfirmArgs {
  id?: string;
}

export const confirmCommand = defineCommand<ConfirmArgs>({
  name: "confirm",
  tool: null,
  summary: "approve a command that exited 8 confirmation_required",
  details: `Shows the command a pending confirmation request saved, asks a person to approve it on
this terminal, and writes the approval (method terminal) to <configDir>/approvals/<hex>.json. The
id is the hex in the request's confirmCommand. Needs a terminal (exit 2 without one). Declining
exits 8 confirmation_declined.`,
  input: {
    type: "object",
    properties: {
      id: { type: "string", description: "the pending confirmation's id", placeholder: "<id>" },
    },
    additionalProperties: false,
  },
  positionals: [{ name: "id" }],
  effect: { readOnly: false, spends: "never", writes: "settings" },
  confirm: "command",
  async run(args, ctx) {
    if (args.id === undefined) throw new InputError("missing the id of the pending confirmation");
    const tty = ctx.tty ?? processTty();
    if (!tty.interactive) throw new InputError("confirm needs a terminal");
    const request = readPending(ctx.settings.stateDir, args.id);
    if (request.kind !== "command") {
      throw new InputError(
        `pending confirmation ${args.id} is a ${request.kind}; confirm approves commands only`,
      );
    }
    const command = request.command as CommandIdentity;
    // The request must describe exactly the command its id names.
    if (command?.hash !== args.id || hashIdentity(command) !== args.id) {
      throw new InputError(`pending confirmation ${args.id} does not match the command it holds`);
    }
    if (!(await tty.ask(describeForPerson(command), "Approve this command?"))) {
      return refusal(
        "confirmation_declined",
        `the command was not approved (${args.id})`,
        { id: args.id, kind: request.kind },
        "not approved",
      );
    }
    const approvalPath = writeApproval(ctx.settings, command, "terminal");
    removePending(ctx.settings.stateDir, args.id);
    return {
      exitCode: 0,
      fields: { id: args.id, kind: request.kind, approvalPath, command },
      human: `approved ${command.hash}: ${approvalPath}`,
    };
  },
});
