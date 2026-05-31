/**
 * CommandSuggestions — renders a slash-command suggestion list above the input.
 * Uses ScrollableListViewport (centered window) to show at most MAX_VISIBLE items.
 *
 * Layout invariant: the command name MUST render in full — even when long
 * (e.g. `/skill-creator`). The description gets the remaining columns and
 * truncates with an ellipsis when space is tight.
 *
 * Args mode: when the user has typed an exact command match with extra text
 * (e.g. `/switch-session admin`), the overlay switches to single-command
 * mode showing the command + its positional parameter hints from params_schema.
 */

import React, { useMemo } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import type { SlashCommand } from "../types.js";
import { ScrollableListViewport } from "../lib/scrollable-list-viewport.js";
import { ScrollableListFrame } from "./ScrollableListFrame.js";
import { theme } from "../lib/theme.js";

const MAX_VISIBLE = 5;
/** border + footer hint row */
const SUGGESTIONS_CHROME_OVERHEAD = 2;

const NAME_COL = 18;

interface CommandSuggestionsProps {
  suggestions: SlashCommand[];
  selectedIdx: number;
  /** Current arg cursor in args mode (0-based). null = not in args mode. */
  argIndex: number | null;
  /** Matched command when in args mode. */
  matchedCommand: SlashCommand | null;
}

export function CommandSuggestions({
  suggestions,
  selectedIdx,
  argIndex,
  matchedCommand,
}: CommandSuggestionsProps): React.JSX.Element {
  const viewport = useMemo(() => new ScrollableListViewport(), []);
  const isArgsMode = argIndex !== null && matchedCommand !== null;
  const slice = viewport.slice({
    itemCount: suggestions.length,
    cursorIndex: selectedIdx,
    rowBudget: MAX_VISIBLE + SUGGESTIONS_CHROME_OVERHEAD,
    chromeOverhead: SUGGESTIONS_CHROME_OVERHEAD,
    maxVisible: MAX_VISIBLE,
    scrollMode: "centered",
  });
  const visible = suggestions.slice(slice.start, slice.end);

  return (
    <Box flexDirection="column" width="100%" borderStyle={theme.overlay.borderStyle} borderColor={theme.overlay.borderColor}>
      <ScrollableListFrame slice={slice}>
        {visible.map((cmd, i) => {
          const realIdx = slice.start + i;
          const selected = realIdx === selectedIdx;
          const namePadded = `/${cmd.name}`.padEnd(NAME_COL);
          return (
            <Box key={cmd.name} width="100%" flexWrap="nowrap">
              <Box flexShrink={0}>
                <Text color={selected ? theme.overlay.selectedColor : undefined} bold={selected}>
                  {selected ? `${theme.overlay.selectedChar} ` : "  "}
                </Text>
                <Text color={selected ? theme.overlay.selectedColor : theme.overlay.commandColor} bold={selected}>
                  {namePadded}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text dimColor wrap="truncate-end">— {cmd.description}</Text>
              </Box>
            </Box>
          );
        })}
      </ScrollableListFrame>
      {isArgsMode && matchedCommand!.params_schema && matchedCommand!.params_schema.length > 0 && (
        <ArgsHint params={matchedCommand!.params_schema} argIndex={argIndex!} />
      )}
      <Text dimColor> Tab 补全  ↑↓ 导航  Enter 执行</Text>
    </Box>
  );
}

/** Render parameter hints when the user is typing positional args. */
function ArgsHint({
  params,
  argIndex,
}: {
  params: { name: string; description: string }[];
  argIndex: number;
}): React.JSX.Element {
  const clampedIdx = Math.min(argIndex, params.length - 1);
  return (
    <Box flexDirection="column" paddingTop={0} borderTop borderStyle="single" borderColor={theme.overlay.borderColor}>
      {params.map((p, i) => {
        const isCurrent = i === clampedIdx;
        const isDone = i < clampedIdx;
        const prefix = isCurrent ? "\u25B8" : isDone ? "\u2713" : " ";
        const hintColor = isCurrent ? theme.overlay.selectedColor : isDone ? theme.overlay.disabledColor : undefined;
        return (
          <Box key={p.name} flexDirection="row" width="100%">
            <Box width={3} flexShrink={0}>
              <Text color={hintColor} bold={isCurrent}>{prefix}</Text>
            </Box>
            <Box width={NAME_COL} flexShrink={0}>
              <Text color={hintColor} bold={isCurrent}>{p.name}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text color={hintColor} wrap="truncate-end">{p.description}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
