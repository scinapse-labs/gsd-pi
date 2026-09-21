// gsd-pi + src/resources/extensions/gsd/orphan-stash-audit.ts
// Startup sweep for orphaned gsd-preflight-stash entries left behind by
// interrupted milestone merges (#5538-followup).

import { execFileSync } from "node:child_process";
import { GIT_NO_PROMPT_ENV } from "./git-constants.js";
import { loadUokFlags } from "./uok/flags.js";

export interface OrphanPreflightStashAuditResult {
  applied: Array<{ milestoneId: string; stashRef: string }>;
  warnings: string[];
}

/**
 * Recognize the "already restored" failure mode of `git stash apply`.
 *
 * When a preflight stash captured untracked files via `--include-untracked`
 * and those files are now present in the working tree (e.g. a prior audit
 * run already applied this stash), `git stash apply` aborts with
 * `<path> already exists, no checkout` and exits non-zero. That is the
 * idempotent steady state for this audit, not a recovery failure — treat
 * it as a no-op so repeated GSD startups stop spamming the user with
 * warnings about stashes that have already been restored (#5538-followup
 * peer-review feedback).
 */
function _isAlreadyRestoredApplyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const stderr = (err as { stderr?: unknown }).stderr;
  const stderrText = typeof stderr === "string" ? stderr : stderr instanceof Uint8Array ? Buffer.from(stderr).toString("utf-8") : "";
  if (stderrText && /already exists, no checkout/i.test(stderrText)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /already exists, no checkout/i.test(message);
}

export { _isAlreadyRestoredApplyError };

function gitOutput(basePath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: basePath,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: GIT_NO_PROMPT_ENV,
  });
}

function listStashUntrackedPaths(basePath: string, stashRef: string): string[] | null {
  try {
    return gitOutput(basePath, ["ls-tree", "-r", "-z", "--name-only", `${stashRef}^3`]).split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function listStashTrackedPaths(basePath: string, stashRef: string): string[] | null {
  try {
    return gitOutput(basePath, ["diff", "--name-only", "-z", `${stashRef}^1`, stashRef]).split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

interface PorcelainEntry {
  code: string;
  path: string;
}

function readWorkingTreeStatus(basePath: string): PorcelainEntry[] | null {
  try {
    return gitOutput(basePath, ["status", "--porcelain", "-z", "--untracked-files=all"])
      .split("\0")
      .filter(Boolean)
      .map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) }));
  } catch {
    return null;
  }
}

function isAlreadyRestoredUntrackedStatus(basePath: string, stashRef: string, statusEntries: PorcelainEntry[]): boolean {
  if (statusEntries.length === 0 || statusEntries.some((entry) => entry.code !== "??")) return false;
  const stashTrackedPaths = listStashTrackedPaths(basePath, stashRef);
  if (!stashTrackedPaths || stashTrackedPaths.length > 0) return false;
  const stashUntrackedPaths = listStashUntrackedPaths(basePath, stashRef);
  if (!stashUntrackedPaths || stashUntrackedPaths.length === 0) return false;
  const stashUntrackedPathSet = new Set(stashUntrackedPaths);
  const workingTreeUntrackedPathSet = new Set(statusEntries.map((entry) => entry.path));
  // "Already restored" requires the working tree's untracked paths to match the
  // stash's untracked paths exactly, in BOTH directions:
  //   1. every current untracked path comes from the stash (no unexplained user
  //      work that an apply would clobber), AND
  //   2. every stash untracked path is already present in the working tree.
  // Without (2), a partial restore (where only some stash files were recovered)
  // would be misread as fully restored: the audit would no-op without applying
  // or warning, leaving the remaining pre-merge files missing.
  return (
    statusEntries.every((entry) => stashUntrackedPathSet.has(entry.path)) &&
    stashUntrackedPaths.every((path) => workingTreeUntrackedPathSet.has(path))
  );
}

function manualApplyWarning(stashRef: string, milestoneId: string, reason: string): string {
  return (
    `Pre-merge stash ${stashRef} for milestone ${milestoneId} not auto-applied: ${reason}; ` +
    `run \`git stash apply ${stashRef}\` manually to restore your pre-merge changes.`
  );
}

/**
 * Audit `git stash list` for orphaned `gsd-preflight-stash:M00x:*` entries.
 *
 * The matching merge code in `phases.ts` previously skipped the postflight
 * pop whenever `mergeAndExit` threw, leaking the user's pre-merge working
 * tree into the stash list. Completed-milestone stashes are only auto-applied
 * when the working tree is clean and the stash does not modify tracked files.
 * Dirty trees and tracked-file stashes are left untouched with a manual
 * recovery warning. When auto-apply is safe, `git stash apply` is invoked —
 * NOT `pop`. The stash entry stays in the list so the user retains a backup
 * if the apply produces unexpected merge results.
 *
 * Failures are best-effort: a list error (no repo, git unavailable) returns
 * an empty result. An apply error becomes a warning the user sees alongside
 * the existing orphan-branch audit messages — startup continues.
 */
export function auditOrphanedPreflightStashes(
  basePath: string,
  isMilestoneComplete: (milestoneId: string) => boolean,
): OrphanPreflightStashAuditResult {
  const result: OrphanPreflightStashAuditResult = { applied: [], warnings: [] };
  if (!loadUokFlags(basePath).gitops) return result;

  let listOutput: string;
  try {
    listOutput = gitOutput(basePath, ["stash", "list", "--format=%gd%x00%s"]);
  } catch {
    return result;
  }

  const MARKER_RE = /\bgsd-preflight-stash:([A-Za-z0-9_-]+):/;
  for (const line of listOutput.split("\n")) {
    const sep = line.indexOf("\x00");
    if (sep < 0) continue;
    const ref = line.slice(0, sep);
    const subject = line.slice(sep + 1);
    if (!ref || !subject) continue;

    const match = MARKER_RE.exec(subject);
    if (!match) continue;
    const milestoneId = match[1];

    let complete = false;
    try {
      complete = isMilestoneComplete(milestoneId);
    } catch (err) {
      result.warnings.push(
        `Could not determine completion status for ${milestoneId} during preflight-stash audit: ${err instanceof Error ? err.message : String(err)}.`,
      );
      continue;
    }
    if (!complete) continue;

    const statusEntries = readWorkingTreeStatus(basePath);
    if (!statusEntries) {
      result.warnings.push(
        manualApplyWarning(ref, milestoneId, "could not verify working tree status"),
      );
      continue;
    }
    if (statusEntries.length > 0) {
      if (isAlreadyRestoredUntrackedStatus(basePath, ref, statusEntries)) continue;
      result.warnings.push(manualApplyWarning(ref, milestoneId, "working tree not clean"));
      continue;
    }

    const trackedPaths = listStashTrackedPaths(basePath, ref);
    if (trackedPaths === null) {
      result.warnings.push(
        manualApplyWarning(ref, milestoneId, "could not inspect tracked paths in stash"),
      );
      continue;
    }
    if (trackedPaths.length > 0) {
      // A retained tracked-file stash has no durable marker showing whether a
      // clean tree needs first recovery or would be re-mutated by an old backup.
      const preview = trackedPaths.slice(0, 5).join(", ");
      const suffix = trackedPaths.length > 5 ? `, and ${trackedPaths.length - 5} more` : "";
      result.warnings.push(
        manualApplyWarning(ref, milestoneId, `stash modifies tracked files (${preview}${suffix})`),
      );
      continue;
    }

    try {
      gitOutput(basePath, ["stash", "apply", "--quiet", ref]);
      result.applied.push({ milestoneId, stashRef: ref });
    } catch (err) {
      // Idempotent steady state: stash was already applied in a prior audit
      // run; the files exist and `git stash apply` refuses to overwrite.
      // Skip silently so repeat runs are no-ops.
      if (_isAlreadyRestoredApplyError(err)) continue;
      result.warnings.push(
        `Could not apply orphaned preflight stash ${ref} (milestone ${milestoneId}): ${err instanceof Error ? err.message : String(err)}. ` +
          `Run \`git stash apply ${ref}\` manually to restore your pre-merge changes.`,
      );
    }
  }

  return result;
}
