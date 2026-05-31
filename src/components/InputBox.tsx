/**
 * InputBox — segment-aware input area with cursor rendering and slash-command
 * suggestions.
 *
 * Renders InputSegment[] directly: each character carries its segment type,
 * so paste/file/media labels get colored backgrounds without offset remapping.
 *
 * Performance:
 *   - visualRows/cursorRowIdx/viewport computation is memoized so typing
 *     only rebuilds what actually changed.
 *   - Each visual row is rendered by a React.memo'd InputRow subcomponent.
 *     Rows without the cursor skip re-render entirely when cursor moves.
 */

import React, { useCallback, useContext, useEffect, useImperativeHandle, useMemo } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import useInput from "../ink/hooks/use-input.js";
import { useCommandRouter } from "../hooks/use-command-router.js";
import type { CommandSpec } from "@agenteam/types";
import { useInputState } from "../hooks/use-input-state.js";
import { CtrlCLayerContext } from "../hooks/use-ctrl-c-chain.js";
import { useSetPromptOverlay } from "../hooks/prompt-overlay-context.js";
import { theme } from "../lib/theme.js";
import { stringWidth } from "../ink/stringWidth.js";
import type { InputSegment } from "../types.js";
import { segmentLabel, totalLen } from "@agenteam/types";
import type { KeyboardEvent } from "../ink/events/keyboard-event.js";

/**
 * Imperative handle for the draft persistence layer: read the live segments
 * (for snapshot writes) and replace them (for restore) without remounting the
 * InputBox, which would tear down its Ctrl+C guards.
 */
export interface InputBoxControl {
  getSegments(): InputSegment[];
  setSegments(segs: InputSegment[]): void;
}

interface InputBoxProps {
  onSubmit: (text: string, segments: InputSegment[]) => void;
  onSteerSubmit?: (text: string, segments: InputSegment[]) => void;
  onSlashCommand?: (command: string) => void;
  onAttachment?: (paths: string[]) => void;
  /**
   * Invoked when the user hits Ctrl+Enter / Ctrl+\ with an EMPTY input box
   * to push the head of the reserved-input queue into the agent. When the
   * input has content, Ctrl+Enter still routes to `onSteerSubmit` as usual.
   */
  onFlushReserved?: () => void;
  isActive?: boolean;
  columns?: number;
  maxRows?: number;
  /**
   * Imperative handle (`InputBoxControl`) — accepted as a regular prop instead
   * of via `forwardRef` to sidestep edge cases in the custom Ink reconciler.
   * Used by draft persistence to read / replace segments without remounting.
   */
  controlRef?: React.MutableRefObject<InputBoxControl | null>;
  /**
   * Remote commands from the worker (via `useRemoteCommands`). Merged with
   * the built-in SLASH_COMMANDS table for autocomplete suggestions. Local
   * names win on conflict — see `getSlashCommandSuggestions`.
   */
  remoteCommands?: readonly CommandSpec[];
}

const PROMPT = `${theme.prompt.char} `;
const PROMPT_CONT = `${theme.promptCont.char}`;

// ── FlatChar: one display character tagged with its segment type ──

interface FlatChar {
  ch: string;
  type: "text" | "paste" | "file" | "media";
}

interface VisualRow {
  li: number;           // logical line index
  wi: number;           // wrap index within logical line
  chars: FlatChar[];
  displayStartIdx: number;
  /**
   * True when this row is the LAST wrap of its logical line AND there is at
   * least one more logical line after it — i.e. a manual newline ('\n')
   * sits right after this row's last visible char. The cursor position that
   * lives in that newline gap belongs to THIS row's trailing edge; otherwise
   * it falls into the gap between visualRows and renders nowhere.
   */
  endsWithNewline: boolean;
}

function buildFlatChars(segments: InputSegment[]): FlatChar[] {
  const flat: FlatChar[] = [];
  for (const seg of segments) {
    if (seg.type === "text") {
      for (const ch of Array.from(seg.content)) flat.push({ ch, type: "text" });
    } else {
      const label = segmentLabel(seg);
      for (const ch of Array.from(label)) flat.push({ ch, type: seg.type });
    }
  }
  return flat;
}

/**
 * Map content-space cursor position to display-space index in the flat char array.
 */
function cursorToDisplay(segments: InputSegment[], cursorPos: number): number {
  let contentOff = 0;
  let displayOff = 0;
  for (const seg of segments) {
    if (seg.type === "text") {
      const contentLen = seg.content.length;
      const displayLen = Array.from(seg.content).length;
      if (cursorPos <= contentOff + contentLen) {
        const relUtf16 = cursorPos - contentOff;
        const relChars = Array.from(seg.content.slice(0, relUtf16)).length;
        return displayOff + relChars;
      }
      contentOff += contentLen;
      displayOff += displayLen;
    } else {
      // paste (cursorLen = content.length), file/media (cursorLen = 1)
      const cursorLen = (seg.type === "paste") ? seg.content.length : 1;
      const label = segmentLabel(seg);
      const labelLen = Array.from(label).length;
      if (cursorPos <= contentOff) return displayOff;
      if (cursorPos <= contentOff + cursorLen) return displayOff + labelLen;
      contentOff += cursorLen;
      displayOff += labelLen;
    }
  }
  return displayOff;
}

/**
 * Reverse of cursorToDisplay: map a display-space index back to content-space
 * cursor position. For atomic segments (paste/file/media) the cursor is not
 * allowed to land mid-label; if displayIdx falls inside such a segment, snap
 * to the segment's trailing edge — matches left/right arrow atomic-skip
 * semantics in useInputState.
 */
function displayToCursor(segments: InputSegment[], displayIdx: number): number {
  let contentOff = 0;
  let displayOff = 0;
  for (const seg of segments) {
    if (seg.type === "text") {
      const contentLen = seg.content.length;
      const chars = Array.from(seg.content);
      const displayLen = chars.length;
      if (displayIdx <= displayOff + displayLen) {
        const relChars = Math.max(0, displayIdx - displayOff);
        const relUtf16 = chars.slice(0, relChars).join("").length;
        return contentOff + relUtf16;
      }
      contentOff += contentLen;
      displayOff += displayLen;
    } else {
      const cursorLen = (seg.type === "paste") ? seg.content.length : 1;
      const label = segmentLabel(seg);
      const labelLen = Array.from(label).length;
      if (displayIdx <= displayOff) return contentOff;
      if (displayIdx <= displayOff + labelLen) return contentOff + cursorLen;
      contentOff += cursorLen;
      displayOff += labelLen;
    }
  }
  return contentOff;
}

function wrapFlatLine(chars: FlatChar[], maxWidth: number): FlatChar[][] {
  if (maxWidth <= 0 || chars.length === 0) return [chars];
  const rows: FlatChar[][] = [];
  let row: FlatChar[] = [];
  let w = 0;
  for (const fc of chars) {
    const cw = stringWidth(fc.ch);
    if (w + cw > maxWidth && row.length > 0) {
      rows.push(row);
      row = [];
      w = 0;
    }
    row.push(fc);
    w += cw;
  }
  rows.push(row);
  return rows;
}

const CHUNK_STYLE = {
  paste: { backgroundColor: theme.inputChunk.paste.bg, color: theme.inputChunk.paste.fg },
  file:  { backgroundColor: theme.inputChunk.file.bg,  color: theme.inputChunk.file.fg },
  media: { backgroundColor: theme.inputChunk.media.bg, color: theme.inputChunk.media.fg },
} as const;

/**
 * Render a row's <Text> elements.  cursorRel < 0 means cursor is NOT in this
 * row; cursorRel === chars.length is a valid "cursor at end of row" when the
 * row allows a trailing cursor cell (last row, or any row immediately
 * followed by a manual newline).
 */
function renderRowElements(
  chars: FlatChar[],
  cursorRel: number,
  allowTrailingCursor: boolean,
): React.JSX.Element[] {
  const elements: React.JSX.Element[] = [];
  let ek = 0;
  const cursorInRow = cursorRel >= 0 && (cursorRel < chars.length || (allowTrailingCursor && cursorRel === chars.length));

  let i = 0;
  while (i < chars.length) {
    if (cursorInRow && i === cursorRel) {
      const fc = chars[i]!;
      const style = fc.type !== "text" ? CHUNK_STYLE[fc.type] : undefined;
      elements.push(
        style
          ? <Text key={ek++} inverse backgroundColor={style.backgroundColor}>{fc.ch}</Text>
          : <Text key={ek++} inverse>{fc.ch}</Text>
      );
      i++;
      continue;
    }

    const startType = chars[i]!.type;
    let end = i + 1;
    while (end < chars.length && chars[end]!.type === startType && !(cursorInRow && end === cursorRel)) {
      end++;
    }
    const merged = chars.slice(i, end).map(fc => fc.ch).join("");
    const style = startType !== "text" ? CHUNK_STYLE[startType] : undefined;
    elements.push(
      style
        ? <Text key={ek++} backgroundColor={style.backgroundColor} color={style.color}>{merged}</Text>
        : <Text key={ek++}>{merged}</Text>
    );
    i = end;
  }

  if (cursorInRow && cursorRel === chars.length) {
    elements.push(<Text key={ek++} inverse>{" "}</Text>);
  }

  return elements;
}

interface InputRowProps {
  chars: FlatChar[];
  /** Relative cursor position inside this row; -1 if cursor not in this row. */
  cursorRel: number;
  /**
   * Whether this row may render a trailing inverse cell when the cursor sits
   * at `cursorRel === chars.length` — true for the last visible row or for
   * any row that ends with a manual '\n'.
   */
  allowTrailingCursor: boolean;
  isFirstLine: boolean;
}

/**
 * React.memo'd row: when the cursor moves to a different row, all other rows
 * receive the same props as last render (`cursorRel === -1`, same `chars` ref
 * from the memoized visualRows) and short-circuit re-rendering.
 */
const InputRow = React.memo(function InputRow({
  chars,
  cursorRel,
  allowTrailingCursor,
  isFirstLine,
}: InputRowProps): React.JSX.Element {
  const prompt = isFirstLine
    ? <Text color={theme.prompt.color} bold>{PROMPT}</Text>
    : <Text dimColor>{PROMPT_CONT}</Text>;

  const elements = renderRowElements(chars, cursorRel, allowTrailingCursor);

  return (
    <Box>
      {prompt}
      {elements.length > 0 ? elements : null}
    </Box>
  );
});

export function InputBox({
  onSubmit,
  onSteerSubmit,
  onSlashCommand,
  onAttachment,
  onFlushReserved,
  isActive = true,
  columns,
  maxRows,
  controlRef,
  remoteCommands,
}: InputBoxProps): React.JSX.Element {
  const { text, segments, cursorPos, handleInput, setText, setSegments, setCursor, clear: clearInput } = useInputState({
    onSubmit,
    onSteerSubmit,
    onSlashCommand,
    onAttachment,
  });

  // Imperative handle for draft persistence: getSegments reads through a ref
  // so the handle identity is stable across keystrokes.
  const segsHandleRef = React.useRef(segments);
  segsHandleRef.current = segments;
  useImperativeHandle(controlRef, () => ({
    getSegments: () => segsHandleRef.current,
    setSegments,
  }), [setSegments]);

  // ── Ctrl+C guard: clear input if non-empty ──
  const layer = useContext(CtrlCLayerContext);
  const segmentsRef = React.useRef(segments);
  segmentsRef.current = segments;

  // Refs for vertical cursor movement on Up/Down. wrappedHandleInput is
  // defined before visualRows/displayCursor/cursorRowIdx in source order, but
  // it's invoked later (via useInput), so reading through refs is safe.
  const visualRowsRef = React.useRef<VisualRow[]>([]);
  const displayCursorRef = React.useRef(0);
  const cursorRowIdxRef = React.useRef(0);

  // Home/End live on the Box (focus-routed via onKeyDown), not in useInputState.
  // Ctrl+Home / Ctrl+End are reserved for history scroll (use-scroll-keys via
  // useInput) — let those bubble untouched so they don't double-trigger as a
  // cursor jump here AND a viewport jump there.
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.ctrl) return;
    if (e.key === "home") { setCursor(0); e.preventDefault(); }
    else if (e.key === "end") { setCursor(totalLen(segmentsRef.current)); e.preventDefault(); }
  }, [setCursor]);
  const clearRef = React.useRef(clearInput);
  clearRef.current = clearInput;

  useEffect(() => {
    layer.register("input-clear", 20, () => {
      if (totalLen(segmentsRef.current) > 0) {
        clearRef.current();
        return true;
      }
      return false;
    });
    return () => layer.unregister("input-clear");
  }, [layer]);

  const router = useCommandRouter(text, remoteCommands);

  const overlayData = useMemo(
    () => router.isActive ? {
      suggestions: router.suggestions,
      selectedIdx: router.selectedIdx,
      argIndex: router.argIndex,
      matchedCommand: router.matchedCommand,
    } : null,
    [router.isActive, router.suggestions, router.selectedIdx, router.argIndex, router.matchedCommand],
  );
  useSetPromptOverlay(overlayData);

  const wrappedHandleInput: typeof handleInput = (input, key, event) => {
    if (key.tab && router.isActive) {
      const completed = router.tabComplete(text);
      if (completed) {
        setText(completed);
      }
      return;
    }
    if (key.upArrow && router.isActive) { router.moveUp(); return; }
    if (key.downArrow && router.isActive) { router.moveDown(); return; }
    if (key.return && router.isActive) {
      const cmd = router.confirmSelected();
      if (cmd && onSlashCommand) {
        onSlashCommand(`/${cmd}`);
        clearInput();
        return;
      }
    }

    // Vertical cursor movement on Up/Down when input is non-empty.
    // Walks the wrapped+manual-newline visual rows; if there's no row to
    // jump to (top/bottom edge, or single-row input), this is a no-op.
    // Empty input falls through to useInputState's history/draft logic.
    if ((key.upArrow || key.downArrow) && !key.ctrl && !key.meta && !key.shift) {
      if (totalLen(segments) > 0) {
        const rows = visualRowsRef.current;
        const cur = cursorRowIdxRef.current;
        const targetIdx = key.upArrow ? cur - 1 : cur + 1;
        if (targetIdx < 0 || targetIdx >= rows.length) return;
        const curRow = rows[cur]!;
        const tgtRow = rows[targetIdx]!;
        const col = displayCursorRef.current - curRow.displayStartIdx;
        const tgtDisplay = tgtRow.displayStartIdx + Math.min(col, tgtRow.chars.length);
        setCursor(displayToCursor(segments, tgtDisplay));
        return;
      }
    }

    // Empty-input Ctrl+Enter / Ctrl+\ → flush reserved-queue head.
    // Non-empty input keeps the existing steer-submit semantics handled by
    // useInputState; we only short-circuit when there is nothing to steer.
    if (onFlushReserved && totalLen(segments) === 0) {
      const isCtrlEnter = key.return && key.ctrl;
      const isCtrlBackslash = key.ctrl && input === "\\";
      if (isCtrlEnter || isCtrlBackslash) {
        onFlushReserved();
        return;
      }
    }
    handleInput(input, key, event);
  };

  useInput(wrappedHandleInput, { isActive });

  const cols = columns ?? process.stdout.columns ?? 80;
  const promptWidth = stringWidth(PROMPT);
  const contPromptWidth = stringWidth(PROMPT_CONT);

  const flatChars = useMemo(() => buildFlatChars(segments), [segments]);
  const displayCursor = useMemo(() => cursorToDisplay(segments, cursorPos), [segments, cursorPos]);

  const logicalLines = useMemo(() => {
    const lines: FlatChar[][] = [[]];
    for (const fc of flatChars) {
      if (fc.ch === "\n") {
        lines.push([]);
      } else {
        lines[lines.length - 1]!.push(fc);
      }
    }
    return lines;
  }, [flatChars]);

  // ── Memoized visual row layout ──
  // Rebuilt only when the characters or wrap width change, NOT on cursor-only
  // moves.  This keeps the chars[] references stable so InputRow.memo hits.
  const visualRows = useMemo<VisualRow[]>(() => {
    const rows: VisualRow[] = [];
    let dIdx = 0;
    for (let li = 0; li < logicalLines.length; li++) {
      const maxW = li === 0 ? Math.max(cols - promptWidth, 10) : Math.max(cols - contPromptWidth, 10);
      const wrapped = wrapFlatLine(logicalLines[li]!, maxW);
      const hasNextLine = li < logicalLines.length - 1;
      for (let wi = 0; wi < wrapped.length; wi++) {
        const isLastWrap = wi === wrapped.length - 1;
        rows.push({
          li,
          wi,
          chars: wrapped[wi]!,
          displayStartIdx: dIdx,
          endsWithNewline: isLastWrap && hasNextLine,
        });
        dIdx += wrapped[wi]!.length;
      }
      if (hasNextLine) dIdx += 1; // \n
    }
    return rows;
  }, [logicalLines, cols, promptWidth, contPromptWidth]);

  // Cursor row is cheap to recompute; depends on cursor position only.
  const cursorRowIdx = useMemo(() => {
    let idx = visualRows.length - 1;
    for (let r = 0; r < visualRows.length; r++) {
      const vr = visualRows[r]!;
      const rowEnd = vr.displayStartIdx + vr.chars.length;
      if (displayCursor >= vr.displayStartIdx && displayCursor < rowEnd) {
        return r;
      }
      // Trailing-edge case: cursor lives in the '\n' gap after this row.
      // That position is logically "end of this row" — keep it on this row
      // instead of letting it fall through to the next row's pre-startIdx
      // gap (which renders nothing).
      if (displayCursor === rowEnd && vr.endsWithNewline) {
        return r;
      }
      if (r === visualRows.length - 1 && displayCursor === rowEnd) {
        idx = r;
      }
    }
    return idx;
  }, [visualRows, displayCursor]);

  // Publish layout/cursor info for wrappedHandleInput's Up/Down branch.
  visualRowsRef.current = visualRows;
  displayCursorRef.current = displayCursor;
  cursorRowIdxRef.current = cursorRowIdx;

  // Viewport slicing centered on cursor when input exceeds maxRows.
  const { viewStart, viewEnd } = useMemo(() => {
    let start = 0;
    let end = visualRows.length;
    if (maxRows != null && maxRows > 0 && visualRows.length > maxRows) {
      const halfAbove = Math.floor((maxRows - 1) * 0.7);
      start = cursorRowIdx - halfAbove;
      end = start + maxRows;
      if (start < 0) {
        start = 0;
        end = maxRows;
      }
      if (end > visualRows.length) {
        end = visualRows.length;
        start = Math.max(0, end - maxRows);
      }
    }
    return { viewStart: start, viewEnd: end };
  }, [visualRows.length, cursorRowIdx, maxRows]);

  // Render visible rows via memoized InputRow subcomponent
  const rows: React.JSX.Element[] = [];
  for (let r = viewStart; r < viewEnd; r++) {
    const vr = visualRows[r]!;
    const isFirstLine = vr.li === 0 && vr.wi === 0;
    const isLast = r === visualRows.length - 1;
    // Rows that need a trailing cursor cell: the very last row, or any row
    // whose logical line ends with a manual newline (cursor sits in the '\n'
    // gap belongs to THIS row's tail, not the next row's head).
    const allowTrailingCursor = isLast || vr.endsWithNewline;

    // cursorRel = -1 means "cursor not in this row"; InputRow.memo relies on
    // this being a stable primitive so non-cursor rows bail out of re-render.
    const rowEnd = vr.displayStartIdx + vr.chars.length;
    let cursorRel = -1;
    if (displayCursor >= vr.displayStartIdx && displayCursor < rowEnd) {
      cursorRel = displayCursor - vr.displayStartIdx;
    } else if (allowTrailingCursor && displayCursor === rowEnd) {
      cursorRel = vr.chars.length;
    }

    rows.push(
      <InputRow
        key={`${vr.li}-${vr.wi}`}
        chars={vr.chars}
        cursorRel={cursorRel}
        allowTrailingCursor={allowTrailingCursor}
        isFirstLine={isFirstLine}
      />
    );
  }

  if (rows.length === 0) {
    rows.push(
      <Box key="empty">
        <Text color={theme.prompt.color} bold>{PROMPT}</Text>
        <Text inverse>{" "}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      {rows}
    </Box>
  );
}
