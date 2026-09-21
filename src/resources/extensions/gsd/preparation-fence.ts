/**
 * Synchronous admission primitive for GSD execution versus preparation-only turns.
 * Scheduling owners must reserve BEFORE awaiting, scheduling a timer, or mutating
 * workflow state. The SDK host (not an extension agent_end handler) owns release
 * of preparation leases after the entire turn has settled.
 *
 * This module alone does not activate helpers or establish complete coverage.
 */
export interface PreparationIdentity {
  readonly sessionId: string;
  readonly workspace: string;
}

export class PreparationBusyError extends Error {
  constructor() {
    super("GSD execution is blocked while a preparation-only turn owns the host.");
    this.name = "PreparationBusyError";
  }
}

export interface ExecutionReservation {
  /** Idempotent; only removes this reservation. */
  release(): void;
}

export interface PreparationLease {
  /** Fails closed after release or session/workspace changes. */
  assertCurrent(identity: PreparationIdentity): void;
  /** Idempotent; an old lease cannot release a newer lease. */
  release(): void;
}

export type PreparationAdmission =
  | { readonly admitted: false; readonly reasons: readonly string[] }
  | { readonly admitted: true; readonly lease: PreparationLease };

export class PreparationFence {
  private readonly executions = new Map<symbol, string>();
  private owner: symbol | null = null;

  assertExecutionAllowed(): void {
    if (this.owner !== null) throw new PreparationBusyError();
  }

  reserveExecution(kind: string): ExecutionReservation {
    this.assertExecutionAllowed();
    if (!kind.trim()) throw new Error("Execution reservation requires a kind.");
    const token = Symbol(kind);
    this.executions.set(token, kind);
    return Object.freeze({ release: () => { this.executions.delete(token); } });
  }

  async runExecution<T>(kind: string, operation: () => Promise<T>): Promise<T> {
    const reservation = this.reserveExecution(kind);
    try { return await operation(); } finally { reservation.release(); }
  }

  /**
   * Call with host-derived identity and synchronous blocker observations, with no
   * await between observing blockers and admission. Denial changes no state.
   */
  acquirePreparation(identity: PreparationIdentity, blockers: readonly string[] = []): PreparationAdmission {
    if (!identity.sessionId.trim() || !identity.workspace.trim()) {
      return { admitted: false, reasons: ["missing-host-identity"] };
    }
    const reasons = [...blockers];
    if (this.owner !== null) reasons.push("preparation-already-active");
    for (const kind of this.executions.values()) reasons.push(`pending-execution:${kind}`);
    if (reasons.length) return { admitted: false, reasons: Object.freeze([...new Set(reasons)]) };

    // Capture values, never a mutable identity object supplied by the caller.
    const { sessionId, workspace } = identity;
    const token = Symbol("preparation");
    this.owner = token;
    const lease: PreparationLease = Object.freeze({
      assertCurrent: (current: PreparationIdentity) => {
        if (this.owner !== token || current.sessionId !== sessionId || current.workspace !== workspace) {
          throw new Error("Preparation admission is stale or belongs to another session/workspace.");
        }
      },
      release: () => { if (this.owner === token) this.owner = null; },
    });
    return { admitted: true, lease };
  }

  /** Diagnostics only: a snapshot is never an admission capability. */
  snapshot(): { preparationActive: boolean; pendingExecutionKinds: readonly string[] } {
    return {
      preparationActive: this.owner !== null,
      pendingExecutionKinds: Object.freeze([...this.executions.values()]),
    };
  }
}

// One loaded GSD extension owns the coordinator. Project extensions must use the
// supported SDK registration, not import their own copy of this singleton.
export const preparationFence = new PreparationFence();
