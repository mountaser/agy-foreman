import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git, type ExecResult } from "./exec.js";
import { contractCases, parseJUnit, type TestCounts } from "./junit.js";
import { runSuite } from "./suite.js";
import type { Worktree } from "./worktree.js";

export interface ContractTest {
  path: string;
  content: string;
}

export async function addContractTests(wt: Worktree, tests: ContractTest[]): Promise<string> {
  for (const t of tests) {
    if (path.isAbsolute(t.path)) {
      throw new Error("contract test path escapes worktree");
    }
    const fullPath = path.resolve(wt.path, t.path);
    const root = path.resolve(wt.path);
    const rel = path.relative(root, fullPath);
    if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
      throw new Error("contract test path escapes worktree");
    }
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, t.content, "utf8");
  }

  await git(["add", "-A"], wt.path);
  await git(["commit", "-m", "agy: contract tests"], wt.path);
  const newSha = await git(["rev-parse", "HEAD"], wt.path);
  wt.baseSha = newSha;
  return newSha;
}

export const NEEDS_REPORT =
  "contract tests need test_report: set it in .agy-foreman.json to the JUnit file test_command writes (vitest --reporter=junit --outputFile.junit=…, pytest --junitxml=…, jest with jest-junit), so the server can check each contract test";

export interface RedCheck {
  /** Some contract test case ran and failed on the base. */
  red: boolean;
  /** Why the check is not red. */
  reason?: string;
  /** The base run; absent when there was nothing to check it with (no test_report). */
  result?: ExecResult;
  /** The base run's counts, the baseline for verify. */
  counts?: TestCounts;
}

/**
 * Runs the suite on the base (contract tests committed) and reads the contract tests' own cases
 * from the report. The suite's exit code alone can't tell: an unrelated failing test made it red
 * even when the contract tests passed, and a contract file the runner never collected looked red.
 */
export async function redCheck(
  wt: Worktree,
  o: { testCommand: string[]; testReport?: string; contractPaths: string[]; timeoutMs: number },
): Promise<RedCheck> {
  if (!o.testReport) return { red: false, reason: NEEDS_REPORT };
  const { result, report } = await runSuite(wt.path, o.testCommand, o.testReport, o.timeoutMs);
  if (report === undefined) {
    return { red: false, reason: `the test command wrote no report at ${o.testReport}`, result };
  }
  const counts = parseJUnit(report);
  const cc = contractCases(report, o.contractPaths);
  if (cc.collected === 0) {
    return {
      red: false,
      reason: `the test report has no cases from the contract tests (${o.contractPaths.join(", ")}): check that test_command collects them and that the report names each test's file`,
      result,
      counts,
    };
  }
  if (cc.failed.length === 0) {
    const skipped = cc.skipped > 0 ? `, ${cc.skipped} skipped` : "";
    return {
      red: false,
      reason: `contract tests already pass on base (${cc.collected} cases${skipped})`,
      result,
      counts,
    };
  }
  return { red: true, result, counts };
}
