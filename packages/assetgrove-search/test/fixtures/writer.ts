/** A writer process: indexes one work tree into a store, waiting its turn for the write lock. */
import { SearchIndex } from "../../src/find.ts";
import { ScriptedEmbedder } from "../../src/scripted.ts";
import { folderLibrary } from "../helpers/library.ts";

const [dir, worktree] = process.argv.slice(2) as [string, string];
const index = await SearchIndex.open({
  dir,
  embedder: new ScriptedEmbedder(),
  library: folderLibrary(worktree),
  worktree,
});
const stats = await index.index();
index.close();
process.stdout.write(JSON.stringify(stats));
