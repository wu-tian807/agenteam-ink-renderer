/**
 * @desc Public CLI entrypoint for `@agenteam/ink-renderer/cli`.
 *
 * Hosts the InkRenderer subscriber as a self-contained process: connects to
 * the gateway, drives the TUI, handles reconnects, and exits cleanly. The
 * caller (e.g. `agenteam` main CLI) is responsible only for parsing top-level
 * args and forwarding them here.
 */

import { resolveStateDir } from "@agenteam/types";
import { InkRendererSubscriber, resolveStartupInstanceId } from "./subscriber.js";

export interface RunRendererOptions {
  /**
   * Override `~/.agenteam`. Falls back to `AGENTEAM_STATE_DIR` env or default.
   * Pass through whatever the caller's state-dir resolver gave you so the
   * subscriber and the main CLI agree on paths.
   */
  stateDir?: string;
  /**
   * Explicit instance to connect to. If omitted, the subscriber falls back
   * to `MC_TARGET_INSTANCE` env, then gateway-side resolveInstanceId, then
   * the first listed instance.
   */
  instanceId?: string;
}

/**
 * Boot the ink-renderer subscriber and drive the TUI to exit.
 *
 * Resolves only after the user quits (or never resolves if the renderer
 * exits the process directly). Errors during bootstrap propagate to the
 * caller; runtime errors are surfaced inside the TUI / via process.exit.
 */
export async function runRenderer(opts: RunRendererOptions = {}): Promise<void> {
  const stateDir = opts.stateDir ?? resolveStateDir();
  const instanceId = await resolveStartupInstanceId({ stateDir, cliArg: opts.instanceId });

  const sub = new InkRendererSubscriber({ stateDir, instanceId });
  await sub.start();
}

export { InkRendererSubscriber } from "./subscriber.js";
export type { SubscriberOptions } from "./subscriber.js";
