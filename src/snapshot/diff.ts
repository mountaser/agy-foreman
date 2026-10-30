import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../pipeline/exec.js";
import type { DiffStat } from "./types.js";

const IGNORED_PREFIXES = [".agy-task/", ".agents/"];
const MAX_UNTRACKED_BYTES = 1_000_000;

const ignored = (p: string) => {
  const norm = p.replace(/\\/g, "/");
  return IGNORED_PREFIXES.some((d) => norm.startsWith(d));
};

function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * Files, added lines and deleted lines in a job's worktree: tracked changes against HEAD plus new
 * untracked files. Every git call uses `--no-optional-locks`, so it never takes the index lock and
 * cannot collide with Gemini's or the pipeline's own git commands. Undefined when the folder is
 * not itself a worktree or git fails.
 */
export async function diffStat(
  worktree: string,
  run: typeof runCommand = runCommand,
): Promise<DiffStat | undefined> {
  // A folder inside some other repository would make git measure that repository instead.
  if (!existsSync(path.join(worktree, ".git"))) return undefined;
  const tracked = await run(["git", "--no-optional-locks", "diff", "--numstat", "HEAD"], {
    cwd: worktree,
    timeoutMs: 5000,
  });
  const untracked = await run(
    ["git", "--no-optional-locks", "ls-files", "--others", "--exclude-standard"],
    { cwd: worktree, timeoutMs: 5000 },
  );
  if (tracked.code !== 0 || untracked.code !== 0) return undefined;

  let files = 0;
  let added = 0;
  let deleted = 0;
  for (const line of tracked.stdout.split(/\r?\n/)) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m || ignored(m[3])) continue;
    files++;
    added += m[1] === "-" ? 0 : Number(m[1]);
    deleted += m[2] === "-" ? 0 : Number(m[2]);
  }
  for (const rel of untracked.stdout.split(/\r?\n/)) {
    if (!rel || ignored(rel)) continue;
    files++;
    try {
      const file = path.join(worktree, rel);
      if ((await stat(file)).size <= MAX_UNTRACKED_BYTES) {
        added += countLines((await readFile(file)).toString("utf8"));
      }
    } catch {
      // unreadable: it still counts as a file
    }
  }
  return { files, added, deleted };
}
