import { useState, useEffect, useRef, useCallback } from "react";
import { CodeJar } from "codejar";
import {
  X,
  Save,
  Download,
  Search,
  ChevronUp,
  ChevronDown,
  RotateCcw,
  Code2,
  SlidersHorizontal,
} from "lucide-react";
import { sendCommand } from "../lib/http";
import { useMachineStore } from "../store";
import { ConfigStudio } from "./ConfigStudio";
import {
  validateFluidConfigForSave,
  type ConfigIssue,
} from "../lib/configValidation";
import { GCODE_EXTENSION_SET } from "../lib/gcodeFiles";

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightGcode(editor: HTMLElement) {
  const code = editor.textContent ?? "";
  const TOKEN =
    /(;.*)|(\(.*?\))|\b(N\d+)|\b(G\d+(?:\.\d+)?)|\b(M\d+(?:\.\d+)?)|\b([XYZABCIJKR])(-?\.?\d+\.?\d*)|\b([FS])(\d+\.?\d*)|^(\$\S+)/i;
  editor.innerHTML = code
    .split("\n")
    .map((line) => {
      let result = "";
      let last = 0;
      const re = new RegExp(TOKEN.source, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        result += escapeHtml(line.slice(last, m.index));
        if (m[1])
          result += `<span class="hl-comment">${escapeHtml(m[1])}</span>`;
        else if (m[2])
          result += `<span class="hl-comment">${escapeHtml(m[2])}</span>`;
        else if (m[3])
          result += `<span class="hl-line-num">${escapeHtml(m[3])}</span>`;
        else if (m[4])
          result += `<span class="hl-gcode">${escapeHtml(m[4])}</span>`;
        else if (m[5])
          result += `<span class="hl-mcode">${escapeHtml(m[5])}</span>`;
        else if (m[6])
          result += `<span class="hl-coord">${escapeHtml(m[6])}</span><span class="hl-number">${escapeHtml(m[7])}</span>`;
        else if (m[8])
          result += `<span class="hl-feed">${escapeHtml(m[8])}</span><span class="hl-number">${escapeHtml(m[9])}</span>`;
        else if (m[10])
          result += `<span class="hl-gcode">${escapeHtml(m[10])}</span>`;
        else result += escapeHtml(m[0]);
        last = m.index + m[0].length;
      }
      result += escapeHtml(line.slice(last));
      return result;
    })
    .join("\n");
}

function highlightYaml(editor: HTMLElement) {
  const code = editor.textContent ?? "";
  const TOKEN =
    /("[^"]*"|'[^']*')|(#.*)$|([&*]\w+)|\b(true|false|yes|no|on|off)\b|^(\s*)([\w][^\s:]*?)(:)|((?<=:\s)-?\d+\.?\d*\b)/gm;
  editor.innerHTML = code
    .split("\n")
    .map((line) => {
      let result = "";
      let last = 0;
      const re = new RegExp(TOKEN.source, "gm");
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        result += escapeHtml(line.slice(last, m.index));
        if (m[1])
          result += `<span class="hl-string">${escapeHtml(m[1])}</span>`;
        else if (m[2])
          result += `<span class="hl-comment">${escapeHtml(m[2])}</span>`;
        else if (m[3])
          result += `<span class="hl-anchor">${escapeHtml(m[3])}</span>`;
        else if (m[4])
          result += `<span class="hl-bool">${escapeHtml(m[4])}</span>`;
        else if (m[6]) {
          result += escapeHtml(m[5]);
          result += `<span class="hl-key">${escapeHtml(m[6])}</span><span class="hl-punct">${escapeHtml(m[7])}</span>`;
        } else if (m[8])
          result += `<span class="hl-number">${escapeHtml(m[8])}</span>`;
        else result += escapeHtml(m[0]);
        last = m.index + m[0].length;
      }
      result += escapeHtml(line.slice(last));
      return result;
    })
    .join("\n");
}

type FileKind = "gcode" | "yaml" | "text";

const GCODE_EXT = GCODE_EXTENSION_SET;
const YAML_EXT = new Set([".yaml", ".yml"]);

type TextEdit = { at: number; remove: number; insert: string };

function mapOffsetThroughEdits(
  offset: number,
  edits: TextEdit[],
  includeInsertionAtOffset: boolean,
) {
  let delta = 0;
  for (const edit of edits) {
    if (offset < edit.at) break;
    if (offset === edit.at && !includeInsertionAtOffset) break;
    if (offset <= edit.at + edit.remove) {
      return (
        edit.at + delta + (includeInsertionAtOffset ? edit.insert.length : 0)
      );
    }
    delta += edit.insert.length - edit.remove;
  }
  return offset + delta;
}

/** Toggle indentation-aware YAML comments on every line touched by a selection. */
export function toggleYamlLineComments(
  code: string,
  selectionStart: number,
  selectionEnd: number,
) {
  const anchor = Math.max(0, Math.min(code.length, selectionStart));
  const focus = Math.max(0, Math.min(code.length, selectionEnd));
  const low = Math.min(anchor, focus);
  const high = Math.max(anchor, focus);
  const lineStart = code.lastIndexOf("\n", low - 1) + 1;
  // A selection ending at column zero belongs to the preceding selected line.
  const effectiveEnd = high > low && code[high - 1] === "\n" ? high - 1 : high;
  const nextNewline = code.indexOf("\n", effectiveEnd);
  const lineEnd = nextNewline === -1 ? code.length : nextNewline;
  const lines = code.slice(lineStart, lineEnd).split("\n");
  const nonBlank = lines.filter((line) => !/^\s*$/.test(line));
  if (!nonBlank.length) return { code, start: anchor, end: focus };

  const shouldUncomment = nonBlank.every((line) => /^\s*#/.test(line));
  const edits: TextEdit[] = [];
  let offset = lineStart;
  for (const line of lines) {
    if (!/^\s*$/.test(line)) {
      if (shouldUncomment) {
        const match = line.match(/^(\s*)# ?/)!;
        edits.push({
          at: offset + match[1].length,
          remove: match[0].length - match[1].length,
          insert: "",
        });
      } else {
        const indentation = line.match(/^\s*/)?.[0].length ?? 0;
        edits.push({ at: offset + indentation, remove: 0, insert: "# " });
      }
    }
    offset += line.length + 1;
  }

  let nextCode = "";
  let cursor = 0;
  for (const edit of edits) {
    nextCode += code.slice(cursor, edit.at) + edit.insert;
    cursor = edit.at + edit.remove;
  }
  nextCode += code.slice(cursor);

  const collapsed = anchor === focus;
  const map = (value: number) =>
    mapOffsetThroughEdits(value, edits, collapsed || value === high);
  return { code: nextCode, start: map(anchor), end: map(focus) };
}

function detectKind(filename: string): FileKind {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (GCODE_EXT.has(ext)) return "gcode";
  if (YAML_EXT.has(ext)) return "yaml";
  return "text";
}

function getHighlighter(kind: FileKind) {
  if (kind === "gcode") return highlightGcode;
  if (kind === "yaml") return highlightYaml;
  return (el: HTMLElement) => {
    el.innerHTML = escapeHtml(el.textContent ?? "");
  };
}

function applySearchMarks(
  editor: HTMLElement,
  term: string,
  activeIndex: number,
): number {
  if (!term) return 0;
  const needle = term.toLowerCase();
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  let matchIdx = 0;
  for (const node of textNodes) {
    const text = node.textContent ?? "";
    const lower = text.toLowerCase();
    let searchStart = 0;
    let idx = lower.indexOf(needle, searchStart);
    if (idx === -1) continue;

    const frag = document.createDocumentFragment();
    let last = 0;
    while (idx !== -1) {
      if (idx > last)
        frag.appendChild(document.createTextNode(text.slice(last, idx)));
      const mark = document.createElement("mark");
      mark.className =
        matchIdx === activeIndex ? "hl-search-active" : "hl-search";
      mark.textContent = text.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      matchIdx++;
      last = idx + needle.length;
      idx = lower.indexOf(needle, last);
    }
    if (last < text.length)
      frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode!.replaceChild(frag, node);
  }
  return matchIdx;
}

/** Count matches in plain text */
function countMatches(text: string, term: string): number {
  if (!term) return 0;
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  let count = 0;
  let idx = 0;
  while ((idx = lower.indexOf(needle, idx)) !== -1) {
    count++;
    idx += 1;
  }
  return count;
}

function applyDiagnosticLine(
  editor: HTMLElement,
  line: number,
  severity: "error" | "warning",
) {
  const lines = editor.innerHTML.split("\n");
  if (line < 1 || line > lines.length) return;
  lines[line - 1] =
    `<span class="hl-diagnostic-line hl-diagnostic-${severity}" data-diagnostic-line="${line}">${lines[line - 1]}</span>`;
  editor.innerHTML = lines.join("\n");
}

const CLOSE_CHARS = new Set([")", "]", "}", '"', "'"]);

/** If the char being typed is already the next char (auto-inserted), skip over it instead of doubling */
function handleOvertype(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!CLOSE_CHARS.has(e.key)) return;
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || !sel.focusNode) return;
  const node = sel.focusNode;
  const off = sel.focusOffset;
  // Get the character right after the cursor
  const text = node.nodeType === Node.TEXT_NODE ? (node.textContent ?? "") : "";
  if (
    node.nodeType === Node.TEXT_NODE &&
    off < text.length &&
    text[off] === e.key
  ) {
    e.preventDefault();
    // Move cursor forward by one character
    const range = document.createRange();
    range.setStart(node, off + 1);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

interface CodeEditorProps {
  filename: string;
  content: string;
  onSave: (content: string) => Promise<void>;
  onClose: () => void;
  initialView?: "studio" | "code";
  restoreFromHistory?: boolean;
}

export function CodeEditor({
  filename,
  content,
  onSave,
  onClose,
  initialView = "code",
  restoreFromHistory = false,
}: CodeEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const jarRef = useRef<ReturnType<typeof CodeJar> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const isYamlFile = YAML_EXT.has(
    filename.slice(filename.lastIndexOf(".")).toLowerCase(),
  );
  const [confirmClose, setConfirmClose] = useState(false);
  const [validationIssues, setValidationIssues] = useState<
    ConfigIssue[] | null
  >(null);
  const [diagnosticHighlight, setDiagnosticHighlight] = useState<{
    line: number;
    severity: "error" | "warning";
  } | null>(null);
  const [lineCount, setLineCount] = useState(1);
  const [showSearch, setShowSearch] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const firmwareVersion = useMachineStore((s) => s.espInfo?.version);
  const [view, setView] = useState<"studio" | "code">(
    isYamlFile ? initialView : "code",
  );
  const [studioSource, setStudioSource] = useState(content);
  const [studioKey, setStudioKey] = useState(0);
  const kind = detectKind(filename);

  const currentContent = useRef(content);
  const searchTermRef = useRef("");
  const matchIndexRef = useRef(0);
  const historyEntryRef = useRef(false);
  const ignoreNextPopstateRef = useRef(false);
  const requestCloseRef = useRef<() => void>(() => {});
  const diagnosticRef = useRef<{
    line: number;
    severity: "error" | "warning";
    original: string;
  } | null>(null);

  function updateLineCount(code: string) {
    // contentEditable often appends a trailing newline — don't count it as an extra line
    let count = code.split("\n").length;
    if (code.endsWith("\n")) count--;
    setLineCount(Math.max(1, count));
  }

  // Wrap the syntax highlighter to also apply search marks
  const makeHighlighter = useCallback((kind: FileKind) => {
    const base = getHighlighter(kind);
    return (editor: HTMLElement) => {
      base(editor);
      if (searchTermRef.current) {
        applySearchMarks(editor, searchTermRef.current, matchIndexRef.current);
      }
      if (diagnosticRef.current)
        applyDiagnosticLine(
          editor,
          diagnosticRef.current.line,
          diagnosticRef.current.severity,
        );
    };
  }, []);

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const jar = CodeJar(el, makeHighlighter(kind), { tab: "  " });
    jar.updateCode(currentContent.current);
    updateLineCount(currentContent.current);
    jar.onUpdate((code) => {
      if (
        diagnosticRef.current &&
        code.split("\n")[diagnosticRef.current.line - 1] !==
          diagnosticRef.current.original
      ) {
        diagnosticRef.current = null;
        setDiagnosticHighlight(null);
      }
      currentContent.current = code;
      setDirty(code !== content);
      updateLineCount(code);
      // Update match count as content changes
      if (searchTermRef.current) {
        const c = countMatches(code, searchTermRef.current);
        setMatchCount(c);
        if (matchIndexRef.current >= c) {
          matchIndexRef.current = Math.max(0, c - 1);
          setMatchIndex(matchIndexRef.current);
        }
      }
    });
    // Overtype handler must fire before CodeJar's keydown (capture phase)
    const handleYamlCommentShortcut = (event: KeyboardEvent) => {
      if (
        kind !== "yaml" ||
        (!event.metaKey && !event.ctrlKey) ||
        (event.key !== "/" && event.code !== "Slash")
      )
        return;
      event.preventDefault();
      const position = jar.save();
      const code = jar.toString();
      const toggled = toggleYamlLineComments(
        code,
        position.start,
        position.end,
      );
      if (toggled.code === code) return;
      jar.recordHistory();
      jar.updateCode(toggled.code);
      jar.restore({
        start: toggled.start,
        end: toggled.end,
        dir: position.dir,
      });
      jar.recordHistory();
    };
    el.addEventListener("keydown", handleOvertype, true);
    el.addEventListener("keydown", handleYamlCommentShortcut, true);
    jarRef.current = jar;
    return () => {
      el.removeEventListener("keydown", handleOvertype, true);
      el.removeEventListener("keydown", handleYamlCommentShortcut, true);
      jar.destroy();
    };
  }, [content, kind, makeHighlighter, view]);

  // Keep gutter horizontal position pinned when scrolling horizontally
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const onScroll = () => {
      if (gutterRef.current) {
        gutterRef.current.style.transform = `translateX(${scrollEl.scrollLeft}px)`;
      }
    };
    scrollEl.addEventListener("scroll", onScroll);
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, []);

  // Re-apply search highlights when term or active index changes, and scroll active into view
  useEffect(() => {
    if (!editorRef.current) return;
    const editor = editorRef.current;
    // Re-run the full highlighter (syntax + search marks)
    makeHighlighter(kind)(editor);
    // Scroll the active match into view
    requestAnimationFrame(() => {
      const active = editor.querySelector(".hl-search-active");
      if (active && scrollRef.current) {
        const scrollRect = scrollRef.current.getBoundingClientRect();
        const markRect = active.getBoundingClientRect();
        if (
          markRect.top < scrollRect.top ||
          markRect.bottom > scrollRect.bottom
        ) {
          active.scrollIntoView({ block: "center" });
        }
      }
    });
  }, [searchTerm, matchIndex, diagnosticHighlight, kind, makeHighlighter]);

  const jumpToDiagnostic = useCallback((issue: ConfigIssue) => {
    diagnosticRef.current = {
      line: issue.line,
      severity: issue.severity,
      original: currentContent.current.split("\n")[issue.line - 1] ?? "",
    };
    setDiagnosticHighlight({ line: issue.line, severity: issue.severity });
    setValidationIssues(null);
    setView("code");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const marker = editorRef.current?.querySelector(
          `[data-diagnostic-line="${issue.line}"]`,
        );
        marker?.scrollIntoView({ block: "center" });
        const node =
          marker &&
          document.createTreeWalker(marker, NodeFilter.SHOW_TEXT).nextNode();
        if (node) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.setStart(node, 0);
          range.collapse(true);
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        editorRef.current?.focus();
      }),
    );
  }, []);

  const handleSave = useCallback(
    async (force = false) => {
      if (isYamlFile && !force) {
        const issues = await validateFluidConfigForSave(
          currentContent.current,
          useMachineStore.getState().espInfo?.version,
        );
        if (issues.length) {
          setValidationIssues(issues);
          return false;
        }
      }
      setSaving(true);
      try {
        await onSave(currentContent.current);
        setDirty(false);
        if (isYamlFile) setSavedOnce(true);
        return true;
      } finally {
        setSaving(false);
      }
    },
    [onSave, isYamlFile],
  );

  const handleStudioChange = useCallback(
    (code: string) => {
      if (!code.includes("# Edited using Config Studio"))
        code = `# Edited using Config Studio\n${code}`;
      currentContent.current = code;
      setDirty(code !== content);
      updateLineCount(code);
      jarRef.current?.updateCode(code);
    },
    [content],
  );

  const switchToStudio = useCallback(() => {
    setStudioSource(currentContent.current);
    setStudioKey((key) => key + 1);
    setView("studio");
  }, []);

  const switchToCode = useCallback(() => {
    jarRef.current?.updateCode(currentContent.current);
    setView("code");
  }, []);

  const pushHistoryEntry = useCallback(() => {
    const currentState = window.history.state;
    window.history.pushState(
      currentState && typeof currentState === "object"
        ? { ...currentState, figuiCodeEditor: { filename } }
        : { figuiCodeEditor: { filename } },
      "",
      window.location.href,
    );
    historyEntryRef.current = true;
  }, []);

  const dismiss = useCallback(() => {
    if (historyEntryRef.current) {
      historyEntryRef.current = false;
      ignoreNextPopstateRef.current = true;
      window.history.back();
    }
    onClose();
  }, [onClose]);

  const handleRestart = useCallback(async () => {
    if (
      !confirm(
        "Restart the controller now? The config will take effect after reboot.",
      )
    )
      return;
    useMachineStore.getState().setRestarting(true);
    dismiss();
    sendCommand("[ESP444]RESTART").catch(() => {});
  }, [dismiss]);

  /** Attempt to close — if dirty, show confirmation; otherwise close immediately */
  function tryClose() {
    if (dirty) {
      setConfirmClose(true);
    } else {
      dismiss();
    }
  }

  async function confirmSaveAndClose() {
    const saved = await handleSave();
    if (!saved) return;
    setConfirmClose(false);
    dismiss();
  }

  function confirmDiscardAndClose() {
    setConfirmClose(false);
    dismiss();
  }

  requestCloseRef.current = tryClose;

  useEffect(() => {
    if (restoreFromHistory) {
      historyEntryRef.current = true;
    } else {
      pushHistoryEntry();
    }

    const handlePopState = () => {
      if (ignoreNextPopstateRef.current) {
        ignoreNextPopstateRef.current = false;
        return;
      }

      // Back moved to the page beneath the editor. Restore the same-URL entry
      // so a cancelled unsaved-changes prompt keeps the editor open.
      pushHistoryEntry();
      requestCloseRef.current();
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (historyEntryRef.current) {
        historyEntryRef.current = false;
        ignoreNextPopstateRef.current = true;
        window.history.back();
      }
    };
  }, [pushHistoryEntry, restoreFromHistory]);

  function handleDownload() {
    const blob = new Blob([currentContent.current], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function doSearch(term: string) {
    searchTermRef.current = term;
    matchIndexRef.current = 0;
    setSearchTerm(term);
    setMatchIndex(0);
    setMatchCount(countMatches(currentContent.current, term));
  }

  function nextMatch() {
    if (!matchCount) return;
    const next = (matchIndex + 1) % matchCount;
    matchIndexRef.current = next;
    setMatchIndex(next);
  }

  function prevMatch() {
    if (!matchCount) return;
    const prev = (matchIndex - 1 + matchCount) % matchCount;
    matchIndexRef.current = prev;
    setMatchIndex(prev);
  }

  function closeSearch() {
    searchTermRef.current = "";
    matchIndexRef.current = 0;
    setShowSearch(false);
    setSearchTerm("");
    setMatchCount(0);
    setMatchIndex(0);
  }

  function toggleSearch() {
    if (showSearch) {
      closeSearch();
    } else {
      setShowSearch(true);
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      handleSave();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "f") {
      e.preventDefault();
      toggleSearch();
    }
    if (e.key === "Escape" && !showSearch) {
      e.preventDefault();
      tryClose();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={tryClose}
    >
      <div
        className={`bg-surface border border-border shadow-xl flex flex-col animate-in ${
          isYamlFile
            ? "w-screen h-screen rounded-none"
            : "w-[90vw] h-[85vh] max-w-[1000px] rounded-sm"
        }`}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="panel-header justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate max-w-[120px] sm:max-w-[300px]">
              {filename}
            </span>
            <span className="text-sm font-mono px-1.5 py-0.5 rounded bg-elevated text-text-dim uppercase shrink-0">
              {kind}
            </span>
            {dirty && (
              <span className="text-sm text-warn font-semibold shrink-0">
                modified
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {isYamlFile && (
              <div className="mr-1 flex rounded-md border border-border bg-elevated p-0.5">
                <button
                  className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${view === "studio" ? "bg-surface text-accent shadow-sm" : "text-text-muted"}`}
                  onClick={switchToStudio}
                >
                  <SlidersHorizontal size={12} /> Studio
                </button>
                <button
                  className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${view === "code" ? "bg-surface text-accent shadow-sm" : "text-text-muted"}`}
                  onClick={switchToCode}
                >
                  <Code2 size={12} /> YAML
                </button>
              </div>
            )}
            <button
              className="btn btn-ghost text-sm py-1 px-2"
              onClick={toggleSearch}
              title="Search (Ctrl+F)"
            >
              <Search size={12} />
              <span className="hidden sm:inline"> Find</span>
            </button>
            <button
              className="btn btn-ghost text-sm py-1 px-2"
              onClick={handleDownload}
              title="Download"
            >
              <Download size={12} />
              <span className="hidden sm:inline"> Download</span>
            </button>
            <button
              className="btn btn-primary text-sm py-1 px-2"
              onClick={() => handleSave()}
              disabled={saving || !dirty}
              title="Save (Ctrl+S)"
            >
              <Save size={12} />
              <span className="hidden sm:inline">
                {" "}
                {saving ? "Saving…" : "Save"}
              </span>
            </button>
            {isYamlFile && savedOnce && !dirty && (
              <button
                className="btn btn-warn text-sm py-1 px-2"
                onClick={handleRestart}
                title="Restart controller to apply config"
              >
                <RotateCcw size={12} />
                <span className="hidden sm:inline"> Restart</span>
              </button>
            )}
            <button
              className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-elevated transition-colors ml-1"
              onClick={tryClose}
              title="Close"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Search bar */}
        {showSearch && (
          <div className="flex items-center gap-2 px-3 py-2 bg-elevated border-b border-border shrink-0">
            <Search size={13} className="text-text-dim shrink-0" />
            <input
              ref={searchRef}
              className="input-field flex-1 py-1 text-sm"
              placeholder="Search…"
              value={searchTerm}
              onChange={(e) => doSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.shiftKey) prevMatch();
                else if (e.key === "Enter") nextMatch();
                else if (e.key === "Escape") closeSearch();
              }}
              autoFocus
            />
            {searchTerm && (
              <span className="text-sm text-text-muted font-mono shrink-0">
                {matchCount > 0
                  ? `${matchIndex + 1}/${matchCount}`
                  : "No results"}
              </span>
            )}
            <button
              className="p-1 rounded hover:bg-surface text-text-muted hover:text-text-primary transition-colors"
              onClick={prevMatch}
              title="Previous (Shift+Enter)"
            >
              <ChevronUp size={14} />
            </button>
            <button
              className="p-1 rounded hover:bg-surface text-text-muted hover:text-text-primary transition-colors"
              onClick={nextMatch}
              title="Next (Enter)"
            >
              <ChevronDown size={14} />
            </button>
            <button
              className="p-1 rounded text-text-muted hover:text-text-primary transition-colors"
              onClick={closeSearch}
            >
              <X size={13} />
            </button>
          </div>
        )}

        {isYamlFile && (
          <div
            className={`${view === "studio" ? "flex" : "hidden"} min-h-0 flex-1`}
          >
            <ConfigStudio
              key={studioKey}
              content={studioSource}
              onChange={handleStudioChange}
              isActive={view === "studio"}
              firmwareVersion={firmwareVersion}
            />
          </div>
        )}
        <div
          ref={scrollRef}
          className={`${isYamlFile && view === "studio" ? "hidden" : "block"} flex-1 overflow-auto min-h-0 bg-elevated/50`}
        >
          <div className="flex min-h-full">
            {/* Gutter */}
            <div
              ref={gutterRef}
              className="code-gutter shrink-0 select-none z-10"
              aria-hidden="true"
            >
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i} className="code-gutter-line">
                  {i + 1}
                </div>
              ))}
            </div>
            {/* Code area */}
            <div className="flex-1 min-w-0">
              <div ref={editorRef} className="code-editor" />
            </div>
          </div>
        </div>
      </div>

      {/* Unsaved changes confirmation */}
      {confirmClose && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
          onClick={() => setConfirmClose(false)}
        >
          <div
            className="bg-surface border border-border rounded-sm shadow-xl p-5 max-w-sm w-full animate-in"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-base text-text-primary mb-1 font-semibold">
              Unsaved changes
            </p>
            <p className="text-sm text-text-muted mb-4">
              Do you want to save your changes to{" "}
              <span className="font-mono">{filename}</span> before closing?
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="btn btn-ghost text-sm py-1.5 px-3"
                onClick={() => setConfirmClose(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-ghost text-sm py-1.5 px-3 text-warn"
                onClick={confirmDiscardAndClose}
              >
                Don&apos;t Save
              </button>
              <button
                className="btn btn-primary text-sm py-1.5 px-3"
                onClick={confirmSaveAndClose}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
      {validationIssues && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4"
          onClick={() => setValidationIssues(null)}
        >
          <div
            className="flex max-h-[75vh] w-full max-w-xl flex-col rounded-lg border border-border bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-border px-5 py-4">
              <div className="text-base font-semibold text-text-primary">
                Configuration diagnostics
              </div>
              <div className="mt-1 text-sm text-text-muted">
                {validationIssues.filter((i) => i.severity === "error").length}{" "}
                errors ·{" "}
                {
                  validationIssues.filter((i) => i.severity === "warning")
                    .length
                }{" "}
                warnings
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-auto p-4">
              {validationIssues.map((issue, index) => (
                <button
                  key={index}
                  onClick={() => jumpToDiagnostic(issue)}
                  className={`flex w-full gap-3 rounded-md border p-3 text-left ${issue.severity === "error" ? "border-danger/30 bg-danger/10" : "border-warn/30 bg-warn/10"}`}
                >
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-xs ${issue.severity === "error" ? "text-danger" : "text-warn"}`}
                  >
                    L{issue.line}
                  </span>
                  <span>
                    <span className="block text-sm text-text-primary">
                      {issue.message}
                    </span>
                    {issue.path && (
                      <span className="mt-0.5 block font-mono text-xs text-text-muted">
                        {issue.path}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2 border-t border-border p-4">
              <button
                className="btn btn-ghost"
                onClick={() => setValidationIssues(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn-warn"
                onClick={() => {
                  setValidationIssues(null);
                  handleSave(true);
                }}
                title="Save without validation"
              >
                Save anyway
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setValidationIssues(null);
                  setView("code");
                }}
              >
                Review YAML
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const EDITABLE_EXT = new Set([
  ...GCODE_EXT,
  ...YAML_EXT,
  ".txt",
  ".cfg",
  ".ini",
  ".conf",
]);

export function isEditable(name: string): boolean {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return EDITABLE_EXT.has(ext);
}
