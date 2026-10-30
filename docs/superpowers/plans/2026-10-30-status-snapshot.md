# Status Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agy-foreman server write `status.json`, a small versioned file describing the delegation work that is running, as specified in `docs/superpowers/specs/2026-10-30-status-snapshot-design.md`.

**Architecture:** Pure functions turn job records into a snapshot (`buildSnapshot`), classify tool calls into plain activities (`activityFor`) and measure a worktree's diff (`diffStat`). A `SnapshotWriter` runs inside the MCP server, rebuilds the snapshot whenever a job record is written and once a second while a job is active, and writes it atomically. The job store gets an optional write callback, job records get an `activity` and the plan's `delegateSteps`.

**Tech Stack:** TypeScript (strict, ESM), Node 20+, vitest, prettier. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-30-status-snapshot-design.md`. Behavior there is authoritative.
- ESM imports use the `.js` suffix (`import { x } from "./y.js"`). Type-only imports use `import type`.
- Format with `npx prettier --write src test` (print width 100). `npm run test:ci` must pass before every commit: it runs `tsc --noEmit`, `prettier --check src test` and `vitest`.
- No new dependencies. The only process the new code starts is `git`, in `src/snapshot/diff.ts`.
- Tests that touch the filesystem use `mkdtempSync(path.join(os.tmpdir(), "foreman-..."))`.
- A failure while building or writing a snapshot must never stop or fail a job.
- Run every command in Git Bash.
- Commit after every task. Do not push.

## File Structure

```
src/snapshot/types.ts         Snapshot, Activity, DiffStat and related types
src/snapshot/activity.ts      classifyTool, activityFor
src/snapshot/diff.ts          diffStat (live worktree diff)
src/snapshot/build.ts         buildSnapshot, parseShortstat, cleanTitle
src/snapshot/writer.ts        SnapshotWriter
src/paths.ts                  + statusFile()
src/jobs/store.ts             + Progress.activity, plan.delegateSteps, JobStore onWrite callback
src/jobs/start.ts             record.plan keeps delegateSteps
src/jobs/execute.ts           records activity from stream events
src/runtime.ts                creates and starts the writer
test/snapshot/*.test.ts       one test file per module
test/paths-status.test.ts
test/jobs/store-onwrite.test.ts
```

---

### Task 1: Types, status file path and store hooks

**Files:**
- Create: `src/snapshot/types.ts`
- Modify: `src/paths.ts` (add `statusFile`), `src/jobs/store.ts`
- Test: `test/paths-status.test.ts`, `test/jobs/store-onwrite.test.ts`

**Interfaces:**
- Produces:
  - `src/snapshot/types.ts`: `ActivityKind`, `Activity`, `DiffStat`, `StepState`, `SnapshotJob`, `Snapshot` (exact shapes below).
  - `statusFile(p?: Partial<PathEnv>): string` in `src/paths.ts`.
  - `Progress.activity?: Activity` and `JobRecord.plan.delegateSteps?: number[]` in `src/jobs/store.ts`.
  - `new JobStore(dir: string, onWrite?: (rec: JobRecord) => void)`; `onWrite` runs after each successful `write`, and an exception from it is swallowed.

- [ ] **Step 1: Write the failing tests**

`test/paths-status.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { statusFile } from "../src/paths.js";

describe("statusFile", () => {
  it("puts status.json in the state dir on every platform", () => {
    expect(
      statusFile({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
        home: "C:\\Users\\a",
      }),
    ).toBe("C:\\Users\\a\\AppData\\Local\\agy-foreman\\status.json");
    expect(statusFile({ platform: "linux", env: { XDG_STATE_HOME: "/s" }, home: "/h" })).toBe(
      "/s/agy-foreman/status.json",
    );
    expect(statusFile({ platform: "darwin", env: {}, home: "/Users/a" })).toBe(
      "/Users/a/Library/Application Support/agy-foreman/status.json",
    );
  });

  it("follows FOREMAN_STATE_DIR", () => {
    expect(statusFile({ platform: "linux", env: { FOREMAN_STATE_DIR: "/x" }, home: "/h" })).toBe(
      "/x/status.json",
    );
  });
});
```

`test/jobs/store-onwrite.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyProgress, JobStore, type JobRecord } from "../../src/jobs/store.js";

function record(id: string): JobRecord {
  return {
    id,
    kind: "implement",
    repoRoot: "/repo",
    title: "Task",
    state: "running",
    progress: emptyProgress(),
    createdAt: "2026-10-30T14:00:00.000Z",
    updatedAt: "2026-10-30T14:00:00.000Z",
    returnedChars: 0,
  };
}

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "foreman-store-"));

describe("JobStore onWrite", () => {
  it("calls the callback after each write", async () => {
    const seen: string[] = [];
    const store = new JobStore(tmp(), (r) => seen.push(r.id));
    await store.write(record("a"));
    await store.write(record("b"));
    expect(seen).toEqual(["a", "b"]);
  });

  it("does not let a throwing callback break the write", async () => {
    const store = new JobStore(tmp(), () => {
      throw new Error("boom");
    });
    await store.write(record("a"));
    expect((await store.read("a"))?.id).toBe("a");
  });

  it("keeps the activity and delegate steps in the record", async () => {
    const store = new JobStore(tmp());
    const r = record("a");
    r.plan = { file: "docs/p.md", step: 4, delegateSteps: [2, 3, 4] };
    r.progress.activity = { kind: "editing", target: "render.go", at: "2026-10-30T14:00:01.000Z" };
    await store.write(r);
    const back = await store.read("a");
    expect(back?.plan?.delegateSteps).toEqual([2, 3, 4]);
    expect(back?.progress.activity?.target).toBe("render.go");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/paths-status.test.ts test/jobs/store-onwrite.test.ts`
Expected: FAIL (`statusFile` is not exported). The store tests only fail the type check, which `npm run test:ci` runs through `tsc`.

- [ ] **Step 3: Write the implementation**

`src/snapshot/types.ts`:
```ts
import type { JobPhase } from "../jobs/store.js";
import type { QuotaSnapshot } from "../usage-quota.js";

export type ActivityKind = "reading" | "editing" | "testing" | "git" | "command" | "thinking";

export interface Activity {
  kind: ActivityKind;
  /** Base name of the file or folder, when the tool names one. Never a command line. */
  target?: string;
  /** ISO time the activity started. */
  at: string;
}

export interface DiffStat {
  files: number;
  added: number;
  deleted: number;
}

export type StepState = "passed" | "running" | "queued" | "failed" | "pending";

export interface SnapshotJob {
  id: string;
  step: number | null;
  title: string;
  state: "queued" | "running";
  phase: JobPhase;
  activity?: Activity;
}

export interface Snapshot {
  version: 1;
  updatedAt: string;
  pid: number;
  active: boolean;
  plan?: {
    file: string | null;
    steps: StepState[];
    done: number;
    failed: number;
    elapsedSec: number;
    tokens: number;
    diff?: DiffStat;
  };
  jobs: SnapshotJob[];
  quota?: QuotaSnapshot;
}
```

In `src/paths.ts`, add after `jobsDir`:
```ts
export function statusFile(p?: Partial<PathEnv>): string {
  const e = resolveEnv(p);
  return joinFor(e.platform)(stateDir(e), "status.json");
}
```

In `src/jobs/store.ts`:

1. Add near the other imports: `import type { Activity } from "../snapshot/types.js";`
2. In `interface Progress`, after `etaSec?: number;` add: `activity?: Activity;`
3. In `interface JobRecord`, change the plan line to: `plan?: { file: string; step: number; delegateSteps?: number[] };`
4. Replace `export class JobStore {\n  constructor(readonly dir: string) {}` with:
```ts
export class JobStore {
  constructor(
    readonly dir: string,
    private readonly onWrite?: (rec: JobRecord) => void,
  ) {}
```
5. At the end of `write`, after the `await this.queue.run(...)` call, add:
```ts
    try {
      this.onWrite?.(rec);
    } catch {
      // observers must never break a write
    }
```

- [ ] **Step 4: Run the tests and the full check**

Run: `npx prettier --write src test && npm run test:ci`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/types.ts src/paths.ts src/jobs/store.ts test/paths-status.test.ts test/jobs/store-onwrite.test.ts
git commit -m "feat: snapshot types, status file path and store write hook"
```

---

### Task 2: Activity classification

**Files:**
- Create: `src/snapshot/activity.ts`
- Test: `test/snapshot/activity.test.ts`

**Interfaces:**
- Consumes: `Activity`, `ActivityKind` from `src/snapshot/types.ts` (Task 1).
- Produces:
  - `classifyTool(toolName: string | undefined, params: Record<string, unknown> | undefined): { kind: ActivityKind; target?: string } | undefined`
  - `activityFor(prev: Activity | undefined, ev: { toolName?: string; toolParams?: Record<string, unknown>; state: string }, now: Date): Activity | undefined`

- [ ] **Step 1: Write the failing test**

`test/snapshot/activity.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { activityFor, classifyTool } from "../../src/snapshot/activity.js";
import type { Activity } from "../../src/snapshot/types.js";

const NOW = new Date("2026-10-30T14:30:00.000Z");

describe("classifyTool", () => {
  it("names the file for edits", () => {
    expect(
      classifyTool("write_to_file", { TargetFile: "C:\\wt\\internal\\render\\render.go" }),
    ).toEqual({ kind: "editing", target: "render.go" });
    expect(classifyTool("replace_file_content", { TargetFile: "/wt/a/b.ts" })).toEqual({
      kind: "editing",
      target: "b.ts",
    });
    expect(classifyTool("multi_replace_file_content", { TargetFile: "/wt/x.go" })).toEqual({
      kind: "editing",
      target: "x.go",
    });
  });

  it("names the file or folder for reads", () => {
    expect(classifyTool("view_file", { AbsolutePath: "/wt/.agy-task/brief.md" })).toEqual({
      kind: "reading",
      target: "brief.md",
    });
    expect(classifyTool("list_dir", { DirectoryPath: "/wt/internal" })).toEqual({
      kind: "reading",
      target: "internal",
    });
    expect(classifyTool("grep_search", { SearchPath: "/wt/src", Query: "foo" })).toEqual({
      kind: "reading",
      target: "src",
    });
    expect(classifyTool("read_url_content", { Url: "https://x.y/z" })).toEqual({
      kind: "reading",
    });
  });

  it("describes commands without ever showing them", () => {
    expect(classifyTool("run_command", { CommandLine: "go test ./..." })).toEqual({
      kind: "testing",
    });
    expect(classifyTool("run_command", { CommandLine: "npx vitest run" })).toEqual({
      kind: "testing",
    });
    expect(classifyTool("run_command", { CommandLine: "gofmt -l ." })).toEqual({
      kind: "testing",
    });
    expect(classifyTool("run_command", { CommandLine: "git status" })).toEqual({ kind: "git" });
    const odd = classifyTool("run_command", {
      CommandLine: "echo $([System.IO.File]::Delete('x'))",
    });
    expect(odd).toEqual({ kind: "command" });
    expect(JSON.stringify(odd)).not.toContain("echo");
  });

  it("recognises a test command that follows other commands", () => {
    expect(classifyTool("run_command", { CommandLine: "cd internal && go test ./..." })).toEqual({
      kind: "testing",
    });
  });

  it("does not take a word inside an argument for a test command", () => {
    expect(classifyTool("run_command", { CommandLine: 'git commit -m "fix tsc"' })).toEqual({
      kind: "git",
    });
    expect(classifyTool("run_command", { CommandLine: 'echo "go test"' })).toEqual({
      kind: "command",
    });
  });

  it("ignores tools that only poll or feed a terminal", () => {
    expect(classifyTool("command_status", { CommandId: "1" })).toBeUndefined();
    expect(classifyTool("read_terminal", {})).toBeUndefined();
    expect(classifyTool("send_command_input", { Input: "y" })).toBeUndefined();
  });

  it("returns undefined for unknown or missing tools", () => {
    expect(classifyTool("mystery_tool", {})).toBeUndefined();
    expect(classifyTool(undefined, {})).toBeUndefined();
  });
});

describe("activityFor", () => {
  it("records the tool that is running", () => {
    expect(
      activityFor(
        undefined,
        { toolName: "view_file", toolParams: { AbsolutePath: "/a/b.md" }, state: "RUNNING" },
        NOW,
      ),
    ).toEqual({ kind: "reading", target: "b.md", at: NOW.toISOString() });
  });

  it("switches to thinking when a step finishes", () => {
    const prev: Activity = { kind: "editing", target: "a.go", at: "2026-10-30T14:29:00.000Z" };
    expect(activityFor(prev, { toolName: "write_to_file", state: "DONE" }, NOW)).toEqual({
      kind: "thinking",
      at: NOW.toISOString(),
    });
  });

  it("keeps the first moment of thinking when more steps finish", () => {
    const prev: Activity = { kind: "thinking", at: "2026-10-30T14:29:50.000Z" };
    expect(activityFor(prev, { state: "done" }, NOW)).toBe(prev);
  });

  it("keeps the previous activity for unknown tools", () => {
    const prev: Activity = { kind: "editing", target: "a.go", at: "2026-10-30T14:29:00.000Z" };
    expect(activityFor(prev, { toolName: "mystery_tool", state: "RUNNING" }, NOW)).toBe(prev);
  });

  it("keeps testing while the command's status is polled", () => {
    const prev: Activity = { kind: "testing", at: "2026-10-30T14:29:00.000Z" };
    expect(activityFor(prev, { toolName: "command_status", state: "RUNNING" }, NOW)).toBe(prev);
  });

  it("starts nothing without a tool name", () => {
    expect(activityFor(undefined, { state: "RUNNING" }, NOW)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/snapshot/activity.test.ts`
Expected: FAIL (cannot find module `../../src/snapshot/activity.js`)

- [ ] **Step 3: Write the implementation**

`src/snapshot/activity.ts`:
```ts
import type { Activity, ActivityKind } from "./types.js";

// The program must start the command or follow `&&`, `;`, `|` or `(`, so a word inside an argument
// (`git commit -m "fix tsc"`) does not count.
const TEST_COMMAND =
  /(^|&&|;|\||\()\s*(go\s+(test|vet)|gofmt|npm\s+(run\s+)?test|npx\s+(vitest|tsc|prettier)|vitest|pytest|cargo\s+test|tsc|prettier)\b/i;

const PATH_KEYS = ["TargetFile", "AbsolutePath", "DirectoryPath", "SearchDirectory", "SearchPath"];

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function targetOf(params: Record<string, unknown> | undefined): string | undefined {
  if (!params) return undefined;
  for (const key of PATH_KEYS) {
    const v = params[key];
    if (typeof v === "string" && v) {
      const name = baseName(v);
      if (name) return name;
    }
  }
  return undefined;
}

/**
 * What a tool call means in plain terms. Commands never carry their text: only whether they run
 * tests, use git or are something else. Unknown tools return undefined.
 */
export function classifyTool(
  toolName: string | undefined,
  params: Record<string, unknown> | undefined,
): { kind: ActivityKind; target?: string } | undefined {
  if (!toolName) return undefined;
  // Polling or feeding a terminal does not change what the command is.
  if (/status|terminal|input/i.test(toolName)) return undefined;
  if (/command|shell|exec/i.test(toolName)) {
    const line = String(params?.CommandLine ?? params?.command ?? "");
    if (TEST_COMMAND.test(line)) return { kind: "testing" };
    if (/^\s*git\b/i.test(line)) return { kind: "git" };
    return { kind: "command" };
  }
  const target = targetOf(params);
  if (/write|replace|edit|patch|create|delete|rename|move/i.test(toolName)) {
    return { kind: "editing", ...(target ? { target } : {}) };
  }
  if (/view|read|list|grep|find|search|open/i.test(toolName)) {
    return { kind: "reading", ...(target ? { target } : {}) };
  }
  return undefined;
}

/**
 * The activity after one stream step event. A finished step means the model is thinking until the
 * next tool starts; a tool we do not know leaves the activity as it was.
 */
export function activityFor(
  prev: Activity | undefined,
  ev: { toolName?: string; toolParams?: Record<string, unknown>; state: string },
  now: Date,
): Activity | undefined {
  if (/^done$/i.test(ev.state)) {
    return prev?.kind === "thinking" ? prev : { kind: "thinking", at: now.toISOString() };
  }
  const c = classifyTool(ev.toolName, ev.toolParams);
  return c ? { ...c, at: now.toISOString() } : prev;
}
```

- [ ] **Step 4: Run the test and the full check**

Run: `npx prettier --write src test && npm run test:ci`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/activity.ts test/snapshot/activity.test.ts
git commit -m "feat: classify tool calls into plain activities"
```

---

### Task 3: Live worktree diff

**Files:**
- Create: `src/snapshot/diff.ts`
- Test: `test/snapshot/diff.test.ts`

**Interfaces:**
- Consumes: `DiffStat` from `src/snapshot/types.ts` (Task 1); `runCommand` from `src/pipeline/exec.ts` (existing: `runCommand(argv: string[], opts: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>`).
- Produces: `diffStat(worktree: string, run?: typeof runCommand): Promise<DiffStat | undefined>`. Undefined when `git` fails (not a repository, timeout).

- [ ] **Step 1: Write the failing test**

`test/snapshot/diff.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffStat } from "../../src/snapshot/diff.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "pipe",
  });

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "foreman-diff-"));
  git(dir, "init", "-q");
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(path.join(dir, "b.txt"), "keep\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("diffStat", () => {
  it("is zero for a clean tree", async () => {
    expect(await diffStat(repo())).toEqual({ files: 0, added: 0, deleted: 0 });
  });

  it("counts tracked changes and new files, ignoring task folders", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "a.txt"), "one\nTWO\nthree\nfour\n"); // +2 -1
    writeFileSync(path.join(dir, "new.go"), "package x\n\nfunc F() {}\n"); // +3, untracked
    mkdirSync(path.join(dir, ".agy-task"));
    writeFileSync(path.join(dir, ".agy-task", "brief.md"), "x\ny\n");
    mkdirSync(path.join(dir, ".agents"));
    writeFileSync(path.join(dir, ".agents", "p.json"), "{}\n");
    expect(await diffStat(dir)).toEqual({ files: 2, added: 5, deleted: 1 });
  });

  it("counts an empty new file as a file with no lines", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "empty.txt"), "");
    expect(await diffStat(dir)).toEqual({ files: 1, added: 0, deleted: 0 });
  });

  it("counts a last line without a trailing newline", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "n.txt"), "a\nb");
    expect(await diffStat(dir)).toEqual({ files: 1, added: 2, deleted: 0 });
  });

  it("counts a file over 1 MB as a file with no lines", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "big.bin"), "a\n".repeat(600_000));
    expect(await diffStat(dir)).toEqual({ files: 1, added: 0, deleted: 0 });
  });

  it("is undefined when git fails", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "foreman-nogit-"));
    mkdirSync(path.join(dir, ".git"));
    const failing = async () => ({ code: 128, stdout: "", stderr: "fatal", timedOut: false });
    expect(await diffStat(dir, failing)).toBeUndefined();
  });

  it("is undefined for a folder that is not itself a worktree", async () => {
    const dir = repo();
    const sub = path.join(dir, "sub");
    mkdirSync(sub);
    expect(await diffStat(sub)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/snapshot/diff.test.ts`
Expected: FAIL (cannot find module `../../src/snapshot/diff.js`)

- [ ] **Step 3: Write the implementation**

`src/snapshot/diff.ts`:
```ts
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
```

- [ ] **Step 4: Run the test and the full check**

Run: `npx prettier --write src test && npm run test:ci`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/diff.ts test/snapshot/diff.test.ts
git commit -m "feat: measure a worktree's live diff"
```

---

### Task 4: Snapshot builder

**Files:**
- Create: `src/snapshot/build.ts`
- Test: `test/snapshot/build.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `SnapshotJob`, `StepState`, `DiffStat` (Task 1); `JobRecord`, `isTerminal`, `emptyProgress` from `src/jobs/store.ts`; `QuotaSnapshot` from `src/usage-quota.ts`.
- Produces:
  - `cleanTitle(title: string): string`
  - `parseShortstat(text: string): DiffStat | undefined`
  - `buildSnapshot(i: { jobs: JobRecord[]; now: Date; pid: number; quota?: QuotaSnapshot; planSteps?: (planFile: string, repoRoot: string) => number | undefined; liveDiff?: ReadonlyMap<string, DiffStat> }): Snapshot`

- [ ] **Step 1: Write the failing test**

`test/snapshot/build.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildSnapshot, cleanTitle, parseShortstat } from "../../src/snapshot/build.js";
import { emptyProgress, type JobRecord } from "../../src/jobs/store.js";
import type { DiffStat } from "../../src/snapshot/types.js";

const NOW = new Date("2026-10-30T14:30:00.000Z");

function rec(over: Partial<JobRecord> & { id: string }): JobRecord {
  return {
    kind: "implement",
    repoRoot: "/repo",
    title: "Task",
    state: "running",
    progress: emptyProgress(),
    createdAt: "2026-10-30T14:20:00.000Z",
    updatedAt: "2026-10-30T14:20:00.000Z",
    returnedChars: 0,
    ...over,
  };
}

const plan = (step: number, delegateSteps?: number[]) => ({
  file: "docs/p.md",
  step,
  ...(delegateSteps ? { delegateSteps } : {}),
});

const envelope = (totalTokens: number, diffStat: string) =>
  ({ usage: { totalTokens }, diffStat }) as unknown as JobRecord["envelope"];

describe("parseShortstat", () => {
  it("reads the summary line", () => {
    expect(parseShortstat("a.go | 63 +++\n 1 file changed, 63 insertions(+)")).toEqual({
      files: 1,
      added: 63,
      deleted: 0,
    });
    expect(parseShortstat("2 files changed, 10 insertions(+), 3 deletions(-)")).toEqual({
      files: 2,
      added: 10,
      deleted: 3,
    });
    expect(parseShortstat("1 file changed, 4 deletions(-)")).toEqual({
      files: 1,
      added: 0,
      deleted: 4,
    });
    expect(parseShortstat("nothing here")).toBeUndefined();
  });
});

describe("cleanTitle", () => {
  it("drops the task prefix, backticks and emphasis", () => {
    expect(cleanTitle("Task 4: Render the `two` lines")).toBe("Render the two lines");
    expect(cleanTitle("**Gauge** formatting")).toBe("Gauge formatting");
  });
});

describe("buildSnapshot", () => {
  const base = { now: NOW, pid: 42 };

  it("is inactive and empty when no job is active", () => {
    const s = buildSnapshot({ ...base, jobs: [rec({ id: "a", state: "passed" })] });
    expect(s).toEqual({
      version: 1,
      updatedAt: NOW.toISOString(),
      pid: 42,
      active: false,
      jobs: [],
    });
  });

  it("describes a plan with delegated steps", () => {
    const live = new Map<string, DiffStat>([["c", { files: 1, added: 5, deleted: 0 }]]);
    const s = buildSnapshot({
      ...base,
      liveDiff: live,
      jobs: [
        rec({
          id: "a",
          state: "passed",
          plan: plan(2, [2, 3, 4, 6, 7]),
          envelope: envelope(200000, "1 file changed, 1 insertion(+)"),
        }),
        rec({
          id: "b",
          state: "passed",
          plan: plan(3, [2, 3, 4, 6, 7]),
          createdAt: "2026-10-30T14:22:00.000Z",
          envelope: envelope(100000, "2 files changed, 10 insertions(+), 3 deletions(-)"),
        }),
        rec({
          id: "c",
          title: "Task 4: Render the two lines",
          plan: plan(4, [2, 3, 4, 6, 7]),
          createdAt: "2026-10-30T14:25:00.000Z",
          progress: {
            ...emptyProgress(),
            phase: "run",
            tokens: 50000,
            activity: { kind: "editing", target: "render.go", at: "2026-10-30T14:29:56.000Z" },
          },
        }),
      ],
    });
    expect(s.active).toBe(true);
    expect(s.plan).toEqual({
      file: "docs/p.md",
      steps: ["passed", "passed", "running", "pending", "pending"],
      done: 2,
      failed: 0,
      elapsedSec: 600,
      tokens: 350000,
      diff: { files: 4, added: 16, deleted: 3 },
    });
    expect(s.jobs).toEqual([
      {
        id: "c",
        step: 4,
        title: "Render the two lines",
        state: "running",
        phase: "run",
        activity: { kind: "editing", target: "render.go", at: "2026-10-30T14:29:56.000Z" },
      },
    ]);
  });

  it("lists several running jobs oldest first and drops the activity outside the run phase", () => {
    const s = buildSnapshot({
      ...base,
      jobs: [
        rec({
          id: "late",
          plan: plan(6, [2, 3, 6]),
          createdAt: "2026-10-30T14:21:00.000Z",
          progress: { ...emptyProgress(), phase: "prepare" },
        }),
        rec({
          id: "early",
          plan: plan(2, [2, 3, 6]),
          progress: {
            ...emptyProgress(),
            phase: "run",
            activity: { kind: "testing", at: "2026-10-30T14:29:00.000Z" },
          },
        }),
        rec({ id: "queued", state: "queued", plan: plan(3, [2, 3, 6]), createdAt: "2026-10-30T14:22:00.000Z" }),
      ],
    });
    expect(s.plan?.steps).toEqual(["running", "queued", "running"]);
    expect(s.jobs.map((j) => [j.id, j.state, j.phase, j.activity?.kind])).toEqual([
      ["early", "running", "run", "testing"],
      ["late", "running", "prepare", undefined],
      ["queued", "queued", "queued", undefined],
    ]);
  });

  it("treats a job without a plan as a single step", () => {
    const s = buildSnapshot({ ...base, jobs: [rec({ id: "solo" })] });
    expect(s.plan?.file).toBeNull();
    expect(s.plan?.steps).toEqual(["running"]);
    expect(s.jobs[0].step).toBeNull();
  });

  it("marks a step failed, and a passing follow-up wins over it", () => {
    const failedOnly = buildSnapshot({
      ...base,
      jobs: [
        rec({ id: "x", state: "failed", plan: plan(4, [4, 6]) }),
        rec({ id: "y", plan: plan(6, [4, 6]), createdAt: "2026-10-30T14:21:00.000Z" }),
      ],
    });
    expect(failedOnly.plan?.steps).toEqual(["failed", "running"]);
    expect(failedOnly.plan?.failed).toBe(1);

    const fixed = buildSnapshot({
      ...base,
      jobs: [
        rec({ id: "x", state: "failed", plan: plan(4, [4, 6]) }),
        rec({ id: "x2", state: "passed", plan: plan(4, [4, 6]), createdAt: "2026-10-30T14:21:00.000Z" }),
        rec({ id: "y", plan: plan(6, [4, 6]), createdAt: "2026-10-30T14:22:00.000Z" }),
      ],
    });
    expect(fixed.plan?.steps).toEqual(["passed", "running"]);
    expect(fixed.plan?.failed).toBe(0);
  });

  it("falls back to the plan file's step count, then to the steps seen", () => {
    const jobs = [
      rec({ id: "a", state: "passed", plan: plan(1) }),
      rec({ id: "b", plan: plan(2), createdAt: "2026-10-30T14:21:00.000Z" }),
    ];
    expect(buildSnapshot({ ...base, jobs, planSteps: () => 3 }).plan?.steps).toEqual([
      "passed",
      "running",
      "pending",
    ]);
    expect(buildSnapshot({ ...base, jobs }).plan?.steps).toEqual(["passed", "running"]);
  });

  it("describes only the plan of the oldest running job", () => {
    const s = buildSnapshot({
      ...base,
      jobs: [
        rec({ id: "other", state: "queued", plan: { file: "docs/other.md", step: 1 } }),
        rec({ id: "mine", plan: plan(1, [1]), createdAt: "2026-10-30T14:21:00.000Z" }),
      ],
    });
    expect(s.plan?.file).toBe("docs/p.md");
    expect(s.jobs.map((j) => j.id)).toEqual(["mine"]);
  });

  it("ignores an earlier run of the same plan", () => {
    const s = buildSnapshot({
      ...base,
      jobs: [
        rec({
          id: "old1",
          state: "passed",
          plan: plan(2, [2, 3]),
          createdAt: "2026-10-27T10:00:00.000Z",
          progress: { ...emptyProgress(), tokens: 900000 },
        }),
        rec({
          id: "old2",
          state: "passed",
          plan: plan(3, [2, 3]),
          createdAt: "2026-10-27T10:30:00.000Z",
          progress: { ...emptyProgress(), tokens: 900000 },
        }),
        rec({
          id: "new",
          plan: plan(2, [2, 3]),
          progress: { ...emptyProgress(), phase: "run", tokens: 1000 },
        }),
      ],
    });
    expect(s.plan?.steps).toEqual(["running", "pending"]);
    expect(s.plan?.done).toBe(0);
    expect(s.plan?.elapsedSec).toBe(600);
    expect(s.plan?.tokens).toBe(1000);
  });

  it("keeps the earlier jobs of the same run when the gaps are under two hours", () => {
    const s = buildSnapshot({
      ...base,
      jobs: [
        rec({
          id: "a",
          state: "passed",
          plan: plan(2, [2, 3, 4]),
          createdAt: "2026-10-30T12:30:00.000Z",
        }),
        rec({
          id: "b",
          state: "passed",
          plan: plan(3, [2, 3, 4]),
          createdAt: "2026-10-30T13:40:00.000Z",
        }),
        rec({ id: "c", plan: plan(4, [2, 3, 4]) }),
      ],
    });
    expect(s.plan?.steps).toEqual(["passed", "passed", "running"]);
    expect(s.plan?.elapsedSec).toBe(7200);
  });

  it("passes the quota through", () => {
    const quota = {
      fetchedAt: "2026-10-30T14:29:00.000Z",
      fiveHour: { remaining: 94, resetAt: "2026-10-30T17:42:00Z" },
    };
    expect(buildSnapshot({ ...base, jobs: [rec({ id: "a" })], quota }).quota).toEqual(quota);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/snapshot/build.test.ts`
Expected: FAIL (cannot find module `../../src/snapshot/build.js`)

- [ ] **Step 3: Write the implementation**

`src/snapshot/build.ts`:
```ts
import { isTerminal, type JobRecord } from "../jobs/store.js";
import type { QuotaSnapshot } from "../usage-quota.js";
import type { DiffStat, Snapshot, SnapshotJob, StepState } from "./types.js";

/** Plain-text title: drops the `Task N:` prefix, Markdown emphasis and code ticks. */
export function cleanTitle(title: string): string {
  return title
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/^task\s+\d+[:.]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reads `N files changed, A insertions(+), D deletions(-)` from the end of a `git diff --stat`. */
export function parseShortstat(text: string): DiffStat | undefined {
  const m = text.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  if (!m) return undefined;
  return { files: Number(m[1]), added: Number(m[2] ?? 0), deleted: Number(m[3] ?? 0) };
}

export interface BuildInput {
  jobs: JobRecord[];
  now: Date;
  pid: number;
  quota?: QuotaSnapshot;
  /** Number of steps in a plan file, when it can be read. */
  planSteps?: (planFile: string, repoRoot: string) => number | undefined;
  /** Live diff of running jobs, by job id. */
  liveDiff?: ReadonlyMap<string, DiffStat>;
}

const byCreated = (a: JobRecord, b: JobRecord) => a.createdAt.localeCompare(b.createdAt);

/** Two neighbouring jobs of a plan more than this far apart belong to different runs. */
const RUN_GAP_MS = 2 * 60 * 60 * 1000;

/**
 * The jobs of the shown plan that belong to the current run: everything from the oldest active job
 * on, plus the earlier jobs that lead up to it without a gap of more than two hours. Older jobs
 * of the same plan are history.
 */
function currentRun(shown: JobRecord, jobs: JobRecord[]): JobRecord[] {
  const samePlan = jobs
    .filter((j) =>
      shown.plan ? j.plan?.file === shown.plan.file && j.repoRoot === shown.repoRoot : j.id === shown.id,
    )
    .sort(byCreated);
  if (!shown.plan) return samePlan;
  let start = Math.max(
    0,
    samePlan.findIndex((j) => !isTerminal(j.state)),
  );
  while (
    start > 0 &&
    Date.parse(samePlan[start].createdAt) - Date.parse(samePlan[start - 1].createdAt) <= RUN_GAP_MS
  ) {
    start--;
  }
  return samePlan.slice(start);
}

function stepState(mine: JobRecord[]): StepState {
  if (mine.some((j) => j.state === "passed")) return "passed";
  if (mine.some((j) => j.state === "running")) return "running";
  if (mine.some((j) => j.state === "queued")) return "queued";
  return mine.length > 0 ? "failed" : "pending";
}

function stepNumbers(shown: JobRecord, group: JobRecord[], i: BuildInput): number[] | undefined {
  if (!shown.plan) return undefined;
  const listed = [...group].reverse().find((j) => j.plan?.delegateSteps?.length);
  if (listed?.plan?.delegateSteps) return listed.plan.delegateSteps;
  const n = i.planSteps?.(shown.plan.file, shown.repoRoot);
  if (n && n > 0) return Array.from({ length: n }, (_, k) => k + 1);
  return [...new Set(group.map((j) => j.plan!.step))].sort((a, b) => a - b);
}

function toSnapshotJob(j: JobRecord): SnapshotJob {
  return {
    id: j.id,
    step: j.plan?.step ?? null,
    title: cleanTitle(j.title),
    state: j.state === "queued" ? "queued" : "running",
    phase: j.progress.phase,
    ...(j.progress.phase === "run" && j.progress.activity ? { activity: j.progress.activity } : {}),
  };
}

/** The snapshot for the plan of the oldest running job (or the oldest queued one). */
export function buildSnapshot(i: BuildInput): Snapshot {
  const base = { version: 1 as const, updatedAt: i.now.toISOString(), pid: i.pid };
  const quota = i.quota ? { quota: i.quota } : {};
  const active = i.jobs.filter((j) => !isTerminal(j.state)).sort(byCreated);
  if (active.length === 0) return { ...base, active: false, jobs: [], ...quota };

  const shown = active.find((j) => j.state === "running") ?? active[0];
  const group = currentRun(shown, i.jobs);

  const numbers = stepNumbers(shown, group, i);
  const steps = numbers
    ? numbers.map((n) => stepState(group.filter((j) => j.plan?.step === n)))
    : [stepState(group)];

  const diffs = group
    .map((j) =>
      j.state === "running"
        ? i.liveDiff?.get(j.id)
        : j.envelope?.diffStat
          ? parseShortstat(j.envelope.diffStat)
          : undefined,
    )
    .filter((d): d is DiffStat => d !== undefined);
  const diff = diffs.length
    ? diffs.reduce((a, d) => ({
        files: a.files + d.files,
        added: a.added + d.added,
        deleted: a.deleted + d.deleted,
      }))
    : undefined;

  return {
    ...base,
    active: true,
    plan: {
      file: shown.plan?.file ?? null,
      steps,
      done: steps.filter((s) => s === "passed").length,
      failed: steps.filter((s) => s === "failed").length,
      elapsedSec: Math.max(0, Math.round((i.now.getTime() - Date.parse(group[0].createdAt)) / 1000)),
      tokens: group.reduce(
        (sum, j) => sum + (j.envelope?.usage?.totalTokens ?? j.progress.tokens ?? 0),
        0,
      ),
      ...(diff ? { diff } : {}),
    },
    jobs: group.filter((j) => !isTerminal(j.state)).map(toSnapshotJob),
    ...quota,
  };
}
```

- [ ] **Step 4: Run the test and the full check**

Run: `npx prettier --write src test && npm run test:ci`
Expected: PASS. If `tsc` reports that `envelope.diffStat` or `envelope.usage` has another type, adjust only the access in `build.ts` (the tests cast the envelope), keeping the behavior the tests describe.

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/build.ts test/snapshot/build.test.ts
git commit -m "feat: build the status snapshot from job records"
```

---

### Task 5: Snapshot writer

**Files:**
- Create: `src/snapshot/writer.ts`
- Test: `test/snapshot/writer.test.ts`

**Interfaces:**
- Consumes: `buildSnapshot` (Task 4); `Snapshot`, `DiffStat` (Task 1); `JobRecord` from `src/jobs/store.ts`; `QuotaSnapshot`; `renameWithRetry` from `src/jobs/fsutil.ts` (existing, used by `JobStore.write` as `renameWithRetry(tmpPath, finalPath)`).
- Produces:
  - `interface SnapshotWriterDeps { file: string; listJobs: () => Promise<JobRecord[]>; readQuota: () => QuotaSnapshot | undefined; liveDiff: (job: JobRecord) => Promise<DiffStat | undefined>; planSteps: (planFile: string, repoRoot: string) => number | undefined; now: () => Date; pid: number; heartbeatMs?: number; debounceMs?: number; write?: (file: string, text: string) => Promise<void>; }`
  - `class SnapshotWriter { constructor(deps: SnapshotWriterDeps); start(): void; notify(rec?: JobRecord): void; writeNow(): Promise<void>; stop(): void }`
  - Behavior:
    - The writer keeps the job records in memory. `listJobs` is called once, on the first write, to load the records already on disk. After that `notify(rec)` stores the record it is given (the live object the server is updating), so an unreadable job file can never drop a job.
    - `notify()` schedules one write after `debounceMs` (default 200); several calls inside the window give one write.
    - `start()` runs a timer every `heartbeatMs` (default 1000). A tick writes only when the last written snapshot was active and no write is running at that moment.
    - `writeNow()` serializes writes and never rejects. A write never waits for git: the live diff of each running job is measured in the background, at most once per 5000 ms per job and never twice at the same time, and a write uses the latest finished measurement.
    - `stop()` clears both timers. All timers are `unref()`ed.
    - The default `write` writes `file + ".<pid>.tmp"` and renames it over `file` with `renameWithRetry`, creating the folder first.

- [ ] **Step 1: Write the failing test**

`test/snapshot/writer.test.ts`:
```ts
import { afterEach, describe, it, expect, vi } from "vitest";
import { SnapshotWriter, type SnapshotWriterDeps } from "../../src/snapshot/writer.js";
import { emptyProgress, type JobRecord } from "../../src/jobs/store.js";
import type { Snapshot } from "../../src/snapshot/types.js";

function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "a",
    kind: "implement",
    repoRoot: "/repo",
    title: "Task",
    state: "running",
    progress: { ...emptyProgress(), phase: "run" },
    createdAt: "2026-10-30T14:20:00.000Z",
    updatedAt: "2026-10-30T14:20:00.000Z",
    returnedChars: 0,
    ...over,
  };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function make(jobs: JobRecord[], over: Partial<SnapshotWriterDeps> = {}) {
  const state = { jobs, now: Date.parse("2026-10-30T14:30:00.000Z"), lists: 0, diffs: 0 };
  const written: Snapshot[] = [];
  const deps: SnapshotWriterDeps = {
    file: "unused",
    listJobs: async () => {
      state.lists++;
      return state.jobs;
    },
    readQuota: () => undefined,
    liveDiff: async () => {
      state.diffs++;
      return { files: 1, added: 2, deleted: 0 };
    },
    planSteps: () => undefined,
    now: () => new Date(state.now),
    pid: 42,
    heartbeatMs: 1000,
    debounceMs: 200,
    write: async (_file, text) => {
      written.push(JSON.parse(text) as Snapshot);
    },
    ...over,
  };
  return { w: new SnapshotWriter(deps), state, written };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SnapshotWriter", () => {
  it("writes an active snapshot and adds the live diff once it has been measured", async () => {
    const { w, written } = make([job()]);
    await w.writeNow();
    expect(written).toHaveLength(1);
    expect(written[0].version).toBe(1);
    expect(written[0].pid).toBe(42);
    expect(written[0].active).toBe(true);
    expect(written[0].plan?.diff).toBeUndefined();
    await settle();
    await w.writeNow();
    expect(written[1].plan?.diff).toEqual({ files: 1, added: 2, deleted: 0 });
  });

  it("writes an inactive snapshot when nothing is running", async () => {
    const { w, written } = make([job({ state: "passed" })]);
    await w.writeNow();
    expect(written[0].active).toBe(false);
    expect(written[0].jobs).toEqual([]);
  });

  it("measures a running job's diff at most every five seconds", async () => {
    const { w, state } = make([job()]);
    await w.writeNow();
    await settle();
    state.now += 1000;
    await w.writeNow();
    await settle();
    expect(state.diffs).toBe(1);
    state.now += 5000;
    await w.writeNow();
    await settle();
    expect(state.diffs).toBe(2);
  });

  it("does not measure the same job twice at the same time", async () => {
    let release!: () => void;
    let calls = 0;
    const { w, state } = make([job()], {
      liveDiff: () => {
        calls++;
        return new Promise((r) => {
          release = () => r({ files: 1, added: 1, deleted: 0 });
        });
      },
    });
    await w.writeNow();
    state.now += 10_000;
    await w.writeNow();
    expect(calls).toBe(1);
    release();
  });

  it("loads the existing records once and keeps the ones it is told about", async () => {
    const { w, state, written } = make([]);
    w.notify(job());
    await w.writeNow();
    await w.writeNow();
    expect(state.lists).toBe(1);
    expect(written[1].active).toBe(true);
    expect(written[1].jobs[0].id).toBe("a");
    w.stop();
  });

  it("uses the latest state of a record it was given", async () => {
    const rec = job();
    const { w, written } = make([]);
    w.notify(rec);
    await w.writeNow();
    rec.state = "passed";
    await w.writeNow();
    expect(written[0].active).toBe(true);
    expect(written[1].active).toBe(false);
    w.stop();
  });

  it("never rejects when the job list fails", async () => {
    const { w } = make([], {
      listJobs: async () => {
        throw new Error("disk");
      },
    });
    await expect(w.writeNow()).resolves.toBeUndefined();
  });

  it("turns several notifications into one write", async () => {
    vi.useFakeTimers();
    const { w, state, written } = make([job()]);
    w.notify();
    w.notify();
    w.notify();
    await vi.advanceTimersByTimeAsync(250);
    expect(state.lists).toBe(1);
    expect(written).toHaveLength(1);
  });

  it("rewrites every second while active", async () => {
    vi.useFakeTimers();
    const { w, written } = make([job()]);
    w.start();
    await w.writeNow();
    expect(written).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3100);
    expect(written.length).toBeGreaterThanOrEqual(4);
    w.stop();
  });

  it("stops the heartbeat once a snapshot says nothing is active", async () => {
    vi.useFakeTimers();
    const rec = job();
    const { w, written } = make([rec]);
    w.start();
    await w.writeNow();
    rec.state = "passed";
    await w.writeNow();
    const count = written.length;
    expect(written[count - 1].active).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(written).toHaveLength(count);
    w.stop();
  });

  it("stops writing after stop()", async () => {
    vi.useFakeTimers();
    const { w, written } = make([job()]);
    w.start();
    await w.writeNow();
    w.stop();
    const count = written.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(written).toHaveLength(count);
  });

  it("skips heartbeat ticks while a write is still running", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let calls = 0;
    const { w } = make([job()], {
      write: () => {
        calls++;
        return calls === 1
          ? new Promise<void>((r) => {
              release = r;
            })
          : Promise.resolve();
      },
    });
    w.start();
    void w.writeNow();
    await vi.advanceTimersByTimeAsync(3500);
    expect(calls).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(1100);
    expect(calls).toBeGreaterThanOrEqual(2);
    w.stop();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/snapshot/writer.test.ts`
Expected: FAIL (cannot find module `../../src/snapshot/writer.js`)

- [ ] **Step 3: Write the implementation**

`src/snapshot/writer.ts`:
```ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "../jobs/fsutil.js";
import type { JobRecord } from "../jobs/store.js";
import type { QuotaSnapshot } from "../usage-quota.js";
import { buildSnapshot } from "./build.js";
import type { DiffStat } from "./types.js";

export interface SnapshotWriterDeps {
  file: string;
  listJobs: () => Promise<JobRecord[]>;
  readQuota: () => QuotaSnapshot | undefined;
  liveDiff: (job: JobRecord) => Promise<DiffStat | undefined>;
  planSteps: (planFile: string, repoRoot: string) => number | undefined;
  now: () => Date;
  pid: number;
  heartbeatMs?: number;
  debounceMs?: number;
  write?: (file: string, text: string) => Promise<void>;
}

const DIFF_TTL_MS = 5000;

async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, "utf8");
  await renameWithRetry(tmp, file);
}

/**
 * Keeps `status.json` current while jobs run. It holds the job records in memory, so a job file
 * that cannot be read for a moment never drops a job, and it never waits for git. Failures are
 * ignored: it must never stop a job.
 */
export class SnapshotWriter {
  private heartbeat?: NodeJS.Timeout;
  private pending?: NodeJS.Timeout;
  private lastActive = false;
  private writing = false;
  private seeded = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly records = new Map<string, JobRecord>();
  private readonly diffs = new Map<string, { at: number; busy: boolean; value?: DiffStat }>();

  constructor(private readonly d: SnapshotWriterDeps) {}

  /** Starts the once-a-second rewrite that keeps `updatedAt` fresh while a job is active. */
  start(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      if (this.lastActive && !this.writing) void this.writeNow();
    }, this.d.heartbeatMs ?? 1000);
    this.heartbeat.unref();
  }

  /** Remembers a record and asks for a write soon. Several calls inside the window give one write. */
  notify(rec?: JobRecord): void {
    if (rec) this.records.set(rec.id, rec);
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void this.writeNow();
    }, this.d.debounceMs ?? 200);
    this.pending.unref();
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.pending) clearTimeout(this.pending);
    this.heartbeat = undefined;
    this.pending = undefined;
  }

  writeNow(): Promise<void> {
    this.chain = this.chain.then(() => this.doWrite()).catch(() => {});
    return this.chain;
  }

  /** Starts a background measurement for each running job whose last one is old enough. */
  private refreshDiffs(jobs: JobRecord[], nowMs: number): void {
    for (const j of jobs) {
      if (j.state !== "running") {
        this.diffs.delete(j.id);
        continue;
      }
      const c = this.diffs.get(j.id);
      if (c && (c.busy || nowMs - c.at < DIFF_TTL_MS)) continue;
      this.diffs.set(j.id, { at: nowMs, busy: true, value: c?.value });
      void this.d
        .liveDiff(j)
        .catch(() => undefined)
        .then((value) => {
          const cur = this.diffs.get(j.id);
          if (cur) {
            this.diffs.set(j.id, {
              at: this.d.now().getTime(),
              busy: false,
              value: value ?? cur.value,
            });
          }
        });
    }
  }

  private async doWrite(): Promise<void> {
    this.writing = true;
    try {
      if (!this.seeded) {
        for (const r of await this.d.listJobs()) {
          if (!this.records.has(r.id)) this.records.set(r.id, r);
        }
        this.seeded = true;
      }
      const now = this.d.now();
      const jobs = [...this.records.values()];
      this.refreshDiffs(jobs, now.getTime());
      const live = new Map<string, DiffStat>();
      for (const [id, c] of this.diffs) if (c.value) live.set(id, c.value);
      const snap = buildSnapshot({
        jobs,
        now,
        pid: this.d.pid,
        quota: this.d.readQuota(),
        planSteps: this.d.planSteps,
        liveDiff: live,
      });
      this.lastActive = snap.active;
      await (this.d.write ?? atomicWrite)(this.d.file, JSON.stringify(snap, null, 2) + "\n");
    } finally {
      this.writing = false;
    }
  }
}
```

- [ ] **Step 4: Run the test and the full check**

Run: `npx prettier --write src test && npm run test:ci`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/writer.ts test/snapshot/writer.test.ts
git commit -m "feat: write the status snapshot while jobs run"
```

---

### Task 6: Wire the snapshot into the server

**Files:**
- Modify: `src/jobs/start.ts` (the `plan` line of the new record), `src/jobs/execute.ts` (`onEvent`, `onPhase`, imports), `src/runtime.ts`, `test/jobs/manager.test.ts`

**Interfaces:**
- Consumes: `activityFor` (Task 2); `diffStat` (Task 3); `SnapshotWriter` (Task 5); `statusFile` (Task 1); `quotaFile`, `readQuotaCache` from `src/usage-quota.ts`; `countPlanSteps` from `src/jobs/plan.ts`; `repoHash` from `src/pipeline/worktree.ts`; `worktreeRoot` from `src/paths.ts`.
- Produces: `createRuntime` additionally returns `snapshot: SnapshotWriter`.

- [ ] **Step 1: Write the failing test**

In `test/jobs/manager.test.ts`:

1. In `setup(o)`, add an option to its type, `events?: (pd: PipelineDeps) => void | Promise<void>;`, and in the `runJob` function, directly after `pd.onPhase?.("run");`, add:
```ts
      await o.events?.(pd);
```
2. Append at the end of the file:
```ts
describe("job activity", () => {
  it("records what the job is doing and saves every change at once", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const ev = (state: string, toolName?: string, toolParams?: Record<string, unknown>) => ({
      kind: "step" as const,
      stepIndex: 1,
      state,
      stepType: "tool",
      toolName,
      toolParams,
    });
    const seen: (string | undefined)[] = [];
    const { m, repo, deps } = setup({
      events: async (pd) => {
        const kind = async () => (await deps.store.list())[0]?.progress.activity?.kind;
        pd.onEvent?.(ev("ACTIVE", "view_file", { AbsolutePath: "/wt/brief.md" }));
        await sleep(40);
        seen.push(await kind());
        // Both arrive inside the 500 ms progress throttle; the change must still be saved.
        pd.onEvent?.(ev("DONE", "view_file"));
        pd.onEvent?.(ev("ACTIVE", "run_command", { CommandLine: "go test ./..." }));
        await sleep(40);
        seen.push(await kind());
      },
    });
    await m.start({ repoRoot: repo, kind: "implement", task: "Do it", estimate: EST });
    await m.idle();
    expect(seen).toEqual(["reading", "testing"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/jobs/manager.test.ts -t "job activity"`
Expected: FAIL (the activity is never recorded: `seen` is `[undefined, undefined]`)

- [ ] **Step 3: Keep the delegate steps on the job record**

In `src/jobs/start.ts`, in the record created in "7. Create the record", replace
```ts
    ...(i.plan ? { plan: { file: i.plan.file, step: i.plan.step } } : {}),
```
with
```ts
    ...(i.plan
      ? {
          plan: {
            file: i.plan.file,
            step: i.plan.step,
            ...(i.plan.delegateSteps?.length ? { delegateSteps: i.plan.delegateSteps } : {}),
          },
        }
      : {}),
```

- [ ] **Step 4: Record the activity from stream events**

In `src/jobs/execute.ts`:

1. Add the import: `import { activityFor } from "../snapshot/activity.js";`
2. In `onPhase`, after `record.progress.phase = phase;` add:
```ts
    if (phase !== "run") record.progress.activity = undefined;
```
3. At the top of `onEvent`, directly after `let changed = false;` add:
```ts
    let activityChanged = false;
```
4. In `onEvent`, inside `if (ev.kind === "step") {`, directly after `const params = ev.toolParams;` add:
```ts
      const prev = record.progress.activity;
      const activity = activityFor(
        prev,
        { toolName: ev.toolName, toolParams: params, state: ev.state },
        ctx.deps.now(),
      );
      if (activity !== prev) {
        record.progress.activity = activity;
        changed = true;
        // A change of what the job is doing is saved at once; the 500 ms throttle never retries.
        if (activity?.kind !== prev?.kind || activity?.target !== prev?.target) {
          activityChanged = true;
        }
      }
```
5. At the end of `onEvent`, change
```ts
    if (changed) {
      updateProgressAndSave(false).catch(() => {});
    }
  };

  let envelope: Envelope | undefined;
```
to
```ts
    if (changed) {
      updateProgressAndSave(activityChanged).catch(() => {});
    }
  };

  let envelope: Envelope | undefined;
```

- [ ] **Step 5: Create and start the writer in the runtime**

In `src/runtime.ts`:

1. Add imports:
```ts
import { countPlanSteps } from "./jobs/plan.js";
import { repoHash } from "./pipeline/worktree.js";
import { diffStat } from "./snapshot/diff.js";
import { SnapshotWriter } from "./snapshot/writer.js";
import { quotaFile, readQuotaCache } from "./usage-quota.js";
```
and extend the existing `./paths.js` import with `statusFile`, and the existing `node:fs` import with `readFileSync` (`import { existsSync, readFileSync } from "node:fs";`).
2. Change the return type of `createRuntime` to `{ manager: JobManager; store: JobStore; snapshot: SnapshotWriter }`.
3. Replace `const store = new JobStore(jobsDir({ env: o.env }));` with:
```ts
  let snapshot: SnapshotWriter | undefined;
  const store = new JobStore(jobsDir({ env: o.env }), (rec) => snapshot?.notify(rec));
  snapshot = new SnapshotWriter({
    file: statusFile({ env: o.env }),
    listJobs: () => store.list(),
    readQuota: () => readQuotaCache(quotaFile(o.env)),
    liveDiff: (job) =>
      diffStat(path.join(worktreeRoot({ env: o.env }), repoHash(job.repoRoot), job.id)),
    planSteps: (planFile, repoRoot) => {
      try {
        return countPlanSteps(readFileSync(path.resolve(repoRoot, planFile), "utf8")) || undefined;
      } catch {
        return undefined;
      }
    },
    now: () => new Date(),
    pid: process.pid,
  });
  snapshot.start();
```
4. Where `createRuntime` returns `{ manager, store }`, return `{ manager, store, snapshot }`.

- [ ] **Step 6: Run the full check**

Run: `npx prettier --write src test && npm run test:ci`
Expected: PASS. No existing test calls `createRuntime` (the server startup test runs the built `dist`), so the runtime wiring itself is checked in Task 7, not here.

- [ ] **Step 7: Commit**

```bash
git add src/jobs/start.ts src/jobs/execute.ts src/runtime.ts test/jobs/manager.test.ts
git commit -m "feat: write status.json from the running server"
```

---

### Task 7: Verify end to end and document

**Files:**
- Modify: `README.md` (add a short section)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: no errors; `dist/` updated.

- [ ] **Step 2: Run a job and watch the file**

Start any small delegated job through the agy-foreman tools in a Claude Code session whose agy-foreman server was started from this build (restart the session so the new `dist` is used). While it runs, in Git Bash:
```bash
cat "$LOCALAPPDATA/agy-foreman/status.json"
```
Expected: `"active": true`, a `plan.steps` list with one `running` entry, `plan.tokens` growing between reads (if it only jumps at the end of the job, `progress.tokens` is a single call's figure: tell the user, because the `tok` segment in claude-gauges would then be misleading), `jobs[0].activity.kind` changing between `reading`, `editing`, `testing` and `thinking`, and `plan.diff` appearing once Gemini writes a file. After the job is finalized the file shows `"active": false`.

- [ ] **Step 3: Document the file**

Add to `README.md`, below the configuration section:
```markdown
### Status file

While jobs run, agy-foreman keeps `status.json` in its state folder up to date (`%LOCALAPPDATA%\agy-foreman` on Windows). Status lines can read it to show progress; the format is described in
[docs/superpowers/specs/2026-10-30-status-snapshot-design.md](docs/superpowers/specs/2026-10-30-status-snapshot-design.md).
```

- [ ] **Step 4: Run the full check and commit**

Run: `npx prettier --write src test README.md && npm run test:ci`
Expected: PASS

```bash
git add README.md
git commit -m "docs: describe the status file"
```
