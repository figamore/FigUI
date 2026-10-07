import {
  STUDIO_API_VERSION,
  type ConfigStudioModule,
} from "./configStudioContract";

const CACHE_PREFIX = "figui.config-studio.v1:";
const MAX_ASSET_CHARS = 2_000_000;

type Assets = { script: string; style: string };

declare global {
  interface Window {
    FigUIConfigStudio?: ConfigStudioModule;
  }
}

/** Cache source text so offline loading also works on HTTP controller origins. */
export function createStudioLoader(
  buildId: string,
  baseUrl: string,
  timeoutMs = 10_000,
) {
  const cacheKey = CACHE_PREFIX + buildId;
  let pending: Promise<ConfigStudioModule> | null = null;

  function validAssets(value: unknown): value is Assets {
    if (!value || typeof value !== "object") return false;
    const { script, style } = value as Assets;
    return [script, style].every(
      (text) =>
        typeof text === "string" &&
        text.trim().length > 0 &&
        text.length <= MAX_ASSET_CHARS,
    );
  }

  function readCache(): Assets | null {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(cacheKey) ?? "null",
      );
      return validAssets(value) ? value : null;
    } catch {
      return null;
    }
  }

  function clearCache() {
    try {
      localStorage.removeItem(cacheKey);
    } catch {
      /* Storage is optional. */
    }
  }

  function saveCache(assets: Assets) {
    try {
      localStorage.setItem(cacheKey, JSON.stringify(assets));
    } catch {
      // A quota or privacy restriction must not prevent online use.
    }
  }

  async function download(): Promise<Assets> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const fetchText = async (name: string) => {
        const response = await fetch(
          `${baseUrl}${buildId}/config-studio.${name}`,
          {
            signal: controller.signal,
            credentials: "omit",
          },
        );
        if (!response.ok)
          throw new Error(`Download failed (${response.status}).`);
        return response.text();
      };
      const [script, style] = await Promise.all([
        fetchText("js"),
        fetchText("css"),
      ]);
      const assets = { script, style };
      if (!validAssets(assets))
        throw new Error("Invalid Config Studio download.");
      return assets;
    } catch {
      throw new Error(
        "Could not download Config Studio. Connect to the Internet and retry. You can still edit the file in YAML view.",
      );
    } finally {
      window.clearTimeout(timer);
      controller.abort();
    }
  }

  function install(assets: Assets): Promise<ConfigStudioModule> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(
        new Blob([assets.script], { type: "text/javascript" }),
      );
      const script = document.createElement("script");
      const cleanup = () => {
        window.clearTimeout(timer);
        URL.revokeObjectURL(url);
        script.remove();
        script.onload = script.onerror = null;
      };
      const fail = () => {
        cleanup();
        delete window.FigUIConfigStudio;
        reject(
          new Error(
            "Could not start Config Studio. Retry to download a fresh copy.",
          ),
        );
      };
      const timer = window.setTimeout(fail, timeoutMs);
      // Never accept a stale global left by a failed or incompatible script.
      delete window.FigUIConfigStudio;
      script.src = url;
      script.onload = () => {
        const studio = window.FigUIConfigStudio;
        if (
          studio?.apiVersion !== STUDIO_API_VERSION ||
          studio.buildId !== buildId ||
          typeof studio.mount !== "function"
        ) {
          fail();
          return;
        }
        cleanup();
        let style = document.querySelector<HTMLStyleElement>(
          "style[data-figui-config-studio]",
        );
        if (!style) {
          style = document.createElement("style");
          style.dataset.figuiConfigStudio = "";
          document.head.appendChild(style);
        }
        style.textContent = assets.style;
        resolve(studio);
      };
      script.onerror = fail;
      document.head.appendChild(script);
    });
  }

  return function load(): Promise<ConfigStudioModule> {
    if (pending) return pending;
    pending = (async () => {
      const cached = readCache();
      if (cached) {
        try {
          return await install(cached);
        } catch {
          clearCache();
        }
      }
      const assets = await download();
      const studio = await install(assets);
      saveCache(assets);
      return studio;
    })().catch((error: unknown) => {
      pending = null; // Retry and reopening both recover after network failure.
      throw error;
    });
    return pending;
  };
}

const loadRemote = createStudioLoader(
  __CONFIG_STUDIO_BUILD__,
  "https://figamore.github.io/FigUI/config-studio/",
);

export function loadConfigStudio(): Promise<ConfigStudioModule> {
  // Vite removes this branch (including Studio's code and CSS) in production.
  if (import.meta.env.DEV) return import("../config-studio");
  return loadRemote();
}
