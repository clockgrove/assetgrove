import { z } from "zod";

const declarationSchema = z.strictObject({
  statement: z.string().min(1),
  evidence: z.string().min(1),
});

export const modelDeclarationsSchema = z.strictObject({
  source: declarationSchema.optional(),
  trainingData: declarationSchema.optional(),
});

export type ModelDeclarations = z.infer<typeof modelDeclarationsSchema>;
export type ModelDeclarationFact =
  { status: "unknown" } | ({ status: "documented" } & z.infer<typeof declarationSchema>);
export interface ModelDeclarationRecord {
  source: ModelDeclarationFact;
  trainingData: ModelDeclarationFact;
}

/** These are supplied claims, not verification or a grant of output rights. */
export function modelDeclarationRecord(declarations?: ModelDeclarations): ModelDeclarationRecord {
  const fact = (value: ModelDeclarations["source"]): ModelDeclarationFact =>
    value === undefined ? { status: "unknown" } : { status: "documented", ...value };
  return { source: fact(declarations?.source), trainingData: fact(declarations?.trainingData) };
}
