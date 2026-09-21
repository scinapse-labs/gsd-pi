import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { scheduleAutoStartAfterIdle } from "../discussion-handoff.js";
import { preparationFence, PreparationBusyError } from "../preparation-fence.js";

const identity = { sessionId: "fixture", workspace: "/fixture" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const pi = {} as ExtensionAPI;
function context(waitForIdle: () => Promise<void>, notices: string[] = []) {
  return { waitForIdle, ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionCommandContext;
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function assertClear() {
  assert.deepEqual(preparationFence.snapshot(), { preparationActive: false, pendingExecutionKinds: [] });
}

test("real handoff is visible from scheduling through asynchronous launch settlement", async t => {
  assertClear();
  const idle = deferred(), entered = deferred(), finish = deferred();
  t.after(() => { idle.resolve(); finish.resolve(); });
  scheduleAutoStartAfterIdle(context(() => idle.promise), pi, "/fixture", false, undefined, async () => {
    entered.resolve();
    await finish.promise;
  });
  assert.equal(preparationFence.acquirePreparation(identity).admitted, false);
  idle.resolve();
  // The reproduced idle-resolution gap remains reserved, before the timer fires.
  assert.equal(preparationFence.acquirePreparation(identity).admitted, false);
  await entered.promise;
  assert.equal(preparationFence.acquirePreparation(identity).admitted, false);
  finish.resolve();
  await tick();
  assertClear();
});

test("held preparation rejects a handoff before calling waitForIdle", () => {
  assertClear();
  const admission = preparationFence.acquirePreparation(identity);
  assert(admission.admitted);
  let waits = 0, launches = 0;
  try {
    assert.throws(() => scheduleAutoStartAfterIdle(context(async () => { waits++; }), pi, "/fixture", false,
      undefined, () => { launches++; }), PreparationBusyError);
    assert.equal(waits, 0);
    assert.equal(launches, 0);
    assert.deepEqual(preparationFence.snapshot().pendingExecutionKinds, []);
  } finally { admission.lease.release(); }
});

test("synchronous idle failure releases only its reservation", () => {
  assertClear();
  assert.throws(() => scheduleAutoStartAfterIdle(context(() => { throw new Error("idle failed"); }),
    pi, "/fixture", false, undefined, () => assert.fail("Must not launch")), /idle failed/);
  assertClear();
});

test("rejected idle wait reports error and releases its reservation", async () => {
  assertClear();
  const notices: string[] = [];
  scheduleAutoStartAfterIdle(context(() => Promise.reject(new Error("idle rejected")), notices),
    pi, "/fixture", false, undefined, () => assert.fail("Must not launch"));
  await tick();
  assert.match(notices.join("\n"), /idle rejected/);
  assertClear();
});

for (const asynchronous of [false, true]) {
  test(`launch failure releases reservation (async=${asynchronous})`, async () => {
    assertClear();
    const notices: string[] = [], entered = deferred();
    scheduleAutoStartAfterIdle(context(async () => {}, notices), pi, "/fixture", false, undefined, () => {
      entered.resolve();
      if (asynchronous) return Promise.reject(new Error("launch rejected"));
      throw new Error("launch threw");
    });
    await entered.promise;
    await tick();
    assert.match(notices.join("\n"), /launch (rejected|threw)/);
    assertClear();
  });
}
