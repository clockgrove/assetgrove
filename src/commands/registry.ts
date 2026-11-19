import { animationQaCommand } from "./animation-qa.ts";
import { applyCommand } from "./apply.ts";
import { approveCommand, reviewCommand } from "./review.ts";
import { cardAcceptCommand, cardDescribeCommand, cardEditCommand } from "./card.ts";
import { auditCommand } from "./audit.ts";
import { bibleCommand } from "./bible.ts";
import { catCommand, lsCommand } from "./browse.ts";
import { compareCommand } from "./compare.ts";
import { confirmCommand } from "./confirm.ts";
import { disclosureCommand } from "./disclosure.ts";
import { estimateCommand } from "./estimate.ts";
import { extensionsCommand, extensionsSetupCommand } from "./extensions.ts";
import { fixFrameCommand } from "./fix-frame.ts";
import { generateSheetCommand } from "./generate-sheet.ts";
import { identityCheckCommand } from "./identity-check.ts";
import { identityEvalCommand } from "./identity-eval.ts";
import { importCommand } from "./import.ts";
import { initCommand } from "./init.ts";
import {
  libraryAdoptCommand,
  libraryCheckCommand,
  libraryDriftCommand,
  libraryJudgeStaleCommand,
  libraryRebuildCommand,
  libraryStatsCommand,
  libraryRelationsCommand,
} from "./library.ts";
import { libraryLabelsCommand } from "./labels.ts";
import { lodCommand } from "./lod.ts";
import { lookDevCommand } from "./look-dev.ts";
import { materialsCommand } from "./materials.ts";
import { mcpCommand } from "./mcp.ts";
import { migrateCommand } from "./migrate.ts";
import { opCommand } from "./op.ts";
import { opsCommand } from "./ops.ts";
import { pickCommand } from "./pick.ts";
import { planCommand } from "./plan.ts";
import { recipeCommand } from "./recipe.ts";
import { rigCommand } from "./rig.ts";
import { runsListCommand, runsShowCommand } from "./runs.ts";
import { settingsChangeCommand, settingsCommand } from "./settings.ts";
import { spendCommand, spendReconcileCommand } from "./spend.ts";
import { findCommand, searchIndexCommand, searchStatusCommand } from "./search.ts";
import { requestChangeCommand } from "./request-change.ts";
import { stageCommand } from "./stage.ts";
import type { CommandSpec } from "./types.ts";
import { varyCommand } from "./vary.ts";
import { writeFamiliesCommand } from "./write-families.ts";

/** Every command, declared once, in the order help lists them. */
export const commands: readonly CommandSpec[] = [
  initCommand,
  bibleCommand,
  planCommand,
  applyCommand,
  mcpCommand,
  materialsCommand,
  stageCommand,
  pickCommand,
  reviewCommand,
  approveCommand,
  cardDescribeCommand,
  cardAcceptCommand,
  cardEditCommand,
  rigCommand,
  lodCommand,
  lookDevCommand,
  importCommand,
  generateSheetCommand,
  writeFamiliesCommand,
  identityEvalCommand,
  identityCheckCommand,
  animationQaCommand,
  fixFrameCommand,
  compareCommand,
  varyCommand,
  auditCommand,
  requestChangeCommand,
  opCommand,
  recipeCommand,
  opsCommand,
  migrateCommand,
  libraryCheckCommand,
  libraryRebuildCommand,
  libraryStatsCommand,
  libraryRelationsCommand,
  libraryDriftCommand,
  libraryJudgeStaleCommand,
  libraryAdoptCommand,
  libraryLabelsCommand,
  settingsCommand,
  settingsChangeCommand,
  extensionsCommand,
  extensionsSetupCommand,
  spendCommand,
  spendReconcileCommand,
  runsListCommand,
  runsShowCommand,
  lsCommand,
  catCommand,
  findCommand,
  searchIndexCommand,
  searchStatusCommand,
  estimateCommand,
  disclosureCommand,
  confirmCommand,
];

/** The name of every registry command. */
export const commandNames: readonly string[] = commands.map((c) => c.name);
