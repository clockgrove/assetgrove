/**
 * The release gate of a delivery (issue #479): what each selected version must meet before a
 * release delivery writes it. A version a person marked as a placeholder never passes. A target
 * profile's `release` section can also require an approved version (`requireApproval`) and list
 * licence windows (`licenseWindows`) the delivery date, the calendar date in its `timeZone`, must
 * fall inside for the licences they name. The card's licence is parsed as an SPDX expression and
 * fails closed: no licence or one that does not parse is refused, an `AND` needs every component
 * to pass and an `OR` one alternative; a licence id no window names passes. Every check is a finding with its status and the evidence it was decided on, so a preview
 * or a draft reports the same facts a release refuses on. Nothing here approves anything.
 */
import { z } from "zod";
import parseLicense from "spdx-expression-parse";
import type { Expression, LicenseNode } from "spdx-expression-parse";
import { InputError } from "./errors.ts";
import { placeholderMarks, targetVersion, versionStatus } from "./library/review.ts";
import type { ReviewRecord, VersionStatus } from "./library/review.ts";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, "is not a calendar date");

const licenseWindowSchema = z
  .strictObject({ license: z.string().min(1), from: isoDate.optional(), until: isoDate.optional() })
  .refine((w) => w.from === undefined || w.until === undefined || w.from <= w.until, {
    message: "from must be on or before until",
  });

/** An IANA time zone name, as `Intl.DateTimeFormat` accepts it. */
const timeZoneSchema = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, "is not an IANA time zone name");

export const releasePolicySchema = z
  .strictObject({
    requireApproval: z.boolean().optional(),
    /** The zone whose calendar date licence windows are checked on; required with them. */
    timeZone: timeZoneSchema.optional(),
    licenseWindows: z.array(licenseWindowSchema).optional(),
  })
  .refine((policy) => policy.licenseWindows === undefined || policy.timeZone !== undefined, {
    message: "is required when licenseWindows is set (an IANA time zone name)",
    path: ["timeZone"],
  });

/** A target profile's `release` section. */
export type ReleasePolicy = z.infer<typeof releasePolicySchema>;
export type LicenseWindow = z.infer<typeof licenseWindowSchema>;

export type ReleaseCheck = "placeholder" | "approval" | "license-window";

export type ReleaseEvidence =
  | { check: "placeholder"; marks: Array<{ annotation: string; created: string }> }
  | {
      check: "approval";
      state: VersionStatus;
      assessment?: { annotation: string; action: string; created: string };
    }
  | {
      check: "license-window";
      /** The card's `license`; null when the card has none, which fails. */
      license: string | null;
      /** The policy's `timeZone` and the calendar date in it the windows were checked on. */
      timeZone: string;
      date: string;
      /** The windows that name a licence of the expression, and those the date is outside. */
      windows: LicenseWindow[];
      outside: LicenseWindow[];
      /** The licence ids of the expression that no window names, so no window applies to them. */
      unnamed: string[];
      /** For each `OR` that passed, the alternative that passed. */
      alternatives: string[];
      /** Why the licence was refused without a window: no licence, or the parse error. */
      error?: string;
    };

export interface ReleaseFinding {
  /** The 0-based index of the selection item. */
  item: number;
  asset: string;
  version: number;
  sha256: string;
  check: ReleaseCheck;
  status: "passed" | "failed";
  message: string;
  evidence: ReleaseEvidence;
}

export interface ReleaseSubject {
  item: number;
  asset: string;
  /** The version's position in the stack. */
  version: number;
  sha256: string;
  record: ReviewRecord;
  /** The asset card's front matter; its `license` is the asset's declared licence. */
  card: Record<string, unknown>;
}

/** The calendar date (`YYYY-MM-DD`) in `timeZone` at `now`, as licence windows are written. */
export function releaseDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const windowText = (w: LicenseWindow) =>
  `${w.license} ${w.from ?? "(open)"} to ${w.until ?? "(open)"}`;

/** The release checks of one selected version: placeholder always, the others as `policy` asks. */
export function evaluateRelease(
  subject: ReleaseSubject,
  policy: ReleasePolicy | undefined,
  now: Date,
): ReleaseFinding[] {
  const { item, asset, version, sha256, record } = subject;
  const which = `${asset} version ${version} (${sha256})`;
  const finding = (
    status: ReleaseFinding["status"],
    message: string,
    evidence: ReleaseEvidence,
  ): ReleaseFinding => ({
    item,
    asset,
    version,
    sha256,
    check: evidence.check,
    status,
    message,
    evidence,
  });
  const findings: ReleaseFinding[] = [];

  const marks = placeholderMarks(record, sha256).map((a) => ({
    annotation: a.id,
    created: a.created,
  }));
  findings.push(
    marks.length > 0
      ? finding(
          "failed",
          `${which} is a placeholder: marked by ${marks.map((m) => `${m.annotation} at ${m.created}`).join(", ")}`,
          { check: "placeholder", marks },
        )
      : finding("passed", `${which} is not marked as a placeholder`, {
          check: "placeholder",
          marks,
        }),
  );

  if (policy?.requireApproval === true) {
    const state = versionStatus(record, sha256);
    const latest = record.annotations
      .filter((a) => a.motivation === "assessing" && targetVersion(a) === sha256)
      .at(-1);
    const assessment = latest && {
      annotation: latest.id,
      action: String(latest["ag:action"]),
      created: latest.created,
    };
    const decided = assessment
      ? `${assessment.action} by ${assessment.annotation} at ${assessment.created}`
      : "no approval or rejection is recorded";
    findings.push(
      finding(
        state === "approved" ? "passed" : "failed",
        state === "approved"
          ? `${which} is approved: ${decided}`
          : `${which} is not approved (state ${state}): ${decided}; the project policy requires an approved version`,
        { check: "approval", state, ...(assessment && { assessment }) },
      ),
    );
  }

  const windows = policy?.licenseWindows ?? [];
  if (windows.length > 0) {
    findings.push(licenseWindowFinding(subject, which, windows, policy?.timeZone, now, finding));
  }
  return findings;
}

type Finding = (
  status: ReleaseFinding["status"],
  message: string,
  evidence: ReleaseEvidence,
) => ReleaseFinding;

const leafText = (node: LicenseNode) =>
  `${node.license}${node.plus === true ? "+" : ""}${node.exception === undefined ? "" : ` WITH ${node.exception}`}`;

/** An expression written back as SPDX text, with parentheses around nested conjunctions. */
function expressionText(node: Expression, nested = false): string {
  if ("license" in node) return leafText(node);
  const text = `${expressionText(node.left, true)} ${node.conjunction.toUpperCase()} ${expressionText(node.right, true)}`;
  return nested ? `(${text})` : text;
}

/** The licence-window check of one version, on the calendar date in the policy's `timeZone`. */
function licenseWindowFinding(
  subject: ReleaseSubject,
  which: string,
  windows: LicenseWindow[],
  timeZone: string | undefined,
  now: Date,
  finding: Finding,
): ReleaseFinding {
  if (timeZone === undefined) {
    throw new InputError("release.timeZone is required when release.licenseWindows is set");
  }
  const date = releaseDate(now, timeZone);
  const declared = subject.card["license"];
  const license = typeof declared === "string" && declared.trim() !== "" ? declared : null;
  const base = { check: "license-window" as const, license, timeZone, date };
  const empty = { windows: [], outside: [], unnamed: [], alternatives: [] };
  if (license === null) {
    return finding(
      "failed",
      `${which}: no licence on the card, so its licence windows cannot be checked`,
      {
        ...base,
        ...empty,
        error: "no licence on the card",
      },
    );
  }
  let expression: Expression;
  try {
    expression = parseLicense(license);
  } catch (error) {
    // The parser throws a TypeError, not a message, on an expression that ends too early.
    const reason =
      error instanceof TypeError ? "the expression ends early" : (error as Error).message;
    return finding(
      "failed",
      `${which} is licensed "${license}", which is not an SPDX expression: ${reason}`,
      { ...base, ...empty, error: reason },
    );
  }

  const applicable: LicenseWindow[] = [];
  const outside: LicenseWindow[] = [];
  const unnamed: string[] = [];
  const alternatives: string[] = [];
  const isOutside = (w: LicenseWindow) =>
    (w.from !== undefined && date < w.from) || (w.until !== undefined && date > w.until);
  const add = <T>(list: T[], value: T) => {
    if (!list.includes(value)) list.push(value);
  };
  const passes = (node: Expression): boolean => {
    if ("license" in node) {
      const named = windows.filter(
        (w) => w.license === node.license || w.license === leafText(node),
      );
      if (named.length === 0) {
        add(unnamed, leafText(node));
        return true;
      }
      for (const w of named) add(applicable, w);
      const failed = named.filter(isOutside);
      for (const w of failed) add(outside, w);
      return failed.length === 0;
    }
    const left = passes(node.left);
    const right = passes(node.right);
    if (node.conjunction === "and") return left && right;
    if (left) alternatives.push(expressionText(node.left));
    else if (right) alternatives.push(expressionText(node.right));
    return left || right;
  };
  const passed = passes(expression);
  const evidence: ReleaseEvidence = {
    ...base,
    windows: applicable,
    outside,
    unnamed,
    alternatives,
  };
  const notes = [
    ...(alternatives.length > 0 ? [`passed through ${alternatives.join(" and ")}`] : []),
    ...(unnamed.length > 0 ? [`no licence window names ${unnamed.join(", ")}`] : []),
  ];
  const on = `on ${date} (${timeZone})`;
  let message: string;
  if (!passed) {
    message = `${which} is licensed ${license}, outside ${outside
      .map(
        (w) =>
          `${windowText(w)} (${w.until !== undefined && date > w.until ? "expired" : "not yet open"})`,
      )
      .join(" and ")} ${on}`;
  } else if (applicable.length === 0) {
    message = `${which} is licensed ${license}, which no licence window names, so none applies ${on}`;
  } else {
    const inside = applicable.filter((w) => !isOutside(w));
    message =
      inside.length > 0
        ? `${which} is licensed ${license}, inside ${inside.map(windowText).join(" and ")} ${on}`
        : `${which} is licensed ${license} ${on}`;
  }
  if (notes.length > 0 && applicable.length > 0) message += `; ${notes.join("; ")}`;
  return finding(passed ? "passed" : "failed", message, evidence);
}
