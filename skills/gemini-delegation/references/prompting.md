# Prompting: Writing the Brief

When delegating to Gemini 3.8 Flash in headless mode, the generated brief file (`.agy-task/brief.md`) is everything Gemini knows. There is no prior conversation history or interactive steering.

## XML Structure

Briefs should be organized into clear, structured XML blocks:

```markdown
<task>
Specific description of the feature, refactor, or bugfix to implement.
</task>

<context>
Background documentation, system architecture, interfaces, and current date (e.g. 2026-10-17).
Pin any relevant library versions to counter knowledge cutoff limitations.
</context>

<scope>
List of files to modify, files to create, and explicit list of files to leave untouched.
</scope>

<constraints>
- Do not run git commit.
- Do not modify tests, contract tests, test-runner config, package.json or .agy-foreman.json (the server restores them before verifying).
- Run one plain command per call: the gate denies redirection, $( ), backticks, background & and multi-line commands.
- Never add code paths that exist only to make a specific test pass; if a test looks wrong, stop and report.
</constraints>

<verification>
Explicit verification commands matching project configuration (e.g., `npm test`, `npx vitest run`).
Never say "run the tests" ambiguously; always name the exact command and arguments.
</verification>

<skills>
Referenced skills made available in `<worktree>/.agents/skills/`.
</skills>

<lessons>
Injected implementer lessons from prior runs and failures.
</lessons>

<progress>
Instructions to update `.agy-task/progress.md` checkboxes (`- [ ]` to `- [x]`) as subtasks finish.
</progress>

<report>
Requested shape of the completion report (e.g., changes made, files touched, verification outcome).
</report>
```

## Prompting Rules & Best Practices

1. **Context First, Instructions Last**: Place broad background and reference files early in the brief, followed by explicit instructions at the end, concluding with an anchor directive like `Execute the task described above.`
2. **Never Set Hard Word or Length Limits**: **Never set hard word or length limits** for briefs or reports. Live testing revealed that Gemini loops continuously writing temporary scripts to count words in its draft, wasting time and running out the clock. Instead, request specific structural sections or bullet points, and let the server truncate if necessary.
3. **Forbid Test Cheating in Production Code**: Explicitly instruct: _"Never add code paths that exist only to make a specific test pass; if a test looks wrong, stop and report."_ If a test is broken, Gemini must report it rather than patching around it with hidden hacks in shared helpers.
4. **Single Bounded Scope**: Limit each brief to a single cohesive task. Do not overload one run with multiple independent components.
5. **No Git Commits**: Gemini must never commit code; the orchestrator server handles snapshots, commits, and diffs.
