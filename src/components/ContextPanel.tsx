/**
 * ContextPanel — fullscreen overlay for the /context command.
 * Renders a grid visualization (claude-code parity) of the current agent's
 * context-window usage, with a categories legend and per-slot / per-tool
 * breakdown tables.
 *
 * Data contract: receives the structured payload emitted by `commands/context.ts`
 * (kind: "context-visualization"). Server is the data producer; this component
 * owns all rendering decisions (grid dimensions, symbols, colors, layout).
 */

import React, { useRef } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import { default as ScrollBox, type ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import { useScrollKeys } from "../hooks/use-scroll-keys.js";
import { theme } from "../lib/theme.js";

// ── Types ─────────────────────────────────────────────────────────────

interface Category {
  name: string;
  label: string;
  tokens: number;
  /** Theme key matching theme.contextPanel.category — server emits "system"/"tools"/"messages" */
  color: string;
}

interface SlotEntry {
  name: string;
  tokens: number;
  cacheHint: string;
}

interface ToolEntry {
  name: string;
  tokens: number;
}

export interface ContextVisualizationData {
  kind: "context-visualization";
  agentId: string;
  model: string;
  totalTokens: number;
  contextWindow: number;
  percentage: number;
  categories: Category[];
  slots: SlotEntry[];
  tools: ToolEntry[];
  messageCount: number;
}

interface ContextPanelProps {
  data: ContextVisualizationData;
}

// ── Helpers ───────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

interface GridSquare {
  /** Category label for legend lookup */
  label: string;
  /** Theme color key */
  colorKey: string;
  /** 0..1; last partial square may be <1, all others 1 */
  fullness: number;
}

const FREE_LABEL = "Free space";

/**
 * Lay out squares row by row:
 *   1. Each non-zero category claims max(1, round(tokens/cw * TOTAL)) squares
 *   2. Free space fills remaining squares
 *   3. Last "real" square of each category may be partially filled (fractional)
 *
 * Mirrors claude-code's analyzeContext.ts:createCategorySquares.
 */
function buildGrid(
  data: ContextVisualizationData,
  width: number,
  height: number,
): GridSquare[][] {
  const TOTAL = width * height;
  if (data.contextWindow <= 0 || TOTAL === 0) return [];

  const squares: GridSquare[] = [];
  for (const cat of data.categories) {
    if (cat.tokens <= 0) continue;
    const exact = (cat.tokens / data.contextWindow) * TOTAL;
    const whole = Math.floor(exact);
    const frac = exact - whole;
    const num = Math.max(1, Math.round(exact));
    for (let i = 0; i < num; i++) {
      // Partial fill applies to the boundary square (claude-code parity).
      const fullness = i === whole && frac > 0 ? frac : 1.0;
      squares.push({ label: cat.label, colorKey: cat.color, fullness });
    }
  }

  // Cap at TOTAL (rounding can overshoot when categories sum to > 100% — won't
  // happen in normal data, but be defensive so Free space never shows negative).
  const used = Math.min(squares.length, TOTAL);
  const free = TOTAL - used;
  const final = squares.slice(0, used);
  for (let i = 0; i < free; i++) {
    final.push({ label: FREE_LABEL, colorKey: "free", fullness: 1.0 });
  }

  const rows: GridSquare[][] = [];
  for (let r = 0; r < height; r++) {
    rows.push(final.slice(r * width, (r + 1) * width));
  }
  return rows;
}

function colorFor(key: string): string {
  const map = theme.contextPanel.category as Record<string, string>;
  return map[key] ?? theme.overlay.disabledColor;
}

function symbolFor(square: GridSquare): string {
  if (square.label === FREE_LABEL) return theme.contextPanel.symbol.free;
  return square.fullness >= 0.7 ? theme.contextPanel.symbol.filled : theme.contextPanel.symbol.partial;
}

// ── Subcomponents ─────────────────────────────────────────────────────

function GridView({ rows }: { rows: GridSquare[][] }): React.JSX.Element {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {rows.map((row, ri) => (
        <Box key={ri} flexDirection="row">
          {row.map((sq, ci) => (
            <Text key={ci} color={colorFor(sq.colorKey)} dimColor={sq.label === FREE_LABEL}>
              {symbolFor(sq)}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function CategoriesLegend({ data, freeTokens }: { data: ContextVisualizationData; freeTokens: number }): React.JSX.Element {
  const cw = data.contextWindow;
  const pct = (n: number): string => (cw > 0 ? `${((n / cw) * 100).toFixed(1)}%` : "—");

  return (
    <Box flexDirection="column">
      <Text dimColor italic>Estimated usage by category</Text>
      {data.categories.map((cat) => {
        if (cat.tokens === 0) return null;
        const messageSuffix = cat.name === "messages" && data.messageCount > 0 ? ` (${data.messageCount})` : "";
        return (
          <Box key={cat.name}>
            <Text color={colorFor(cat.color)}>{theme.contextPanel.symbol.filled}</Text>
            <Text>{cat.label}{messageSuffix}: </Text>
            <Text dimColor>{formatTokens(cat.tokens)} ({pct(cat.tokens)})</Text>
          </Box>
        );
      })}
      {freeTokens > 0 && (
        <Box>
          <Text dimColor>{theme.contextPanel.symbol.free}</Text>
          <Text>{FREE_LABEL}: </Text>
          <Text dimColor>{formatTokens(freeTokens)} ({pct(freeTokens)})</Text>
        </Box>
      )}
    </Box>
  );
}

function SlotsTable({ slots }: { slots: SlotEntry[] }): React.JSX.Element | null {
  if (slots.length === 0) return null;
  const nameW = Math.max(4, ...slots.map((s) => s.name.length));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>System prompt sections</Text>
      <Box>
        <Text dimColor>{"  "}{"Slot".padEnd(nameW)}</Text>
        <Text dimColor>{"  "}Tokens</Text>
        <Text dimColor>{"  "}Cache</Text>
      </Box>
      {slots.map((s) => (
        <Box key={s.name}>
          <Text>{"  "}{s.name.padEnd(nameW)}</Text>
          <Text>{"  "}{formatTokens(s.tokens).padEnd(6)}</Text>
          <Text dimColor>{"  "}{s.cacheHint}</Text>
        </Box>
      ))}
    </Box>
  );
}

function ToolsTable({ tools }: { tools: ToolEntry[] }): React.JSX.Element | null {
  if (tools.length === 0) return null;
  const TOP_N = 15;
  const top = tools.slice(0, TOP_N);
  const nameW = Math.max(4, ...top.map((t) => t.name.length));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>
        Tools ({tools.length})
        {tools.length > top.length ? <Text dimColor> — top {top.length} by tokens</Text> : null}
      </Text>
      <Box>
        <Text dimColor>{"  "}{"Tool".padEnd(nameW)}</Text>
        <Text dimColor>{"  "}Tokens</Text>
      </Box>
      {top.map((t) => (
        <Box key={t.name}>
          <Text>{"  "}{t.name.padEnd(nameW)}</Text>
          <Text>{"  "}{formatTokens(t.tokens)}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ── Main ──────────────────────────────────────────────────────────────

export function ContextPanel({ data }: ContextPanelProps): React.JSX.Element {
  // Grid sizing: 10×10 for ≤200K, 20×10 for 1M+ (claude-code uses terminal-width
  // heuristic; we just key off context window size — narrow-screen support can
  // come later if anyone complains).
  const wide = data.contextWindow >= 1_000_000;
  const gridWidth = wide ? 20 : 10;
  const gridHeight = 10;
  const rows = buildGrid(data, gridWidth, gridHeight);

  const headerTokens = data.contextWindow > 0
    ? `${formatTokens(data.totalTokens)}/${formatTokens(data.contextWindow)} tokens (${data.percentage.toFixed(1)}%)`
    : `${formatTokens(data.totalTokens)} tokens (model context window unknown)`;
  const sumTokens = data.categories.reduce((acc, c) => acc + c.tokens, 0);
  const freeTokens = Math.max(0, data.contextWindow - sumTokens);

  const scrollRef = useRef<ScrollBoxHandle>(null);
  useScrollKeys(scrollRef, true);

  return (
    <ScrollBox ref={scrollRef} flexGrow={1} flexDirection="column">
      <Box flexDirection="column" paddingTop={0}>
        {/* Header */}
        <Box marginBottom={1}>
          <Text bold>{data.agentId}</Text>
          <Text dimColor> · {data.model || "(no model)"} · {headerTokens}</Text>
        </Box>

        {/* Grid + categories side-by-side */}
        <Box flexDirection="row" gap={2}>
          {rows.length > 0 ? <GridView rows={rows} /> : <Text dimColor>(grid unavailable — model context window unknown)</Text>}
          <CategoriesLegend data={data} freeTokens={freeTokens} />
        </Box>

        {/* Breakdown tables */}
        <SlotsTable slots={data.slots} />
        <ToolsTable tools={data.tools} />
      </Box>
    </ScrollBox>
  );
}
