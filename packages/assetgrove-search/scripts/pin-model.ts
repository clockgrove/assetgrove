/**
 * Pins the model: resolves the Hugging Face commit of `main`, downloads each manifest file at
 * that commit and writes its sha256 into src/model-manifest.json. Run where Hugging Face is
 * reachable; review the diff before committing.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../src/model-manifest.json", import.meta.url);
const manifest = JSON.parse(await readFile(path, "utf8"));
const info = (await (
  await fetch(`${manifest.primaryBase}/api/models/${manifest.repo}`)
).json()) as { sha: string };
manifest.revision = info.sha;
for (const f of manifest.files) {
  const res = await fetch(`${manifest.primaryBase}/${manifest.repo}/resolve/${info.sha}/${f.path}`);
  if (!res.ok) throw new Error(`${f.path}: ${res.status}`);
  f.sha256 = createHash("sha256")
    .update(Buffer.from(await res.arrayBuffer()))
    .digest("hex");
  console.log(f.path, f.sha256);
}
await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
