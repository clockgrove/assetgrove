/**
 * The typed per-call parameters a kind may pass on an image call (#416): output size, tiling and
 * a palette file. Core validates them, checks the palette with the reference-path rule and hashes
 * it, records them in provenance and puts them in the call key and the request digest; with none
 * passed, both are byte-identical to a call that never knew of them. The serving adapter maps them
 * to its API, and one that does not declare a passed parameter is refused before any spend.
 */
import { InputError } from "./errors.ts";

/** Every typed per-call parameter, in the order core names them. */
export const CALL_PARAMETERS = ["size", "tiling", "palette"] as const;

export type CallParameterName = (typeof CALL_PARAMETERS)[number];

/** What a kind passes on one call. */
export interface CallParameters {
  /** The output's size in pixels. */
  size?: { width: number; height: number };
  /** Whether the output tiles seamlessly across its x and y edges. */
  tiling?: { x: boolean; y: boolean };
  /**
   * A palette file: `path`, `/`-separated, relative to `dir` (the spec's, bible's or profile's
   * directory). It must resolve inside `dir`'s project root, like any bible reference.
   */
  palette?: { path: string; dir: string };
}

/** The parameters as the call key, the provenance record and the adapter see the palette: by path and hash. */
export interface KeyedCallParameters {
  size?: { width: number; height: number };
  tiling?: { x: boolean; y: boolean };
  palette?: { path: string; sha256: string };
}

/** The parameters as the request digest carries them: the palette by its path (planning reads no file). */
export interface PlannedCallParameters {
  size?: { width: number; height: number };
  tiling?: { x: boolean; y: boolean };
  palette?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The names of the parameters `parameters` passes, after checking each one's type. Throws
 * `InputError` (exit 2 `invalid_input`) naming the parameter for an unknown or malformed one.
 */
export function checkCallParameters(parameters: unknown, operation: string): CallParameterName[] {
  if (parameters === undefined) return [];
  const what = `the ${operation} call's parameters`;
  if (!isRecord(parameters)) throw new InputError(`${what} must be an object`);
  const passed: CallParameterName[] = [];
  for (const [name, value] of Object.entries(parameters)) {
    if (value === undefined) continue;
    if (!(CALL_PARAMETERS as readonly string[]).includes(name))
      throw new InputError(
        `${what} name "${name}", which is not a typed parameter (known: ${CALL_PARAMETERS.join(", ")})`,
      );
    if (name === "size") {
      const ok =
        isRecord(value) &&
        Number.isInteger(value["width"]) &&
        Number.isInteger(value["height"]) &&
        (value["width"] as number) > 0 &&
        (value["height"] as number) > 0;
      if (!ok)
        throw new InputError(`${what}: size must be {width, height} in whole pixels above 0`);
    } else if (name === "tiling") {
      if (!isRecord(value) || typeof value["x"] !== "boolean" || typeof value["y"] !== "boolean")
        throw new InputError(`${what}: tiling must be {x, y}, each true or false`);
    } else {
      if (
        !isRecord(value) ||
        typeof value["path"] !== "string" ||
        value["path"] === "" ||
        typeof value["dir"] !== "string"
      )
        throw new InputError(
          `${what}: palette must be {path, dir}, a file path and the directory it is relative to`,
        );
      if (value["path"].includes("\\"))
        throw new InputError(`${what}: palette path "${value["path"]}" must use "/" separators`);
    }
    passed.push(name as CallParameterName);
  }
  return passed;
}

/** The planned form of `parameters`, or undefined when none is passed (so a digest stays as it was). */
export function plannedCallParameters(
  parameters: CallParameters | undefined,
): PlannedCallParameters | undefined {
  if (parameters === undefined) return undefined;
  const planned: PlannedCallParameters = {
    ...(parameters.size !== undefined && { size: { ...parameters.size } }),
    ...(parameters.tiling !== undefined && { tiling: { ...parameters.tiling } }),
    ...(parameters.palette !== undefined && { palette: parameters.palette.path }),
  };
  return Object.keys(planned).length === 0 ? undefined : planned;
}
