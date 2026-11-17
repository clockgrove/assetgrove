import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { comparisonFields, compareRasters, loadView, writeCompareSheet } from "../compare.ts";
import { InputError } from "../errors.ts";
import { parseRegions } from "../regions.ts";
import { defineCommand } from "./types.ts";

interface CompareArgs {
  before?: string;
  candidate?: string;
  region?: string[];
  frame?: number;
  view?: number;
  frameWidth?: number;
  out?: string;
}

export const compareCommand = defineCommand<CompareArgs>({
  name: "compare",
  tool: "compare",
  summary: "write a numbers-only compare sheet of a candidate against the version before",
  details: `Writes <out>/compare.png: one row with the version before, the candidate and a difference
map (black where the pixels are equal), region outlines drawn on all three, and numbers only.
Reports identical, changed (the share of all pixels) and outsideChange: the share of the figure's
pixels (those not fully transparent in either image and, on an opaque image with a one-colour
border such as a turntable render, not the border's backdrop colour in both) changed outside every --region (above 0.05
it adds the advisory reason changed_outside_region). A strip compares the
frame named by --frame (1-based; --frame-width when frames are not square), a 3D asset (its .glb,
or the directory of its turntable renders) the view named by --view.
A region is "<x,y,w,h|mask=PATH> [frame N|view N] [ref PATH]... : <note>", a box in pixels or, with
% on each value, in percent. A malformed region, or a path outside the project root, exits 2.
Free: no provider call.`,
  input: {
    type: "object",
    properties: {
      before: { type: "string", description: "the version before", placeholder: "<before>" },
      candidate: { type: "string", description: "the candidate", placeholder: "<candidate>" },
      region: {
        type: "array",
        items: { type: "string" },
        description: "a region the change is meant for",
        placeholder: "<region>",
      },
      frame: {
        type: "integer",
        minimum: 1,
        description: "the frame of a strip to compare, counted from 1",
        placeholder: "<n>",
      },
      view: {
        type: "integer",
        minimum: 1,
        description: "the view of a 3D asset to compare, counted from 1",
        placeholder: "<n>",
      },
      frameWidth: {
        type: "integer",
        minimum: 1,
        description: "the width of a strip's frames in pixels; its height by default",
        placeholder: "<px>",
      },
      out: {
        type: "string",
        description: "where compare.png is written",
        default: ".assetgrove/compare",
      },
    },
    required: ["before", "candidate"],
    additionalProperties: false,
  },
  positionals: [{ name: "before" }, { name: "candidate" }],
  effect: { readOnly: false, spends: "never", writes: "out" },
  async run(args) {
    if (args.before === undefined || args.candidate === undefined)
      throw new InputError("compare needs two addresses: the version before and the candidate");
    // Regions are parsed first: a malformed one refuses before anything is read or written.
    const regions = parseRegions(args.region ?? [], { requireNote: false }).filter(
      (r) =>
        (r.frame === undefined || r.frame === args.frame) &&
        (r.view === undefined || r.view === args.view),
    );
    const select = {
      ...(args.frame !== undefined && { frame: args.frame }),
      ...(args.view !== undefined && { view: args.view }),
      ...(args.frameWidth !== undefined && { frameWidth: args.frameWidth }),
    };
    const comparison = await compareRasters(
      await loadView(args.before, select),
      await loadView(args.candidate, select),
      regions,
    );
    const dir = resolve(args.out ?? ".assetgrove/compare");
    await mkdir(dir, { recursive: true });
    const sheet = await writeCompareSheet(dir, [{ number: 1, comparison }]);
    const numbers = comparisonFields(comparison);
    return {
      exitCode: 0,
      fields: { compareSheet: sheet, rows: [{ number: 1, candidate: args.candidate, ...numbers }] },
      human: [
        `wrote ${sheet}`,
        numbers.identical
          ? "pixel-identical"
          : `changed ${numbers.changed}, outside the regions ${numbers.outsideChange}`,
        ...numbers.reasons.map((r) => `advisory ${r.check}: ${r.reason}`),
      ].join("\n"),
    };
  },
});
