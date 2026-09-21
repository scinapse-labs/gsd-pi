import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  auditOrphanedMilestoneBranches,
  bootstrapAutoSession,
  bootstrapAutoSessionLayout,
  initializeAutoSessionRepo,
  prepareAutoSessionGitignore,
  recoverAutoSessionBranch,
  resolveSurvivorRecoveryIsolationMode,
} from "../auto-start.ts";
import { auditOrphanedPreflightStashes } from "../orphan-stash-audit.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask } from "../gsd-db.ts";
import { migrateToExternalState } from "../migrate-external.ts";
import { AutoSession } from "../auto/session.ts";
import { releaseSessionLock } from "../session-lock.ts";

// Git writes below are confined to disposable test repositories, never the checkout.
function fixture(t: test.TestContext, gitops: boolean, manageGitignore = false, isolation = "none") {
  const base = mkdtempSync(join(tmpdir(), "gsd-bootstrap-gitops-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: base,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "GSD test");
  git("config", "user.email", "gsd-test@example.invalid");
  mkdirSync(join(base, ".gsd"));
  writeFileSync(join(base, ".gitignore"), ".gsd/\n");
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"),
    `---\nuok:\n  gitops:\n    enabled: ${gitops}\ngit:\n  isolation: ${isolation}\n  manage_gitignore: ${manageGitignore}\n---\n`);
  for (const file of ["owned.txt", "unrelated.txt"]) writeFileSync(join(base, file), "baseline\n");
  git("add", ".");
  git("commit", "-m", "fixture baseline");
  writeFileSync(join(base, "owned.txt"), "already staged\n");
  git("add", "owned.txt");
  writeFileSync(join(base, "owned.txt"), "additional unstaged change\n");
  writeFileSync(join(base, "unrelated.txt"), "unrelated unstaged work\n");
  writeFileSync(join(base, "untracked.txt"), "untracked work\n");
  const snapshot = () => ({
    head: git("rev-parse", "HEAD"),
    refs: git("for-each-ref", "--format=%(refname) %(objectname)"),
    branch: git("symbolic-ref", "HEAD"),
    gitignore: readFileSync(join(base, ".gitignore"), "utf8"),
    index: readFileSync(join(base, ".git", "index")).toString("hex"),
    config: readFileSync(join(base, ".git", "config"), "utf8"),
    files: ["owned.txt", "unrelated.txt", "untracked.txt"].map(file => readFileSync(join(base, file), "utf8")),
  });
  return { base, git, snapshot };
}

for (const legacy of [false, true]) {
  test(`disabled GitOps preserves HEAD, refs, index and unrelated work (${legacy ? "legacy cleanup" : "fresh layout"})`, (t) => {
    const { base, snapshot } = fixture(t, false);
    if (legacy) mkdirSync(join(base, ".gsd", "milestones"));
    const before = snapshot();
    bootstrapAutoSessionLayout(base);
    assert.equal(existsSync(join(base, ".gsd", "phases")), true);
    assert.equal(existsSync(join(base, ".gsd", "milestones")), false);
    assert.deepEqual(snapshot(), before);
    bootstrapAutoSessionLayout(base);
    assert.deepEqual(snapshot(), before, "repeated bootstrap must also preserve Git state");
  });
}

test("enabled GitOps retains the existing layout bootstrap commit", (t) => {
  const { base, git, snapshot } = fixture(t, true);
  const before = snapshot();
  bootstrapAutoSessionLayout(base);
  assert.notEqual(git("rev-parse", "HEAD"), before.head);
  assert.equal(git("log", "-1", "--format=%s"), "chore: init gsd");
  assert.equal(git("status", "--porcelain"), "");
  assert.deepEqual(snapshot().files, before.files);
});

test("an unchanged layout does not stage or commit even with GitOps enabled", (t) => {
  const { base, snapshot } = fixture(t, true);
  mkdirSync(join(base, ".gsd", "phases"));
  const before = snapshot();
  bootstrapAutoSessionLayout(base);
  assert.deepEqual(snapshot(), before);
});

for (const gitops of [false, true]) {
  test(`repository initialization respects GitOps=${gitops}`, (t) => {
    const base = mkdtempSync(join(tmpdir(), "gsd-bootstrap-init-gitops-"));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    mkdirSync(join(base, ".gsd"));
    writeFileSync(join(base, ".gsd", "PREFERENCES.md"),
      `---\nuok:\n  gitops:\n    enabled: ${gitops}\n---\n`);
    initializeAutoSessionRepo(base);
    assert.equal(existsSync(join(base, ".git")), gitops);
  });
}

test("disabled GitOps overrides gitignore management and preserves tracked runtime files", (t) => {
  const { base, git, snapshot } = fixture(t, false, true);
  writeFileSync(join(base, ".gsd", "STATE.md"), "tracked runtime state\n");
  git("add", "--force", ".gsd/STATE.md");
  const before = snapshot();
  prepareAutoSessionGitignore(base);
  assert.deepEqual(snapshot(), before);
  assert.equal(git("ls-files", ".gsd/STATE.md"), ".gsd/STATE.md");
});

test("disabled GitOps leaves stale milestone branch and dirty work untouched", (t) => {
  const { base, git, snapshot } = fixture(t, false);
  git("checkout", "-b", "milestone/M001");
  const before = snapshot();
  recoverAutoSessionBranch(base, false);
  assert.deepEqual(snapshot(), before);
});

test("enabled GitOps still recovers a stale milestone branch", (t) => {
  const { base, git } = fixture(t, true);
  git("add", ".");
  git("commit", "-m", "preserve fixture work");
  git("checkout", "-b", "milestone/M001");
  recoverAutoSessionBranch(base, false);
  assert.equal(git("branch", "--show-current"), "main");
});

test("disabled GitOps does not delete completed branches or worktrees", (t) => {
  const { base, git, snapshot } = fixture(t, false);
  git("branch", "milestone/M001");
  const worktree = join(base, ".gsd", "worktrees", "M001");
  git("worktree", "add", worktree, "milestone/M001");
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    insertMilestone({ id: "M001", title: "Completed test", status: "complete" });
    const before = snapshot();
    const result = auditOrphanedMilestoneBranches(base, "none");
    assert.deepEqual(result, { recovered: [], warnings: [], actions: [], blockingStrandedWork: null });
    assert.deepEqual(snapshot(), before);
    assert.equal(existsSync(worktree), true);
    assert(git("worktree", "list", "--porcelain").includes("branch refs/heads/milestone/M001"));
  } finally {
    closeDatabase();
  }
});

test("disabled GitOps does not restore an orphaned untracked-file stash", (t) => {
  const { base, git, snapshot } = fixture(t, false);
  git("add", ".");
  git("commit", "-m", "preserve fixture work");
  writeFileSync(join(base, "orphan.txt"), "stashed untracked work\n");
  git("stash", "push", "--include-untracked", "-m", "gsd-preflight-stash:M001:test");
  assert.equal(existsSync(join(base, "orphan.txt")), false);
  const before = snapshot();
  const result = auditOrphanedPreflightStashes(base, () => true);
  assert.deepEqual(result, { applied: [], warnings: [] });
  assert.equal(existsSync(join(base, "orphan.txt")), false);
  assert.deepEqual(snapshot(), before);
});

for (const gitops of [false, true]) {
  test(`external-state migration respects GitOps=${gitops} for index cleanup`, (t) => {
    const { base, snapshot } = fixture(t, gitops);
    const stateDir = mkdtempSync(join(tmpdir(), "gsd-migration-gitops-"));
    t.after(() => rmSync(stateDir, { recursive: true, force: true }));
    const oldStateDir = process.env.GSD_STATE_DIR;
    const original = childProcess.execFileSync;
    let indexCleanupCalls = 0;
    process.env.GSD_STATE_DIR = stateDir;
    // Record the real index-cleanup call, not a stubbed migration result.
    childProcess.execFileSync = ((file: string, args: string[], options: unknown) => {
      if (file === "git" && args[0] === "rm" && args.includes("--cached")) indexCleanupCalls++;
      return original(file, args, options as Parameters<typeof original>[2]);
    }) as typeof original;
    syncBuiltinESMExports();
    try {
      const beforeStatus = execFileSync("git", ["status", "--porcelain"], { cwd: base, encoding: "utf8" });
      const before = snapshot();
      const result = migrateToExternalState(base);
      assert.equal(result.migrated, gitops, result.error);
      assert.equal(indexCleanupCalls, gitops ? 1 : 0);
      assert.deepEqual(snapshot(), before);
      if (!gitops) {
        assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: base, encoding: "utf8" }), beforeStatus);
      }
      assert(existsSync(join(base, ".gsd", "PREFERENCES.md")));
    } finally {
      childProcess.execFileSync = original;
      syncBuiltinESMExports();
      if (oldStateDir === undefined) delete process.env.GSD_STATE_DIR;
      else process.env.GSD_STATE_DIR = oldStateDir;
    }
  });
}

for (const isolation of ["none", "worktree"]) {
  test(`full bootstrap with disabled GitOps preserves external ownership (${isolation} configured)`, async (t) => {
    const { base, git, snapshot } = fixture(t, false, true, isolation);
    git("checkout", "-b", "milestone/M002");
    git("branch", "milestone/M003");
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Active fixture", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Planned fixture", status: "pending", sequence: 1 });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Pending fixture", status: "pending" });
    insertMilestone({ id: "M002", title: "Stale current branch", status: "complete" });
    insertMilestone({ id: "M003", title: "Merged orphan", status: "complete" });
    closeDatabase();
    const previousCwd = process.cwd();
    const session = new AutoSession();
    const model = { provider: "claude-code", id: "claude-sonnet-4-6", contextWindow: 128000 };
    const notices: string[] = [];
    const beforeStatus = git("status", "--porcelain");
    const before = snapshot();
    const lifecycleCalls: string[] = [];
    try {
      const ready = await bootstrapAutoSession(session, {
        ui: { notify: (message: string) => notices.push(message), setStatus() {}, setWidget() {} },
        model,
        modelRegistry: {
          getAvailable: () => [model], isProviderRequestReady: () => true, getProviderAuthMode: () => "oauth",
        },
        sessionManager: { getSessionId: () => "gitops-bootstrap-test", getSessionFile: () => null, getEntries: () => [] },
      } as any, {
        getThinkingLevel: () => "medium", getActiveTools: () => [], events: { emit() {} },
      } as any, base, false, false, {
        shouldUseWorktreeIsolation: () => true,
        registerSigtermHandler() {}, registerAutoWorkerForSession() {}, lockBase: () => base,
        buildLifecycle: () => new Proxy({
          adoptSessionRoot: (path: string) => { session.basePath = path; session.originalBasePath = path; },
        }, {
          get(target, name: string) {
            if (name === "adoptSessionRoot") return target.adoptSessionRoot;
            return () => { lifecycleCalls.push(name); throw new Error(`Unexpected Git lifecycle call: ${name}`); };
          },
        }) as any,
      }, {
        classification: "none", lock: null, pausedSession: null, state: null, recovery: null,
        recoveryPrompt: null, recoveryToolCallCount: 0, artifactSatisfied: false,
        hasResumableDiskState: false, isBootstrapCrash: false,
      });
      assert.equal(ready, true, notices.join("\n"));
      assert.deepEqual(lifecycleCalls, [], "startup must not enter, adopt, or merge Git isolation");
      assert.deepEqual(snapshot(), before);
      assert.equal(git("status", "--porcelain"), beforeStatus);
    } finally {
      closeDatabase();
      releaseSessionLock(base);
      process.chdir(previousCwd);
    }
  });
}

test("disabled GitOps never promotes survivor recovery to branch or worktree mode", () => {
  for (const isolation of ["none", "branch", "worktree"] as const) {
    for (const phase of ["complete", "pre-planning", "needs-discussion"]) {
      assert.equal(resolveSurvivorRecoveryIsolationMode(isolation, phase, false), "none");
    }
  }
  assert.equal(resolveSurvivorRecoveryIsolationMode("none", "complete", true), "branch");
});
