import { uiText as __uiText, formatUi } from '../lib/i18n'
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
import { RemoteConfigStudio } from "./RemoteConfigStudio";
import { useViewportMetrics } from "../lib/viewport";
import {
  validateFluidConfigForSave,
  type ConfigIssue,
} from "../lib/configValidation";
import { GCODE_EXTENSION_SET } from "../lib/gcodeFiles";
import {
  indentLines,
  smartHomeOffset,
  indentBackspace,
} from "../lib/editorIndent";
import { applySearchMarks, findEditorMatches } from "../lib/editorSearch";

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

/** Toggle column-one YAML comments while preserving each line's indentation. */
export function toggleYamlLineComments(
  code: string,
  selectionStart: number,
  selectionEnd: number,
) {
  const anchor = Math.max(0, Math.min(code.length, selectionStart));
  const focus = Math.max(0, Math.min(code.length, selectionEnd));
  const low = Math.min(anchor, focus);
  const high = Math.max(anchor, focus);
  const lineStart = low === 0 ? 0 : code.lastIndexOf("\n", low - 1) + 1;
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
        edits.push({ at: offset, remove: 0, insert: "# " });
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
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
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
  const viewport = useViewportMetrics();
  const canUseStudio = viewport.innerWidth >= 768;
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
  const [cursor, setCursor] = useState({ line: 1, column: 1, selected: 0 });
  const [showSearch, setShowSearch] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [view, setView] = useState<"studio" | "code">(
    isYamlFile && canUseStudio ? initialView : "code",
  );
  const [studioSource, setStudioSource] = useState(content);
  const [studioKey, setStudioKey] = useState(0);
  const kind = detectKind(filename);

  const currentContent = useRef(content);
  const savedContent = useRef(content);
  const composingRef = useRef(false);
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
    setLineCount(code.split("\n").length);
  }

  useEffect(() => {
    savedContent.current = content;
  }, [content]);

  // Wrap the syntax highlighter to also apply search marks
  const makeHighlighter = useCallback((kind: FileKind) => {
    const base = getHighlighter(kind);
    return (editor: HTMLElement) => {
      if (composingRef.current) return;
      base(editor);
      // Decoration only: clipboard text and cursor offsets keep the real spaces.
      editor.innerHTML = editor.innerHTML.replace(
        /^[ \t]+/gm,
        '<span class="hl-indent">$&</span>',
      );
      if (diagnosticRef.current)
        applyDiagnosticLine(
          editor,
          diagnosticRef.current.line,
          diagnosticRef.current.severity,
        );
      if (searchTermRef.current) {
        applySearchMarks(editor, searchTermRef.current, matchIndexRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const jar = CodeJar(el, makeHighlighter(kind), { tab: "  " });
    // CodeJar sets wrapping inline; wrapped lines otherwise drift from the gutter.
    el.style.whiteSpace = "pre";
    el.style.overflowWrap = "normal";
    el.style.overflowY = "visible";
    jar.updateCode(currentContent.current);
    updateLineCount(currentContent.current);
    const syncCode = (code: string) => {
      if (
        diagnosticRef.current &&
        code.split("\n")[diagnosticRef.current.line - 1] !==
          diagnosticRef.current.original
      ) {
        diagnosticRef.current = null;
        setDiagnosticHighlight(null);
      }
      currentContent.current = code;
      setDirty(code !== savedContent.current);
      updateLineCount(code);
      // Update match count as content changes
      if (searchTermRef.current) {
        const c = findEditorMatches(code, searchTermRef.current).length;
        setMatchCount(c);
        if (matchIndexRef.current >= c) {
          matchIndexRef.current = Math.max(0, c - 1);
          setMatchIndex(matchIndexRef.current);
        }
      }
    };
    jar.onUpdate(syncCode);
    const updateCursor = () => {
      const selection = window.getSelection();
      if (
        !selection?.focusNode ||
        !el.contains(selection.focusNode) ||
        !selection.anchorNode ||
        !el.contains(selection.anchorNode)
      )
        return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.setEnd(selection.focusNode, selection.focusOffset);
      const before = range.toString();
      const line = before.split("\n").length;
      const column =
        before
          .slice(before.lastIndexOf("\n") + 1)
          .split("")
          .reduce((col, char) => col + (char === "\t" ? 2 - (col % 2) : 1), 0) +
        1;
      const selected = selection.toString().length;
      setCursor((previous) =>
        previous.line === line &&
        previous.column === column &&
        previous.selected === selected
          ? previous
          : { line, column, selected },
      );
    };
    let highlightTimer = 0;
    let historyTimer = 0;
    let historyPending = false;
    const finishHistory = () => {
      window.clearTimeout(historyTimer);
      if (historyPending && !composingRef.current) {
        jar.recordHistory();
        historyPending = false;
      }
    };
    const beginInput = () => {
      if (!historyPending && !composingRef.current) jar.recordHistory();
      historyPending = true;
    };
    const onInput = () => {
      // Mobile keyboards and dictation may never dispatch a keyboard keyup.
      syncCode(jar.toString());
      updateCursor();
      historyPending = true;
      window.clearTimeout(highlightTimer);
      window.clearTimeout(historyTimer);
      if (composingRef.current) return;
      highlightTimer = window.setTimeout(() => {
        const position = document.activeElement === el ? jar.save() : null;
        makeHighlighter(kind)(el);
        if (position) jar.restore(position);
      }, 30);
      historyTimer = window.setTimeout(finishHistory, 300);
    };
    const onCompositionStart = () => {
      finishHistory();
      beginInput();
      composingRef.current = true;
    };
    const onCompositionEnd = () => {
      composingRef.current = false;
      onInput();
    };
    const recordOnFocus = () => jar.recordHistory();
    // Capture before CodeJar: its default Tab replaces a selected block.
    const handleIndent = (event: KeyboardEvent) => {
      if (event.isComposing || composingRef.current) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        finishHistory();
        return;
      }
      if (
        !["Tab", "Home", "Backspace"].includes(event.key) ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      const position = jar.save();
      const code = jar.toString();
      if (event.key === "Home") {
        event.preventDefault();
        const end = smartHomeOffset(code, position.end);
        const start = event.shiftKey ? position.start : end;
        jar.restore({ start, end, dir: start <= end ? "->" : "<-" });
        updateCursor();
        return;
      }
      if (
        event.key === "Tab" &&
        position.start === position.end &&
        !event.shiftKey
      )
        return;
      const changed =
        event.key === "Backspace"
          ? indentBackspace(code, position.start, position.end)
          : indentLines(code, position.start, position.end, event.shiftKey);
      if (!changed) return;
      event.preventDefault();
      if (changed.code === code) return;
      finishHistory();
      jar.recordHistory();
      jar.updateCode(changed.code);
      jar.restore({ ...changed, dir: position.dir });
      jar.recordHistory();
      updateCursor();
    };
    // Overtype handler must fire before CodeJar's keydown (capture phase)
    const handleYamlCommentShortcut = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        composingRef.current ||
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
    el.addEventListener("keydown", handleIndent, true);
    el.addEventListener("keydown", handleYamlCommentShortcut, true);
    el.addEventListener("focus", recordOnFocus, { once: true });
    // Capture before CodeJar marks itself unfocused, so quick saves retain undo.
    el.addEventListener("blur", finishHistory, true);
    el.addEventListener("beforeinput", beginInput);
    el.addEventListener("input", onInput);
    el.addEventListener("compositionstart", onCompositionStart);
    el.addEventListener("compositionend", onCompositionEnd);
    document.addEventListener("selectionchange", updateCursor);
    el.addEventListener("keyup", updateCursor);
    updateCursor();
    jarRef.current = jar;
    return () => {
      el.removeEventListener("keydown", handleOvertype, true);
      el.removeEventListener("keydown", handleIndent, true);
      el.removeEventListener("keydown", handleYamlCommentShortcut, true);
      el.removeEventListener("focus", recordOnFocus);
      el.removeEventListener("blur", finishHistory, true);
      el.removeEventListener("beforeinput", beginInput);
      el.removeEventListener("input", onInput);
      el.removeEventListener("compositionstart", onCompositionStart);
      el.removeEventListener("compositionend", onCompositionEnd);
      document.removeEventListener("selectionchange", updateCursor);
      el.removeEventListener("keyup", updateCursor);
      window.clearTimeout(highlightTimer);
      window.clearTimeout(historyTimer);
      composingRef.current = false;
      jar.destroy();
    };
  }, [content, kind, makeHighlighter, view]);

  // Re-apply search highlights when term or active index changes, and scroll active into view
  useEffect(() => {
    if (!editorRef.current || composingRef.current) return;
    const editor = editorRef.current;
    const position =
      document.activeElement === editor ? jarRef.current?.save() : null;
    // Re-run the full highlighter (syntax + search marks)
    makeHighlighter(kind)(editor);
    if (position) jarRef.current?.restore(position);
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
      const code = currentContent.current;
      if (isYamlFile && !force) {
        const issues = await validateFluidConfigForSave(
          code,
          useMachineStore.getState().espInfo?.version,
        );
        if (issues.length) {
          setValidationIssues(issues);
          return false;
        }
      }
      setSaving(true);
      try {
        await onSave(code);
        savedContent.current = code;
        setDirty(currentContent.current !== code);
        if (isYamlFile) setSavedOnce(true);
        return true;
      } catch (e) {
        alert(e instanceof Error ? e.message : __uiText("components.CodeEditor.alert_coverage.1", "Save failed"));
        return false;
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
      setDirty(code !== savedContent.current);
      updateLineCount(code);
      jarRef.current?.updateCode(code);
    },
    [content],
  );

  const switchToStudio = useCallback(() => {
    if (window.innerWidth < 768) return;
    setStudioSource(currentContent.current);
    setStudioKey((key) => key + 1);
    setView("studio");
  }, []);

  const switchToCode = useCallback(() => {
    jarRef.current?.updateCode(currentContent.current);
    setView("code");
  }, []);

  useEffect(() => {
    if (!canUseStudio && view === "studio") switchToCode();
  }, [canUseStudio, view, switchToCode]);

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
        __uiText("components.CodeEditor.notice.1", "Restart the controller now? The config will take effect after reboot."),
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
    setMatchCount(findEditorMatches(currentContent.current, term).length);
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
      className="fixed z-50 flex items-center justify-center bg-black/50"
      // Mobile keyboards can resize and pan only the visual viewport.
      style={{
        top: viewport.visualViewportOffsetTop,
        left: viewport.visualViewportOffsetLeft,
        width: viewport.visualViewportWidth ?? viewport.innerWidth,
        height: viewport.visualViewportHeight ?? viewport.innerHeight,
      }}
      onClick={tryClose}
    >
      <div
        className={`bg-surface border border-border shadow-xl flex flex-col min-h-0 overflow-hidden animate-in ${
          isYamlFile
            ? "w-full h-full rounded-none"
            : "w-[90%] h-[85%] max-w-[1000px] rounded-sm"
        }`}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="panel-header flex-wrap justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate max-w-[120px] sm:max-w-[300px]">
              {filename}
            </span>
            <span className="text-sm font-mono px-1.5 py-0.5 rounded bg-elevated text-text-dim uppercase shrink-0">
              {kind}
            </span>
            {dirty && (
              <span className="text-sm text-warn font-semibold shrink-0">
                {__uiText("components.CodeEditor.modified.1", "modified")}
              </span>
            )}
          </div>
          <div className="flex max-w-full flex-wrap items-center justify-end gap-1 shrink-0">
            {isYamlFile && (
              <div className="mr-1 flex rounded-md border border-border bg-elevated p-0.5">
                <button
                  className={`flex items-center gap-1 rounded px-2 py-1 text-xs disabled:opacity-40 ${view === "studio" ? "bg-surface text-accent shadow-sm" : "text-text-muted"}`}
                  onClick={switchToStudio}
                  disabled={!canUseStudio}
                  title={
                    !canUseStudio
                      ? __uiText("components.CodeEditor.config_studio_is_available_on_table.1", "Config Studio is available on tablets and desktops")
                      : undefined
                  }
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
              title={__uiText("components.CodeEditor.search_ctrl_f.1", "Search (Ctrl+F)")}
            >
              <Search size={12} />
              <span className="hidden sm:inline"> {__uiText("components.CodeEditor.find.1", "Find")}</span>
            </button>
            <button
              className="btn btn-ghost text-sm py-1 px-2"
              onClick={handleDownload}
              title={__uiText("components.CodeEditor.download.1", "Download")}
            >
              <Download size={12} />
              <span className="hidden sm:inline"> {__uiText("components.CodeEditor.download.2", "Download")}</span>
            </button>
            <button
              className="btn btn-primary text-sm py-1 px-2"
              onClick={() => handleSave()}
              disabled={saving || !dirty}
              title={__uiText("components.CodeEditor.save_ctrl_s.1", "Save (Ctrl+S)")}
            >
              <Save size={12} />
              <span className="hidden sm:inline">
                {" "}
                {saving ? __uiText("components.CodeEditor.saving.1", "Saving…") : __uiText("components.CodeEditor.save.1", "Save")}
              </span>
            </button>
            {isYamlFile && savedOnce && !dirty && (
              <button
                className="btn btn-warn text-sm py-1 px-2"
                onClick={handleRestart}
                title={__uiText("components.CodeEditor.restart_controller_to_apply_config.1", "Restart controller to apply config")}
              >
                <RotateCcw size={12} />
                <span className="hidden sm:inline"> {__uiText("components.CodeEditor.restart.1", "Restart")}</span>
              </button>
            )}
            <button
              className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-elevated transition-colors ml-1"
              onClick={tryClose}
              title={__uiText("components.CodeEditor.close.1", "Close")}
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
              placeholder={__uiText("components.CodeEditor.search.1", "Search…")}
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
                  : __uiText("components.CodeEditor.no_results.1", "No results")}
              </span>
            )}
            <button
              className="p-1 rounded hover:bg-surface text-text-muted hover:text-text-primary transition-colors"
              onClick={prevMatch}
              title={__uiText("components.CodeEditor.previous_shift_enter.1", "Previous (Shift+Enter)")}
            >
              <ChevronUp size={14} />
            </button>
            <button
              className="p-1 rounded hover:bg-surface text-text-muted hover:text-text-primary transition-colors"
              onClick={nextMatch}
              title={__uiText("components.CodeEditor.next_enter.1", "Next (Enter)")}
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
            <RemoteConfigStudio
              key={studioKey}
              content={studioSource}
              onChange={handleStudioChange}
              isActive={view === "studio"}
            />
          </div>
        )}
        <div
          ref={scrollRef}
          className={`${isYamlFile && view === "studio" ? "hidden" : "block"} flex-1 overflow-auto min-h-0 bg-elevated/50`}
        >
          <div dir="ltr" className="flex min-h-full min-w-full w-max">
            {/* Gutter */}
            <div
              ref={gutterRef}
              className="code-gutter shrink-0 select-none z-10"
              aria-hidden="true"
            >
              {Array.from({ length: lineCount }, (_, i) => (
                <div
                  key={i}
                  className={`code-gutter-line ${cursor.line === i + 1 ? "code-gutter-active" : ""}`}
                >
                  {i + 1}
                </div>
              ))}
            </div>
            {/* Code area */}
            <div className="flex-1 relative">
              <div
                className="code-active-line"
                aria-hidden="true"
                style={{ top: `calc(16px + ${cursor.line - 1} * 1.6em)` }}
              />
              <div
                ref={editorRef}
                dir="ltr"
                className="code-editor"
                role="textbox"
                aria-label={formatUi(__uiText("components.CodeEditor.tail_coverage.1", "{v0} code editor"), { v0: filename })}
                aria-multiline="true"
                aria-describedby="code-editor-help"
                autoCapitalize="off"
                autoCorrect="off"
              />
            </div>
          </div>
        </div>
        {view === "code" && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border bg-surface px-3 py-1 text-xs text-text-muted shrink-0">
            <span className="font-mono">
              {__uiText("components.CodeEditor.coverage.3", "Ln")} {cursor.line}, Col {cursor.column}
              {cursor.selected > 0 && formatUi(__uiText("components.CodeEditor.tail_coverage.2", " · {v0} selected"), { v0: cursor.selected })} {__uiText("components.CodeEditor.coverage.1", "· Spaces: 2")}
            </span>
            <span id="code-editor-help">
              {__uiText("components.CodeEditor.tab_shift_tab_indent_selection_past.1", "Tab / Shift+Tab: indent selection · Paste keeps spacing")}
            </span>
          </div>
        )}
      </div>

      {/* Unsaved changes confirmation */}
      {confirmClose && (
        <div
          className="absolute inset-0 z-[60] flex items-center justify-center bg-black/40 p-3"
          onClick={() => setConfirmClose(false)}
        >
          <div
            className="bg-surface border border-border rounded-sm shadow-xl p-5 max-w-sm w-full max-h-full overflow-auto animate-in"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-base text-text-primary mb-1 font-semibold">
              {__uiText("components.CodeEditor.unsaved_changes.1", "Unsaved changes")}
            </p>
            <p className="text-sm text-text-muted mb-4">
              {__uiText("components.CodeEditor.do_you_want_to_save_your_changes_to.1", "Do you want to save your changes to")}{" "}
              <span className="font-mono">{filename}</span> {__uiText("components.CodeEditor.before_closing.1", "before closing?")}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                className="btn btn-ghost text-sm py-1.5 px-3"
                onClick={() => setConfirmClose(false)}
              >
                {__uiText("components.CodeEditor.cancel.1", "Cancel")}
              </button>
              <button
                className="btn btn-ghost text-sm py-1.5 px-3 text-warn"
                onClick={confirmDiscardAndClose}
              >
                {__uiText("components.CodeEditor.coverage.2", "Don't Save")}
              </button>
              <button
                className="btn btn-primary text-sm py-1.5 px-3"
                onClick={confirmSaveAndClose}
              >
                {__uiText("components.CodeEditor.save.2", "Save")}
              </button>
            </div>
          </div>
        </div>
      )}
      {validationIssues && (
        <div
          className="absolute inset-0 z-[70] flex items-center justify-center bg-black/55 p-4"
          onClick={() => setValidationIssues(null)}
        >
          <div
            className="flex max-h-full w-full max-w-xl flex-col overflow-auto rounded-lg border border-border bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="shrink-0 border-b border-border px-5 py-4">
              <div className="text-base font-semibold text-text-primary">
                {__uiText("components.CodeEditor.configuration_diagnostics.1", "Configuration diagnostics")}
              </div>
              <div className="mt-1 text-sm text-text-muted">
                {validationIssues.filter((i) => i.severity === "error").length}{" "}
                {__uiText("components.CodeEditor.errors.1", "errors ·")}{" "}
                {
                  validationIssues.filter((i) => i.severity === "warning")
                    .length
                }{" "}
                {__uiText("components.CodeEditor.warnings.1", "warnings")}
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
            <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border p-4">
              <button
                className="btn btn-ghost"
                onClick={() => setValidationIssues(null)}
              >
                {__uiText("components.CodeEditor.cancel.2", "Cancel")}
              </button>
              <button
                className="btn btn-warn"
                onClick={() => {
                  setValidationIssues(null);
                  handleSave(true);
                }}
                title={__uiText("components.CodeEditor.save_without_validation.1", "Save without validation")}
              >
                {__uiText("components.CodeEditor.save_anyway.1", "Save anyway")}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setValidationIssues(null);
                  setView("code");
                }}
              >
                {__uiText("components.CodeEditor.review_yaml.1", "Review YAML")}
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

// The highlighter rebuilds the whole document after every edit and the gutter
// renders one element per line, so a multi-megabyte job file freezes the tab.
export const MAX_EDITABLE_BYTES = 512 * 1024;

export function isEditable(name: string, size = 0): boolean {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return EDITABLE_EXT.has(ext) && size <= MAX_EDITABLE_BYTES;
}
