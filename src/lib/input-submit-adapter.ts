import type { ContentPart, EventContent } from "@agenteam/types";
import { fileToContentPart, isBinaryFile } from "@agenteam/types";
import type { InputSegment } from "@agenteam/types";
import { lookup } from "mime-types";

export async function inputSegmentsToEventContent(segments: InputSegment[]): Promise<EventContent> {
  const hasAttachments = segments.some((seg) => seg.type === "file" || seg.type === "media");
  const text = segmentsToPlainText(segments);

  if (!hasAttachments) return text;

  const parts: ContentPart[] = [];
  let pendingText = "";

  const flushText = () => {
    if (!pendingText) return;
    parts.push({ type: "text", text: pendingText });
    pendingText = "";
  };

  for (const seg of segments) {
    if (seg.type === "media") {
      flushText();
      parts.push({ type: seg.modality, data: seg.data, mimeType: seg.mimeType } as ContentPart);
      continue;
    }
    if (seg.type !== "file") {
      pendingText += seg.content;
      continue;
    }

    flushText();
    const mimeType = seg.mimeType || lookup(seg.path) || "application/octet-stream";
    const binary = await isBinaryFile(seg.path).catch(() => true);
    const part = fileToContentPart(seg.path, mimeType, binary);
    // User-supplied path originates on the host — mark ALL path-based parts
    // (text_file / file / *_file) so readFileBytes / readMediaBytes skip the
    // sandboxFs bridge. fileToContentPart only returns path-based parts.
    parts.push({ ...part, inContainer: false });
  }

  flushText();
  return parts.length > 0 ? parts : text;
}

/** Encode a paste segment with source into a code-fenced text block. */
function encodeSourcePaste(seg: Extract<InputSegment, { type: "paste" }>): string {
  const src = seg.source;
  if (!src) return seg.content;
  if (!seg.content.trim()) return seg.content;

  // Format: ```language path lineStart:lineEnd\ncontent\n```
  // Falls back gracefully if any field is missing.
  const header = [
    src.language ?? "",
    src.path,
    src.lineStart != null && src.lineEnd != null
      ? `${src.lineStart}:${src.lineEnd}`
      : src.lineStart != null ? `${src.lineStart}` : "",
  ].filter(Boolean).join(" ");

  const body = seg.content.endsWith("\n") ? seg.content : seg.content + "\n";
  return `\`\`\`${header}\n${body}\`\`\``;
}

export function segmentsToPlainText(segments: InputSegment[]): string {
  let out = "";
  for (const seg of segments) {
    if (seg.type === "paste") {
      out += encodeSourcePaste(seg);
    } else if (seg.type === "text") {
      out += seg.content;
    }
  }
  return out;
}

export function hasSubmittableSegments(segments: InputSegment[]): boolean {
  if (segments.some((seg) => seg.type === "file" || seg.type === "media")) return true;
  return segmentsToPlainText(segments).trim().length > 0;
}
