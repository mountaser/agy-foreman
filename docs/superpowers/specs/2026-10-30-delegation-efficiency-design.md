# Delegation efficiency design

## Purpose

An analysis of the first 61 jobs in the ledger (2026-10-17 to 2026-10-30) found where delegation wastes Gemini tokens, time and orchestrator context. This design fixes the largest sources of waste and the confusing failures.

## What the data showed

| Finding | Evidence |
|---|---|
| Gemini retypes code the plan already contains | 18 jobs had reasons such as "full code given in the plan". 12 passed, 4 were refused for missing config, 1 failed, 1 errored. The 12 passes used about 3.8M Gemini tokens and 109 minutes. |
| Wasted runs are under-counted | The ledger stores `usageTotal` only for `passed` and `failed` jobs. The timeouts and one error carry token use only in the job's progress record. Counted that way the waste is about 4.8M tokens, not the 2.29M the ledger shows. |
| Timeouts are not verified | Both 30-minute timeouts had real diffs in the worktree. A timed-out run is already committed and its worktree kept, but its tests are never run, so green work looks like a failure. The incident is labelled `timeout_too_short`, which suggests a longer timeout, the wrong fix. The second timeout sat inside one long build step for 1800 s. |
| A missing `.agy-foreman.json` fails late and confusingly | 6 of 61 jobs were refused. `agy_start` reports `running` first. `agy-foreman wait` hides the reason. `finalize` on the refused job fails with "not a working tree". |
| Repeat `agy_get` calls and `deniedCommands` cost orchestrator context | A job's `returnedChars` is a running total over all its `agy_get` calls (the largest is about 40k characters over 5 calls; the largest single return is about 7.6k). `deniedCommands` can hold pasted file bodies (2.4k characters on one job). |
| Retries have no visible limit | `routing.md` states two strikes. Nothing in the result tells the orchestrator which attempt it is looking at. |

Starting a job is already cheap: `agy_start` with `plan: {file, step}` sends a few hundred characters because the server reads the plan.

## Decisions

1. **Apply locally what the plan already contains.** A plan step that carries its full code is applied by a command, not delegated. Gemini is for steps where it has to write code.
2. **Fail fast and say why.** A missing configuration is reported by `agy_start` itself, by the dry run, and by `wait`.
3. **Count and keep what was spent.** Every terminal state writes its token use to the ledger. A timeout runs `verify()` on its kept worktree, so green work is visible.
4. **Return less on repeat reads.** A second `agy_get` on a finished job returns a short "unchanged" answer, and `deniedCommands` is capped.
5. **Make retries visible.** The result tells the orchestrator which attempt this is and when to take over.
6. **Gemini does not write plans.** Plans are design work with no machine check. Explore jobs gather cited facts (exports, signatures, test names) that the orchestrator writes plans from. This is a rule in the skill docs, not code.

## Changes

### 1. Ledger records every state

`LedgerEntry.usageTotal` is filled for every terminal state, including `error`, `timeout`, `cancelled` and `refused` (0 for a job that never ran). The value comes from the token use kept in the job's progress record when the envelope has none. `returnedTokens` keeps its meaning (Gemini output tokens) and its doc comment says so.

### 2. Configuration fails fast

- `startJob` (the part of `src/jobs/start.ts` that builds the record) returns `{state: "refused", reason}` before it creates a record when an implement job has no `test_command`. The reason names the file: `config.test_command is required for implement jobs. Create .agy-foreman.json (see README, "Configuration").` No approval card is shown for a job that cannot run.
- The dry run returns the same refusal text as a `warning` field in its result, because the real run would refuse.
- `agy-foreman wait <job>` prints the job's `envelope.reason` on a second line when the state is `refused` or `error`.
- `finalize` with mode `discard` on a job that has no worktree succeeds with `{state: "discarded", note: "nothing to discard"}`.
- A new incident category `missing_config` replaces `wrong_or_missing_gate` for the missing-`test_command` refusal.
- `skills/gemini-delegation/SKILL.md` gets a "First time in a repo" section.

### 3. `agy-foreman apply`

```
agy-foreman apply <plan-file> <step> [--dry-run]
```

Reads the plan step with `parsePlanStep`, writes every fenced code block that is tied to a file path, then runs the project's `test_command`. It exits 0 when the tests pass and 1 otherwise, and prints the files written and the test result.

Version 1 creates files only. A block is applied only when it is unambiguous:

- the block is tied to a path by the backticked path on the nearest non-blank line before it, or by a path comment on its first line (`// path`, `# path`, `-- path`, `<!-- path -->`; the comment line is removed from the content);
- the path is inside the repo, relative, without `\` or `..`, and not under `.git`;
- the target does not exist yet.

It refuses, writing nothing, when any block is ambiguous: an instruction word before it (append, add to, insert, replace, modify), two blocks for one path, a path outside the repo, or an existing target. It also refuses when the step has no file blocks (it never runs the tests and reports green for nothing), when `test_command` is missing, and when tracked files have changes. Test blocks of the step are written too. The refusal lists each problem with the reason. Fenced blocks inside indented list items count. The command is a convenience for the orchestrator; it does not use Gemini.

### 4. Smaller `agy_get`

- `compactRecord` truncates `deniedCommands` to the first 5 entries, each cut to 200 characters, and adds `deniedCommandsTotal` when it cut anything.
- A repeat `agy_get` on a terminal job whose record has not changed since the last `agy_get` of the same session returns `{state, unchanged: true, hint: "use diff_mode or paths for more"}` instead of the full record. A `diff_mode` or `paths` argument always returns the full answer.

### 5. Timeouts keep the work

In this code "gate" is the command-permission hook (`gate.ts`); the test run is `verify()`. This spec means `verify()` whenever it says tests.

- When a run reaches its timeout, the pipeline already commits the work and keeps the worktree. It now also runs `verify()` on that worktree, capped at 10 minutes, and puts the result in the envelope as `verify` with `partial: true`. The state stays `timeout`. The orchestrator can finalize a green timeout.
- Stall detection: when no new tool step has started for `stall_after_sec` (default 300) and no tool step is in progress, the pipeline aborts agy through its own `AbortController` (chained to the job's cancel signal, and marked so it is not reported as `cancelled`). Only after agy has stopped does it run `verify()` once. If that passes, the run ends with state `passed` and the note `ended early: no activity and verify passes`; otherwise it ends as `timeout` with `partial: true`. `verify()` never runs while agy is still editing.
- The timeout incident category is renamed `timeout_with_work` when the envelope's `diffStat` is non-empty and `timeout_no_progress` otherwise. The old `timeout_too_short` lesson tag stays readable.

### 6. Retry visibility

The job record carries `attempt` (a number, shown in the compact `agy_get` answer; the limit of 2 is in the hint text). `n` is 1 for a new job, the parent's `n` + 1 for a follow-up, and the earlier job's `n` + 1 for a new job on the same plan file and step after a `failed` or `timeout` job. Infrastructure errors, cancels, refusals and quota auto-follow-ups are not strikes. When `n` reaches 2 and the job did not pass, the answer adds `hint: "second strike: take this over or split it"`. Nothing is blocked.

### 7. Routing rules in the skill docs

`references/routing.md` gets two rules: a step with full code and tests is applied with `agy-foreman apply`; a plan is written by the orchestrator, with explore jobs used only to gather cited facts.

## Out of scope

- Blocking a third attempt.
- Changing the token gate or the estimate format.
- A Gemini-written plan flow.

## Safety

- `apply` never overwrites an existing file, and it refuses when tracked files have changes.
- The early end on a stall only converts a state to `passed` after agy has stopped and `verify()` passes in the worktree, the same check a normal run uses.
- None of these changes alter what Gemini is allowed to run.
