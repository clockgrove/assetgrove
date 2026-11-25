/** The SPDX expression parser (`spdx-expression-parse`, which ships no types) as Assetgrove uses it. */
declare module "spdx-expression-parse" {
  export interface LicenseNode {
    license: string;
    plus?: true;
    exception?: string;
  }
  export interface ConjunctionNode {
    left: LicenseNode | ConjunctionNode;
    conjunction: "and" | "or";
    right: LicenseNode | ConjunctionNode;
  }
  export type Expression = LicenseNode | ConjunctionNode;
  /** Parses an SPDX licence expression; throws on one that does not parse. */
  export default function parse(source: string): Expression;
}
