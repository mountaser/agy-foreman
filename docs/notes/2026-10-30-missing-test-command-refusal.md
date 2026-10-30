# Note for the next agent: a repo without `.agy-foreman.json` fails confusingly

Found while delegating plan steps in a fresh Go repo (`claude-gauges`) from a Claude Code session on Windows. None of this has been fixed. These are observations for whoever works on agy-foreman next.

## What happened

1. The repo had no `.agy-foreman.json`.
2. `agy_start` with `dry_run: true` worked and returned a normal rendered brief and command. It did not warn that the real run would be refused.
3. The real `agy_start` (three jobs, started together) returned `state: "running"` and a `wait_hint`.
4. Within about 50 ms each job went to `state: "refused"` with `reason: "config.test_command is required for implement jobs"`. The three branches (`agy/t-...`) were never given worktrees.
5. `agy-foreman wait <job_id>` printed only `<job_id> refused` and `next: agy_get <job_id>`, then exited 1. The reason was visible only after calling `agy_get`, inside `envelope.reason` and `incident.evidence`.
6. `agy_act(finalize, mode: "discard")` on a refused job failed with `git worktree remove --force ...: fatal: '...' is not a working tree`, because no worktree existed. The refused jobs stayed in `agy_status` history and the error looked like a real failure.

Fix applied in the project: a committed `.agy-foreman.json` with `test_command` (`["go","test","./..."]`), `allowed_commands`, `protected_paths` and `max_concurrent`. After that the same plan steps ran normally.

## Suggested changes

- **Dry run should check the config.** `dry_run` should fail or warn when `test_command` is missing, since the real run will always be refused.
- **Refuse before reporting `running`.** `agy_start` could return the refusal directly instead of `running` followed by a refusal moments later.
- **Show the reason in `agy-foreman wait`.** Print `envelope.reason` next to `refused`, so an agent does not need a second call to learn why.
- **`finalize` on a refused job.** Treat a missing worktree as "nothing to discard" and succeed, or return a clear message.
- **Skill docs.** `skills/gemini-delegation/SKILL.md` and its `references/` never mention `.agy-foreman.json` or `test_command`. A grep for `test_command` in the installed skill folder found nothing. A short "first-time setup in a new repo" section would have saved the detour. The README documents the file, but an agent working from the skill alone will not read it.
- **Incident category.** The refusal was labelled `wrong_or_missing_gate`, which reads like an approval or token-gate problem. Something like `missing_config` would point at the cause.

## Smaller observations (not verified further)

- The dry-run command used `--model gemini-3.8-flash-medium` for an `effort: "medium"` request, but the refused envelope reported `model: "gemini-3.8-flash-high"`. This may only be how a refused envelope is filled in; check it on a job that actually runs.
- On Windows the `lessons` list already warns that a `test_command` starting with `bash` runs WSL's bash. Using `go` directly worked fine as the first element.
