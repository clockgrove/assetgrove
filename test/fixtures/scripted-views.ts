/**
 * A scripted reference-view model for offline 3D runs: it answers which view each reference shows
 * from `SCRIPT_REFERENCE_VIEWS`, a JSON object of reference role to view, at probability 0.9. A
 * role it does not list fails the call, so a test names every view it relies on.
 *
 * `facing` answers which way a generated 3D model faces from `SCRIPT_3D_FACING`, the yaw of the
 * render that shows its front (default "90": +x, the default Tripo route's setting), or "unclear".
 */
import type { Script } from "../../src/gateway/scripted.ts";

export const referenceView: NonNullable<Script["referenceView"]> = (request) => {
  const role = /names its role: "([^"]*)"/.exec(request.prompt)?.[1] ?? "";
  const views = JSON.parse(process.env["SCRIPT_REFERENCE_VIEWS"] ?? "{}") as Record<string, string>;
  const view = views[role];
  if (view === undefined) throw new Error(`the script has no view for the reference "${role}"`);
  return {
    answer: { type: "choice", choice: view, probabilities: { [view]: 0.9 } },
    costUsd: 0.00003,
  };
};

export const facing: NonNullable<Script["facing"]> = () => {
  const choice = process.env["SCRIPT_3D_FACING"] ?? "90";
  return {
    answer: { type: "choice", choice, probabilities: { [choice]: 0.9 } },
    costUsd: 0.00003,
  };
};
