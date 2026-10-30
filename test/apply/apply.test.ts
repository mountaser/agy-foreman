import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyStep } from "../../src/apply/apply.js";
import { MISSING_TEST_COMMAND } from "../../src/config.js";
import { makeRepo } from "../pipeline/repo.js";

const fence = "```";
const plan = (...lines: string[]): string => lines.join("\n") + "\n";
const onePlan = plan(
  "### Task 1: x",
  "- Create: `src/a.ts`",
  fence + "ts",
  "export const a = 1;",
  fence,
);

const pass = () => vi.fn(async () => ({ code: 0, out: "ok\n" }));
const fail = () => vi.fn(async () => ({ code: 1, out: "1 failed\n" }));
const base = { planFile: "plan.md", step: 1, testCommand: ["npm", "test"] };

describe("applyStep", () => {
  it("writes the file, runs the tests and reports ok", async () => {
    const repoRoot = makeRepo({ "plan.md": onePlan });
    const run = pass();
    const r = await applyStep({ ...base, repoRoot, run });
    expect(r.ok).toBe(true);
    expect(r.written).toEqual(["src/a.ts"]);
    expect(r.testExit).toBe(0);
    expect(existsSync(path.join(repoRoot, "src/a.ts"))).toBe(true);
    expect(run).toHaveBeenCalledWith(["npm", "test"], repoRoot);
  });

  it("reports a failing test run but keeps the file", async () => {
    const repoRoot = makeRepo({ "plan.md": onePlan });
    const r = await applyStep({ ...base, repoRoot, run: fail() });
    expect(r.ok).toBe(false);
    expect(r.testExit).toBe(1);
    expect(r.testTail).toContain("1 failed");
    expect(existsSync(path.join(repoRoot, "src/a.ts"))).toBe(true);
  });

  it("refuses when tracked files have changes", async () => {
    const repoRoot = makeRepo({ "plan.md": onePlan });
    writeFileSync(path.join(repoRoot, "plan.md"), onePlan + "\nedited\n");
    const run = pass();
    const r = await applyStep({ ...base, repoRoot, run });
    expect(r.ok).toBe(false);
    expect(r.written).toEqual([]);
    expect(existsSync(path.join(repoRoot, "src/a.ts"))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("ignores untracked files in the dirty check", async () => {
    const repoRoot = makeRepo({ "plan.md": onePlan });
    writeFileSync(path.join(repoRoot, "scratch.txt"), "x");
    const r = await applyStep({ ...base, repoRoot, run: pass() });
    expect(r.ok).toBe(true);
  });

  it("refuses an ambiguous block and writes nothing", async () => {
    const text = plan(
      "### Task 1: x",
      "Append to `src/a.ts`:",
      fence + "ts",
      "export const a = 1;",
      fence,
    );
    const repoRoot = makeRepo({ "plan.md": text });
    const run = pass();
    const r = await applyStep({ ...base, repoRoot, run });
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(existsSync(path.join(repoRoot, "src/a.ts"))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a step with no file blocks and never runs the tests", async () => {
    const repoRoot = makeRepo({ "plan.md": plan("### Task 1: x", "Just prose.") });
    const run = pass();
    const r = await applyStep({ ...base, repoRoot, run });
    expect(r.ok).toBe(false);
    expect(r.problems[0]?.reason).toMatch(/nothing to apply/);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses when the target already exists", async () => {
    const repoRoot = makeRepo({ "plan.md": onePlan, "src/a.ts": "old\n" });
    const run = pass();
    const r = await applyStep({ ...base, repoRoot, run });
    expect(r.ok).toBe(false);
    expect(r.problems[0]?.reason).toMatch(/target exists: src\/a\.ts/);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString()).toBe("");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses when test_command is missing", async () => {
    const repoRoot = makeRepo({ "plan.md": onePlan });
    const r = await applyStep({ ...base, repoRoot, testCommand: undefined, run: pass() });
    expect(r.ok).toBe(false);
    expect(r.problems[0]?.reason).toBe(MISSING_TEST_COMMAND);
    expect(existsSync(path.join(repoRoot, "src/a.ts"))).toBe(false);
  });

  it("dry run lists the files, writes nothing and runs nothing", async () => {
    const repoRoot = makeRepo({ "plan.md": onePlan });
    const run = pass();
    const r = await applyStep({ ...base, repoRoot, dryRun: true, run });
    expect(r.ok).toBe(true);
    expect(r.written).toEqual(["src/a.ts"]);
    expect(existsSync(path.join(repoRoot, "src/a.ts"))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("creates missing folders and keeps only the last 40 lines of output", async () => {
    const text = plan(
      "### Task 1: x",
      "- Create: `deep/er/b.ts`",
      fence + "ts",
      "export const b = 1;",
      fence,
    );
    const repoRoot = makeRepo({ "plan.md": text });
    const out = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const run = vi.fn(async () => ({ code: 0, out }));
    const r = await applyStep({ ...base, repoRoot, run });
    expect(existsSync(path.join(repoRoot, "deep/er/b.ts"))).toBe(true);
    expect(r.testTail?.split("\n").filter(Boolean)).toHaveLength(40);
    expect(r.testTail).toContain("line 100");
    expect(r.testTail).not.toContain("line 60\n");
  });
});

describe("applyStep coverage", () => {
  it("refuses when a listed file has no block, and writes nothing", async () => {
    const text = plan(
      "### Task 1: x",
      "- Create: `src/a.ts`",
      "- Test: `test/a.test.ts`",
      fence + "ts",
      "// src/a.ts",
      "export const a = 1;",
      fence,
    );
    const repoRoot = makeRepo({ "plan.md": text });
    const run = pass();
    const r = await applyStep({ ...base, repoRoot, run });
    expect(r.ok).toBe(false);
    expect(r.problems[0]?.reason).toBe("no block found for listed file: test/a.test.ts");
    expect(existsSync(path.join(repoRoot, "src/a.ts"))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
