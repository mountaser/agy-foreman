# Routing: Gemini or Orchestrator?

The orchestrator must route tasks deliberately. Delegating to Gemini 3.8 Flash saves orchestrator context and tokens only when tasks are well-bounded and verifiable.

## When to Keep on the Orchestrator

Do **not** delegate:

- **Unclear or exploratory requirements**: Ambiguous design decisions, product requirements, or architecture exploration.
- **Security-sensitive code**: Cryptographic keys, authentication logic, credential handling, and permissions.
- **Tasks without machine checks**: Any write task lacking automated tests or verification commands.
- **Small edits**: Minor bugfixes, typos, or changes under ~60 lines / 1–2 tool calls.
- **Dependency or test-config changes**: `package.json`, runner config and `tsconfig` are protected and restored before verification. Make those changes yourself, commit them, then delegate the rest.
- **Information retrieval primitives**: Never delegate simple `grep`, regex searches, or file listing. The orchestrator does these directly.
- **Interactive or ongoing debugging**: Tasks needing iterative conversational feedback with the user.
- **Final review**: The orchestrator always conducts final code review.

## When to Delegate to Gemini 3.8 Flash

Delegate tasks that satisfy these criteria:

- **Plan steps with contract tests**: Specific steps from an approved plan with orchestrator-written contract tests.
- **Bulk mechanical changes**: Porting patterns across multiple files, updating API calls, or boilerplate generation.
- **Writing tests from specs**: Drafting test cases given existing implementation or detailed interface specs.
- **Large-codebase exploration (`explore`)**: Read-only codebase investigations with verifiable citations.

## The Two Strikes Rule

If Gemini 3.8 Flash fails a delegated task twice (or requires two rounds of corrective follow-ups without passing), **stop delegating that task**. Take the work back onto the orchestrator, or split the task into significantly smaller, simpler sub-tasks.

## Token Gate & Estimation

Every `agy_start` call requires an `estimate`:

```json
{
  "direct_tokens": 30000,
  "delegate_overhead_tokens": 4500,
  "reason": "6 files modified, verified against contract tests"
}
```

- `direct_tokens`: Estimated tokens the orchestrator would spend doing the task directly (reading source files ≈ chars / 4, plus writing changes, plus test execution output).
- `delegate_overhead_tokens`: Overhead incurred by delegating (writing brief ~1.5k, contract test generation, result envelope ~0.6k, diff review).
- **Refusal Ratio**: The server automatically refuses tasks without prompting if `delegate_overhead_tokens * refuse_ratio > direct_tokens` (default `refuse_ratio = 1.5`).

## Check Lessons First

Before delegating any task, call `agy_status()` to inspect the top orchestrator lessons recorded for the project. These lessons document repo-specific quirks, flaky test suites, and previously identified routing traps.
