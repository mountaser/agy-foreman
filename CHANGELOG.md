# Changelog

All notable changes to agy-foreman. Versions follow [semver](https://semver.org/); the newest is first.

## 0.2.3 - 2026-10-30

Found by running every feature against a live agy 1.4.11.

### Fixed

- **A follow-up could not work.** The resumed Gemini conversation kept using the previous worktree's path and reported that it was "unable to switch", editing nothing. The resume prompt now names the new working directory and says the old path is gone.
- **Explore jobs failed with "No parseable JSON" when Gemini added prose around the JSON** (it usually does). The JSON object is now found inside the reply: whole text, fenced block, or embedded.
- **`apply` could write a step's code into the wrong file.** With several files listed (`- Create`, `- Test`), a bare code block was bound to the last listed file and the run reported green. Now a bare block in that situation is refused (name the file in a first-line comment), and a step is refused if any listed file has no block.

## 0.2.2 - 2026-10-30

### Fixed

- **Works with agy 1.4.** The agy CLI renamed its file tools (`write_to_file` to `write_file`, `replace_file_content` to `edit_file`, `view_file` to `read_file`), and the gate denied every one of them, so Gemini could not edit or read a single file. The gate now handles both generations with the same rules (inside the worktree, not protected, not `.git`). A write tool that sends no recognisable path is denied with a message that lists the argument names it did send, so the next rename is easy to map. The status file and progress tracking recognise the new names too.
- The brief names both sets of file tools.

## 0.2.1 - 2026-10-30

Two bugs found by the first live job on 0.2.0.

### Fixed

- **A project's own test command was refused by the gate when it ended in a symbol** (`node --test test/`, `go test ./...`): the allowlist match used a word boundary, which never exists after `/` or `.`. Gemini could not run the tests it was told to run.
- **The brief now names the file tools** (`write_to_file`, `replace_file_content`, `multi_replace_file_content`, `view_file`). "File edit tools only" made Gemini try tool names the gate does not know (`edit_file`, `read_file`) and give up without editing anything.

## 0.2.0 - 2026-10-30

This release makes delegation cheaper and its failures clearer, and moves the status line to [claude-gauges](https://github.com/mountaser/claude-gauges).

### Added

- **`agy-foreman apply <plan> <step>`**: writes the files a plan step spells out in full and runs your `test_command`, so Gemini does not retype code that already exists. It only creates files and refuses anything ambiguous ("append to", two blocks for one path, a path that exists, a dirty tracked tree) without writing. `--dry-run` lists what it would write.
- **`agy-foreman report [--since YYYY-MM-DD]`**: jobs, Gemini tokens and minutes per state, incident counts, orchestrator characters per job, and the five costliest non-passed jobs.
- **Status file**: the server keeps `status.json` in its state folder up to date (jobs, plan progress, activity, diff size, quota). Format: [docs/superpowers/specs/2026-10-30-status-snapshot-design.md](docs/superpowers/specs/2026-10-30-status-snapshot-design.md).
- **`agy-foreman statusline`** offers to install claude-gauges: it asks first, downloads the release for your system, checks its SHA-256 and runs its installer. `--install`, `--manual` and `--force` skip the question.
- **Attempt counter**: each job carries `attempt`; a failed or timed-out second try gets a hint to take the work back.
- **Stall detection**: a run with no new tool step for 300 s (`AGY_STALL_SEC`) and no tool step running is stopped. If the tests pass it ends as `passed` ("ended early"); otherwise it ends as a partial `timeout`.
- **One automatic resume** of a job cut off by a service error (503 and the like) after real work.
- New incident categories `missing_config`, `timeout_with_work` and `timeout_no_progress`.
- `CHANGELOG.md`.

### Changed

- **A missing `test_command` is refused by `agy_start` itself**, before any approval card, with a message that names `.agy-foreman.json`. A dry run shows the same text as `warning`. `agy-foreman wait` prints the reason of a refused or errored job. `init` prints a hint about the status line instead of installing one.
- **A timed-out run is verified.** Its result is `timeout` with `partial: true` and a `verify` report, so finished work is visible.
- **The default timeout** is three times the median passed run, between 10 and 30 minutes, once ten jobs have passed; before that the configured default (30 minutes) stands.
- **`agy_get` is smaller**: a repeat read of a finished job returns a short record with `unchanged: true` (ask for `diff_mode` for the full one), and `deniedCommands` is capped at five entries of 200 characters.
- **The brief forbids shell file writes**, and the gate allows harmless probes (`git branch` listing, `go version` and similar), which removes many denied steps per job.
- The ledger records Gemini token use for every state, including errors and timeouts. The median run time, used for the progress estimate, counts passed jobs only. The calibration figure compares the orchestrator's characters with its estimate instead of Gemini output tokens.
- Discarding a job that has no worktree succeeds, even when the main checkout has changes.

### Removed

- The built-in status line renderer (`dist/statusline.js` is now an empty program so an old `settings.json` entry keeps working and shows nothing) and `statusline --uninstall`. Use `claude-gauges uninstall` to remove claude-gauges.

## 0.1.0 - 2026-10-17

First release.
