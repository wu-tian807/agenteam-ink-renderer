/**
 * @desc Background loop: discover IDE lock, connect, report focus, deliver snippets.
 */

import { getTerminalFocused, subscribeTerminalFocus } from "../ink/terminal-focus-state.js";
import { connectIdeBridge, discoverIdeLock } from "./ide-bridge-client.js";
import type { SnippetPayload } from "./snippet-ingest.js";

export interface IdeBridgeSubscriberOptions {
  onSnippet: (payload: SnippetPayload) => void;
  isStopped: () => boolean;
  cwd?: string;
  getInstanceId?: () => string;
}

export interface IdeBridgeSubscriberHandle {
  stop(): void;
}

/** Start reconnecting IDE Bridge client until `stop()` is called. */
export function startIdeBridgeSubscriber(
  opts: IdeBridgeSubscriberOptions,
): IdeBridgeSubscriberHandle {
  let stopped = false;
  let focusUnsub: (() => void) | null = null;
  let connClose: (() => void) | null = null;

  void (async () => {
    const cwd = opts.cwd ?? process.cwd();

    while (!stopped && !opts.isStopped()) {
      const lock = discoverIdeLock(cwd);
      if (!lock) {
        await sleep(5_000);
        continue;
      }

      let disconnectResolve: (() => void) | null = null;
      const conn = await connectIdeBridge(
        lock,
        {
          onSnippet: opts.onSnippet,
          onDisconnected() {
            focusUnsub?.();
            focusUnsub = null;
            disconnectResolve?.();
          },
        },
        { cwd, instanceId: opts.getInstanceId?.() },
      );

      if (stopped || opts.isStopped()) break;
      if (!conn) {
        await sleep(5_000);
        continue;
      }

      connClose = () => conn.close();
      conn.sendFocusState(getTerminalFocused());
      focusUnsub = subscribeTerminalFocus(() => {
        conn.sendFocusState(getTerminalFocused());
      });

      await new Promise<void>((resolve) => {
        disconnectResolve = resolve;
      });
      connClose = null;
      await sleep(2_000);
    }
  })();

  return {
    stop() {
      stopped = true;
      focusUnsub?.();
      focusUnsub = null;
      connClose?.();
      connClose = null;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
