// Stub: CLI syntax highlighting (replaces claude-code cliHighlight.ts)
// Syntax highlighting is disabled in agentic_os2 — returns null (no highlight)

export type CliHighlight = {
  highlight: (code: string, options?: { language?: string } | string) => string
  supportsLanguage: (lang: string) => boolean
}

/**
 * Returns null — no syntax highlighting in agentic_os2.
 * StreamingMarkdown falls back to plain monospace rendering for code blocks.
 */
export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  return Promise.resolve(null)
}
