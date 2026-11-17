import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { enabledLanguages } from "./languages.mjs";

// Include every input to the standalone bundle. Keep this list in step with
// Studio's imports; changing host-only code need not invalidate offline copies.
export function configStudioBuildId(locale = process.env.VITE_FIGUI_LOCALE || "en") {
  const languages = enabledLanguages();
  if (!languages.some(language => language.code === locale)) throw new Error(`Unsupported Studio locale: ${locale}`);
  const files = [
    "src/config-studio.tsx",
    "src/config-studio.css",
    "src/components/ConfigStudio.tsx",
    "src/lib/configStudioContract.ts",
    "src/lib/configValidation.ts",
    "src/lib/i18n.ts",
    "locales/languages.json",
    ...languages.flatMap(language => [`locales/${language.code}.json`, `locales/plurals.${language.code}.json`]),
    "scripts/languages.mjs",
    "scripts/translate-jsx.mjs",
    "src/lib/fluidSchema.ts",
    "src/icons.tsx",
    "tailwind.config.js",
    "tailwind.config.studio.js",
    "postcss.config.js",
    "vite.config.studio.ts",
    "scripts/config-studio-build-id.mjs",
    "package-lock.json",
  ];
  const hash = createHash("sha256");
  hash.update(`locale:${locale}\0`);
  for (const file of files) {
    hash.update(file + "\0");
    hash.update(readFileSync(new URL("../" + file, import.meta.url)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 24);
}
