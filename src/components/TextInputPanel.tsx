/**
 * TextInputPanel — reusable text input panel for overlay flows.
 * Accepts a prompt, optional default value, and calls onSubmit with the result.
 */

import React, { useState, useCallback } from "react";
import { default as Box } from "../ink/components/Box.js";
import { default as Text } from "../ink/components/Text.js";
import { theme } from "../lib/theme.js";
import { useSimpleInput } from "../hooks/use-simple-input.js";

interface TextInputPanelProps {
  prompt: string;
  defaultValue?: string;
  /** Optional caller-supplied validator (return error string or null). Built-in only checks non-empty. */
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void;
}

/** Reusable validator for pack/agent IDs — pass via `validate` prop where needed. */
export function validateId(value: string): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) return "仅允许字母、数字、下划线和连字符";
  if (value.length > 64) return "名称过长（最多 64 字符）";
  return null;
}

export function TextInputPanel({ prompt, defaultValue = "", validate, onSubmit }: TextInputPanelProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback((raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) { setError("不能为空"); return; }
    if (validate) {
      const msg = validate(trimmed);
      if (msg) { setError(msg); return; }
    }
    onSubmit(trimmed);
  }, [validate, onSubmit]);

  const { before, at, after } = useSimpleInput({
    defaultValue,
    onSubmit: submit,
    onChange: () => setError(null),
  });

  return (
    <Box flexDirection="column" paddingTop={1}>
      <Text> {prompt}</Text>
      <Box paddingLeft={1}>
        <Text color={theme.overlay.selectedColor}>{">"} </Text>
        <Text>{before}</Text>
        <Text color={theme.overlay.selectedColor} inverse>{at || " "}</Text>
        <Text>{after}</Text>
      </Box>
      {error ? (
        <Box paddingLeft={1} paddingTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
