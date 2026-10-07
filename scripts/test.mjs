import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const temporary = mkdtempSync(path.join(tmpdir(), "oddshot-tests-"));
const tests = readdirSync(path.join(root, "tests")).filter(name => name.endsWith(".test.ts"));
const moduleTests = readdirSync(path.join(root, "tests")).filter(name => name.endsWith(".test.mjs"));
let exitCode = 1;
try {
  const compilation = spawnSync(process.execPath, [
    path.join(root, "node_modules/typescript/bin/tsc"),
    "--target", "ES2022", "--module", "commonjs", "--moduleResolution", "node",
    "--esModuleInterop", "--strict", "--skipLibCheck", "--noEmit", "false",
    "--outDir", temporary, ...tests.map(name => path.join(root, "tests", name)),
  ], { cwd: root, stdio: "inherit" });
  if (compilation.status === 0) {
    const run = spawnSync(process.execPath, ["--test", ...tests.map(name => path.join(temporary, "tests", name.replace(/\.ts$/, ".js"))), ...moduleTests.map(name => path.join(root, "tests", name))], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ODDSHOT_STORAGE_MODE: "sqlite", ODDSHOT_SCORING_MODE: "demo", OPENAI_API_KEY: "" },
    });
    exitCode = run.status ?? 1;
  } else {
    exitCode = compilation.status ?? 1;
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
process.exitCode = exitCode;
