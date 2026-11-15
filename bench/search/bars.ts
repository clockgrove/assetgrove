/** The bars, read from docs/decisions.md (the owner-confirmed record). */
import { readFile } from "node:fs/promises";

export type Op = ">=" | "<=" | "<" | "=";
export interface Bar {
  id: string;
  op: Op;
  value: number;
  unit: "" | "ms";
  where: string;
}

export const DECISIONS_URL = new URL("../../docs/decisions.md", import.meta.url);

export function parseBars(markdown: string): Bar[] {
  const bars: Bar[] = [];
  for (const line of markdown.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 6 || !/^[a-z0-9-]+$/.test(cells[1] ?? "") || cells[1] === "id") continue;
    const m = /^(>=|<=|<|=)\s*([\d.]+)\s*(%|ms)?$/.exec(cells[3] ?? "");
    if (!m) continue;
    const num = Number(m[2]);
    bars.push({
      id: cells[1] as string,
      op: m[1] as Op,
      value: m[3] === "%" ? num / 100 : num,
      unit: m[3] === "ms" ? "ms" : "",
      where: cells[4] as string,
    });
  }
  return bars;
}

export async function readBars(path: string | URL = DECISIONS_URL): Promise<Map<string, Bar>> {
  return new Map(parseBars(await readFile(path, "utf8")).map((b) => [b.id, b]));
}

export function passes(bar: Bar, measured: number): boolean {
  switch (bar.op) {
    case ">=":
      return measured >= bar.value;
    case "<=":
      return measured <= bar.value;
    case "<":
      return measured < bar.value;
    case "=":
      return measured === bar.value;
  }
}
