/**
 * Test-only: runs `body` with the clearance of a confirmed spend outside any run directory, for a
 * test or real check that drives a paid `Caller` itself. The request is confirmed exactly as the
 * executor confirms a run (`requireConfirmation`: headless settings, its record, else exit 8),
 * and nothing is journaled. Only the run executor builds a clearance in src/ (design section 7).
 */
import { requireConfirmation } from "../../src/confirm/index.ts";
import type { ConfirmGate, KindRequest } from "../../src/confirm/index.ts";
import { withRunScope } from "../../src/runs/journal.ts";

export async function withConfirmedSpend<T>(
  request: KindRequest & { kind: "spend" },
  gate: ConfirmGate,
  body: () => Promise<T>,
): Promise<T> {
  const record = await requireConfirmation(request, gate);
  return withRunScope({ clearance: { digest: request.id, record } }, body);
}
