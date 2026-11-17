import { execFileSync } from "node:child_process";
import { enabledLanguages } from "./languages.mjs";

execFileSync(process.execPath, ["scripts/generate-icons.mjs"], {
  stdio: "inherit",
});
execFileSync("npx", ["tsc"], { stdio: "inherit" });
for (const { code: locale } of enabledLanguages()) {
  execFileSync("npx", ["vite", "build", "--config", "vite.config.studio.ts"], {
    stdio: "inherit",
    env: { ...process.env, VITE_FIGUI_LOCALE: locale },
  });
}
