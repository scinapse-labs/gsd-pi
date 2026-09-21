// gsd-pi + src/resources/extensions/gsd/bootstrap/fallback-continuation.ts - Dispatches the post-fallback-switch continuation on a fresh turn.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { preparationFence } from "../preparation-fence.js";
import { logWarning } from "../workflow-logger.js";

/**
 * Dispatch the post-fallback continuation on a *fresh* turn after the current
 * run settles.
 *
 * #804: At `agent_end` time the agent's run is still tearing down — its
 * `isStreaming` flag stays `true` until `finishRun()` clears it in the `finally`
 * block that fires *after* the awaited `agent_end` listeners return (see
 * pi-agent-core/src/agent.ts processEvents comment). A synchronous
 * `sendMessage({ triggerTurn: true, deliverAs: "steer" })` from inside that
 * listener is therefore routed down the `isStreaming` branch and queued as a
 * steering message against the turn that just errored out — which is never
 * consumed, so the fallback model is selected but no new turn ever starts (the
 * reported symptom: "switched but work stays stopped").
 *
 * Deferring to a macrotask lets `finishRun()` flip `isStreaming` to `false`
 * first; the plain `triggerTurn` (no `deliverAs`) then dispatches a fresh turn
 * on the freshly-selected fallback model, mirroring the network-retry path.
 */
export function scheduleFallbackContinuation(
  pi: ExtensionAPI,
  options: { delayMs?: number; content?: string } = {},
): void {
  const reservation = preparationFence.reserveExecution("fallback-or-network-retry");
  setTimeout(() => {
    void Promise.resolve().then(() => pi.sendMessage(
      { customType: "gsd-auto-timeout-recovery", content: options.content ?? "Continue execution.", display: false },
      { triggerTurn: true },
    )).catch(error => {
      logWarning("bootstrap", `Deferred continuation failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => reservation.release());
  }, options.delayMs ?? 0);
}
