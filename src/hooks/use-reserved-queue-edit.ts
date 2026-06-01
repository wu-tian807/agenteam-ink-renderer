// @desc Edit-in-place state machine for the reserved queue — consolidates
//       editingId, Ctrl+C cancel, commit, and "save current input" into one
//       call-site so app.tsx doesn't scatter the edit concern across 7 places.
//
//   Editing flow:
//     startEdit(id) → loads item segments into input box
//     Ctrl+C       → cancelEdit() → clears input, restores to normal
//     Enter/steer  → commitEdit(text, segments) → updateById
//     flush/remove → clearIfEditing(id) → clean up if the mutated item was being edited
//     auto-flush   → isEditingHead → skip (don't dequeue while editing the head)

import { useState, useRef, useEffect, useCallback } from "react";
import type { InputBoxControl } from "../components/InputBox.js";
import type { ReservedQueueApi } from "./use-reserved-queue.js";

export interface ReservedQueueEditApi {
  /** Which queued item is currently being edited (null = no edit active). */
  editingId: string | null;
  /** Start editing a queued item: save current input if non-empty, load item. */
  startEdit: (id: string) => void;
  /** Cancel editing: clear input box and exit edit mode. */
  cancelEdit: () => void;
  /** Commit the edit: update the item in the queue and exit edit mode. Returns false if nothing was being edited. */
  commitEdit: (text: string, segments: any[]) => boolean;
  /** If `id` matches the item being edited, cancel the edit first. Call from flush/remove handlers. */
  clearIfEditing: (id: string) => void;
  /** True when the head of the queue is being edited (auto-flush should skip). */
  isEditingHead: boolean;
}

export function useReservedQueueEdit(
  reservedQueue: ReservedQueueApi,
  inputControlRef: React.MutableRefObject<InputBoxControl | null>,
  mainLayerApi: { register: (name: string, priority: number, fn: () => boolean) => void; unregister: (name: string) => void },
): ReservedQueueEditApi {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;
  const reservedQueueRef = useRef(reservedQueue);
  reservedQueueRef.current = reservedQueue;

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    inputControlRef.current?.setSegments([]);
  }, []);

  const startEdit = useCallback((id: string) => {
    if (editingIdRef.current === id) {
      cancelEdit();
      return;
    }
    const item = reservedQueueRef.current.items.find(i => i.id === id);
    if (!item) return;
    // Save current input box content to the queue before replacing it
    const currentSegs = inputControlRef.current?.getSegments();
    if (currentSegs && currentSegs.length > 0) {
      const hasContent = currentSegs.some(s =>
        s.type === "text" ? s.content.trim().length > 0 : true,
      );
      if (hasContent) {
        const text = currentSegs.map(s => s.type === "text" ? s.content : "").join("");
        reservedQueueRef.current.enqueue(text, currentSegs);
      }
    }
    setEditingId(id);
    inputControlRef.current?.setSegments(item.segments);
  }, [cancelEdit]);

  const commitEdit = useCallback((text: string, segments: any[]): boolean => {
    const id = editingIdRef.current;
    if (!id) return false;
    reservedQueueRef.current.updateById(id, text, segments);
    setEditingId(null);
    return true;
  }, []);

  const clearIfEditing = useCallback((id: string) => {
    if (editingIdRef.current === id) {
      setEditingId(null);
      inputControlRef.current?.setSegments([]);
    }
  }, []);

  const isEditingHead = reservedQueue.items.length > 0 && reservedQueue.items[0]!.id === editingId;

  // Register Ctrl+C cancel on the global key layer — useEffect so it
  // cleans up on unmount. Priority 15 fires before input-clear (20).
  useEffect(() => {
    mainLayerApi.register("edit-cancel", 15, () => {
      if (!editingIdRef.current) return false;
      setEditingId(null);
      inputControlRef.current?.setSegments([]);
      return true;
    });
    return () => mainLayerApi.unregister("edit-cancel");
  }, [mainLayerApi]);

  return { editingId, startEdit, cancelEdit, commitEdit, clearIfEditing, isEditingHead };
}
