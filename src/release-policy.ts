/**
 * The release gate of a delivery (issue #479): what each selected version must meet before a
 * release delivery writes it. A version a person marked as a placeholder never passes. A target
 * profile's `release` section can also require an approved version (`requireApproval`) and list
 * licence windows (`licenseWindows`) the delivery date must fall inside for the licences they
 * name. Every check is a finding with its status and the evidence it was decided on, so a preview
 * or a draft reports the same facts a release refuses on. Nothing here approves anything.
 */
import { z } from "zod";
import { licenseComponents } from "./license.ts";
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

export const releasePolicySchema = z.strictObject({
  requireApproval: z.boolean().optional(),
  licenseWindows: z.array(licenseWindowSchema).optional(),
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
      license: string | null;
      date: string;
      windows: LicenseWindow[];
      outside: LicenseWindow[];
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

/** The UTC calendar date of `now`, as licence windows are written. */
export function releaseDate(now: Date): string {
  return now.toISOString().slice(0, 10);
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
    const date = releaseDate(now);
    const declared = subject.card["license"];
    const license = typeof declared === "string" && declared.trim() !== "" ? declared : null;
    const components = license === null ? [] : licenseComponents(license);
    const applicable = windows.filter((w) => components.includes(w.license));
    const outside = applicable.filter(
      (w) => (w.from !== undefined && date < w.from) || (w.until !== undefined && date > w.until),
    );
    const evidence: ReleaseEvidence = {
      check: "license-window",
      license,
      date,
      windows: applicable,
      outside,
    };
    let message: string;
    if (license === null) message = `${which} declares no licence, so no licence window applies`;
    else if (applicable.length === 0)
      message = `${which} is licensed ${license}, which no licence window names`;
    else if (outside.length === 0)
      message = `${which} is licensed ${license}, inside ${applicable.map(windowText).join(" and ")} on ${date}`;
    else
      message = `${which} is licensed ${license}, outside ${outside
        .map(
          (w) =>
            `${windowText(w)} (${w.until !== undefined && date > w.until ? "expired" : "not yet open"})`,
        )
        .join(" and ")} on ${date}`;
    findings.push(finding(outside.length > 0 ? "failed" : "passed", message, evidence));
  }
  return findings;
}
