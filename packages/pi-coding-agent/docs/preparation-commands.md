# Guarded preparation commands (local candidate API)

These APIs exist in the preparation-host candidate, not the previously released
SDK. Detect `registerPreparationCommand` before using it. They provide host-owned
turn admission, not tool authorization, an OS sandbox, or cross-process exclusion.

## Provider registration

The extension that owns execution state registers a versioned provider:

```ts
pi.registerPreparationGuard("workflow.preparation.v1", {
  acquire(ctx) {
    // Synchronous: inspect owned pending work and reserve without an await.
    // Return { admitted: false, reason } when busy or uncertain.
    // Otherwise return { admitted: true, lease }, where lease has:
    //   assertCurrent(freshContext): throws for stale session/workspace identity
    //   release(): idempotently releases only this admission
    return coordinator.acquire(ctx);
  },
});
```

`coordinator` is the provider's implementation, not a built-in SDK object.
Providers must account for their own pending callbacks, idle waits, timers,
recovery paths, and dispatch entrypoints. A snapshot is not a reservation.
Scheduling must be prevented while admission is held; denial must not cancel or
consume another operation's work. Do not import another extension's private
singleton from a project extension: ask the registered provider through the host.
Multiple providers claiming the same name cause admission to fail closed.

## Command registration

```ts
pi.registerPreparationCommand("prepare-work", {
  description: "Read-only preparation",
  guard: "workflow.preparation.v1",
  async prepare(args, ctx) {
    // Admission is already held. Validate inputs and read necessary data here.
    return buildReadOnlyPrompt(args, ctx);
  },
});
```

`prepare` returns nonempty plain prompt content, not another slash command. Do not
call `sendMessage` or `sendUserMessage` to dispatch the turn yourself. Missing
providers, busy host state, stale identities, shadowed commands, and ambiguous
registrations are refused before preparation. Provider/command errors surface
through the existing extension command error channel.

The host:

1. Refuses active runs (including pending agent-end listeners), concurrent
   in-flight prompts, queued messages, compaction, retries, and related host work.
2. Acquires the provider reservation synchronously before calling `prepare`.
3. Revalidates identity and conversation context after preparation and at actual
   dispatch, including after awaited input hooks. An abort prevents later dispatch;
   metadata-only entries do not invalidate the conversation context.
4. Prevents conflicting host prompt/run/message/queue admission during the turn.
5. Waits for the full agent run and every awaited agent-end listener, then checks
   identity and releases in `finally`, including errors and aborts.

Recognized guarded commands remain guarded when template expansion is disabled,
when input handlers or prompt aliases produce the command, and through command
aliases. They cannot be enqueued as steering/follow-up text to bypass admission.
Arbitrary copied prose is not an invocation of a guarded command or proof that a
reservation exists.

## Older hosts and deployment

Register a normal refusal-only command when this API is unavailable. Such a
fallback must not inspect workflow data, send an agent message, or claim that an
idle snapshot is equivalent to admission. Keep helper prompt bodies private,
not exposed as ordinary templates that could survive a failed extension load.

GSD's candidate provider is `gsd.preparation.v1`. It additionally checks GSD-owned
state and scheduling reservations. Preparation observes gate state without
reconciling or resetting it: malformed/unreadable state denies admission, and
cached pending work remains for the normal host to reconcile. Its success is not permission to persist GSD
records, mutate Git, publish, or run auto mode. Those remain separate policies.
Runtime promotion requires verification of the concrete candidate and a fresh
session; changing the selected installation does not update an already-running
host.
