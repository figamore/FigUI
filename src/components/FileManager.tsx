import { useState, useEffect, useRef, useCallback } from "react";
import { canLoadControllerResources, useControllerResourcesReady } from "../lib/controllerResources";
import {
  Folder,
  File,
  Upload,
  Trash2,
  RefreshCw,
  ChevronRight,
  HardDrive,
  FolderPlus,
  X,
  Pencil,
  Check,
  Download,
  Server,
  FileCode,
  FilePlus,
  Search,
  Loader2,
} from "lucide-react";
import {
  listFiles,
  deleteFile,
  deleteDir,
  uploadFile,
  createDir,
  renameFile,
  downloadFile,
  fetchFileContent,
  saveFileContent,
} from "../lib/http";
import { CodeEditor, isEditable } from "./CodeEditor";
import { useMachineStore } from "../store";
import { useGCodeStore } from "../store/gcode";
import type { FileEntry, FileListResult } from "../types";
import { isGCodeFileName } from "../lib/gcodeFiles";

type Filesystem = "sd" | "local";
type UploadTarget = { fs: Filesystem; path: string; name: string };
type EditingFile = {
  fs: Filesystem;
  path: string;
  filename: string;
  content: string;
  openStudio?: boolean;
  restoreFromHistory?: boolean;
};

const isGcode = isGCodeFileName;
const isYamlFile = (name: string) => /\.ya?ml$/i.test(name);

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

interface FileRowProps {
  entry: FileEntry;
  path: string;
  fs: Filesystem;
  canLoadGcode: boolean;
  selectionMode: boolean;
  selected: boolean;
  selectionDisabled: boolean;
  onToggleSelection: () => void;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onEdit: (fullPath: string, filename: string) => void;
  isTablet?: boolean;
}

function FileRow({
  entry,
  path,
  fs,
  canLoadGcode,
  selectionMode,
  selected,
  selectionDisabled,
  onToggleSelection,
  onNavigate,
  onRefresh,
  onEdit,
  isTablet,
}: FileRowProps) {
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(entry.name);
  const [showMenu, setShowMenu] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);

  const fullPath = path.endsWith("/") ? path : `${path}/`;
  const fullName = `${fullPath}${entry.name}`;

  function startRename() {
    setNewName(entry.name);
    setRenaming(true);
    setTimeout(() => renameRef.current?.select(), 0);
  }

  async function commitRename() {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === entry.name) {
      setRenaming(false);
      return;
    }
    try {
      await renameFile(fullPath, entry.name, trimmed, fs);
      onRefresh();
    } catch {}
    setRenaming(false);
  }

  async function handleDelete() {
    if (!confirm(`Delete ${entry.name}?`)) return;
    setDeleting(true);
    try {
      if (entry.isDir) await deleteDir(fullPath, entry.name, fs);
      else await deleteFile(fullPath, entry.name, fs);
      onRefresh();
    } finally {
      setDeleting(false);
    }
  }

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadFile(fullName, entry.name, fs);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  function handleTap() {
    if (entry.isDir) {
      onNavigate(`${fullPath}${entry.name}`);
    } else {
      setShowMenu(true);
    }
  }

  function handleGcodeLoad() {
    setShowMenu(false);
    window.dispatchEvent(new CustomEvent("gcode:load", { detail: fullName }));
  }

  function handleMenuEdit() {
    setShowMenu(false);
    onEdit(fullPath, entry.name);
  }

  function handleMenuDownload() {
    setShowMenu(false);
    void handleDownload();
  }

  function handleMenuRename() {
    setShowMenu(false);
    startRename();
  }

  async function handleMenuDelete() {
    setShowMenu(false);
    await handleDelete();
  }

  return (
    <>
      <div
        className={`flex items-center gap-2 px-3 ${isTablet ? "py-3" : "py-2"} hover:bg-elevated group transition-colors ${
          selectionMode && selected ? "bg-accent/10" : ""
        }`}
      >
        {selectionMode && (
          <input
            type="checkbox"
            checked={selected}
            disabled={selectionDisabled}
            onChange={onToggleSelection}
            className={`${isTablet ? "w-5 h-5" : "w-4 h-4"} shrink-0 accent-[var(--accent)] cursor-pointer`}
            aria-label={`Select ${entry.name}`}
          />
        )}

        <div className="text-text-dim shrink-0">
          {entry.isDir ? (
            <Folder size={isTablet ? 20 : 14} className="text-accent/70" />
          ) : (
            <File size={isTablet ? 20 : 14} />
          )}
        </div>

        {renaming ? (
          <input
            ref={renameRef}
            className={`flex-1 input-field py-0.5 text-lg`}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={commitRename}
            autoFocus
          />
        ) : isTablet ? (
          <button
            className={`flex-1 min-w-0 text-left text-2xl truncate ${
              entry.isDir
                ? "text-text-primary"
                : isGcode(entry.name)
                  ? canLoadGcode
                    ? "text-text-primary"
                    : "text-text-dim"
                  : "text-text-primary"
            }`}
            onClick={handleTap}
          >
            {entry.name}
          </button>
        ) : entry.isDir ? (
          <button
            className={`flex-1 text-left text-xl text-text-primary hover:text-accent truncate`}
            onClick={() => onNavigate(`${fullPath}${entry.name}`)}
          >
            {entry.name}
          </button>
        ) : isGcode(entry.name) ? (
          <button
            className={`flex-1 text-left text-xl truncate ${canLoadGcode ? "text-text-primary hover:text-accent" : "text-text-dim cursor-not-allowed"}`}
            onClick={() => {
              if (!canLoadGcode) return;
              window.dispatchEvent(
                new CustomEvent("gcode:load", { detail: fullName }),
              );
            }}
            title={
              canLoadGcode
                ? `Load ${entry.name} in G-code viewer`
                : "Cannot load another file while a job is running or held"
            }
          >
            {entry.name}
          </button>
        ) : (
          <span className={`flex-1 text-xl text-text-primary truncate`}>
            {entry.name}
          </span>
        )}

        {!renaming && isTablet && !entry.isDir && (
          <span className="shrink-0 text-base text-text-dim font-mono text-right whitespace-nowrap">
            {fmtSize(entry.size)}
          </span>
        )}

        {!renaming && !isTablet && (
          <div className="w-28 shrink-0 flex items-center justify-end">
            {!entry.isDir && (
              <span className="text-base text-text-dim font-mono text-right group-hover:hidden">
                {fmtSize(entry.size)}
              </span>
            )}
            <div className="hidden group-hover:flex items-center gap-1">
              {!entry.isDir && isEditable(entry.name) && (
                <button
                  className="p-1.5 rounded text-info hover:bg-info/10 transition-colors"
                  onClick={() => onEdit(fullPath, entry.name)}
                  title="Edit file"
                >
                  <FileCode size={12} />
                </button>
              )}
              {!entry.isDir && (
                <button
                  className="p-1.5 rounded text-info hover:bg-info/10 transition-colors disabled:opacity-50"
                  onClick={handleDownload}
                  disabled={downloading}
                  title={downloading ? "Downloading" : "Download"}
                >
                  {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                </button>
              )}
              <button
                className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-elevated transition-colors"
                onClick={startRename}
                title="Rename"
              >
                <Pencil size={12} />
              </button>
              <button
                className="p-1.5 rounded text-danger hover:bg-danger/10 transition-colors"
                onClick={handleDelete}
                disabled={deleting}
                title="Delete"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        )}

        {renaming && (
          <button
            className="p-1.5 rounded text-ok hover:bg-ok/10 transition-colors shrink-0"
            onClick={commitRename}
            title="Confirm rename"
          >
            <Check size={12} />
          </button>
        )}
      </div>

      {showMenu && (
        <div
          className="fixed inset-0 z-50 flex items-end"
          onClick={() => setShowMenu(false)}
        >
          <div
            className="w-full bg-surface border-t border-border rounded-t-xl shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div className="flex items-center gap-3 min-w-0">
                {entry.isDir ? (
                  <Folder size={20} className="text-accent/70 shrink-0" />
                ) : (
                  <File size={20} className="text-text-dim shrink-0" />
                )}
                <span className="text-xl font-medium text-text-primary truncate">
                  {entry.name}
                </span>
              </div>
              <button
                className="p-2 rounded text-text-muted hover:text-text-primary shrink-0"
                onClick={() => setShowMenu(false)}
              >
                <X size={20} />
              </button>
            </div>
            <div className="px-3 py-3 flex flex-col gap-1">
              {!entry.isDir && isGcode(entry.name) && (
                <button
                  className={`flex items-center gap-4 px-4 py-4 rounded-lg text-xl w-full text-left transition-colors ${
                    canLoadGcode
                      ? "text-accent hover:bg-accent/10"
                      : "text-text-dim cursor-not-allowed"
                  }`}
                  onClick={canLoadGcode ? handleGcodeLoad : undefined}
                  disabled={!canLoadGcode}
                >
                  <ChevronRight size={22} />
                  <span>Load in Viewer</span>
                  {!canLoadGcode && (
                    <span className="text-base text-text-dim ml-auto">
                      Job running
                    </span>
                  )}
                </button>
              )}
              {!entry.isDir && isEditable(entry.name) && (
                <button
                  className="flex items-center gap-4 px-4 py-4 rounded-lg text-xl w-full text-left text-info hover:bg-info/10 transition-colors"
                  onClick={handleMenuEdit}
                >
                  <FileCode size={22} />
                  <span>Edit</span>
                </button>
              )}
              {!entry.isDir && (
                <button
                  className="flex items-center gap-4 px-4 py-4 rounded-lg text-xl w-full text-left text-text-primary hover:bg-elevated transition-colors disabled:opacity-50"
                  onClick={handleMenuDownload}
                  disabled={downloading}
                >
                  {downloading ? <Loader2 size={22} className="animate-spin" /> : <Download size={22} />}
                  <span>{downloading ? "Downloading…" : "Download"}</span>
                </button>
              )}
              <button
                className="flex items-center gap-4 px-4 py-4 rounded-lg text-xl w-full text-left text-text-primary hover:bg-elevated transition-colors"
                onClick={handleMenuRename}
              >
                <Pencil size={22} />
                <span>Rename</span>
              </button>
              <button
                className="flex items-center gap-4 px-4 py-4 rounded-lg text-xl w-full text-left text-danger hover:bg-danger/10 transition-colors"
                onClick={handleMenuDelete}
                disabled={deleting}
              >
                <Trash2 size={22} />
                <span>Delete</span>
              </button>
            </div>
            <div className="h-safe-bottom pb-4" />
          </div>
        </div>
      )}
    </>
  );
}

const _fmCache = new Map<
  Filesystem,
  { result: FileListResult; path: string }
>();
let _fmLastFs: Filesystem = "sd";
let _internalPrefetch: Promise<void> | null = null;
let _fmCacheVersion = 0;

export function invalidateFileCache() {
  _fmCacheVersion++;
  _fmCache.clear();
}

export function prefetchInternalFiles() {
  if (_fmCache.has("local")) return Promise.resolve();
  if (_internalPrefetch) return _internalPrefetch;

  const cacheVersion = _fmCacheVersion;
  _internalPrefetch = listFiles("/", "local")
    .then((result) => {
      if (cacheVersion !== _fmCacheVersion) return;
      _fmCache.set("local", { result, path: "/" });
    })
    .catch(() => {})
    .finally(() => {
      _internalPrefetch = null;
    });

  return _internalPrefetch;
}

export function FileManager({ isTablet }: { isTablet?: boolean }) {
  const resourcesReady = useControllerResourcesReady();
  const espInfo = useMachineStore((s) => s.espInfo);
  const machineState = useMachineStore((s) => s.status.state);
  const loadGCodeFromText = useGCodeStore((s) => s.loadFromText);
  const beginSdUpload = useGCodeStore((s) => s.beginSdUpload);
  const completeSdUpload = useGCodeStore((s) => s.completeSdUpload);
  const failSdUpload = useGCodeStore((s) => s.failSdUpload);
  const primarySd = espInfo?.primarySd ?? "/sd/";
  const canLoadGcode = machineState !== "Run" && machineState !== "Hold";

  const [fs, setFs] = useState<Filesystem>(_fmLastFs);
  const [path, setPath] = useState(_fmCache.get(_fmLastFs)?.path ?? (_fmLastFs === "sd" ? primarySd : "/"));
  const [result, setResult] = useState<FileListResult | null>(
    _fmCache.get(_fmLastFs)?.result ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadPhase, setUploadPhase] = useState<
    "preparing" | "uploading" | "finishing"
  >("preparing");
  const [uploadIdx, setUploadIdx] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [highlightedUpload, setHighlightedUpload] =
    useState<UploadTarget | null>(null);
  const [newDirName, setNewDirName] = useState("");
  const [showNewDir, setShowNewDir] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [showNewFile, setShowNewFile] = useState(false);
  const [editing, setEditing] = useState<EditingFile | null>(null);
  const editorHistoryRef = useRef<EditingFile | null>(null);
  const [editLoading, setEditLoading] = useState<string | null>(null);
  const [configChoices, setConfigChoices] = useState<FileEntry[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [search, setSearch] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingSelected, setDeletingSelected] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileListRef = useRef<HTMLDivElement>(null);
  const uploadedRowRef = useRef<HTMLDivElement>(null);

  const sdRoot = primarySd;
  const localRoot = "/";
  const pendingListing = useRef<{ path: string; fs: Filesystem } | null>(null);
  const activeListing = useRef<{ path: string; fs: Filesystem } | null>(null);
  const listingGeneration = useRef(0);

  const load = useCallback(async (p: string, filesystem: Filesystem) => {
    const generation = ++listingGeneration.current;
    const request = { path: p, fs: filesystem };
    pendingListing.current = request;
    activeListing.current = null;
    setFs(filesystem);
    setPath(p);
    setResult(null);
    setError("");
    _fmLastFs = filesystem;
    if (!canLoadControllerResources(useMachineStore.getState())) {
      setLoading(false);
      return;
    }
    pendingListing.current = null;
    activeListing.current = request;
    setLoading(true);
    try {
      const data = await listFiles(p, filesystem);
      if (generation !== listingGeneration.current) return;
      if (!canLoadControllerResources(useMachineStore.getState())) {
        pendingListing.current = request;
        return;
      }
      setResult(data);
      _fmCache.set(filesystem, { result: data, path: p });
    } catch (e) {
      if (generation !== listingGeneration.current) return;
      if (!canLoadControllerResources(useMachineStore.getState())) {
        pendingListing.current = request;
        return;
      }
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      if (generation === listingGeneration.current) {
        activeListing.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!resourcesReady) return;
    const pending = pendingListing.current;
    if (pending) {
      load(pending.path, pending.fs);
      return;
    }
    if (activeListing.current?.fs === fs && activeListing.current.path === path) return;
    if (_fmCache.get(fs)?.path === path) return;
    load(path, fs);
  }, [load, fs, path, resourcesReady]);

  useEffect(() => () => { listingGeneration.current++; }, []);

  useEffect(() => {
    if (editing) editorHistoryRef.current = editing;
  }, [editing]);

  useEffect(() => {
    const restoreEditor = (event: PopStateEvent) => {
      const state = event.state as {
        figuiCodeEditor?: { filename?: unknown };
      } | null;
      const filename = state?.figuiCodeEditor?.filename;
      const previousEditor = editorHistoryRef.current;
      if (
        typeof filename !== "string" ||
        !previousEditor ||
        previousEditor.filename !== filename
      )
        return;

      setEditing({ ...previousEditor, restoreFromHistory: true });
    };

    window.addEventListener("popstate", restoreEditor);
    return () => window.removeEventListener("popstate", restoreEditor);
  }, []);

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      load(path, fs);
    }, 500);
  }, [load, path, fs]);

  useEffect(() => {
    window.addEventListener("files:changed", scheduleRefresh);
    return () => {
      window.removeEventListener("files:changed", scheduleRefresh);
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [scheduleRefresh]);

  const openStudioFile = useCallback(async (filename: string) => {
    setConfigChoices(null);
    setEditLoading(filename);
    try {
      const content = await fetchFileContent(`/${filename}`, "local");
      setEditing({
        fs: "local",
        path: "/",
        filename,
        content,
        openStudio: true,
      });
    } catch (e) {
      alert(
        `Failed to open ${filename}: ${e instanceof Error ? e.message : "Unknown error"}`,
      );
    } finally {
      setEditLoading(null);
    }
  }, []);

  const openConfigEditor = useCallback(async () => {
    setEditLoading("config.yaml");
    try {
      const content = await fetchFileContent("/config.yaml", "local");
      setEditing({
        fs: "local",
        path: "/",
        filename: "config.yaml",
        content,
      });
    } catch (e) {
      alert(
        `Failed to open config.yaml: ${e instanceof Error ? e.message : "Unknown error"}`,
      );
    } finally {
      setEditLoading(null);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("files:open-config-editor", openConfigEditor);
    return () => {
      window.removeEventListener("files:open-config-editor", openConfigEditor);
    };
  }, [openConfigEditor]);

  useEffect(() => {
    const openStudio = async () => {
      setEditLoading("YAML files");
      try {
        const cachedLocal = _fmCache.get("local");
        const localRoot =
          fs === "local" && path === "/" && result
            ? result
            : cachedLocal?.path === "/"
              ? cachedLocal.result
              : await listFiles("/", "local");
        if (!_fmCache.has("local") || cachedLocal?.path !== "/") {
          _fmCache.set("local", { result: localRoot, path: "/" });
        }

        const yamlFiles = localRoot.files
          .filter((entry) => !entry.isDir && isYamlFile(entry.name))
          .sort((a, b) => a.name.localeCompare(b.name));

        if (yamlFiles.length === 0) {
          alert("No .yaml or .yml files were found in Internal storage.");
        } else if (yamlFiles.length === 1) {
          await openStudioFile(yamlFiles[0].name);
        } else {
          setConfigChoices(yamlFiles);
        }
      } catch (e) {
        alert(
          `Failed to list YAML files: ${e instanceof Error ? e.message : "Unknown error"}`,
        );
      } finally {
        setEditLoading(null);
      }
    };

    window.addEventListener("config:open-studio", openStudio);
    return () => {
      window.removeEventListener("config:open-studio", openStudio);
    };
  }, [fs, path, result, openStudioFile]);

  useEffect(() => {
    if (!result) return;
    const availableNames = new Set(result.files.map((entry) => entry.name));
    setSelectedNames((current) => {
      const next = new Set(
        [...current].filter((name) => availableNames.has(name)),
      );
      return next.size === current.size ? current : next;
    });
  }, [result]);

  useEffect(() => {
    if (
      !highlightedUpload ||
      highlightedUpload.fs !== fs ||
      highlightedUpload.path !== path ||
      !result?.files.some((entry) => entry.name === highlightedUpload.name)
    ) {
      return;
    }

    // This pane owns its scroll position. Calling scrollIntoView() here can
    // instead scroll an outer layout container, leaving the file list still.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const list = fileListRef.current;
        const row = uploadedRowRef.current;
        if (!list || !row) return;
        list.scrollTo({
          behavior: "smooth",
          top: Math.max(0, row.offsetTop - (list.clientHeight - row.offsetHeight) / 2),
        });
      });
    });
    const clearHighlight = window.setTimeout(
      () => setHighlightedUpload(null),
      3_000,
    );
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(clearHighlight);
    };
  }, [fs, highlightedUpload, path, result]);

  function switchFs(newFs: Filesystem) {
    listingGeneration.current++;
    pendingListing.current = null;
    activeListing.current = null;
    setLoading(false);
    setError("");
    _fmLastFs = newFs;
    setHighlightedUpload(null);
    setSelectionMode(false);
    setSelectedNames(new Set());
    setFs(newFs);
    const cached = _fmCache.get(newFs);
    if (cached) {
      setResult(cached.result);
      setPath(cached.path);
      return;
    }
    setResult(null);
    const root = newFs === "sd" ? sdRoot : localRoot;
    load(root, newFs);
  }

  function navigate(p: string) {
    setSearch("");
    setHighlightedUpload(null);
    setSelectionMode(false);
    setSelectedNames(new Set());
    load(p, fs);
  }

  function goUp() {
    setSearch("");
    setHighlightedUpload(null);
    setSelectionMode(false);
    setSelectedNames(new Set());
    const root = fs === "sd" ? sdRoot : localRoot;
    const trimmed = path.replace(/\/$/, "");
    const parts = trimmed.split("/");
    if (parts.length <= 2) {
      load(root, fs);
    } else {
      parts.pop();
      load(parts.join("/") + "/", fs);
    }
  }

  async function handleUpload(files: FileList | null) {
    if (!files || !files.length || uploading) return;
    setUploading(true);
    setUploadTotal(files.length);
    setUploadPct(0);
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const previewPath =
          fs === "sd" && isGcode(file.name)
            ? `${path.endsWith("/") ? path : `${path}/`}${file.name}`
            : null;
        let previewLoad: Promise<void> | null = null;

        setUploadIdx(i + 1);
        setUploadPct(0);
        setUploadPhase("preparing");
        if (previewPath) {
          // Load from the local File so the preview is available while the SD
          // transfer runs, but retain the card path for the eventual Start.
          beginSdUpload(previewPath);
          window.dispatchEvent(new Event("gcode:preview-upload"));
          previewLoad = file
            .text()
            .then((text) => loadGCodeFromText(text, file.name, previewPath));
        }

        try {
          await uploadFile(
            path,
            file,
            fs,
            (p) => setUploadPct(p),
            setUploadPhase,
          );
          await previewLoad;
          if (previewPath) await completeSdUpload(previewPath);
        } catch (e) {
          // Let the preview request settle before removing it, so it cannot
          // finish later and re-enable Start for an incomplete SD file.
          await previewLoad?.catch(() => {});
          if (previewPath) failSdUpload(previewPath);
          throw e;
        }
      }
      await load(path, fs);
      setSearch("");
      setHighlightedUpload({
        fs,
        path,
        name: files[files.length - 1].name,
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function handleCreateDir() {
    if (!newDirName.trim()) return;
    await createDir(path, newDirName.trim(), fs);
    setNewDirName("");
    setShowNewDir(false);
    load(path, fs);
  }

  function createNewFile() {
    const name = newFileName.trim();
    if (!name) return;
    setNewFileName("");
    setShowNewFile(false);
    if (isEditable(name)) {
      setEditing({
        fs,
        path: path.endsWith("/") ? path : `${path}/`,
        filename: name,
        content: "",
      });
    } else {
      // For non-editable extensions, create an empty file directly
      saveFileContent(
        path.endsWith("/") ? path : `${path}/`,
        name,
        "",
        fs,
      ).then(() => load(path, fs));
    }
  }

  async function openEditor(filePath: string, filename: string) {
    setEditLoading(filename);
    try {
      const fullFilePath = `${filePath}${filename}`;
      const content = await fetchFileContent(fullFilePath, fs);
      setEditing({ fs, path: filePath, filename, content });
    } catch (e) {
      alert(
        `Failed to load file: ${e instanceof Error ? e.message : "Unknown error"}`,
      );
    } finally {
      setEditLoading(null);
    }
  }

  async function handleSaveFile(content: string) {
    if (!editing) return;
    if (
      isYamlFile(editing.filename) &&
      content.includes("# Edited using Config Studio") &&
      !editing.content.includes("# Edited using Config Studio")
    ) {
      const extensionIndex = editing.filename.lastIndexOf(".");
      const backupName = `${editing.filename.slice(0, extensionIndex)}_backup${editing.filename.slice(extensionIndex)}`;
      await saveFileContent(
        editing.path,
        backupName,
        editing.content,
        editing.fs,
      );
    }
    await saveFileContent(editing.path, editing.filename, content, editing.fs);
    setEditing((current) => (current ? { ...current, content } : current));
    load(path, fs);
  }

  const root = fs === "sd" ? sdRoot : localRoot;
  const breadcrumbs = path.replace(/\/$/, "").split("/").filter(Boolean);
  const visibleEntries =
    result?.files
      ?.slice()
      .filter(
        (entry) =>
          !search || entry.name.toLowerCase().includes(search.toLowerCase()),
      )
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      }) ?? [];
  const selectedEntries =
    result?.files.filter((entry) => selectedNames.has(entry.name)) ?? [];
  const allVisibleSelected =
    visibleEntries.length > 0 &&
    visibleEntries.every((entry) => selectedNames.has(entry.name));

  function toggleSelection(name: string) {
    setSelectedNames((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    setSelectedNames((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        visibleEntries.forEach((entry) => next.delete(entry.name));
      } else {
        visibleEntries.forEach((entry) => next.add(entry.name));
      }
      return next;
    });
  }

  async function handleDeleteSelected() {
    if (!selectedEntries.length) return;
    const folderCount = selectedEntries.filter((entry) => entry.isDir).length;
    const itemLabel =
      selectedEntries.length === 1
        ? selectedEntries[0].name
        : `${selectedEntries.length} selected items`;
    const folderWarning = folderCount
      ? `\n\nThis includes ${folderCount} folder${folderCount === 1 ? "" : "s"} and their contents.`
      : "";
    if (!confirm(`Delete ${itemLabel}?${folderWarning}`)) return;

    setDeletingSelected(true);
    setError("");
    const failed: FileEntry[] = [];
    const fullPath = path.endsWith("/") ? path : `${path}/`;

    for (const entry of selectedEntries) {
      try {
        if (entry.isDir) await deleteDir(fullPath, entry.name, fs);
        else await deleteFile(fullPath, entry.name, fs);
      } catch {
        failed.push(entry);
      }
    }

    setSelectedNames(new Set(failed.map((entry) => entry.name)));
    await load(path, fs);
    if (failed.length) {
      setError(
        `Failed to delete: ${failed.map((entry) => entry.name).join(", ")}`,
      );
    } else {
      setSelectionMode(false);
    }
    setDeletingSelected(false);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-border shrink-0">
        {(
          [
            ["sd", "SD Card", HardDrive],
            ["local", "Internal", Server],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => switchFs(id)}
            className={`flex-1 flex items-center justify-center gap-1.5 ${isTablet ? "py-3 text-lg" : "py-2 text-base"} font-medium
                          uppercase tracking-wide transition-colors border-b-2 -mb-px ${
                            fs === id
                              ? "border-accent text-accent"
                              : "border-transparent text-text-muted hover:text-text-primary"
                          }`}
          >
            <Icon size={isTablet ? 18 : 11} />
            {label}
          </button>
        ))}
      </div>

      <div className="panel-header justify-between">
        <div
          className={`flex items-center gap-1.5 flex-wrap min-w-0 normal-case tracking-normal font-normal ${isTablet ? "text-lg" : ""}`}
        >
          <button
            className={`hover:text-accent transition-colors ${isTablet ? "p-2" : ""}`}
            onClick={() => navigate(root)}
          >
            {fs === "sd" ? (
              <HardDrive size={isTablet ? 20 : 13} />
            ) : (
              <Server size={isTablet ? 20 : 13} />
            )}
          </button>
          {breadcrumbs.map((seg, i) => (
            <div key={i} className="flex items-center gap-1">
              <ChevronRight
                size={isTablet ? 16 : 10}
                className="text-text-dim"
              />
              <button
                className={`hover:text-accent transition-colors max-w-[80px] truncate ${isTablet ? "p-2" : ""}`}
                onClick={() =>
                  navigate("/" + breadcrumbs.slice(0, i + 1).join("/") + "/")
                }
              >
                {seg}
              </button>
            </div>
          ))}
        </div>
        <div
          className={`flex items-center ${isTablet ? "gap-2" : "gap-1"} shrink-0`}
        >
          <button
            className={`rounded hover:bg-elevated text-text-muted hover:text-text-primary transition-colors ${isTablet ? "p-3" : "p-1"}`}
            onClick={() => {
              setShowNewFile((v) => !v);
              setShowNewDir(false);
            }}
            title="New file"
          >
            <FilePlus size={isTablet ? 20 : 13} />
          </button>
          <button
            className={`rounded hover:bg-elevated text-text-muted hover:text-text-primary transition-colors ${isTablet ? "p-3" : "p-1"}`}
            onClick={() => {
              setShowNewDir((v) => !v);
              setShowNewFile(false);
            }}
            title="New folder"
          >
            <FolderPlus size={isTablet ? 20 : 13} />
          </button>
          <button
            className={`rounded transition-colors ${isTablet ? "p-3" : "p-1"} ${
              selectionMode
                ? "bg-danger/10 text-danger"
                : "hover:bg-danger/10 text-text-muted hover:text-danger"
            }`}
            onClick={() => {
              setSelectionMode((active) => !active);
              setSelectedNames(new Set());
            }}
            disabled={deletingSelected}
            title={
              selectionMode
                ? "Cancel multiple selection"
                : "Select multiple items to delete"
            }
            aria-pressed={selectionMode}
          >
            <Trash2 size={isTablet ? 20 : 13} />
          </button>
          <button
            className={`rounded hover:bg-elevated text-text-muted hover:text-text-primary transition-colors ${isTablet ? "p-3" : "p-1"}`}
            onClick={() => fileInput.current?.click()}
            title="Upload file"
          >
            <Upload size={isTablet ? 20 : 13} />
          </button>
          <button
            className={`rounded hover:bg-elevated text-text-muted hover:text-accent transition-colors ${isTablet ? "p-3" : "p-1"}`}
            onClick={() => load(path, fs)}
            title="Refresh"
          >
            <RefreshCw
              size={isTablet ? 20 : 13}
              className={loading ? "animate-spin" : ""}
            />
          </button>
        </div>
      </div>

      {showNewFile && (
        <div className="flex items-center gap-2 px-3 py-2 bg-elevated border-b border-border">
          <FilePlus size={13} className="text-text-dim shrink-0" />
          <input
            className="input-field flex-1 py-1 text-base"
            placeholder="Filename (e.g. job.nc, config.yaml)"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createNewFile();
              if (e.key === "Escape") setShowNewFile(false);
            }}
            autoFocus
          />
          <button
            className="btn-primary text-base px-2 py-1"
            onClick={createNewFile}
          >
            Create
          </button>
          <button
            className="text-text-muted hover:text-text-primary"
            onClick={() => setShowNewFile(false)}
          >
            <X size={13} />
          </button>
        </div>
      )}

      {showNewDir && (
        <div className="flex items-center gap-2 px-3 py-2 bg-elevated border-b border-border">
          <FolderPlus size={13} className="text-text-dim shrink-0" />
          <input
            className="input-field flex-1 py-1 text-base"
            placeholder="Folder name"
            value={newDirName}
            onChange={(e) => setNewDirName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateDir()}
            autoFocus
          />
          <button
            className="btn-primary text-base px-2 py-1"
            onClick={handleCreateDir}
          >
            Create
          </button>
          <button
            className="text-text-muted hover:text-text-primary"
            onClick={() => setShowNewDir(false)}
          >
            <X size={13} />
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Search size={13} className="text-text-dim shrink-0" />
        <input
          ref={searchRef}
          className="input-field flex-1 py-1 text-base"
          placeholder="Filter files…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setSearch("");
          }}
        />
        {search && (
          <button
            className="text-text-muted hover:text-text-primary"
            onClick={() => setSearch("")}
          >
            <X size={13} />
          </button>
        )}
      </div>

      {selectionMode &&
        result &&
        (visibleEntries.length > 0 || selectedEntries.length > 0) && (
          <div
            className={`flex items-center gap-2 px-3 border-b border-border bg-elevated/40 ${
              isTablet ? "py-3" : "py-2"
            }`}
          >
            <label className="flex items-center gap-2 cursor-pointer min-w-0">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                disabled={deletingSelected || visibleEntries.length === 0}
                onChange={toggleSelectAllVisible}
                className={`${isTablet ? "w-5 h-5" : "w-4 h-4"} shrink-0 accent-[var(--accent)]`}
              />
              <span
                className={`${isTablet ? "text-lg" : "text-base"} text-text-muted`}
              >
                {selectedEntries.length
                  ? `${selectedEntries.length} selected`
                  : "Select all"}
              </span>
            </label>
            {selectedEntries.length > 0 && (
              <>
                <button
                  className={`${isTablet ? "text-lg" : "text-base"} text-text-muted hover:text-text-primary ml-auto`}
                  onClick={() => setSelectedNames(new Set())}
                  disabled={deletingSelected}
                >
                  Clear
                </button>
                <button
                  className={`btn btn-danger gap-1.5 ${isTablet ? "text-lg py-2 px-3" : "text-base py-1 px-2"}`}
                  onClick={handleDeleteSelected}
                  disabled={deletingSelected}
                >
                  <Trash2 size={isTablet ? 18 : 13} />
                  {deletingSelected ? "Deleting…" : "Delete"}
                </button>
              </>
            )}
          </div>
        )}

      {uploading && (
        <div className="px-3 py-2 bg-info/5 border-b border-info/20">
          <div className="flex justify-between text-base text-info mb-1">
            <span>
              {uploadPhase === "preparing"
                ? "Checking storage"
                : uploadPhase === "finishing"
                  ? "Finishing upload"
                  : "Uploading"}
              {uploadTotal > 1 ? ` (${uploadIdx} of ${uploadTotal})` : ""}…
            </span>
            <span>
              {uploadPhase === "uploading" ? (
                `${uploadPct}%`
              ) : (
                <Loader2 size={14} className="animate-spin" />
              )}
            </span>
          </div>
          <div className="w-full h-1 bg-elevated rounded-full overflow-hidden">
            <div
              className={`h-full bg-info transition-all ${uploadPhase !== "uploading" ? "animate-pulse" : ""}`}
              style={{
                width:
                  uploadPhase === "preparing"
                    ? "0%"
                    : uploadPhase === "finishing"
                      ? "100%"
                      : `${uploadPct}%`,
              }}
            />
          </div>
        </div>
      )}

      <div
        ref={fileListRef}
        className="flex-1 overflow-y-auto min-h-0 relative"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node))
            setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleUpload(e.dataTransfer.files);
        }}
      >
        {dragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-accent/10 border-2 border-dashed border-accent rounded-sm pointer-events-none">
            <div className="flex flex-col items-center gap-2 text-accent">
              <Upload size={isTablet ? 40 : 28} />
              <span className={isTablet ? "text-xl" : "text-base"}>
                Drop files to upload
              </span>
            </div>
          </div>
        )}
        {error && (
          <div className="m-3 p-3 rounded-sm bg-danger/10 border border-danger/30 text-danger text-base">
            {error}
          </div>
        )}

        {!resourcesReady && !result && (
          <div className="p-4 text-text-muted text-sm">
            Files will load when the controller is idle.
          </div>
        )}

        {loading && !result && (
          <div className="flex items-center justify-center h-24 text-text-muted text-base">
            <RefreshCw size={14} className="animate-spin mr-2" /> Loading…
          </div>
        )}

        {result && path !== root && (
          <button
            className="flex items-center gap-2 px-3 py-2 w-full text-left
                       hover:bg-elevated text-text-muted hover:text-text-primary transition-colors
                       border-b border-border"
            onClick={goUp}
          >
            <Folder size={14} className="text-accent/50" />
            <span className="text-base">..</span>
          </button>
        )}

        {visibleEntries.map((entry) => (
          <div
            key={entry.name}
            ref={
              highlightedUpload?.fs === fs &&
              highlightedUpload.path === path &&
              highlightedUpload.name === entry.name
                ? uploadedRowRef
                : null
            }
            className={`border-b border-border last:border-b-0 transition-colors ${
              highlightedUpload?.fs === fs &&
              highlightedUpload.path === path &&
              highlightedUpload.name === entry.name
                ? "bg-info/10 ring-1 ring-inset ring-info/40"
                : ""
            }`}
          >
            <FileRow
              isTablet={isTablet}
              entry={entry}
              path={path}
              fs={fs}
              canLoadGcode={canLoadGcode}
              selectionMode={selectionMode}
              selected={selectedNames.has(entry.name)}
              selectionDisabled={deletingSelected}
              onToggleSelection={() => toggleSelection(entry.name)}
              onNavigate={navigate}
              onRefresh={() => load(path, fs)}
              onEdit={openEditor}
            />
          </div>
        ))}

        {result && !visibleEntries.length && (
          <div className="flex items-center justify-center h-24 text-text-muted text-xl">
            {search ? "No matches" : "Empty directory"}
          </div>
        )}
      </div>

      {result && (
        <div className="border-t border-border px-3 py-2 flex items-center gap-2 text-base text-text-muted">
          <HardDrive size={12} />
          <div className="flex-1">
            <div className="flex justify-between mb-1">
              <span>{fmtSize(result.total - result.used)} free</span>
              <span>{result.occupation}% used</span>
            </div>
            <div className="w-full h-1 bg-elevated rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  result.occupation > 90
                    ? "bg-danger"
                    : result.occupation > 70
                      ? "bg-warn"
                      : "bg-ok"
                }`}
                style={{ width: `${result.occupation}%` }}
              />
            </div>
          </div>
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        className="hidden"
        multiple
        onChange={(e) => handleUpload(e.target.files)}
      />

      {editLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[1px]">
          <div className="flex min-w-64 flex-col items-center rounded-lg border border-border bg-surface px-8 py-7 text-center shadow-2xl">
            <Loader2
              size={30}
              className="animate-spin text-accent"
              aria-hidden="true"
            />
            <div className="mt-3 text-base font-semibold text-text-primary">
              Loading file…
            </div>
            <div className="mt-1 max-w-64 truncate font-mono text-sm text-text-muted">
              {editLoading}
            </div>
          </div>
        </div>
      )}

      {configChoices && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[1px]"
          onClick={() => setConfigChoices(null)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="min-w-0">
                <div className="text-base font-semibold text-text-primary">
                  Choose Config File
                </div>
                <div className="mt-0.5 text-sm text-text-muted">
                  Internal storage
                </div>
              </div>
              <button
                className="rounded p-2 text-text-muted hover:bg-elevated hover:text-text-primary"
                onClick={() => setConfigChoices(null)}
                title="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="min-h-0 overflow-y-auto p-2">
              {configChoices.map((entry) => (
                <button
                  key={entry.name}
                  className="flex w-full items-center gap-3 rounded px-3 py-3 text-left hover:bg-elevated"
                  onClick={() => void openStudioFile(entry.name)}
                >
                  <FileCode size={18} className="shrink-0 text-accent" />
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-text-primary">
                    {entry.name}
                  </span>
                  <span className="shrink-0 text-xs text-text-muted">
                    {fmtSize(entry.size)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {editing && (
        <CodeEditor
          filename={editing.filename}
          content={editing.content}
          onSave={handleSaveFile}
          onClose={() => setEditing(null)}
          initialView={editing.openStudio ? "studio" : "code"}
          restoreFromHistory={editing.restoreFromHistory}
        />
      )}
    </div>
  );
}
