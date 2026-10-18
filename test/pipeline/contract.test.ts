import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { addContractTests, NEEDS_REPORT, redCheck } from "../../src/pipeline/contract.js";
import { createWorktree, removeWorktree } from "../../src/pipeline/worktree.js";
import { git } from "../../src/pipeline/exec.js";
import { makeRepo, tmpRoot } from "./repo.js";

// A tiny test runner: imports every tests/*.mjs and writes one JUnit case per file.
const RUNNER = `import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
let cases = "", failed = 0;
for (const f of readdirSync("tests").filter((f) => f.endsWith(".mjs"))) {
  try { await import("./tests/" + f); cases += '<testcase classname="tests/' + f + '" name="runs"/>'; }
  catch (e) { failed++; cases += '<testcase classname="tests/' + f + '" name="runs"><failure>' + e.message + '</failure></testcase>'; }
}
mkdirSync("reports", { recursive: true });
writeFileSync("reports/junit.xml", "<testsuite>" + cases + "</testsuite>");
process.exit(failed ? 1 : 0);
`;
const ADD_CONTRACT = {
  path: "tests/add.test.mjs",
  content:
    'import { add } from "../src/add.mjs";\nif (add(2, 3) !== 5) throw new Error("add broken");\n',
};
const check = (
  wt: Parameters<typeof redCheck>[0],
  o: Partial<Parameters<typeof redCheck>[1]> = {},
) =>
  redCheck(wt, {
    testCommand: ["node", "run.mjs"],
    testReport: "reports/junit.xml",
    contractPaths: [ADD_CONTRACT.path],
    timeoutMs: 30_000,
    ...o,
  });

async function setup(files: Record<string, string>, jobId: string) {
  const repo = makeRepo({ "run.mjs": RUNNER, "tests/.keep": "", ...files });
  const wt = await createWorktree({ repoRoot: repo, jobId, root: tmpRoot() });
  return wt;
}

describe("contract tests", () => {
  it("commits them as the new base and passes the red check when they fail", async () => {
    const wt = await setup({ "src/add.mjs": "export const add = () => 0;\n" }, "c-1");
    const oldBase = wt.baseSha;
    const sha = await addContractTests(wt, [ADD_CONTRACT]);
    expect(sha).not.toBe(oldBase);
    expect(wt.baseSha).toBe(sha);
    expect(existsSync(path.join(wt.path, "tests/add.test.mjs"))).toBe(true);
    expect(await git(["log", "-1", "--format=%s"], wt.path)).toBe("agy: contract tests");
    const r = await check(wt);
    expect(r).toMatchObject({ red: true, counts: { tests: 1, failures: 1 } });
    expect(r.reason).toBeUndefined();
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);

  it("is not red when the contract already passes", async () => {
    const wt = await setup({ "src/add.mjs": "export const add = (a, b) => a + b;\n" }, "c-2");
    await addContractTests(wt, [ADD_CONTRACT]);
    const r = await check(wt);
    expect(r.red).toBe(false);
    expect(r.reason).toMatch(/already pass on base \(1 cases\)/);
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);

  // Regression (found in review): red was the suite's exit code, so any failing test on the base
  // counted as the contract failing.
  it("is not red when only an unrelated test fails", async () => {
    const wt = await setup(
      {
        "src/add.mjs": "export const add = (a, b) => a + b;\n",
        "tests/old.mjs": 'throw new Error("already broken");\n',
      },
      "c-4",
    );
    await addContractTests(wt, [ADD_CONTRACT]);
    const r = await check(wt);
    expect(r.result?.code).toBe(1);
    expect(r).toMatchObject({ red: false, reason: expect.stringMatching(/already pass/) });
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);

  it("is not red when the report has no case from the contract tests", async () => {
    const wt = await setup(
      {
        "src/add.mjs": "export const add = () => 0;\n",
        "tests/old.mjs": 'throw new Error("already broken");\n',
      },
      "c-5",
    );
    // A contract test the runner never collects (it only imports .mjs files).
    await addContractTests(wt, [{ path: "tests/add.test.js", content: ADD_CONTRACT.content }]);
    const r = await check(wt, { contractPaths: ["tests/add.test.js"] });
    expect(r).toMatchObject({
      red: false,
      reason: expect.stringMatching(/no cases from the contract tests/),
    });
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);

  it("needs a report, and never reads one an earlier run left behind", async () => {
    const wt = await setup({ "src/add.mjs": "export const add = () => 0;\n" }, "c-6");
    await addContractTests(wt, [ADD_CONTRACT]);
    expect(await check(wt, { testReport: undefined })).toEqual({
      red: false,
      reason: NEEDS_REPORT,
    });
    mkdirSync(path.join(wt.path, "reports"));
    writeFileSync(
      path.join(wt.path, "reports/junit.xml"),
      '<testsuite><testcase classname="tests/add.test.mjs" name="runs"><failure/></testcase></testsuite>',
    );
    const r = await check(wt, { testCommand: ["node", "-e", "process.exit(1)"] });
    expect(r).toMatchObject({ red: false, reason: expect.stringMatching(/wrote no report/) });
    expect(existsSync(path.join(wt.path, "reports/junit.xml"))).toBe(false);
    await removeWorktree(wt, { deleteBranch: true });
  }, 30_000);

  it("rejects paths that escape the worktree", async () => {
    const repo = makeRepo({ a: "a" });
    const wt = await createWorktree({ repoRoot: repo, jobId: "c-3", root: tmpRoot() });
    await expect(addContractTests(wt, [{ path: "../evil.mjs", content: "" }])).rejects.toThrow(
      /escapes worktree/,
    );
    await removeWorktree(wt, { deleteBranch: true });
  }, 20_000);
});
