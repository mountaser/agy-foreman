import { describe, it, expect, inject } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  runJob,
  fenceUntrusted,
  type JobSpec,
  type PipelineDeps,
} from "../../src/pipeline/index.js";
import { run } from "../../src/agy/index.js";
import { parseProjectConfig, loadRuntimeConfig } from "../../src/config.js";
import { makeRepo, tmpRoot } from "./repo.js";
import { fixture } from "../helpers.js";

const RUNNER = `import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
let cases = "", failed = 0;
for (const f of readdirSync("tests").filter((f) => f.endsWith(".test.mjs"))) {
  try { await import("./tests/" + f); cases += '<testcase classname="tests/' + f + '" name="runs"/>'; }
  catch (e) { failed++; cases += '<testcase classname="tests/' + f + '" name="runs"><failure>' + e.message + '</failure></testcase>'; }
}
mkdirSync("reports", { recursive: true });
writeFileSync("reports/junit.xml", "<testsuite>" + cases + "</testsuite>");
process.exit(failed ? 1 : 0);
`;
const CONTRACT = {
  path: "tests/add.test.mjs",
  content:
    'import { add } from "../src/add.mjs";\nif (add(2, 3) !== 5) throw new Error("add broken");\n',
};

function setup(scenario: string, env: Record<string, string> = {}) {
  Object.assign(process.env, { FAKE_AGY_SCENARIO: scenario, ...env });
  const repo = makeRepo({
    "run.mjs": RUNNER,
    "tests/.keep": "",
    "src/add.mjs": "export const add = () => 0;\n",
    "README.md": "# demo\n",
  });
  const config = parseProjectConfig({
    test_command: ["node", "run.mjs"],
    test_report: "reports/junit.xml",
  });
  const spec: JobSpec = {
    jobId: "j-" + Math.random().toString(16).slice(2, 8),
    kind: "implement",
    repoRoot: repo,
    task: "Make add() add.",
    contractTests: [CONTRACT],
    timeoutSec: 30,
    config,
    runtime: loadRuntimeConfig({}),
  };
  const deps: PipelineDeps = {
    agyRun: run,
    agyCommand: { command: process.execPath, prefixArgs: [fixture("fake-agy.mjs")] },
    hookBundlePath: inject("hookBundle"),
    worktreeRoot: tmpRoot(),
    home: os.homedir(),
    now: () => new Date(),
  };
  return { repo, spec, deps };
}

describe("fenceUntrusted", () => {
  it("wraps and truncates", () => {
    const f = fenceUntrusted("x".repeat(9000), "ab12cd34");
    expect(f.startsWith("<<<AGY-UNTRUSTED nonce=ab12cd34>>>\n")).toBe(true);
    expect(f.endsWith("\n<<<END nonce=ab12cd34>>>")).toBe(true);
    expect(f.length).toBeLessThan(8100);
  });
});

describe("runJob implement", () => {
  it("passes when the agent fixes the code: red → green, committed, gate installed", async () => {
    const { spec, deps } = setup("implement", {
      FAKE_AGY_EDITS: JSON.stringify({ "src/add.mjs": "export const add = (a, b) => a + b;\n" }),
    });
    const env = await runJob(spec, deps);
    expect(env.state).toBe("passed");
    expect(env.contract).toEqual({ redOnBase: true, greenAfter: true });
    expect(env.verify?.counts).toMatchObject({ tests: 1, failures: 0 });
    expect(env.diffStat).toContain("src/add.mjs");
    expect(env.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(env.mergeCheck).toEqual({ clean: true, conflictingFiles: [] });
    expect(env.untrustedReport).toMatch(
      /^<<<AGY-UNTRUSTED nonce=[0-9a-f]{8}>>>\nimplemented\n<<<END/,
    );
    expect(existsSync(path.join(env.worktreePath, ".agents", "hooks.json"))).toBe(true);
    expect(existsSync(path.join(env.worktreePath, ".agy-task", "brief.md"))).toBe(true);
    expect(env.branch).toBe(`agy/${spec.jobId}`);
  }, 60_000);

  it("fails when the agent doesn't fix the code", async () => {
    const { spec, deps } = setup("implement", {
      FAKE_AGY_EDITS: JSON.stringify({ "src/other.mjs": "x\n" }),
    });
    const env = await runJob(spec, deps);
    expect(env.state).toBe("failed");
    expect(env.contract).toEqual({ redOnBase: true, greenAfter: false });
  }, 60_000);

  it("restores a contract test the agent tampered with, so cheating fails", async () => {
    const { spec, deps } = setup("tamper", {
      FAKE_AGY_EDITS: JSON.stringify({ "src/other.mjs": "x\n" }),
      FAKE_AGY_TAMPER: "tests/add.test.mjs",
    });
    const env = await runJob(spec, deps);
    expect(env.verify?.protectedRestored).toContain("tests/add.test.mjs");
    expect(env.state).toBe("failed");
  }, 60_000);

  it("stops on a guard violation", async () => {
    const { spec, deps } = setup("implement", {
      FAKE_AGY_EDITS: JSON.stringify({ "tests/add.test.mjs": "// overwritten\n" }),
    });
    const env = await runJob(spec, deps);
    expect(env.state).toBe("guard_violation");
    expect(env.guardEvents[0]).toMatch(/protected/);
  }, 60_000);

  it("refuses when the contract already passes, and without a test command", async () => {
    const a = setup("implement");
    a.spec.contractTests = [{ path: "tests/ok.test.mjs", content: "// passes\n" }];
    expect((await runJob(a.spec, a.deps)).state).toBe("refused");
    const b = setup("implement");
    b.spec.config = parseProjectConfig({});
    const env = await runJob(b.spec, b.deps);
    expect(env.state).toBe("refused");
    expect(env.reason).toMatch(/test_command/);
  }, 60_000);

  it("refuses contract tests without a test report to check them in", async () => {
    const { spec, deps } = setup("implement");
    spec.config = parseProjectConfig({ test_command: ["node", "run.mjs"] });
    const env = await runJob(spec, deps);
    expect(env).toMatchObject({ state: "refused", reason: expect.stringMatching(/test_report/) });
  }, 60_000);

  // Regression (found in review): an unrelated failing test made the base "red", so a contract
  // that already passed was handed to Gemini.
  it("does not count an unrelated failing test as the contract failing", async () => {
    const { spec, deps } = setup("implement", { FAKE_AGY_EDITS: "{}" });
    spec.contractTests = [{ path: "tests/ok.test.mjs", content: "// passes\n" }];
    spec.repoRoot = makeRepo({
      "run.mjs": RUNNER,
      "tests/old.test.mjs": 'throw new Error("broken before the job");\n',
      "src/add.mjs": "export const add = () => 0;\n",
    });
    const env = await runJob(spec, deps);
    expect(env).toMatchObject({
      state: "refused",
      reason: expect.stringMatching(/already pass on base/),
      contract: { redOnBase: false },
    });
  }, 60_000);

  it("runs setup_command in the fresh worktree before any test run", async () => {
    const { spec, deps } = setup("implement", {
      FAKE_AGY_EDITS: JSON.stringify({ "src/add.mjs": "export const add = (a, b) => a + b;\n" }),
    });
    spec.config = parseProjectConfig({
      test_command: ["node", "run.mjs"],
      test_report: "reports/junit.xml",
      setup_command: [
        "node",
        "-e",
        "require('fs').mkdirSync('.agy-task',{recursive:true});require('fs').writeFileSync('.agy-task/setup.done','1')",
      ],
    });
    const env = await runJob(spec, deps);
    expect(env.state).toBe("passed");
    expect(existsSync(path.join(env.worktreePath, ".agy-task", "setup.done"))).toBe(true);
  }, 60_000);

  // Regression (found live): a followup without contract tests changed nothing and "passed".
  it("fails an implement run that changes no file", async () => {
    const { spec, deps } = setup("implement", { FAKE_AGY_EDITS: "{}" });
    spec.contractTests = [];
    const env = await runJob(spec, deps);
    expect(env.state, env.diffStat).toBe("failed");
    expect(env.reason).toMatch(/no changes/);
  }, 60_000);

  it("stops with an error when setup_command fails", async () => {
    const { spec, deps } = setup("implement");
    spec.config = parseProjectConfig({
      test_command: ["node", "run.mjs"],
      test_report: "reports/junit.xml",
      setup_command: ["node", "-e", "console.error('no network'); process.exit(7)"],
    });
    const env = await runJob(spec, deps);
    expect(env.state).toBe("error");
    expect(env.reason).toMatch(/setup_command failed \(exit 7\).*no network/s);
  }, 60_000);

  it("maps quota to state quota with the reset time", async () => {
    const { spec, deps } = setup("quota-exit");
    const env = await runJob(spec, deps);
    expect(env).toMatchObject({ state: "quota", quota: { resetInSec: 30 } });
  }, 60_000);
});

describe("runJob explore", () => {
  it("verifies citations and removes the worktree", async () => {
    const answer = {
      summary: "add is broken",
      citations: [
        { path: "src/add.mjs", line: 1, claim: "returns 0" },
        { path: "src/ghost.mjs", line: 3, claim: "made up" },
        { path: "README.md", line: 99, claim: "bad line" },
      ],
      open_questions: ["why?"],
    };
    const { spec, deps } = setup("explore", { FAKE_AGY_EXPLORE: JSON.stringify(answer) });
    const env = await runJob(
      { ...spec, kind: "explore", contractTests: undefined, task: "Why does add fail?" },
      deps,
    );
    expect(env.state).toBe("passed");
    expect(env.explore?.citations).toEqual([answer.citations[0]]);
    expect(env.explore?.unverifiedCitations).toHaveLength(2);
    expect(env.explore?.openQuestions).toEqual(["why?"]);
    expect(env.branch).toBeNull();
    expect(existsSync(env.worktreePath)).toBe(false);
  }, 60_000);
});
