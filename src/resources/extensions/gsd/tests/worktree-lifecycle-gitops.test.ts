import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoSession } from "../auto/session.js";
import { GitServiceImpl } from "../git-service.js";
import { WorktreeStateProjection } from "../worktree-state-projection.js";
import { WorktreeLifecycle, mergeMilestoneStandalone, type WorktreeLifecycleDeps } from "../worktree-lifecycle.js";

function fixture(t: test.TestContext, gitops = false) {
  const base = mkdtempSync(join(tmpdir(), "gsd-lifecycle-gitops-"));
  const previousCwd = process.cwd();
  t.after(() => { process.chdir(previousCwd); rmSync(base, { recursive: true, force: true }); });
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
  const git = (...args: string[]) => run(base, ...args);
  git("init", "-b", "main"); git("config", "user.name", "Lifecycle test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(base, ".gitignore"), ".gsd/\n");
  writeFileSync(join(base, "owned.txt"), "baseline owned\n");
  writeFileSync(join(base, "unrelated.txt"), "baseline unrelated\n");
  git("add", "."); git("commit", "-m", "fixture baseline");
  mkdirSync(join(base, ".gsd"));
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"),
    `---\nuok:\n  gitops:\n    enabled: ${gitops}\ngit:\n  isolation: worktree\n  auto_push: false\n---\n`);
  const worktree = join(base, ".gsd", "worktrees", "M002");
  git("worktree", "add", "-b", "milestone/M002", worktree);
  writeFileSync(join(worktree, "stranded.txt"), "unmerged prior-session work\n");
  run(worktree, "add", "."); run(worktree, "commit", "-m", "fixture stranded work");
  writeFileSync(join(worktree, "unrelated.txt"), "dirty worktree work\n");
  writeFileSync(join(base, "owned.txt"), "staged task work\n"); git("add", "owned.txt");
  writeFileSync(join(base, "owned.txt"), "unstaged task work\n");
  writeFileSync(join(base, "unrelated.txt"), "unstaged unrelated work\n");
  writeFileSync(join(base, "untracked.txt"), "untracked work\n");
  const s = new AutoSession();
  s.basePath = worktree; s.originalBasePath = base; s.currentMilestoneId = "M002";
  s.strandedRecoveryIsolationMode = "worktree";
  const mutationCalls: string[] = [];
  const deps: WorktreeLifecycleDeps = {
    gitServiceFactory: path => new GitServiceImpl(path),
    worktreeProjection: new WorktreeStateProjection(),
    mergeMilestone: () => { mutationCalls.push("mergeMilestone"); throw new Error("Unexpected merge"); },
  };
  const lifecycle = new WorktreeLifecycle(s, deps);
  const ctx = { notify() {} };
  const snapshot = () => ({
    head: git("rev-parse", "HEAD"), refs: git("for-each-ref", "--format=%(refname) %(objectname)"),
    index: readFileSync(join(base, ".git", "index")).toString("hex"),
    config: readFileSync(join(base, ".git", "config"), "utf8"),
    worktrees: git("worktree", "list", "--porcelain"),
    files: ["owned.txt", "unrelated.txt", "untracked.txt"].map(f => readFileSync(join(base, f), "utf8")),
    worktreeExists: existsSync(worktree),
    worktreeFiles: ["owned.txt", "unrelated.txt", "stranded.txt"].map(f => existsSync(join(worktree, f)) ? readFileSync(join(worktree, f), "utf8") : null),
  });
  return { base, worktree, s, deps, lifecycle, ctx, mutationCalls, snapshot };
}

for (const merge of [false, true]) {
  test(`GitOps opt-out preserves stale worktree on exit (merge=${merge})`, (t) => {
    const f = fixture(t);
    const before = f.snapshot();
    const result = f.lifecycle.exitMilestone("M002", { merge }, f.ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.s.basePath, f.base);
    assert.deepEqual(f.mutationCalls, []);
  });
}

test("GitOps opt-out skips stash-producing closeout preflight", (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  const result = f.lifecycle.exitMilestone("M002", {
    merge: true,
    guardedMerge: {
      projectRoot: f.base,
      preflightCleanRoot: () => { assert.fail("Disabled GitOps must not stash user work"); },
      postflightPopStash: () => { assert.fail("Disabled GitOps must not pop user stashes"); },
    },
  }, f.ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(f.snapshot(), before);
});

test("GitOps opt-out blocks standalone closeout even with forced recovery isolation", (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  const result = mergeMilestoneStandalone(f.deps, {
    originalBasePath: f.base, worktreeBasePath: f.worktree, milestoneId: "M002",
    isolationModeOverride: "worktree", isolationDegraded: false, notify() {},
  });
  assert.deepEqual(result, { merged: false, mode: "skipped", codeFilesChanged: false, pushed: false });
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.mutationCalls, []);
});

test("GitOps opt-out overrides stranded milestone adoption and branch fallback", (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  const entered = f.lifecycle.adoptStrandedMilestone("M002", f.base, f.ctx, { mode: "branch" });
  assert.equal(entered.ok, true);
  if (entered.ok) assert.equal(entered.mode, "none");
  assert.equal(f.s.strandedRecoveryIsolationMode, null);
  f.lifecycle.degradeToBranchMode("M002", f.ctx);
  assert.deepEqual(f.snapshot(), before);
});

for (const gitops of [false, true]) {
  test(`paused worktree adoption respects GitOps=${gitops}`, (t) => {
    const f = fixture(t, gitops);
    const before = f.snapshot();
    f.lifecycle.resumeFromPausedSession(f.base, f.worktree);
    assert.equal(f.s.basePath, gitops ? f.worktree : f.base);
    if (!gitops) assert.equal(f.s.strandedRecoveryIsolationMode, null);
    assert.deepEqual(f.snapshot(), before);
  });
}
