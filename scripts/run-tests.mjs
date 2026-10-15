// Runs every scripts/test-*.mjs as is and every scripts/test-*.ts after
// bundling it with esbuild into node_modules/.cache (works on Windows too).
import { build } from "esbuild";
import { mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const outDir = join("node_modules", ".cache", "figui-tests");
mkdirSync(outDir, { recursive: true });

const tests = readdirSync("scripts")
  .filter((file) => /^test-.+\.(ts|mjs)$/.test(file))
  .sort();

const failed = [];
for (const file of tests) {
  console.log(`\n> ${file}`);
  let entry = join("scripts", file);
  if (file.endsWith(".ts")) {
    const outfile = join(outDir, file.replace(/\.ts$/, ".mjs"));
    try {
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile,
        logLevel: "warning",
      });
    } catch {
      failed.push(file);
      continue;
    }
    entry = outfile;
  }
  const result = spawnSync(process.execPath, [entry], { stdio: "inherit" });
  if (result.status !== 0) failed.push(file);
}

if (failed.length) {
  console.error(`\n${failed.length} of ${tests.length} test files failed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} test files passed`);
