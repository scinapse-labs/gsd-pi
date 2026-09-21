import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@gsd/pi-agent-core";
import { EventStream, getModels, type AssistantMessage, type AssistantMessageEvent } from "@gsd/pi-ai";
import { AgentSession } from "@gsd/agent-core";
import { AuthStorage } from "@gsd/pi-coding-agent/core/auth-storage.js";
import { ModelRegistry } from "@gsd/pi-coding-agent/core/model-registry.js";
import { DefaultResourceLoader } from "@gsd/pi-coding-agent/core/resource-loader.js";
import { SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { SettingsManager } from "@gsd/pi-coding-agent/core/settings-manager.js";
import { createSyntheticSourceInfo } from "@gsd/pi-coding-agent/core/source-info.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { PreparationFence } from "../preparation-fence.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

async function fixture(t: test.TestContext, options: {
  missingGuard?: boolean;
  aliasTemplate?: boolean;
  prepare?: (args: string, ctx: ExtensionCommandContext) => Promise<string>;
  hooks?: (pi: ExtensionAPI, fence: PreparationFence) => void;
  additionalFactories?: Array<(pi: ExtensionAPI) => void>;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "preparation-host-"));
  const fence = new PreparationFence(), errors: string[] = [];
  let prepares = 0, streams = 0;
  const model = getModels("anthropic")[0];
  assert(model);
  const authStorage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "inert-unit-fixture-not-a-credential" } });
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: join(dir, "agent"), settingsManager,
    noExtensions: true, noPromptTemplates: true, noThemes: true,
    promptsOverride: base => options.aliasTemplate ? { ...base, prompts: [{
      name: "aliasprep", description: "Fixture alias", content: "/prep #123", source: "fixture",
      sourceInfo: createSyntheticSourceInfo("<fixture:alias>", { source: "fixture" }), filePath: join(dir, "alias.md"),
    }] } : base,
    extensionFactories: [pi => {
      if (!options.missingGuard) pi.registerPreparationGuard("fixture.v1", {
        acquire(ctx) {
          const identity = { sessionId: ctx.sessionManager.getSessionId(), workspace: ctx.cwd };
          const result = fence.acquirePreparation(identity);
          if (!result.admitted) return { admitted: false, reason: result.reasons.join(", ") };
          return { admitted: true, lease: {
            assertCurrent(current) { result.lease.assertCurrent({ sessionId: current.sessionManager.getSessionId(), workspace: current.cwd }); },
            release() { result.lease.release(); },
          } };
        },
      });
      pi.registerPreparationCommand("prep", {
        guard: "fixture.v1", description: "Unit fixture only",
        async prepare(args, ctx) {
          prepares++;
          assert.equal(fence.snapshot().preparationActive, true);
          return options.prepare ? options.prepare(args, ctx) : "Synthetic unit fixture preparation prompt.";
        },
      });
      options.hooks?.(pi, fence);
    }, ...(options.additionalFactories ?? [])],
  });
  await resourceLoader.reload();
  const agent = new Agent({ initialState: { model }, streamFn: () => {
    streams++;
    // Real Agent/AgentSession, deterministic in-process test stream; no network.
    const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
      event => event.type === "done" || event.type === "error",
      event => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected terminal event");
      },
    );
    const message: AssistantMessage = {
      role: "assistant", content: [{ type: "text", text: "Synthetic unit fixture response." }],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    };
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  } });
  const session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(dir), settingsManager,
    cwd: dir, resourceLoader, modelRegistry });
  await session.bindExtensions({ onError: error => errors.push(error.error) });
  t.after(async () => { await session.abort(); session.dispose(); rmSync(dir, { recursive: true, force: true }); });
  return { session, agent, fence, errors, counts: () => ({ prepares, streams }) };
}

test("host holds lease through every awaited agent_end listener", async t => {
  const entered = deferred(), finish = deferred();
  t.after(() => finish.resolve());
  let secondListener = false;
  const f = await fixture(t, { hooks(pi, fence) {
    pi.on("agent_end", async () => {
      assert(fence.snapshot().preparationActive);
      entered.resolve(); await finish.promise;
      assert(fence.snapshot().preparationActive);
    });
    pi.on("agent_end", async () => { assert(fence.snapshot().preparationActive); secondListener = true; });
  } });
  const running = f.session.prompt("/prep");
  await entered.promise;
  await assert.rejects(f.session.prompt("/prep"), /reserved/);
  await assert.rejects(f.session.sendCustomMessage({ customType: "conflict", content: "No dispatch", display: false },
    { triggerTurn: true }), /reserved/);
  const messagesBefore = f.session.agent.state.messages.length;
  await assert.rejects(f.session.sendCustomMessage({ customType: "conflict", content: "No append", display: false }), /reserved/);
  assert.equal(f.session.agent.state.messages.length, messagesBefore);
  await assert.rejects(f.session.runAgentPrompt({ role: "user", content: "No programmatic bypass", timestamp: Date.now() }), /reserved/);
  await assert.rejects(f.session.steer("No steering bypass"), /reserved/);
  await assert.rejects(f.session.followUp("No follow-up bypass"), /reserved/);
  assert.equal(f.session.pendingMessageCount, 0);
  const aborting = f.session.abort();
  assert(f.fence.snapshot().preparationActive);
  finish.resolve();
  await running; await aborting;
  assert.equal(secondListener, true);
  assert.equal(f.fence.snapshot().preparationActive, false);
  assert.deepEqual(f.counts(), { prepares: 1, streams: 1 });
  assert.deepEqual(f.errors, []);
});

test("missing provider refuses before preparation lookup or model call", async t => {
  const f = await fixture(t, { missingGuard: true });
  await f.session.prompt("/prep #123");
  assert.deepEqual(f.counts(), { prepares: 0, streams: 0 });
  assert.match(f.errors.join("\n"), /missing preparation guard/);
});

test("deferred reservation refuses without removing another owner's work", async t => {
  const f = await fixture(t), pending = f.fence.reserveExecution("retry");
  const before = f.fence.snapshot();
  await f.session.prompt("/prep");
  assert.deepEqual(f.counts(), { prepares: 0, streams: 0 });
  assert.deepEqual(f.fence.snapshot(), before);
  assert.match(f.errors.join("\n"), /pending-execution:retry/);
  pending.release();
});

test("preparation failure releases both host and provider ownership", async t => {
  let first = true;
  const f = await fixture(t, { async prepare() {
    if (first) { first = false; throw new Error("Fixture argument lookup failed"); }
    return "Synthetic retry prompt.";
  } });
  await f.session.prompt("/prep");
  assert.equal(f.fence.snapshot().preparationActive, false);
  assert.match(f.errors.join("\n"), /argument lookup failed/);
  await f.session.prompt("/prep");
  assert.deepEqual(f.counts(), { prepares: 2, streams: 1 });
  assert.equal(f.fence.snapshot().preparationActive, false);
});

test("session change during preparation invalidates admission before dispatch", async t => {
  const entered = deferred(), finish = deferred();
  t.after(() => finish.resolve());
  const f = await fixture(t, { async prepare() { entered.resolve(); await finish.promise; return "Must not dispatch"; } });
  const running = f.session.prompt("/prep");
  await entered.promise;
  f.session.sessionManager.newSession();
  finish.resolve(); await running;
  assert.deepEqual(f.counts(), { prepares: 1, streams: 0 });
  assert.match(f.errors.join("\n"), /stale|another session/);
  assert.equal(f.fence.snapshot().preparationActive, false);
});

test("ordinary prompt awaiting input hooks also blocks preparation admission", async t => {
  const entered = deferred(), finish = deferred();
  t.after(() => finish.resolve());
  const f = await fixture(t, { hooks(pi) {
    pi.on("input", async () => { entered.resolve(); await finish.promise; return { action: "continue" }; });
  } });
  const ordinary = f.session.prompt("Synthetic ordinary prompt");
  await entered.promise;
  assert.equal(f.agent.signal, undefined);
  await f.session.prompt("/prep");
  assert.deepEqual(f.counts(), { prepares: 0, streams: 0 });
  assert.match(f.errors.join("\n"), /active or pending host work/);
  finish.resolve(); await ordinary;
});

test("ambiguous guard registration fails before preparation", async t => {
  const f = await fixture(t, { additionalFactories: [pi => {
    pi.registerPreparationGuard("fixture.v1", { acquire() { return { admitted: false, reason: "second provider" }; } });
  }] });
  await f.session.prompt("/prep");
  assert.deepEqual(f.counts(), { prepares: 0, streams: 0 });
  assert.match(f.errors.join("\n"), /Ambiguous preparation guard/);
});

test("an unguarded command cannot shadow a preparation command, including aliases", async t => {
  let unguardedCalls = 0;
  const f = await fixture(t, { additionalFactories: [pi => {
    pi.registerCommand("prep", { async handler() { unguardedCalls++; } });
  }] });
  const commands = f.session._extensionRunner.getRegisteredCommands();
  const shadow = commands.find(command => command.name === "prep" && !command.preparation);
  assert(shadow, "Expected a namespaced conflicting command fixture");
  await assert.rejects(f.session.prompt(`/${shadow.invocationName}`), /Ambiguous or shadowed/);
  assert.equal(unguardedCalls, 0);
  assert.deepEqual(f.counts(), { prepares: 0, streams: 0 });
});

test("non-triggering custom messages cannot mutate history during idle preparation", async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { async prepare() {
    entered.resolve(); await finish.promise; return "Synthetic prepared prompt";
  } });
  const running = f.session.prompt("/prep");
  try {
    await entered.promise;
    assert.equal(f.session.isStreaming, false);
    const before = f.session.agent.state.messages.length;
    await assert.rejects(f.session.sendCustomMessage({ customType: "conflict", content: "No idle append", display: false }), /reserved/);
    assert.equal(f.session.agent.state.messages.length, before);
  } finally { finish.resolve(); await running; }
});

test("session change during async preparation rejects stale dispatch", async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { async prepare() {
    entered.resolve(); await finish.promise; return "Must not reach the new session";
  } });
  const running = f.session.prompt("/prep");
  try {
    await entered.promise;
    assert.equal(await f.session.newSession(), true);
  } finally { finish.resolve(); await running; }
  assert.deepEqual(f.counts(), { prepares: 1, streams: 0 });
  assert.match(f.errors.join("\n"), /stale|identity|changed/);
  assert.equal(f.fence.snapshot().preparationActive, false);
});

test("abort during async preparation cannot dispatch a later model turn", async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { async prepare() {
    entered.resolve(); await finish.promise; return "Must not run after abort";
  } });
  const running = f.session.prompt("/prep");
  try { await entered.promise; await f.session.abort(); }
  finally { finish.resolve(); await running; }
  assert.deepEqual(f.counts(), { prepares: 1, streams: 0 });
  assert.equal(f.fence.snapshot().preparationActive, false);
});

test("conversation tree changes during preparation reject stale context", async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { async prepare() {
    entered.resolve(); await finish.promise; return "Must not run in another branch";
  } });
  await f.session.prompt("baseline conversation");
  const target = f.session.sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
  assert(target);
  const oldLeaf = f.session.sessionManager.getLeafId();
  const running = f.session.prompt("/prep");
  try {
    await entered.promise;
    await f.session.navigateTree(target.id, { summarize: false });
    assert.notEqual(f.session.sessionManager.getLeafId(), oldLeaf);
  } finally { finish.resolve(); await running; }
  assert.deepEqual(f.counts(), { prepares: 1, streams: 1 });
  assert.equal(f.fence.snapshot().preparationActive, false);
});

test("abort during awaited before-agent handlers prevents prepared dispatch", async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { hooks(pi) {
    pi.on("before_agent_start", async () => { entered.resolve(); await finish.promise; });
  } });
  const running = f.session.prompt("/prep");
  try { await entered.promise; await f.session.abort(); }
  finally { finish.resolve(); await running; }
  assert.deepEqual(f.counts(), { prepares: 1, streams: 0 });
  assert.equal(f.fence.snapshot().preparationActive, false);
});

test("metadata-only session updates do not invalidate preparation context", async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { async prepare() {
    entered.resolve(); await finish.promise; return "Valid prepared prompt";
  } });
  const running = f.session.prompt("/prep");
  try { await entered.promise; f.session.setSessionName("Renamed without changing conversation"); }
  finally { finish.resolve(); await running; }
  assert.deepEqual(f.counts(), { prepares: 1, streams: 1 });
  assert.deepEqual(f.errors, []);
});

test("programmatic prompts cannot disable preparation admission with template expansion", async t => {
  const f = await fixture(t, { missingGuard: true });
  await f.session.prompt("/prep #123", { expandPromptTemplates: false });
  assert.deepEqual(f.counts(), { prepares: 0, streams: 0 });
  assert.match(f.errors.join("\n"), /missing preparation guard/);
});

test("transformed input still requires preparation admission", async t => {
  const f = await fixture(t, { missingGuard: true, hooks(pi) {
    pi.on("input", async event => event.text === "alias" ? { action: "transform", text: "/prep #123" } : { action: "continue" });
  } });
  await f.session.prompt("alias");
  assert.deepEqual(f.counts(), { prepares: 0, streams: 0 });
  assert.match(f.errors.join("\n"), /missing preparation guard/);
});

test("a prompt-template alias cannot bypass preparation admission", async t => {
  const f = await fixture(t, { missingGuard: true, aliasTemplate: true });
  await f.session.prompt("/aliasprep");
  assert.deepEqual(f.counts(), { prepares: 0, streams: 0 });
  assert.match(f.errors.join("\n"), /missing preparation guard/);
});

test("whitespace and queued-message paths cannot bypass preparation commands", async t => {
  const f = await fixture(t, { missingGuard: true });
  await f.session.prompt(" \t/prep\t#123", { expandPromptTemplates: false });
  assert.deepEqual(f.counts(), { prepares: 0, streams: 0 });
  assert.match(f.errors.join("\n"), /missing preparation guard/);
  await assert.rejects(f.session.followUp(" \t/prep\t#123"), /Preparation commands cannot be queued/);
  assert.equal(f.session.pendingMessageCount, 0);
});

test("next-turn messages refuse preparation without consuming that queue", async t => {
  const f = await fixture(t);
  await f.session.sendCustomMessage({ customType: "queued", content: "Synthetic future input", display: false }, { deliverAs: "nextTurn" });
  await f.session.prompt("/prep");
  assert.deepEqual(f.counts(), { prepares: 0, streams: 0 });
  assert.match(f.errors.join("\n"), /active or pending host work/);
});
