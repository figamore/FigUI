import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import { configStudioBuildId } from "./scripts/config-studio-build-id.mjs";

const buildId = configStudioBuildId();

export default defineConfig({
  define: { __CONFIG_STUDIO_BUILD__: JSON.stringify(buildId) },
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
      "react-dom/client": "preact/compat/client",
      "react/jsx-runtime": "preact/jsx-runtime",
      "lucide-react": fileURLToPath(
        new URL("./src/icons.tsx", import.meta.url),
      ),
    },
  },
  plugins: [react()],
  build: {
    outDir: `dist/config-studio/${buildId}`,
    target: "es2022",
    cssTarget: "chrome61",
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: "src/config-studio.tsx",
      name: "FigUIConfigStudio",
      formats: ["iife"],
      fileName: () => "config-studio.js",
    },
    rollupOptions: {
      output: {
        assetFileNames: "config-studio.[ext]",
      },
    },
  },
});
