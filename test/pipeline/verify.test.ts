import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { verify } from "../../src/pipeline/verify.js";
import {
  createWorktree,
  removeWorktree,
  snapshotGitState,
  commitAll,
} from "../../src/pipeline/worktree.js";
import { git } from "../../src/pipeline/exec.js";
import { makeRepo, tmpRoot } from "./repo.js";

// Plain source text: Function.prototype.toString() would include vitest transform helpers.
const JUNIT_SRC = `(tests, failures, skipped) => "<testsuite>" + Array.from({ length: tests }, (_, i) => '<testcase classname="t" name="c' + i + '">' + (i < failures ? "<failure>f</failure>" : i < failures + skipped ? "<skipped/>" : "") + "</testcase>").join("") + "</testsuite>"`;

// A tiny "test runner": exits 1 if src/v.txt isn't "good", and writes a JUnit report.
const RUNNER = `import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const ok = readFileSync("src/v.txt", "utf8").trim() === "good";
const extraSkip = readFileSync("tests/t.mjs", "utf8").includes("SKIPME") ? 1 : 0;
mkdirSync("reports", { recursive: true });
writeFileSync("reports/junit.xml", (${JUNIT_SRC})(3, ok ? 0 : 1, extraSkip));
process.exit(ok ? 0 : 1);
`;

const junit = (cases: [classname: string, name: string, body: string][]) =>
  "<testsuite>" +
  cases.map(([c, n, b]) => `<testcase classname="${c}" name="${n}">${b}</testcase>`).join("") +
  "</testsuite>";

/** A test command that exits 0 after writing this report. */
const writeReport = (xml: string) => [
  "node",
  "-e",
  `const fs = require("fs"); fs.mkdirSync("reports", { recursive: true }); fs.writeFileSync("reports/junit.xml", ${JSON.stringify(xml)});`,
];

async function setup() {
  const repo = makeRepo({
    "run.mjs": RUNNER,
    "src/v.txt": "bad\n",
    "tests/t.mjs": "// contract\n",
  });
  const wt = await createWorktree({ repoRoot: repo, jobId: "v-1", root: tmpRoot() });
  const snapshot = await snapshotGitState(repo, "agy/v-1");
  const base = {
    wt,
    protectedGlobs: ["tests/**"],
    testCommand: ["node", "run.mjs"],
    testReport: "reports/junit.xml",
    baseline: { tests: 3, failures: 1, errors: 0, skipped: 0, failed: [] },
    snapshot,
    ignoreBranch: "agy/v-1",
    timeoutMs: 30_000,
  };
  return { repo, wt, base };
}

describe("verify", () => {
  it("passes when the implementation is fixed", async () => {
    const { wt, base } = await setup();
    writeFileSync(path.join(wt.path, "src/v.txt"), "good\n");
    const r = await verify(base);
    expect(r).toMatchObject({
      exitCode: 0,
      passed: true,
      newSkips: 0,
      fewerTests: false,
      tamper: [],
      protectedRestored: [],
    });
    expect(r.counts).toMatchObject({ tests: 3, failures: 0 });
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);

  it("restores tampered protected files before running the tests", async () => {
    const { wt, base } = await setup();
    writeFileSync(path.join(wt.path, "src/v.txt"), "good\n");
    writeFileSync(path.join(wt.path, "tests/t.mjs"), "// SKIPME\n");
    writeFileSync(path.join(wt.path, "tests/added-by-agent.mjs"), "x");
    const r = await verify(base);
    expect(r.protectedRestored.sort()).toEqual(["tests/added-by-agent.mjs", "tests/t.mjs"]);
    expect(readFileSync(path.join(wt.path, "tests/t.mjs"), "utf8")).toBe("// contract\n");
    expect(existsSync(path.join(wt.path, "tests/added-by-agent.mjs"))).toBe(false);
    expect(r.passed).toBe(true);
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);

  it("fails when tests fail and reports failures", async () => {
    const { wt, base } = await setup();
    const r = await verify(base);
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.failures).toEqual(["t > c0"]);
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);

  it("fails on fewer tests than the baseline", async () => {
    const { wt, base } = await setup();
    writeFileSync(path.join(wt.path, "src/v.txt"), "good\n");
    const r = await verify({
      ...base,
      baseline: { tests: 5, failures: 0, errors: 0, skipped: 0, failed: [] },
    });
    expect(r).toMatchObject({ fewerTests: true, passed: false });
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);

  // Regression (found in review): verify read whatever report was on disk, so one written by
  // Gemini (or left by the red check) could stand in for a run that wrote none.
  it("deletes a stale report first and fails when the run writes none", async () => {
    const { wt, base } = await setup();
    writeFileSync(path.join(wt.path, "src/v.txt"), "good\n");
    mkdirSync(path.join(wt.path, "reports"), { recursive: true });
    writeFileSync(path.join(wt.path, "reports/junit.xml"), junit([["t", "c0", ""]]));
    const r = await verify({ ...base, testCommand: ["node", "-e", "process.exit(0)"] });
    expect(r).toMatchObject({ exitCode: 0, reportMissing: true, passed: false });
    expect(r.counts).toBeUndefined();
    expect(existsSync(path.join(wt.path, "reports/junit.xml"))).toBe(false);
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);

  // Regression (found in review): green was the suite's exit code, so a runner that ignored the
  // contract tests, or a config that stopped failures from failing the run, still passed.
  it("requires every contract case to be in the report and pass", async () => {
    const { wt, base } = await setup();
    writeFileSync(path.join(wt.path, "src/v.txt"), "good\n");
    const run = (cases: [string, string, string][]) =>
      verify({
        ...base,
        baseline: undefined,
        contractPaths: ["tests/t.mjs"],
        testCommand: writeReport(junit(cases)),
      });

    const green = await run([
      ["tests/t.mjs", "adds", ""],
      ["src/x.mjs", "other", ""],
    ]);
    expect(green).toMatchObject({ passed: true, contractCases: { collected: 1, green: true } });

    const failing = await run([["tests/t.mjs", "adds", "<failure/>"]]);
    expect(failing).toMatchObject({
      exitCode: 0,
      passed: false,
      contractCases: { collected: 1, failed: ["tests/t.mjs > adds"], green: false },
    });

    const skipped = await run([["tests/t.mjs", "adds", "<skipped/>"]]);
    expect(skipped).toMatchObject({ passed: false, contractCases: { skipped: 1, green: false } });

    const missing = await run([["src/x.mjs", "other", ""]]);
    expect(missing).toMatchObject({ passed: false, contractCases: { collected: 0, green: false } });
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);

  // Regression (found live): the user committed to main while a job ran and the job failed as "tampered".
  it("ignores the user's own commits on main during the job", async () => {
    const { repo, wt, base } = await setup();
    writeFileSync(path.join(wt.path, "src/v.txt"), "good\n");
    writeFileSync(path.join(repo, "README.md"), "user work\n");
    await git(["add", "README.md"], repo);
    await git(["commit", "-q", "-m", "user commit during job"], repo);
    const r = await verify(base);
    expect(r.tamper).toEqual([]);
    expect(r.passed).toBe(true);
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);

  it("flags audit patterns in non-protected files and detects ref tampering", async () => {
    const { repo, wt, base } = await setup();
    writeFileSync(path.join(wt.path, "src/v.txt"), "good\n");
    writeFileSync(
      path.join(wt.path, "src/hack.js"),
      "// eslint-disable-next-line\nprocess.exit(0)\n",
    );
    await commitAll(wt, "job work");
    await git(["update-ref", "refs/heads/main", "HEAD"], wt.path);
    const r = await verify(base);
    expect(r.auditFlags.sort()).toEqual(["lint-disable", "process-exit"]);
    expect(r.tamper).toEqual(["refs"]);
    expect(r.passed).toBe(false);
    void repo;
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);
});
