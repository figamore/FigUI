import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArchive,
  prepareStudioPages,
} from "./prepare-config-studio-pages.mjs";

const buildId = "a".repeat(24);
const cacheKey = "figui.config-studio.v1:" + buildId;
const script = `window.FigUIConfigStudio = { apiVersion: 1, buildId: '${buildId}', mount() {} };`;
const assets = { script, style: ".config-studio { color: red }" };
const output = await build({
  entryPoints: ["src/lib/remoteConfigStudio.ts"],
  bundle: true,
  write: false,
  platform: "browser",
  format: "cjs",
  define: {
    __CONFIG_STUDIO_BUILD__: JSON.stringify(buildId),
    "import.meta.env.DEV": "false",
  },
});

function browser({
  cache = new Map(),
  offline = false,
  storageBlocked = false,
  downloads = assets,
  hangFetch = false,
  hangScript = false,
} = {}) {
  const requests = [],
    elements = [],
    blobs = new Map();
  const globals = {
    module: { exports: {} },
    Blob,
    AbortController,
    window: { setTimeout, clearTimeout },
    localStorage: {
      getItem(key) {
        if (storageBlocked) throw Error("denied");
        return cache.get(key) ?? null;
      },
      setItem(key, value) {
        if (storageBlocked) throw Error("denied");
        cache.set(key, value);
      },
      removeItem: (key) => cache.delete(key),
    },
    URL: {
      createObjectURL(blob) {
        const url = "blob:" + blobs.size;
        blobs.set(url, blob);
        return url;
      },
      revokeObjectURL(url) {
        blobs.delete(url);
      },
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (hangFetch)
        return new Promise((_, reject) =>
          options.signal.addEventListener("abort", () =>
            reject(Error("aborted")),
          ),
        );
      if (offline) throw Error("offline");
      return {
        ok: true,
        text: async () =>
          url.endsWith(".js") ? downloads.script : downloads.style,
      };
    },
    document: {
      querySelector: () => elements.find((el) => el.tag === "style"),
      createElement: (tag) => ({
        tag,
        dataset: {},
        remove() {
          const i = elements.indexOf(this);
          if (i !== -1) elements.splice(i, 1);
        },
      }),
      head: {
        appendChild(element) {
          elements.push(element);
          if (element.tag === "script" && !hangScript)
            queueMicrotask(async () => {
              try {
                vm.runInContext(await blobs.get(element.src).text(), context);
              } catch {
                /* Browser reports script evaluation errors separately. */
              }
              element.onload?.();
            });
        },
      },
    },
  };
  const context = vm.createContext(globals);
  vm.runInContext(output.outputFiles[0].text, context);
  return {
    load: globals.module.exports.createStudioLoader(
      buildId,
      "https://example.test/studio/",
      25,
    ),
    cache,
    requests,
    elements,
    blobs,
    goOnline() {
      offline = false;
    },
  };
}

const first = browser();
assert.equal(
  first.requests.length,
  0,
  "constructing the loader must not download",
);
const concurrent = [first.load(), first.load()];
assert.equal(
  concurrent[0],
  concurrent[1],
  "concurrent opens share one download",
);
await Promise.all(concurrent);
assert.equal(first.requests.length, 2);
assert(
  first.requests.every(
    (r) =>
      r.url.includes("/" + buildId + "/") && r.options.credentials === "omit",
  ),
);
assert.deepEqual(JSON.parse(first.cache.get(cacheKey)), assets);
assert.equal(first.elements.filter((el) => el.tag === "style").length, 1);
assert.equal(first.blobs.size, 0, "release blob URLs");
await first.load();
assert.equal(first.requests.length, 2);

const offline = browser({ cache: first.cache, offline: true });
assert.equal(typeof (await offline.load()).mount, "function");
assert.equal(
  offline.requests.length,
  0,
  "cached startup must work without network",
);

const retry = browser({ offline: true });
await assert.rejects(retry.load(), /Connect to the Internet/);
retry.goOnline();
await retry.load();
assert.equal(
  retry.requests.length,
  4,
  "failure must not poison the shared promise",
);

for (const badScript of [
  "invalid !!!",
  script.replace("apiVersion: 1", "apiVersion: 99"),
  script.replace(buildId, "b".repeat(24)),
  "window.FigUIConfigStudio = {}",
]) {
  const repaired = browser({
    cache: new Map([
      [cacheKey, JSON.stringify({ ...assets, script: badScript })],
    ]),
  });
  await repaired.load();
  assert.equal(
    repaired.requests.length,
    2,
    "bad cache must recover automatically online",
  );
  assert.deepEqual(JSON.parse(repaired.cache.get(cacheKey)), assets);
}
const invalid = browser({
  downloads: {
    ...assets,
    script: script.replace("apiVersion: 1", "apiVersion: 99"),
  },
});
await assert.rejects(invalid.load(), /Could not start/);
assert.equal(invalid.cache.size, 0);
assert.equal(invalid.elements.length, 0, "invalid JS must not install CSS");

await browser({ storageBlocked: true }).load();
const timeout = browser({ hangFetch: true });
await assert.rejects(timeout.load(), /Could not download/);
assert(timeout.requests.every((r) => r.options.signal.aborted));
const scriptTimeout = browser({ hangScript: true });
await assert.rejects(scriptTimeout.load(), /Could not start/);
assert.equal(scriptTimeout.blobs.size, 0);
assert.equal(scriptTimeout.elements.length, 0);

const oldId = "b".repeat(24);
assert.throws(
  () => parseArchive(gzipSync(JSON.stringify({ "../bad": assets }))),
  /Invalid/,
);
const folder = await mkdtemp(join(tmpdir(), "figui-studio-publish-"));
const originalFetch = globalThis.fetch;
try {
  await mkdir(join(folder, buildId));
  await writeFile(join(folder, buildId, "config-studio.js"), assets.script);
  await writeFile(join(folder, buildId, "config-studio.css"), assets.style);
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => gzipSync(JSON.stringify({ [oldId]: assets })),
  });
  await prepareStudioPages({ outDir: folder, buildId });
  assert.equal(
    await readFile(join(folder, oldId, "config-studio.js"), "utf8"),
    assets.script,
  );
  const preserved = parseArchive(
    await readFile(join(folder, "archive.json.gz")),
  );
  assert.deepEqual(Object.keys(preserved).sort(), [buildId, oldId]);
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      gzipSync(
        JSON.stringify({ [buildId]: { ...assets, script: "different" } }),
      ),
  });
  await assert.rejects(
    prepareStudioPages({ outDir: folder, buildId }),
    /Refusing to overwrite/,
  );
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(
    prepareStudioPages({ outDir: folder, buildId }),
    /Cannot preserve/,
  );
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  await prepareStudioPages({ outDir: folder, buildId });
} finally {
  globalThis.fetch = originalFetch;
  await rm(folder, { recursive: true, force: true });
}
console.log("Config Studio loader and publishing tests passed.");
