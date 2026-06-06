/**
 * @desc Self-governing argv handler for the renderer domain.
 *
 * The host CLI (e.g. agenteam_os's `bin/agenteam`) only routes argv to a
 * domain — it doesn't know about renderer verbs. This module owns:
 *   - the `--renderer` HELP text
 *   - verb dispatch (today: `start`; future: `logs`, `config`, …)
 *   - default-verb resolution (bare `agenteam` ≡ `agenteam -r start`)
 *
 * Adding a new renderer verb is a renderer-package change only; the host
 * CLI never needs to be touched.
 */

import { runRenderer } from "./index.js";

const HELP = `agenteam --renderer / -r [verb] [args]

  start [instance]                  Launch the TUI (default verb)
                                    'agenteam' with no args ≡ 'agenteam -r start'
`;

/**
 * Run the renderer sub-CLI against the given argv tail.
 * `args` is everything after the domain flag (e.g. for
 * `agenteam -r start foo` callers pass `["start", "foo"]`).
 *
 * Throws on unknown verbs / bad input; never calls process.exit itself
 * so the host dispatcher controls the exit code.
 */
export async function runRendererCli(args: string[]): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    return;
  }

  // 'start' is the only verb today; treat both `start [id]` and bare `[id]`
  // the same so users don't have to remember whether to type the verb.
  const verb = args[0];
  const rest = verb === "start" ? args.slice(1) : args;

  // Future verbs (logs / config / …) would branch off here:
  //   if (verb === "logs") { return runLogsCli(rest); }

  const instanceId = rest[0];
  await runRenderer({ instanceId });
}
