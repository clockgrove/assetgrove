/**
 * Which way a generated mesh faces (#365). The route declares one facing for every model it
 * returns; a result that faces another way would be turned by the wrong yaw and rigged backwards.
 * Four free local renders of the raw mesh, at yaw 0, 90, 180 and 270, are shown to one typed choice
 * decision: which one shows the front. Its answer is the model's facing; a candidate whose
 * facing differs from the route's, or is unclear, fails with a reason instead of a rig.
 */
import type { Caller } from "../calls.ts";
import { ProviderError } from "../errors.ts";
import { encodePng } from "../image/raster.ts";
import { sha256 } from "../request.ts";
import { MODEL3D_FACING_OPERATION } from "../routes.ts";
import type { LoadedReference, Reason } from "../types.ts";
import type { Glb } from "./glb.ts";
import { renderView } from "./render.ts";
import { boundsOf, posedPrimitives } from "./scene.ts";
import type { Axis } from "./scene.ts";

/**
 * The facing each render shows as its front, by the yaw it was rendered at. Yaw 0 views a +z-facing
 * model from its front and yaw 90 a +x-facing one, as `yawBetween` and the turntable do.
 */
export const FACING_YAWS: Record<string, Axis> = {
  "0": "+z",
  "90": "+x",
  "180": "-z",
  "270": "-x",
};

export const FACING_UNCLEAR = "unclear";

export interface FacingRender extends LoadedReference {
  yawDeg: number;
}

export interface FacingJudgement {
  /** The model's facing; absent when the decision found no single front. */
  facing?: Axis;
  choice: string;
  probability?: number;
  reason: Reason;
  renders: FacingRender[];
}

/** The raw mesh from the four sides, framed alike. */
export function renderFacingViews(glb: Glb, sizePx: number): FacingRender[] {
  const framing = boundsOf(posedPrimitives(glb));
  if (!framing) throw new ProviderError("the provider returned a model with no geometry");
  return Object.keys(FACING_YAWS).map((name) => {
    const yawDeg = Number(name);
    const bytes = encodePng(renderView(glb, { sizePx, yawDeg, framing }));
    return {
      role: `raw mesh, yaw ${yawDeg}`,
      path: `(raw mesh render, yaw ${yawDeg})`,
      mediaType: "image/png",
      bytes,
      sha256: sha256(bytes),
      yawDeg,
    };
  });
}

function options(): Record<string, string> {
  const out: Record<string, string> = {};
  Object.keys(FACING_YAWS).forEach((name, i) => {
    out[name] =
      `image ${i + 1}, rendered at yaw ${name}°, shows the model's front: its head and face toward the viewer`;
  });
  out[FACING_UNCLEAR] = "no single render clearly shows the model's front";
  return out;
}

const PROMPT = [
  "The four images are renders of one 3D model of a character or creature, turned about its vertical axis: image 1 at yaw 0°, image 2 at yaw 90°, image 3 at yaw 180° and image 4 at yaw 270°.",
  "Which render shows the model's front, with its head and face toward the viewer? Judge by the face, not by the pose or the lighting.",
  "Answer unclear when no single render clearly shows the front.",
].join("\n");

/** One decision on the four renders; passes only when the answer is the route's facing. */
export async function judgeFacing(
  call: Caller,
  glb: Glb,
  routeForward: Axis,
  sizePx: number,
): Promise<FacingJudgement> {
  const renders = renderFacingViews(glb, sizePx);
  const { result, record } = await call.decide(MODEL3D_FACING_OPERATION, PROMPT, renders, {
    type: "choice",
    instructions: "Choose the render that shows the model's front, or unclear.",
    options: options(),
  });
  const choice = result.answer.type === "choice" ? result.answer.choice : undefined;
  if (choice === undefined || (!Object.hasOwn(FACING_YAWS, choice) && choice !== FACING_UNCLEAR)) {
    throw new ProviderError(`the ${MODEL3D_FACING_OPERATION} decision gave no facing`);
  }
  const probability = record.decision?.value;
  const facing = Object.hasOwn(FACING_YAWS, choice) ? FACING_YAWS[choice] : undefined;
  const passed = facing === routeForward;
  const said =
    facing === undefined
      ? "the facing decision finds no render that clearly shows the front"
      : `the facing decision answers ${facing} (yaw ${choice}${
          probability !== undefined ? `, probability ${probability.toFixed(2)}` : ""
        })`;
  const reason = passed
    ? `${said}; the model3d route faces ${routeForward}`
    : `${said}; the model3d route faces ${routeForward}, so the model was not rigged: a rig fitted to the route's facing would be backwards or sideways`;
  return {
    ...(facing !== undefined && { facing }),
    choice,
    ...(probability !== undefined && { probability }),
    reason: { check: "facing", passed, reason, source: "decision" },
    renders,
  };
}
