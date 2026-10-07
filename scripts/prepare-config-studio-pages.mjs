import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { configStudioBuildId } from "./config-studio-build-id.mjs";

const ARCHIVE_URL =
  "https://figamore.github.io/FigUI/config-studio/archive.json.gz";
const BUILD_ID = /^[a-f0-9]{24}$/;

export function parseArchive(bytes) {
  const archive = JSON.parse(
    gunzipSync(bytes, { maxOutputLength: 100_000_000 }).toString(),
  );
  if (!archive || typeof archive !== "object" || Array.isArray(archive))
    throw new Error("Invalid Studio archive");
  for (const [id, assets] of Object.entries(archive)) {
    if (
      !BUILD_ID.test(id) ||
      !assets ||
      !["script", "style"].every(
        (key) =>
          typeof assets[key] === "string" &&
          assets[key].trim() &&
          assets[key].length <= 2_000_000,
      )
    ) {
      throw new Error("Invalid Studio archive entry");
    }
  }
  return archive;
}

export async function prepareStudioPages({
  outDir = "dist/config-studio",
  archiveUrl = ARCHIVE_URL,
  buildId = configStudioBuildId(),
} = {}) {
  // Both Pages workflows are serialized. Restore previous builds before each
  // deployment, since Pages replaces the entire site, including old assets.
  const url = new URL(archiveUrl);
  url.searchParams.set("t", String(Date.now()));
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (!response.ok && response.status !== 404)
    throw new Error(`Cannot preserve Studio builds: HTTP ${response.status}`);
  const archive =
    response.status === 404
      ? {}
      : parseArchive(Buffer.from(await response.arrayBuffer()));
  const current = {
    script: await readFile(`${outDir}/${buildId}/config-studio.js`, "utf8"),
    style: await readFile(`${outDir}/${buildId}/config-studio.css`, "utf8"),
  };
  if (
    archive[buildId] &&
    (archive[buildId].script !== current.script ||
      archive[buildId].style !== current.style)
  ) {
    throw new Error(`Refusing to overwrite immutable Studio build ${buildId}`);
  }
  archive[buildId] = current;
  for (const [id, assets] of Object.entries(archive)) {
    await mkdir(`${outDir}/${id}`, { recursive: true });
    await writeFile(`${outDir}/${id}/config-studio.js`, assets.script);
    await writeFile(`${outDir}/${id}/config-studio.css`, assets.style);
  }
  await writeFile(
    `${outDir}/archive.json.gz`,
    gzipSync(JSON.stringify(archive), { level: 9 }),
  );
  console.log(
    `Preserved ${Object.keys(archive).length} Config Studio build(s).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await prepareStudioPages();
