# Delegation efficiency implementation plan

Spec: `docs/superpowers/specs/2026-10-30-delegation-efficiency-design.md`. Read the spec first.

## Status (2026-10-30)

Done and committed: Tasks 1 to 7 and Optional A to E. Notes on how they differ from the text below:

- Tasks 3 (`apply`) and 8 (`report`) were first delegated to Gemini. Both runs spent 13 minutes and 130 to 150 tool steps fighting the gate's denial of shell file writes (which Optional A now prevents). The `report` job produced a correct `src/report.ts` (8/8 tests) before it was cancelled and its file was kept; the `apply` job produced a corrupt file and was discarded, so `src/apply/*` was written by the orchestrator against the same committed tests.
- Task 6: `attempt` is stored and returned as a number; the limit of 2 appears in the hint.
- Optional D: calibration is computed from job records (`calibrationFromJobs`), so no second ledger line is written.
- Optional B: `medianRunSec` now counts passed jobs only (this also fixes the progress ETA).

Conventions: TypeScript ESM with `.js` import suffixes, Prettier width 100, vitest. Tests live in `test/jobs/`, `test/pipeline/` and `test/` (match the folder of the module under test). Run `npm run test:ci`, `npm run typecheck` and `npm run format:check` after every task; run Prettier on every test file the orchestrator writes before committing it. Every task ends with a commit `feat: <what>` (or `fix:` / `docs:`).

Vocabulary: "verify" is the test run in `verify()` (step 5 of `runImplementJob`). "Gate" in `src/pipeline/gate.ts` is the command-permission hook and is a different thing; this plan never uses "gate" for the test run.

Order: Task 1, then Task 2, then Task 3 (Task 3 uses `MISSING_TEST_COMMAND` from Task 2, and Tasks 2 and 3 both edit `src/cli.ts`, so they never run in parallel). Tasks 4, 5 and 6 are independent of each other. Task 7 comes last and holds every documentation edit (`README.md`, `SKILL.md`, `references/routing.md`). Tasks 1 to 7 are the approved scope. The "Optional steps" at the end (A to E) are approved too and run after Task 7.

How each task is executed: a task marked **local** is written by the orchestrator (small, or needs judgment). A task marked **delegate** has its tests written and committed by the orchestrator first, because `test/**` is a protected path and Gemini cannot edit it; Gemini writes the code only.

### Task 1: Ledger records every state (local)

**Files:**
- Modify: `src/jobs/ledger.ts`
- Modify: `src/jobs/execute.ts`
- Test: `test/jobs/ledger.test.ts`

Behavior:
- Read `execute.ts` around the two `ledger.append` calls (the `error` branch and the envelope branch).
- `usageTotal` is set on every ledger entry: from `envelope.usage.totalTokens`, else from `record.progress.tokens` (the token use the progress tracker keeps), else 0.
- The `error` branch appends `usageTotal` too. A cancel appends an entry if it does not already (check `src/jobs/actions.ts`).
- After Task 2 a missing-config refusal at start creates no record and no ledger entry; only refusals made inside the pipeline (for example a protected-path refusal) reach the ledger.
- `LedgerEntry.returnedTokens` gets a doc comment: Gemini output tokens, not orchestrator cost.

Tests to add (names): `records usageTotal for an error job`, `records usageTotal for a timeout from progress.tokens when the envelope has no usage`, `usageTotal is 0 for a refused job` (use a refusal produced inside the pipeline, not a missing config).

### Task 2: Configuration fails fast (delegate)

**Files:**
- Modify: `src/jobs/start.ts`
- Modify: `src/pipeline/implement.ts`
- Modify: `src/jobs/incidents.ts`
- Modify: `src/jobs/actions.ts`
- Modify: `src/cli.ts`
- Test: `test/jobs/start-config.test.ts`, `test/jobs/actions.test.ts`, `test/cli.test.ts`

Behavior (spec change 2):
1. In `startJob`, after the dry-run branch decision and before approval, if `i.kind === "implement"` and `config.project.testCommand` is missing or empty, return `{ type: "result", result: { state: "refused", reason: MISSING_TEST_COMMAND } }`. Put `MISSING_TEST_COMMAND` in `src/jobs/incidents.ts` or a small shared module and use it in `implement.ts:42` too, so both places say the same thing: `config.test_command is required for implement jobs. Create .agy-foreman.json (see README, "Configuration").`
2. The dry-run result gets `warning: MISSING_TEST_COMMAND` when the command is missing.
3. `classifyIncident`: a refused envelope whose reason starts with `config.test_command` gets category `missing_config` (add the category to the union and to the lesson-tag handling in `actions.ts` if it lists categories).
4. `finalize` with `mode: "discard"` on a job with no worktree on disk returns `{ state: "discarded", note: "nothing to discard" }`. `isDirty(repoRoot)` currently runs before the discard branch; skip it for `discard` (a discard never touches the main checkout). Tolerate both a missing worktree ("is not a working tree") and a missing branch; rethrow other errors.
5. `agy-foreman wait` prints `reason: <reason>` after the state line when the state is `refused` or `error`, where the reason is `envelope?.reason ?? ` the record's error reason (the `error` branch in `execute.ts` stores no envelope; find where it keeps the message).

The documentation for this task (a "First time in a repo" section in `SKILL.md`) is written in Task 7.

Contract tests (the orchestrator writes them after reading the existing tests for helpers that build a deps object):

- `test/jobs/start-config.test.ts`: a repo whose config has no `test_command` makes `startJob` return `state: "refused"` with the text above and creates no job record and shows no approval; a dry run returns `warning`; a repo with `test_command` is unchanged.
- `test/jobs/actions.test.ts` addition: `finalize` discard on a refused job with no worktree and no branch returns `discarded`, also when the main checkout is dirty.
- `test/cli.test.ts` addition: `wait` on a refused job and on an `error` job prints the reason.

### Task 3: `agy-foreman apply` (delegate)

**Files:**
- Create: `src/apply/blocks.ts`
- Create: `src/apply/apply.ts`
- Test: `test/apply/blocks.test.ts`, `test/apply/apply.test.ts` (already written and committed; do not edit them)

The orchestrator wires the `apply` command in `src/cli.ts` afterwards; do not touch `cli.ts`. Only create `src/apply/blocks.ts` and `src/apply/apply.ts`.

`src/apply/blocks.ts` exports a pure function:

```ts
export interface PlannedFile {
  path: string;
  content: string;
}
export interface BlockProblem {
  /** 1-based index of the fenced block in the step. */
  block: number;
  reason: string;
}
export function planFiles(stepText: string, files: string[]): { files: PlannedFile[]; problems: BlockProblem[] };
```

Rules (spec change 3, version 1 creates files only; the `files` argument is the list `parsePlanStep` returns and is only used to recognise a path):

1. Fences: a fence line is a line that, after optional leading spaces, starts with three backticks. Fences inside list items (indented) count. Fence content is the lines between the fences with the common indent removed.
2. Association: a block belongs to the path found by looking at the nearest non-blank line before the fence and taking the one backticked token on it that looks like a file path (it has an extension or a `/`, and no spaces). If that line has none, the block belongs to the path in its first line when that line is a path comment: `// path/x.ts`, `# path/x.py`, `-- path/x.sql` or `<!-- path/x.html -->`, where the path has no spaces and an extension. The path comment line is removed from the content. A shebang line is never taken as a path comment, and a comment with prose is not either.
3. Instruction check, before association: if the nearest non-blank line before the fence contains `append`, `add to`, `insert`, `replace` or `modify` (case-insensitive), the block is a problem (`ambiguous instruction: <word>`), whatever path it names.
4. A block with no path is ignored (it is an example), not a problem.
5. Two blocks for one path are a problem for both (`two blocks for one path`).
6. A path is a problem when it starts with `/`, `\`, or a drive letter and colon, contains `\` or `..`, or starts with `.git/`.
7. Content ends with exactly one newline.

`parsePlanStep` already extracts `testBlocks`; `planFiles` takes the whole step text, so the test blocks are included. No change to `parsePlanStep` is needed.

`src/apply/apply.ts` exports `applyStep(opts: { repoRoot: string; planFile: string; step: number; dryRun?: boolean; testCommand: string[] | undefined; run: (cmd: string[], cwd: string) => Promise<{ code: number; out: string }> }): Promise<{ ok: boolean; written: string[]; problems: BlockProblem[]; testExit?: number; testTail?: string }>`.

Behavior, in this order; every refusal returns `ok: false`, writes nothing and runs no tests:
1. Refuse with `MISSING_TEST_COMMAND` (import it from `src/config.ts`) when `opts.testCommand` is undefined or empty; the caller loads the config and passes `testCommand`.
2. Refuse when the working tree has tracked changes (`git status --porcelain --untracked-files=no` is not empty).
3. Run `planFiles`; refuse when `problems` is not empty.
4. Refuse with `nothing to apply: the step has no file blocks` when `files` is empty. Tests are never run and reported green for an empty step.
5. Refuse when any target path already exists (`target exists: <path>`; version 1 creates files only).
6. With `dryRun`, return `ok: true` with `written` listing the paths that would be written, and stop.
7. Write the files (create folders as needed), then run `test_command` through `run` and return `ok: testExit === 0`, `testExit` and the last 40 lines of output as `testTail`.

The CLI passes a `run` built on `src/pipeline/exec.ts` (the existing process runner that works on Windows); do not spawn processes another way.

Contract tests:

```ts
// test/apply/blocks.test.ts
import { describe, expect, it } from "vitest";
import { planFiles } from "../../src/apply/blocks.js";

const fence = "```";
const join = (...lines: string[]): string => lines.join("\n");

describe("planFiles", () => {
  it("takes the block after a line naming one backticked path", () => {
    const text = join("### Task 1: x", "- Create: `src/a.ts`", fence + "ts", "export const a = 1;", fence);
    const r = planFiles(text, ["src/a.ts"]);
    expect(r.problems).toEqual([]);
    expect(r.files).toEqual([{ path: "src/a.ts", content: "export const a = 1;\n" }]);
  });

  it("takes the path from a first-line comment and removes that line", () => {
    const text = join(fence + "ts", "// src/b.ts", "export const b = 2;", fence);
    expect(planFiles(text, []).files).toEqual([{ path: "src/b.ts", content: "export const b = 2;\n" }]);
  });

  it("does not take a shebang or a prose comment as a path", () => {
    const text = join(fence + "sh", "#!/usr/bin/env bash", "echo hi", fence, fence + "ts", "// this is an example", "foo();", fence);
    expect(planFiles(text, [])).toEqual({ files: [], problems: [] });
  });

  it("finds blocks inside indented list items", () => {
    const text = join("- Create: `src/c.ts`", "  " + fence + "ts", "  export const c = 3;", "  " + fence);
    expect(planFiles(text, ["src/c.ts"]).files).toEqual([{ path: "src/c.ts", content: "export const c = 3;\n" }]);
  });

  it("includes test blocks", () => {
    const text = join("- Test: `test/a.test.ts`", fence + "ts", "it('a', () => {});", fence);
    expect(planFiles(text, ["test/a.test.ts"]).files[0]?.path).toBe("test/a.test.ts");
  });

  it("reports two blocks for one path", () => {
    const text = join("- Create: `src/a.ts`", fence + "ts", "// src/a.ts", "1;", fence, fence + "ts", "// src/a.ts", "2;", fence);
    const r = planFiles(text, ["src/a.ts"]);
    expect(r.files).toEqual([]);
    expect(r.problems.map((p) => p.reason)).toEqual([expect.stringMatching(/two blocks/), expect.stringMatching(/two blocks/)]);
  });

  it("reports an append instruction, case-insensitively", () => {
    const text = join("Append to `src/a.test.ts`:", fence + "ts", "it('x', () => {});", fence);
    const r = planFiles(text, ["src/a.test.ts"]);
    expect(r.files).toEqual([]);
    expect(r.problems[0]?.reason).toMatch(/ambiguous instruction: append/);
  });

  it.each(["../evil.sh", "/etc/x.sh", "C:/x/y.ts", "a\\b.ts", ".git/hooks/pre-commit"])("rejects the path %s", (p) => {
    const text = join(fence + "sh", "# " + p, "x", fence);
    const r = planFiles(text, []);
    expect(r.files).toEqual([]);
    expect(r.problems).toHaveLength(1);
  });

  it("ignores a block with no path", () => {
    const text = join("Example:", fence + "ts", "foo();", fence);
    expect(planFiles(text, [])).toEqual({ files: [], problems: [] });
  });
});
```

`test/apply/apply.test.ts` (the orchestrator writes it after reading how other tests build a temp git repo): a clean temp repo plus a plan with one Create block and a `run` stub returning code 0 gives the file written and `ok: true`; `run` returning code 1 gives `ok: false` and `testExit: 1` with the file still written; tracked changes in the tree give `ok: false` and nothing written; an ambiguous block gives nothing written and the problem listed; a step with no file blocks gives `nothing to apply` and `run` is never called; an existing target gives `target exists`; a missing `test_command` is refused; `dryRun` writes nothing and does not call `run`.

CLI: `agy-foreman apply <plan> <step> [--dry-run]` prints the written files, then the test tail, and exits 0 or 1. Usage line in `help`.

The documentation (`routing.md`) is written in Task 7.

### Task 4: Smaller `agy_get` (delegate)

**Files:**
- Modify: `src/jobs/helpers.ts`
- Modify: `src/jobs/manager.ts`
- Modify: `src/pipeline/index.ts` (add optional `deniedCommandsTotal?: number` to the `Envelope` type)
- Test: `test/jobs/manager.test.ts` (the existing file that tests `compactRecord`)

Behavior (spec change 4):
- `compactRecord`: `envelope.deniedCommands` keeps the first 5 entries, each cut to 200 characters, and `envelope.deniedCommandsTotal` is set to the original count when anything was cut. Nothing else changes.
- `manager.ts` (the `get` path around the `returnedChars` accounting): keep, per manager instance, the `updatedAt` and `state` that were last returned for each terminal job id. A repeat call with no `diff_mode` and no `paths` and an identical `updatedAt` returns `{ state, unchanged: true, hint: "use diff_mode: \"stat\" or paths for more" }` and adds only that object's size to `returnedChars`. (`get()`'s own write does not change `updatedAt`, so the comparison is stable.) `diff_mode: "stat"` is the documented way to get the full record back.

Tests: a record with 12 long denied commands comes back with 5 entries of at most 200 characters and `deniedCommandsTotal: 12`; a record with 3 short ones is untouched; the second `get` of a passed job returns `unchanged: true`; a `get` with `diff_mode` after a first `get` returns the full answer; a running job is never `unchanged`.

### Task 5: Timeouts keep the work (local)

**Files:**
- Modify: `src/pipeline/implement.ts`
- Modify: `src/pipeline/gated-run.ts`
- Modify: `src/jobs/incidents.ts`
- Modify: `src/config.ts`
- Test: `test/pipeline/timeout-keeps-work.test.ts`, `test/jobs/incidents.test.ts`

Behavior (spec change 5). Today a timed-out run is already committed, gets its `diffStat` and keeps its worktree, and `finalize` accepts a timeout; what it lacks is a verify run (`mapFailureOutcome` skips `verify()`). Read `implement.ts`, `gated-run.ts` and `envelope-build.ts` first.
- On timeout, run `verify()` (the call in step 5 of `runImplementJob`) on the kept worktree, with its own cap of 10 minutes, and put the result in the envelope as `verify`, with `partial: true`. The state stays `timeout`.
- Stall detection: a watcher checks once per 60 s. It fires when no new tool step has started for `stall_after_sec` (config key `runtime.stall_after_sec`, default 300) and no tool step is in progress (the second recorded timeout sat inside one long `gradlew` step for 1800 s; a running step is not a stall). Reuse the activity records written for the status snapshot (`src/snapshot/activity.ts`) if the pipeline can reach them; otherwise keep the time of the last tool step in the run state.
- When it fires: abort agy through its own `AbortController`, chained to `deps.signal` so a user cancel still wins. Mark the run `stalled` so the aborted outcome is not mapped to `cancelled`. Do not run `verify()` while agy is still running. After agy has stopped, run `verify()` once; if it passes, finish as `passed` with the note `ended early: no activity and verify passes`, otherwise finish as `timeout` with `partial: true` as above.
- `classifyIncident`: a timeout whose `envelope.diffStat` is non-empty becomes `timeout_with_work`; otherwise `timeout_no_progress`. Update the lesson tags in `actions.ts` (the `cat:timeout_too_short` line) and the lessons text that mentions it.

Tests (written by the orchestrator): with a fake agy runner that never returns and a stubbed `verify` that passes, the stall path ends `passed` with the note; a stall while a tool step is in progress does not fire; a fake killed at the timeout with a red `verify` ends `timeout` with `partial: true` and the worktree path kept; a user cancel during a stall wait is still `cancelled`; incident categories as above.

### Task 6: Retry visibility (local)

**Files:**
- Modify: `src/jobs/manager.ts` or `src/jobs/start.ts` (where the record is built)
- Modify: `src/jobs/store.ts`
- Test: `test/jobs/attempt.test.ts`

Behavior (spec change 6): `record.plan` already holds the plan file and step, so `store.ts` only gains `attempt?: number`. Store it at creation: 1 for a new job; for a follow-up the parent's attempt + 1; for a new job on the same plan file and step as an earlier job in the same repo, that job's attempt + 1, but only when that earlier job ended `failed` or `timeout` (a 503 `error`, a `cancelled` or a `refused` job is not a strike). Quota auto-follow-ups (`startFollowup(..., true)`) do not add an attempt. Return `attempt: { n, max: 2 }` in the compact record, and `hint: "second strike: take this over or split it"` when `n >= 2` and the state is not `passed`.

Tests: first job is `n: 1`; a follow-up is `n: 2`; a fresh start of a failed plan step is `n: 2`; a fresh start after an `error` or `cancelled` job stays `n: 1`; a quota auto-follow-up keeps the parent's `n`; a passed job at `n: 2` has no hint; a failed one has.

### Task 7: Documentation and the routing rule (local)

**Files:**
- Modify: `README.md`
- Modify: `skills/gemini-delegation/references/routing.md`
- Modify: `skills/gemini-delegation/SKILL.md`

Document `agy-foreman apply`, the new `unchanged` and `attempt` fields, the stall setting, the `missing_config`, `timeout_with_work` and `timeout_no_progress` categories, and the rule that plans are written by the orchestrator with explore jobs used for facts. Check the CLI table in the README against `agy-foreman help`.

Also, in `SKILL.md` add a section "First time in a repo": commit `.agy-foreman.json` with `test_command`, `allowed_commands`, `protected_paths` before the first `agy_start`; on Windows do not start `test_command` with `bash`. In `references/routing.md` add two rules: a step with full code and tests is applied with `agy-foreman apply` and not delegated; a plan is written by the orchestrator, with explore jobs used only to gather cited facts. The skill files are copied to users with `install-skill`; check that command still copies them.

## Optional steps (approved)

Approved by the user on 2026-10-30: all of A to E. Run them after Tasks 1 to 7. Optional D uses the ledger line from Task 1; Optional E is the only delegated one.

### Optional A: Stop wasting tool steps on denied commands (local, S)

**Files:**
- Modify: `src/pipeline/brief.ts`
- Modify: `src/pipeline/gate.ts` (built-in read-only allowlist)
- Test: `test/pipeline/brief.test.ts`, `test/pipeline/gate.test.ts`

Behavior:
- The brief states once: "Write and edit files only with the file edit tool. Never write files through the shell (`echo`, `Set-Content`, `[System.IO.File]::WriteAllText`, here-strings, `python -c`, `node -e`, `git apply`). Do not run `bash` on Windows."
- The gate allows a fixed list of read-only commands without a project setting: `git diff`, `git status`, `git log`, `git branch` (no arguments), `git show`, `<tool> --version` / `<tool> version` for `go`, `node`, `python`, `npm`, and reading `.agy-task/brief.md` through `Get-Content` / `cat`.

Tests: the brief contains the rule; each listed read-only command is allowed; `git branch -D x`, `git checkout`, `Set-Content` stay denied.

Expected saving: the 63 job records hold 282 denied commands across 42 jobs. At least 56 are shell file writes (`echo $(`, `WriteAllText`, `Set-Content`, `echo @'`), and about 35 are harmless read-only probes (`git diff`, `git branch`, `go version`, `python --version`, `Get-Content .agy-task/brief.md`). Each denial costs a tool step and a full context resend on the Gemini side. Expect roughly 5 steps fewer per job, or about 3% of the median 134 steps of a passed job. Denied file writes also put file bodies into `deniedCommands`, which reaches the orchestrator (25.9k characters in total).

### Optional B: Timeout from the estimate, not a flat 30 minutes (local, S)

**Files:**
- Modify: `src/jobs/start.ts`
- Modify: `src/jobs/ledger.ts`
- Test: `test/jobs/manager.test.ts`

Behavior: when `timeout_sec` is not given, the timeout is `clamp(3 x ledger median runSec of passed jobs of this kind, 600, 1800)`. When the ledger has fewer than 10 passed jobs, keep 1800. Only `passed` entries count towards the median. Today `medianRunSec` also counts refused runs of 0.05 s and the 1800 s timeouts.

Tests: the median ignores non-passed entries; the clamp holds at both ends; an explicit `timeout_sec` wins.

Expected saving: 42 passed jobs average about 600 s. The two timeouts ran 1805 s and 1804 s and used 2.19M Gemini tokens without passing. With Task 5, a timeout at about 1200 s would still keep the work and stop each such run about 10 minutes and about 0.3-0.4M tokens earlier.

### Optional C: Retry an infrastructure error once, automatically (local, S)

**Files:**
- Modify: `src/jobs/execute.ts`
- Modify: `src/jobs/incidents.ts`
- Test: `test/jobs/scheduler.test.ts`

Behavior: an envelope `error` whose reason matches `UNAVAILABLE|code 503|code 500|ECONNRESET` starts one follow-up in the same conversation (as the quota path does with `startFollowup(..., true)`), after a 60 s delay. The follow-up does not count as a strike for Task 6. A second infrastructure error stops with the error.

Tests: one 503 leads to exactly one automatic follow-up; a second 503 does not; a non-infrastructure error is not retried.

Expected saving: job t-mvh2bs8u failed with `UNAVAILABLE (code 503)` after 377 s and 308k tokens, with 163 lines already written. A resume keeps that work instead of a fresh run that costs the same again.

### Optional D: Fix the calibration figure (local, S)

**Files:**
- Modify: `src/jobs/ledger.ts`
- Modify: `src/jobs/execute.ts`
- Modify: `src/jobs/manager.ts`
- Test: `test/jobs/ledger.test.ts`

Behavior: `Ledger.calibration()` divides `returnedTokens` (Gemini output tokens) by `delegateOverheadTokens` (the orchestrator's estimate of its own cost). These are different units. Record `orchestratorChars` (the job's final `returnedChars`) in a second ledger line, `{"jobId", "orchestratorChars", "at"}`, written when finalize runs. Base the ratio on `orchestratorChars / 4 / delegateOverheadTokens`, and only on entries that carry it.

Tests: an entry without `orchestratorChars` is ignored; the ratio is the median of the new values.

Expected saving: no tokens directly. Today the figure is meaningless: passed jobs return on average 46.6k Gemini output tokens against estimates of about 4-5k, a ratio near 10, while the real orchestrator cost was about 8k characters (about 2k tokens) per job. With a correct figure, the token gate and the orchestrator's estimates can be calibrated.

### Task 8: Optional E - `agy-foreman report` for routing decisions (delegate, M)

**Files:**
- Create: `src/report.ts`
- Test: `test/report.test.ts` (already written and committed; do not edit it)

The orchestrator wires the `report` command in `src/cli.ts` afterwards; do not touch `cli.ts`. Implement only the pure function `buildReport(entries: LedgerEntry[], jobs: ReportJob[], opts?: { since?: Date }): string` (export the type `ReportJob = { id: string; returnedChars?: number }`). The output format is fixed by `test/report.test.ts`: first line `jobs: N` (with ` (since YYYY-MM-DD)` when `since` is given), a table with one row per state (state, count, Gemini tokens with thousands separators, minutes with one decimal), `incidents: cat=n ...`, `orchestrator chars per job: median M max X`, and `costliest non-passed:` followed by up to five rows (job id, state, tokens, estimate reason). An empty input returns the text `no jobs` followed by one newline. At most 40 lines.

Behavior: `agy-foreman report [--since YYYY-MM-DD]` prints, from the ledger and job records:
- per state: count, Gemini tokens (using Task 1's `usageTotal`) and minutes;
- per incident category: count;
- the orchestrator characters returned per job (`returnedChars`, median and max);
- the five most costly non-passed jobs, with their estimate reasons.

The output is plain text under 40 lines.

Tests: a fixture ledger and job directory give the expected lines; an empty ledger prints `no jobs`.

Expected saving: the analysis behind this plan took a separate review agent several tool runs over 61 jobs. A one-command report makes it a routine check before each plan, so routing mistakes such as the 3.8M tokens spent retyping plan code show up after a few jobs, not after 18.
