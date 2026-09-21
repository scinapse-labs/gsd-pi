import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, PreparationGuard } from "@gsd/pi-coding-agent";
import { isAutoActive, isAutoPaused, isAutoCompletionStopInProgress } from "../auto.js";
import { hasPendingAutoStart } from "../pending-auto-start.js";
import { hasPendingDeepProjectSetup } from "../guided-flow.js";
import { hasPendingAutoWakeups } from "../auto/schedule-wakeup.js";
import { hasPendingInteractiveWakeups } from "./schedule-wakeup-tool.js";
import { hasPendingWriteGateWork } from "./write-gate.js";
import { preparationFence } from "../preparation-fence.js";

export const GSD_PREPARATION_GUARD = "gsd.preparation.v1";

function hostIdentity(ctx: ExtensionCommandContext) {
  const workspace = realpathSync(ctx.cwd);
  if (realpathSync(ctx.sessionManager.getCwd()) !== workspace) {
    throw new Error("Session and host workspace differ");
  }
  const sessionId = ctx.sessionManager.getSessionId();
  if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Missing session identity");
  return { sessionId, workspace };
}

/** Read host-owned state synchronously and reserve before returning to the SDK. */
export function createGsdPreparationGuard(bootstrapFailures: () => readonly string[]): PreparationGuard {
  return {
    acquire(ctx) {
      try {
        const identity = hostIdentity(ctx);
        const blockers: string[] = [];
        if (bootstrapFailures().length) blockers.push("host-initialization-incomplete");
        if (isAutoActive()) blockers.push("auto-active");
        if (isAutoPaused()) blockers.push("auto-paused");
        if (isAutoCompletionStopInProgress()) blockers.push("auto-closeout-in-progress");
        if (hasPendingAutoStart()) blockers.push("pending-discussion-autostart");
        if (hasPendingDeepProjectSetup()) blockers.push("pending-deep-project-setup");
        if (hasPendingAutoWakeups() || hasPendingInteractiveWakeups()) blockers.push("pending-wakeup");
        // Observe this workspace and other host-owned roots without reconciling
        // caches: a refused helper must never clear or repair inherited work.
        if (hasPendingWriteGateWork(identity.workspace)) {
          blockers.push("pending-approval-or-queue-work");
        }
        const admission = preparationFence.acquirePreparation(identity, blockers);
        if (!admission.admitted) return { admitted: false, reason: admission.reasons.join(", ") };
        return {
          admitted: true,
          lease: {
            assertCurrent(current) { admission.lease.assertCurrent(hostIdentity(current)); },
            release() { admission.lease.release(); },
          },
        };
      } catch {
        return { admitted: false, reason: "host-state-or-identity-unavailable" };
      }
    },
  };
}

export function registerPreparationGuard(pi: ExtensionAPI, bootstrapFailures: () => readonly string[]): void {
  // Old SDKs cannot establish this guarantee. Never substitute a snapshot or marker.
  if (typeof pi.registerPreparationGuard !== "function") return;
  pi.registerPreparationGuard(GSD_PREPARATION_GUARD, createGsdPreparationGuard(bootstrapFailures));
}
