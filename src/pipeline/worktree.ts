import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { git, runCommand } from "./exec.js";
import { gateDirFor } from "./toolcall-record.js";

export interface Worktree {
  path: string;
  branch: string | null;
  baseSha: string;
  repoRoot: string;
  jobId: string;
}

export interface GitSnapshot {
  refs: string;
  hooks: string;
  config: string;
}

export function repoHash(repoRoot: string): string {
  const resolved = path.resolve(repoRoot);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return createHash("sha1").update(normalized).digest("hex").slice(0, 10);
}

const repoLocks = new Map<string, Promise<unknown>>();

export function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const key =
    process.platform === "win32" ? path.resolve(repoRoot).toLowerCase() : path.resolve(repoRoot);
  const prev = repoLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => fn());
  repoLocks.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

export async function isDirty(repoRoot: string): Promise<boolean> {
  const out = await git(["status", "--porcelain"], repoRoot);
  return out.trim().length > 0;
}

export async function createWorktree(o: {
  repoRoot: string;
  jobId: string;
  root: string;
  baseRef?: string;
  detached?: boolean;
}): Promise<Worktree> {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(o.jobId)) {
    throw new Error("invalid job id");
  }
  const wtPath = path.join(o.root, repoHash(o.repoRoot), o.jobId);
  const baseRef = o.baseRef ?? "HEAD";
  const baseSha = await git(["rev-parse", `${baseRef}^{commit}`], o.repoRoot);
  const branch = o.detached ? null : `agy/${o.jobId}`;

  await withRepoLock(o.repoRoot, async () => {
    const args = ["worktree", "add"];
    if (o.detached) {
      args.push("--detach");
    } else {
      args.push("-b", branch!);
    }
    args.push(wtPath, baseSha);
    await git(args, o.repoRoot);
  });

  return {
    path: wtPath,
    branch,
    baseSha,
    repoRoot: o.repoRoot,
    jobId: o.jobId,
  };
}

export async function removeWorktree(wt: Worktree, o?: { deleteBranch?: boolean }): Promise<void> {
  await withRepoLock(wt.repoRoot, async () => {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await git(["worktree", "remove", "--force", wt.path], wt.repoRoot);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (lastErr) throw lastErr;
    rmSync(gateDirFor(wt.path), { recursive: true, force: true });
    await git(["worktree", "prune"], wt.repoRoot);
    if (o?.deleteBranch && wt.branch) {
      try {
        await git(["branch", "-D", wt.branch], wt.repoRoot);
      } catch {
        // branch may already be deleted
      }
    }
  });
}

export async function excludeInRepo(repoRoot: string, patterns: string[]): Promise<void> {
  const common = await git(["rev-parse", "--git-common-dir"], repoRoot);
  const excludePath = path.resolve(repoRoot, common, "info", "exclude");
  mkdirSync(path.dirname(excludePath), { recursive: true });

  let existing = "";
  if (existsSync(excludePath)) {
    existing = readFileSync(excludePath, "utf8");
  }
  const lines = existing.split(/\r?\n/);
  const toAppend: string[] = [];
  for (const p of patterns) {
    if (!lines.includes(p)) {
      toAppend.push(p);
      lines.push(p);
    }
  }
  if (toAppend.length > 0) {
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(excludePath, prefix + toAppend.join("\n") + "\n");
  }
}

export async function commitAll(wt: Worktree, message: string): Promise<string | null> {
  await git(["add", "-A"], wt.path);
  const diffRes = await runCommand(["git", "diff", "--cached", "--quiet"], { cwd: wt.path });
  if (diffRes.code === 0) {
    return null;
  }
  await git(["commit", "-m", message], wt.path);
  return await git(["rev-parse", "HEAD"], wt.path);
}

export async function changedFiles(wt: Worktree): Promise<string[]> {
  const diffOut = await git(["diff", "--name-only", wt.baseSha], wt.path);
  const untrackedOut = await git(["ls-files", "--others", "--exclude-standard"], wt.path);
  const diffFiles = diffOut
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const untrackedFiles = untrackedOut
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const set = new Set<string>();
  for (const f of [...diffFiles, ...untrackedFiles]) {
    set.add(f.replace(/\\/g, "/"));
  }
  return Array.from(set).sort();
}

export async function diffStat(wt: Worktree): Promise<string> {
  return await git(["diff", "--stat", `${wt.baseSha}..HEAD`], wt.path);
}

export async function mergeCheck(
  repoRoot: string,
  target: string,
  branch: string,
): Promise<{ clean: boolean; conflictingFiles: string[] }> {
  const res = await runCommand(
    ["git", "merge-tree", "--write-tree", "--name-only", "--no-messages", target, branch],
    { cwd: repoRoot },
  );
  if (res.code === 0) {
    return { clean: true, conflictingFiles: [] };
  }
  const lines = res.stdout
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const conflictingFiles = lines.slice(1);
  return { clean: false, conflictingFiles };
}

export async function snapshotGitState(
  repoRoot: string,
  ignoreBranch?: string,
): Promise<GitSnapshot> {
  const common = await git(["rev-parse", "--git-common-dir"], repoRoot);
  const commonDir = path.resolve(repoRoot, common);

  const refsOut = await git(["for-each-ref", "--format=%(refname) %(objectname)"], repoRoot);
  const ignoreRef = ignoreBranch ? `refs/heads/${ignoreBranch}` : null;
  const refLines = refsOut
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && (!ignoreRef || !l.startsWith(ignoreRef + " ")))
    .sort();
  const refs = refLines.join("\n");

  const hooksDir = path.join(commonDir, "hooks");
  let hooks = "";
  if (existsSync(hooksDir)) {
    const files = readdirSync(hooksDir);
    const hookEntries: string[] = [];
    for (const file of files) {
      if (file.endsWith(".sample")) continue;
      const stat = statSync(path.join(hooksDir, file));
      hookEntries.push(`${file}:${stat.size}`);
    }
    hooks = hookEntries.sort().join("\n");
  }

  const configPath = path.join(commonDir, "config");
  let config = "";
  if (existsSync(configPath)) {
    config = readFileSync(configPath, "utf8");
  }

  return { refs, hooks, config };
}

/**
 * Ref changes that point at commits made during the job (reachable from the job's HEAD but not
 * from where the job started). Changes the user makes meanwhile, such as committing to main,
 * point elsewhere and are ignored. Returns "<ref> -> <sha>" entries.
 */
export async function suspiciousRefChanges(
  repoRoot: string,
  before: GitSnapshot,
  after: GitSnapshot,
  o: { jobHead: string; startSha: string },
): Promise<string[]> {
  const parse = (s: string) =>
    new Map(
      s
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.slice(0, l.lastIndexOf(" ")), l.slice(l.lastIndexOf(" ") + 1)] as const),
    );
  const isAncestor = async (a: string, b: string) =>
    (await runCommand(["git", "merge-base", "--is-ancestor", a, b], { cwd: repoRoot })).code === 0;
  const prev = parse(before.refs);
  const out: string[] = [];
  for (const [ref, sha] of parse(after.refs)) {
    if (prev.get(ref) === sha) continue;
    if ((await isAncestor(sha, o.jobHead)) && !(await isAncestor(sha, o.startSha))) {
      out.push(`${ref} -> ${sha.slice(0, 8)}`);
    }
  }
  return out;
}

export function gitStateChanged(before: GitSnapshot, after: GitSnapshot): string[] {
  const changed: string[] = [];
  if (before.refs !== after.refs) changed.push("refs");
  if (before.hooks !== after.hooks) changed.push("hooks");
  if (before.config !== after.config) changed.push("config");
  return changed;
}
