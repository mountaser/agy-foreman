# Status snapshot design

## Purpose

agy-foreman writes one small file, `status.json`, that describes the delegation work happening right now. Any status line can read it to show job progress without starting a process, parsing job records or knowing agy-foreman's internals. claude-gauges is the first reader.

The file is a public contract. Its format is versioned and documented here.

## Location

`<state dir>/status.json`, where the state dir is the one agy-foreman already uses (`stateDir()` in `src/paths.ts`):

| Platform | State dir |
|---|---|
| Windows | `%LOCALAPPDATA%\agy-foreman` |
| macOS | `~/Library/Application Support/agy-foreman` |
| Linux | `$XDG_STATE_HOME/agy-foreman`, or `~/.local/state/agy-foreman` |

`FOREMAN_STATE_DIR` overrides the state dir on every platform.

## Format (version 1)

```json
{
  "version": 1,
  "updatedAt": "2026-10-30T14:30:00.000Z",
  "pid": 5060,
  "active": true,
  "plan": {
    "file": "docs/superpowers/plans/2026-10-30-claude-gauges.md",
    "steps": ["passed", "passed", "running", "pending", "pending"],
    "done": 2,
    "failed": 0,
    "elapsedSec": 651,
    "diff": { "files": 2, "added": 217, "deleted": 0 }
  },
  "jobs": [
    {
      "id": "t-mvv280r4-53d6",
      "step": 4,
      "title": "Render the two lines",
      "state": "running",
      "phase": "run",
      "activity": { "kind": "editing", "target": "render.go", "at": "2026-10-30T14:29:56.000Z" }
    }
  ],
  "quota": {
    "fiveHour": { "remaining": 94, "resetAt": "2026-10-30T17:42:00Z" },
    "weekly": { "remaining": 70, "resetAt": "2026-11-03T00:00:00Z" },
    "fetchedAt": "2026-10-30T14:29:00.000Z"
  }
}
```

### Fields

| Field | Type | Meaning |
|---|---|---|
| `version` | number | Always `1`. A reader that does not know the version ignores the file. |
| `updatedAt` | ISO time | When this file was written. |
| `pid` | number | Process id of the agy-foreman server that wrote it. |
| `active` | boolean | True while any job is queued or running. When false, `plan` is absent and `jobs` is empty. |
| `plan.file` | string or null | Plan file of the shown job group; null for a job started without a plan. |
| `plan.steps` | array | One entry per delegated step, in plan order. Each is `passed`, `running`, `queued`, `failed` or `pending`. |
| `plan.done` | number | How many entries of `steps` are `passed`. |
| `plan.failed` | number | How many entries are `failed`. |
| `plan.elapsedSec` | number | Seconds since the first job of the group was created. |
| `plan.diff` | object, optional | Files, added lines and deleted lines produced by the group. Absent when nothing is known. |
| `jobs` | array | Queued and running jobs of the group, oldest first. |
| `jobs[].step` | number or null | Plan step number, or null without a plan. |
| `jobs[].title` | string | Task title without `Task N:` prefix, backticks or Markdown emphasis. For a job without a plan it is cut to 40 characters, ending in `…` when cut. |
| `jobs[].state` | string | `queued` or `running`. |
| `jobs[].phase` | string | `queued`, `awaiting_approval`, `prepare`, `contract`, `brief`, `run`, `verify`, `report` or `done`. |
| `jobs[].activity` | object, optional | Present only while `phase` is `run` and something has been seen. |
| `quota` | object, optional | Gemini quota from agy-foreman's quota cache, passed through unchanged. `remaining` is a percentage. |

### Group selection

The snapshot describes one group of jobs: the plan of the oldest running job, or of the oldest queued job when none is running. Within that plan (same plan file and repository), the group is the current run: the oldest active job of the plan, every job created after it, and the earlier jobs that lead up to it, going back until two neighbouring jobs were created more than 2 hours apart. Older jobs of the same plan are history and are ignored, so running a plan again later starts from zero. A job started without a plan is a group of one.

### Steps

The step list is built in this order:

1. The `delegate_steps` the plan run was started with, when given. Only those steps appear, so steps done by hand are not counted.
2. Otherwise, every step of the plan file (`1` to the number of `### Task N:` headings).
3. Otherwise, the distinct step numbers seen among the group's jobs, ascending.

A job without a plan gives a single step.

A step is `passed` if any job for it passed, else `running` if one is running, else `queued` if one is queued, else `failed` if there was any job for it, else `pending`. A follow-up job that passes therefore turns an earlier failed attempt into `passed`.

### Activity

`activity.kind` is one of:

| Kind | When | `target` |
|---|---|---|
| `reading` | A tool that views, lists, searches or reads. | File or folder base name, when the tool names one. |
| `editing` | A tool that writes, replaces, patches, creates, deletes or moves. | File base name. |
| `testing` | A command that runs `go test`, `go vet`, `gofmt`, `npm test`, `vitest`, `tsc`, `prettier`, `pytest` or `cargo test`, at the start of the command line or after `&&`, `;`, `|` or `(`. A word inside an argument does not count. | none |
| `git` | A command starting with `git`. | none |
| `command` | Any other command. | none |
| `thinking` | The last tool call finished and the next has not started. | none |

The raw command line is never written. `at` is the time the activity started. Tool calls that only poll or feed a terminal (`command_status`, `read_terminal`, `send_command_input`) leave the activity unchanged.

### Diff

The diff of a running job is measured in its worktree with `git --no-optional-locks`: tracked changes against `HEAD` plus new untracked files (lines counted), ignoring `.agy-task/` and `.agents/`. Reading never takes git's index lock, so it cannot collide with Gemini's or the pipeline's own git commands. An untracked file over 1 MB counts as a file with no lines. Nothing is measured unless the folder itself contains a `.git`. For a finished job the diff is read from the last line of the envelope's `diffStat`. The group diff is the sum.

## When the file is written

- After every job record is written, debounced to at most one write per 200 ms. The server keeps the job records in memory (loaded once on the first write, then updated by every record write), so a job file that cannot be read for a moment never drops a job.
- Every second while any job is active (heartbeat), so `updatedAt` stays fresh and the activity age keeps counting. A heartbeat tick is skipped while a write is still running.
- Once more when the last job finishes, with `active: false`. After that nothing is written until a job starts again.
- Diffs are measured in the background, at most every 5 seconds per running job and never twice at once. A write uses the latest finished measurement and never waits for git.
- Writes go to a temporary file in the same folder and are renamed into place, so a reader never sees half a file.
- A failed write is ignored. It never stops a job.

## Reading rules for status lines

A reader shows nothing when the file is missing, is not valid JSON, has an unknown `version`, has `active: false`, or has an `updatedAt` older than 15 seconds. The last case covers a crashed server that left `active: true` behind.

Fields may be added in later versions of the format without changing `version`. Readers ignore fields they do not know. A change that removes or reinterprets a field raises `version`.

## Out of scope

- Removing agy-foreman's own status line renderer and the `statusline` command's install prompt. That follows once claude-gauges has a published release.
- Per-job history, finished jobs and failure reasons. Only active work is described.
- Token counts. The usage figures that reach the server during a run are per model call, not running totals, so no honest total is available while a job runs.
- Writing the file from a process other than the MCP server.
