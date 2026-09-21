import test from "node:test";
import assert from "node:assert/strict";
import { PreparationFence, PreparationBusyError } from "../preparation-fence.js";

const identity = { sessionId: "session-A", workspace: "/workspace-A" };

function acquire(fence: PreparationFence) {
  const result = fence.acquirePreparation(identity);
  assert.equal(result.admitted, true);
  if (!result.admitted) throw new Error("Expected admission");
  return result.lease;
}

test("idle admission owns execution until explicit host release", () => {
  const fence = new PreparationFence();
  const lease = acquire(fence);
  lease.assertCurrent(identity);
  assert.throws(() => fence.assertExecutionAllowed(), PreparationBusyError);
  assert.throws(() => fence.reserveExecution("auto-start"), PreparationBusyError);
  assert.deepEqual(fence.snapshot(), { preparationActive: true, pendingExecutionKinds: [] });
  lease.release();
  assert.doesNotThrow(() => fence.assertExecutionAllowed());
});

test("denial leaves existing execution reservations untouched", () => {
  const fence = new PreparationFence();
  const execution = fence.reserveExecution("discussion-idle-wait");
  const before = fence.snapshot();
  assert.deepEqual(fence.acquirePreparation(identity), {
    admitted: false, reasons: ["pending-execution:discussion-idle-wait"],
  });
  assert.deepEqual(fence.snapshot(), before);
  execution.release();
  acquire(fence).release();
});

test("duplicate scheduling kinds retain independent ownership", () => {
  const fence = new PreparationFence();
  const a = fence.reserveExecution("retry"), b = fence.reserveExecution("retry");
  a.release(); a.release();
  assert.equal(fence.acquirePreparation(identity).admitted, false);
  b.release();
  acquire(fence).release();
});

test("a second helper cannot take or release an existing lease", () => {
  const fence = new PreparationFence();
  const first = acquire(fence);
  assert.deepEqual(fence.acquirePreparation(identity), {
    admitted: false, reasons: ["preparation-already-active"],
  });
  first.assertCurrent(identity);
  first.release();
});

test("an old lease cannot release a newer lease", () => {
  const fence = new PreparationFence();
  const first = acquire(fence);
  first.release();
  const second = acquire(fence);
  first.release();
  assert.throws(() => first.assertCurrent(identity), /stale/);
  second.assertCurrent(identity);
  assert.throws(() => fence.assertExecutionAllowed(), PreparationBusyError);
  second.release(); second.release();
});

for (const changed of [
  { ...identity, sessionId: "session-B" },
  { ...identity, workspace: "/workspace-B" },
]) {
  test(`lease refuses mismatched identity ${JSON.stringify(changed)}`, () => {
    const fence = new PreparationFence(), lease = acquire(fence);
    assert.throws(() => lease.assertCurrent(changed), /another session\/workspace/);
    assert.throws(() => fence.reserveExecution("resume"), PreparationBusyError);
    lease.release();
  });
}

test("mutating the original identity object cannot rebind admission", () => {
  const fence = new PreparationFence(), mutable = { ...identity };
  const result = fence.acquirePreparation(mutable);
  assert(result.admitted);
  mutable.sessionId = "session-B";
  assert.throws(() => result.lease.assertCurrent(mutable), /another session/);
  result.lease.assertCurrent(identity);
  result.lease.release();
});

for (const invalid of [{ ...identity, sessionId: " " }, { ...identity, workspace: "" }]) {
  test(`missing host identity fails closed ${JSON.stringify(invalid)}`, () => {
    const fence = new PreparationFence();
    assert.deepEqual(fence.acquirePreparation(invalid), { admitted: false, reasons: ["missing-host-identity"] });
    assert.deepEqual(fence.snapshot(), { preparationActive: false, pendingExecutionKinds: [] });
  });
}

test("external active, paused, or unknown-state blockers cannot be bypassed", () => {
  for (const reason of ["auto-active", "auto-paused", "unknown-continuation-state"]) {
    const fence = new PreparationFence();
    assert.deepEqual(fence.acquirePreparation(identity, [reason]), { admitted: false, reasons: [reason] });
    acquire(fence).release();
  }
});

test("reservation spans the idle-resolution scheduling gap", async () => {
  const fence = new PreparationFence();
  const execution = fence.reserveExecution("idle-then-timer");
  let settle!: () => void;
  const waiting = new Promise<void>(resolve => { settle = resolve; });
  let ran = false;
  const scheduled = waiting.then(() => new Promise<void>(resolve => {
    setTimeout(() => { ran = true; execution.release(); resolve(); }, 0);
  }));
  settle();
  assert.equal(fence.acquirePreparation(identity).admitted, false);
  await Promise.resolve();
  assert.equal(fence.acquirePreparation(identity).admitted, false);
  await scheduled;
  assert.equal(ran, true);
  acquire(fence).release();
});

test("execution scheduled during a held turn rejects without queueing", async () => {
  const fence = new PreparationFence(), lease = acquire(fence);
  await Promise.resolve();
  assert.throws(() => fence.reserveExecution("new-work"), PreparationBusyError);
  assert.deepEqual(fence.snapshot().pendingExecutionKinds, []);
  lease.release();
  assert.deepEqual(fence.snapshot().pendingExecutionKinds, []);
});
