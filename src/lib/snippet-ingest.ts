/**
 * @desc Insert an IDE snippet payload into the input box as a paste segment.
 */

import type { InputSegment } from "@agenteam/types";
import { findSegmentAt } from "@agenteam/types";
import type { InputBoxControl } from "../components/InputBox.js";

export interface SnippetPayload {
  path: string;
  content: string;
  lineStart?: number;
  lineEnd?: number;
  language?: string;
}

export function ingestSnippetIntoInput(
  payload: SnippetPayload,
  ctrl: InputBoxControl | null,
): void {
  if (!ctrl) return;

  const newSeg: InputSegment = {
    type: "paste",
    content: payload.content,
    source: {
      path: payload.path,
      lineStart: payload.lineStart,
      lineEnd: payload.lineEnd,
      language: payload.language,
    },
  };
  const segs = [...ctrl.getSegments()];
  const hit = findSegmentAt(segs, ctrl.getCursor());
  const idx = hit
    ? (ctrl.getCursor() === hit.segOffset ? hit.segIdx : hit.segIdx + 1)
    : segs.length;
  segs.splice(idx, 0, newSeg);
  ctrl.setSegments(segs);
}
