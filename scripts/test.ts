// The offline suite: `pnpm test` runs every test/**/*.test.ts; `pnpm test <file>...` runs only the
// files named. Pendulum's validation names this command, and a reviewer reply's test field appends
// one test file to it, so a finding is settled by running that file.
import { spawnSync } from "node:child_process";

const files = process.argv.slice(2);
const run = spawnSync(
  process.execPath,
  ["--test", ...(files.length > 0 ? files : ["test/**/*.test.ts"])],
  {
    stdio: "inherit",
  },
);
process.exit(run.status ?? 1);
