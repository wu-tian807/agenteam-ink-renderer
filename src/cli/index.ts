/**
 * @desc Public CLI entrypoint for `@agenteam/ink-renderer/cli`.
 *
 * Hosts the InkRenderer subscriber as a self-contained process: connects to
 * the gateway, drives the TUI, handles reconnects, and exits cleanly. The
 * caller (e.g. `agenteam` main CLI) is responsible only for parsing top-level
 * args and forwarding them here.
 */

import { resolveStateDir, getSharedPaths } from "@agenteam/types";
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
 *
 * Bootstrap-time "gateway not reachable" errors (missing gateway.json, bad
 * JSON, refused TCP connection) are flattened into a single friendly message
 * + non-zero exit, matching the style of `agenteam --gateway status` etc.
 * Anything we don't recognize is rethrown so real bugs aren't swallowed.
 */
export async function runRenderer(opts: RunRendererOptions = {}): Promise<void> {
  const stateDir = opts.stateDir ?? resolveStateDir();
  // Prime the shared-paths singleton early so any subsequent caller in this
  // process picks up our explicit stateDir (idempotent — first call wins).
  getSharedPaths(stateDir);

  try {
    const instanceId = await resolveStartupInstanceId({ stateDir, cliArg: opts.instanceId });
    const sub = new InkRendererSubscriber({ stateDir, instanceId });
    await sub.start();
  } catch (err) {
    if (isGatewayUnreachable(err)) {
      process.stderr.write(
        `Cannot connect to Gateway (stateDir=${stateDir}).\n` +
        `Is the Gateway running? Start it with: agenteam start\n`,
      );
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Heuristic: did this error come from "gateway is not running / not configured
 * at this stateDir"? We deliberately enumerate concrete codes rather than
 * pattern-matching messages so future TUI-internal errors don't get muted.
 */
function isGatewayUnreachable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; name?: string };
  return (
    e.code === "ENOENT" ||              // gateway.json missing
    e.code === "ECONNREFUSED" ||        // daemon not listening
    e.code === "ENOTFOUND" ||           // host unresolved (custom gateway.json host)
    e.name === "SyntaxError"            // gateway.json corrupt
  );
}

export { InkRendererSubscriber } from "./subscriber.js";
export type { SubscriberOptions } from "./subscriber.js";
