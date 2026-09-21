import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { createGsdPreparationGuard } from "../bootstrap/preparation-guard.js";
import { preparationFence, PreparationBusyError } from "../preparation-fence.js";
import { autoSession } from "../auto-runtime-state.js";
import { startAuto } from "../auto.js";
import { setPendingAutoStart, clearPendingAutoStart, hasPendingAutoStart } from "../pending-auto-start.js";
import { scheduleAutoWakeup, clearAutoWakeup, hasPendingAutoWakeups } from "../auto/schedule-wakeup.js";
import { scheduleFallbackContinuation } from "../bootstrap/fallback-continuation.js";
import { registerScheduleWakeupTool, _resetInteractiveWakeupsForTest, hasPendingInteractiveWakeups } from "../bootstrap/schedule-wakeup-tool.js";
import { setQueuePhaseActive, getPendingGate, hostWriteGateAdapter, currentWriteGateSnapshot } from "../bootstrap/write-gate.js";
import { startDeepProjectSetupForeground, clearPendingDeepProjectSetup, hasPendingDeepProjectSetup } from "../guided-flow.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "preparation-provider-"));
  mkdirSync(join(root, ".gsd"));
  writeFileSync(join(root, ".gsd", "PREFERENCES.md"), "---\nuok:\n  gitops:\n    enabled: false\ngit:\n  isolation: none\n---\n");
  const previous = { active: autoSession.active, paused: autoSession.paused, completionStopInProgress: autoSession.completionStopInProgress };
  Object.assign(autoSession, { active: false, paused: false, completionStopInProgress: false });
  const ctx = { cwd: root, sessionManager: { getCwd: () => root, getSessionId: () => "fixture-session" },
    ui: { notify() {} } } as unknown as ExtensionCommandContext;
  const pi = {} as ExtensionAPI;
  t.after(() => {
    clearPendingAutoStart(root); clearPendingDeepProjectSetup(root); clearAutoWakeup(root, "execute-task", "M001/S01/T01");
    _resetInteractiveWakeupsForTest(); hostWriteGateAdapter.clearPending(root); setQueuePhaseActive(false, root);
    Object.assign(autoSession, previous);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, ctx, pi, guard: createGsdPreparationGuard(() => []) };
}

test("preparation refuses unreadable or malformed persisted gate state without rewriting it", t => {
  const f = fixture(t);
  const path = join(f.root, ".gsd", "runtime", "write-gate-state.json");
  mkdirSync(join(f.root, ".gsd", "runtime"), { recursive: true });
  for (const raw of ["{", "{}", "[]", '{"activeQueuePhase":"yes","pendingGateId":null}']) {
    writeFileSync(path, raw);
    const admission = f.guard.acquire(f.ctx);
    if (admission.admitted) admission.lease.release();
    assert.equal(admission.admitted, false, raw);
    assert.equal(readFileSync(path, "utf8"), raw);
  }
  rmSync(path);
  mkdirSync(path);
  assert.equal(f.guard.acquire(f.ctx).admitted, false, "snapshot path is a directory");
  rmSync(path, { recursive: true });
  symlinkSync(join(f.root, "missing-snapshot"), path);
  assert.equal(f.guard.acquire(f.ctx).admitted, false, "snapshot symlink is dangling");
  rmSync(path);
});

test("refusal never reconciles away inherited pending gate state", t => {
  const f = fixture(t);
  hostWriteGateAdapter.setPending("fixture-pending-gate", f.root);
  const before = currentWriteGateSnapshot(f.root);
  const path = join(f.root, ".gsd", "runtime", "write-gate-state.json");
  assert(JSON.parse(readFileSync(path, "utf8")).pendingGateId);
  writeFileSync(path, "{");
  autoSession.active = true;
  const admission = f.guard.acquire(f.ctx);
  assert.equal(admission.admitted, false);
  assert.deepEqual(currentWriteGateSnapshot(f.root), before);
  assert.equal(readFileSync(path, "utf8"), "{");
});

test("preparation leaves cached pending work for normal host reconciliation", t => {
  const f = fixture(t);
  hostWriteGateAdapter.setPending("fixture-pending-gate", f.root);
  const before = currentWriteGateSnapshot(f.root);
  const path = join(f.root, ".gsd", "runtime", "write-gate-state.json");
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...persisted, pendingGateId: null }));
  const denied = f.guard.acquire(f.ctx);
  if (denied.admitted) denied.lease.release();
  assert.equal(denied.admitted, false);
  assert.deepEqual(currentWriteGateSnapshot(f.root), before);
  hostWriteGateAdapter.readState(f.root); // Normal host action, not helper preflight.
  const admitted = f.guard.acquire(f.ctx);
  if (admitted.admitted) admitted.lease.release();
  assert.equal(admitted.admitted, true);
});

for (const state of ["active", "paused", "completionStopInProgress"] as const) {
  test(`GSD provider refuses ${state} without altering it`, t => {
    const f = fixture(t); autoSession[state] = true;
    const admission = f.guard.acquire(f.ctx);
    assert.equal(admission.admitted, false);
    assert.equal(autoSession[state], true);
  });
}

test("GSD provider refuses existing discussion handoff without deleting it", t => {
  const f = fixture(t);
  setPendingAutoStart(f.root, { basePath: f.root, milestoneId: "M001", ctx: f.ctx, pi: f.pi });
  assert.equal(f.guard.acquire(f.ctx).admitted, false);
  assert.equal(hasPendingAutoStart(f.root), true);
});

test("GSD provider refuses an auto wakeup without consuming it", t => {
  const f = fixture(t);
  scheduleAutoWakeup({ basePath: f.root, unitType: "execute-task", unitId: "M001/S01/T01", delayMs: 1000,
    prompt: "Synthetic fixture wakeup", reason: "fixture", createdAt: Date.now() });
  assert.equal(f.guard.acquire(f.ctx).admitted, false);
  assert.equal(hasPendingAutoWakeups(), true);
});

test("GSD provider refuses a pending interactive timer", async t => {
  const f = fixture(t);
  let tool: any;
  registerScheduleWakeupTool({ registerTool(definition: any) { tool = definition; }, sendMessage() {} } as unknown as ExtensionAPI);
  await tool.execute("fixture", { delaySeconds: 60, prompt: "Synthetic fixture wakeup" }, undefined, undefined, f.ctx);
  assert.equal(hasPendingInteractiveWakeups(), true);
  assert.equal(f.guard.acquire(f.ctx).admitted, false);
  assert.equal(hasPendingInteractiveWakeups(), true);
});

test("GSD provider observes tracked fallback timer through dispatch", async t => {
  const f = fixture(t);
  let dispatched!: () => void;
  const done = new Promise<void>(r => { dispatched = r; });
  scheduleFallbackContinuation({ sendMessage() { dispatched(); } } as unknown as ExtensionAPI);
  assert.equal(f.guard.acquire(f.ctx).admitted, false);
  await done; await new Promise<void>(r => setImmediate(r));
  const admission = f.guard.acquire(f.ctx);
  assert(admission.admitted, JSON.stringify(admission)); admission.lease.release();
});

test("GSD provider refuses queue and approval gates", t => {
  const f = fixture(t);
  setQueuePhaseActive(true, f.root);
  assert.equal(f.guard.acquire(f.ctx).admitted, false);
  setQueuePhaseActive(false, f.root);
  hostWriteGateAdapter.setPending("depth_verification_project_confirm", f.root);
  assert(getPendingGate(f.root));
  assert.equal(f.guard.acquire(f.ctx).admitted, false);
  assert(getPendingGate(f.root));
});

test("bootstrap failure and unknown identity refuse before admission", t => {
  const f = fixture(t);
  assert.equal(createGsdPreparationGuard(() => ["hooks"]).acquire(f.ctx).admitted, false);
  assert.equal(f.guard.acquire({ ...f.ctx, sessionManager: {} } as ExtensionCommandContext).admitted, false);
  assert.equal(preparationFence.snapshot().preparationActive, false);
});

test("held GSD lease rejects direct auto, deep setup, scheduling, and queue changes", async t => {
  const f = fixture(t), admission = f.guard.acquire(f.ctx);
  assert(admission.admitted, JSON.stringify(admission));
  try {
    await assert.rejects(startAuto(f.ctx, f.pi, f.root, false), PreparationBusyError);
    await assert.rejects(startDeepProjectSetupForeground(f.ctx, f.pi, f.root), PreparationBusyError);
    assert.equal(hasPendingDeepProjectSetup(), false);
    assert.throws(() => setPendingAutoStart(f.root, { basePath: f.root, milestoneId: "M001", ctx: f.ctx, pi: f.pi }), PreparationBusyError);
    assert.throws(() => scheduleFallbackContinuation(f.pi), PreparationBusyError);
    assert.throws(() => setQueuePhaseActive(true, f.root), PreparationBusyError);
    assert.equal(autoSession.active, false);
    assert.equal(hasPendingAutoStart(f.root), false);
    admission.lease.assertCurrent(f.ctx);
  } finally { admission.lease.release(); }
});

test("real host identity binding rejects session and workspace changes", t => {
  const f = fixture(t), admission = f.guard.acquire(f.ctx);
  assert(admission.admitted, JSON.stringify(admission));
  try {
    assert.throws(() => admission.lease.assertCurrent({ ...f.ctx, sessionManager: {
      getSessionId: () => "other-session", getCwd: () => f.root,
    } } as ExtensionCommandContext), /stale|another/);
    assert.throws(() => admission.lease.assertCurrent({ ...f.ctx, cwd: tmpdir() } as ExtensionCommandContext), /differ/);
  } finally { admission.lease.release(); }
  assert.throws(() => admission.lease.assertCurrent(f.ctx), /stale/);
});
