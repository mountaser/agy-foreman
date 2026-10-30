# Status line install prompt design

## Purpose

agy-foreman no longer draws its own status line. Its job progress is shown by [claude-gauges](https://github.com/mountaser/claude-gauges), which reads the `status.json` file agy-foreman writes (see `2026-10-30-status-snapshot-design.md`). The `agy-foreman statusline` command offers to install claude-gauges so users do not have to find it themselves.

The command never installs anything without an explicit choice, and never runs a download it could not verify.

## The `statusline` command

```
agy-foreman statusline              ask what to do (when run in a terminal)
agy-foreman statusline --install    download and install claude-gauges, no questions
agy-foreman statusline --manual     print the commands to install it yourself
agy-foreman statusline --force      with --install or option 1: replace an existing status line
```

When run without a flag:

- In a terminal it prints the prompt below and reads one answer.
- Anywhere else (no terminal on standard input) it prints the prompt followed by `Choose with: agy-foreman statusline --install | --manual` and exits 0 without doing anything.

### Prompt

```
Status line

claude-gauges shows your jobs, the Gemini quota, your Claude limits and the cache timer
under the Claude Code prompt.

  [1] Install claude-gauges (downloads the latest release from GitHub and checks its SHA-256)
  [2] I will do it myself (prints the commands)
  [3] Skip
```

The question is `Choose 1, 2 or 3: `. Accepted answers, case-insensitive:

| Choice | Answers |
|---|---|
| Install | `1`, `i`, `install` |
| Manual | `2`, `m`, `manual` |
| Skip | `3`, `s`, `skip`, or an empty answer |

An answer that is none of these prints `Please type 1, 2 or 3.` and asks again, at most 3 times in total; after that the command exits 1.

Skip prints `Skipped. Run agy-foreman statusline any time.` and exits 0.

Manual prints:

```
Install claude-gauges yourself:

  macOS, Linux, WSL:   curl -fsSL https://raw.githubusercontent.com/mountaser/claude-gauges/main/install.sh | bash
  Windows PowerShell:  irm https://raw.githubusercontent.com/mountaser/claude-gauges/main/install.ps1 | iex

Then restart Claude Code. More: https://github.com/mountaser/claude-gauges
```

## Install flow

1. Pick the release file for this system, from the platform and CPU of the running Node process:

   | Platform | CPU | File |
   |---|---|---|
   | linux | x64, arm64 | `claude-gauges_linux_amd64`, `claude-gauges_linux_arm64` |
   | darwin | x64, arm64 | `claude-gauges_darwin_amd64`, `claude-gauges_darwin_arm64` |
   | win32 | x64, arm64 | `claude-gauges_windows_amd64.exe`, `claude-gauges_windows_arm64.exe` |

   Any other combination stops with `claude-gauges has no build for <platform> <cpu>. Install it yourself: agy-foreman statusline --manual` and exit code 1.
2. Download `checksums.txt` and the file from `https://github.com/mountaser/claude-gauges/releases/latest/download/`. Only this address is used.
3. Find the file's line in `checksums.txt` (format `<64 hex digits>  <file name>`, optionally `*` before the name). Compute the SHA-256 of the download. A missing line, a download that fails (any HTTP status that is not a success) or a different hash stops the install. Nothing is written to disk and nothing is run.
4. Write the verified file into a new temporary folder and mark it executable.
5. Run it as `claude-gauges install`, with its output and input passed through to the terminal. The program copies itself to `~/.claude/` and sets the Claude Code status line (see its own README).
6. Delete the temporary folder, whether the install worked or not.
7. Exit with the exit code of `claude-gauges install`.

Any failure before step 5 prints `status line: <reason>` and exits 1.

## Existing status lines

- If Claude Code's settings (`~/.claude/settings.json`, or `FOREMAN_CLAUDE_SETTINGS`) hold a status line whose command ends in `statusline` or `statusline.js"` (the one older agy-foreman versions installed), the install replaces it. The command prints `Replacing the old agy-foreman status line. claude-gauges saves it, and claude-gauges uninstall restores it.` and runs `claude-gauges install --force`.
- If it holds any other status line, `claude-gauges install` refuses and says so. Run `agy-foreman statusline --install --force` to replace it; claude-gauges saves the old one.
- With `--force`, `claude-gauges install --force` is always used.

## `init`

`agy-foreman init` no longer installs a status line. After writing `.agy-foreman.json` and printing the registration command it prints:

`Status line: run agy-foreman statusline to add claude-gauges (jobs, Gemini quota, Claude limits, cache timer).`

The `--no-statusline` flag is still accepted and ignored.

## The old status line

The renderer that older versions installed is removed: its code, its tests and the wrapping of a previous status line. The file `dist/statusline.js` stays as an empty program that exits 0 without printing, so a `settings.json` that still runs it keeps working and just shows nothing. The `--uninstall` flag of `statusline` is gone; `claude-gauges uninstall` removes claude-gauges.

## Safety

- The program only talks to `github.com` over HTTPS and only runs a file whose SHA-256 matches the published `checksums.txt` from the same release.
- It never edits Claude Code's settings itself. Only `claude-gauges install` does, and that program backs the file up first.
- Without a choice (no terminal, no flag) it changes nothing.

## Out of scope

- Updating claude-gauges later (re-run the command) and signature checks beyond the checksum.
- Restoring a status line that an older agy-foreman had wrapped before its own.
- Offering the prompt automatically during `init` or the first run.
