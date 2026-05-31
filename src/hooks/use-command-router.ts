/**
 * useCommandRouter — slash command matching, suggestion list, and navigation.
 *
 * When input starts with `/`, filters BUILTIN_COMMANDS by prefix match.
 * Provides Tab completion, arrow-key navigation, and Enter execution.
 */

import { useState, useCallback, useMemo } from "react";
import type { SlashCommand } from "../types.js";
import type { CommandSpec } from "@agenteam/types";
import { getSlashCommandSuggestions } from "../lib/slash-command-registry.js";

/**
 * Matched command result — null when input doesn't match any known command.
 */
function matchCommand(input: string, remoteCommands: readonly CommandSpec[]): SlashCommand | null {
  if (!input.startsWith("/")) return null;
  const [cmdName] = input.slice(1).split(/\s+/, 1);
  if (!cmdName) return null;
  const all = getSlashCommandSuggestions(cmdName, remoteCommands);
  // Exact match required — prefix match still shows the full suggestion list
  return all.find(c => c.name === cmdName) ?? null;
}

export interface CommandRouterState {
  suggestions: SlashCommand[];
  selectedIdx: number;
  isActive: boolean;
  /** When in args mode (matched command + extra text), which arg cursor is on (0-based). null otherwise. */
  argIndex: number | null;
  /** The matched command in args mode. null otherwise. */
  matchedCommand: SlashCommand | null;
}

export interface CommandRouterActions {
  moveUp: () => void;
  moveDown: () => void;
  tabComplete: (currentInput: string) => string | null;
  confirmSelected: () => string | null;
}

export function useCommandRouter(
  input: string,
  remoteCommands: readonly CommandSpec[] = [],
): CommandRouterState & CommandRouterActions {
  const [selectedIdx, setSelectedIdx] = useState(0);

  const matched = useMemo(() => matchCommand(input, remoteCommands), [input, remoteCommands]);

  // Args mode: exact command match + extra text after the command name.
  const inArgsMode = !!(matched && input.slice(1).includes(" "));

  const args = useMemo(() => {
    if (!inArgsMode || !matched) return [];
    const trimmed = input.slice(1).trim();
    const spaceIdx = trimmed.indexOf(" ");
    return trimmed.slice(spaceIdx + 1).split(/\s+/).filter(Boolean);
  }, [input, inArgsMode, matched]);

  const argIndex = args.length; // which arg the user is typing (0-based: argIndex=0 means typing arg1)

  const suggestions = useMemo(() => {
    if (!input.startsWith("/")) return [];
    if (inArgsMode && matched) {
      // Args mode: show only the matched command (not a list of suggestions).
      // The param hints are rendered by CommandSuggestions.
      return [matched];
    }
    const prefix = input.slice(1).toLowerCase();
    return getSlashCommandSuggestions(prefix, remoteCommands);
  }, [input, remoteCommands, inArgsMode, matched]);

  const isActive = input.startsWith("/") && (suggestions.length > 0 || inArgsMode);

  const clampedIdx = isActive ? Math.min(selectedIdx, Math.max(0, suggestions.length - 1)) : 0;

  const moveUp = useCallback(() => {
    setSelectedIdx(i => Math.max(0, i - 1));
  }, []);

  const moveDown = useCallback(() => {
    setSelectedIdx(i => Math.min(suggestions.length - 1, i + 1));
  }, [suggestions.length]);

  const tabComplete = useCallback((_currentInput: string): string | null => {
    if (!isActive || suggestions.length === 0) return null;
    const cmd = suggestions[clampedIdx];
    if (!cmd) return null;
    return `/${cmd.name}`;
  }, [isActive, suggestions, clampedIdx]);

  const confirmSelected = useCallback((): string | null => {
    if (!isActive || suggestions.length === 0) return null;
    const cmd = suggestions[clampedIdx];
    if (!cmd) return null;
    setSelectedIdx(0);
    return cmd.name;
  }, [isActive, suggestions, clampedIdx]);

  return {
    suggestions,
    selectedIdx: clampedIdx,
    isActive,
    argIndex: inArgsMode ? Math.min(argIndex, (matched?.params_schema?.length ?? 1) - 1) : null,
    matchedCommand: inArgsMode ? matched : null,
    moveUp,
    moveDown,
    tabComplete,
    confirmSelected,
  };
}
