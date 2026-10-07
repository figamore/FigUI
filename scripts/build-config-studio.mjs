import { execFileSync } from "node:child_process";

execFileSync(process.execPath, ["scripts/generate-icons.mjs"], {
  stdio: "inherit",
});
execFileSync("npx", ["tsc"], { stdio: "inherit" });
execFileSync("npx", ["vite", "build", "--config", "vite.config.studio.ts"], {
  stdio: "inherit",
});
