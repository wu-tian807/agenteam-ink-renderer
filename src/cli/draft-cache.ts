/**
 * Per-(instance, agent) draft cache mutation.
 *
 * Empty drafts (no input + no queue) prune the entry — and the parent map
 * if it becomes empty — so the cache file never grows stale `{}` stubs.
 *
 * Returns whether any change was made (lets callers skip flushSync on no-op).
 */

import type { DraftSnapshot } from "../lib/renderer-config.js";
import type { InkCache } from "../lib/renderer-cache-store.js";

export function applyDraft(cache: InkCache, instId: string, agent: string, draft: DraftSnapshot): boolean {
  const empty = !draft.inputSegments?.length && !draft.reservedQueue?.length;
  const existing = cache.drafts?.[instId]?.[agent];
  if (empty) {
    if (!existing) return false;
    delete cache.drafts![instId]![agent];
    if (Object.keys(cache.drafts![instId]!).length === 0) delete cache.drafts![instId];
    return true;
  }
  ((cache.drafts ??= {})[instId] ??= {})[agent] = draft;
  return true;
}
