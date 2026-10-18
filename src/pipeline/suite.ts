import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { runCommand, type ExecResult } from "./exec.js";

export interface SuiteRun {
  result: ExecResult;
  /** The report this run wrote; undefined when none is configured or the run wrote none. */
  report?: string;
}

/**
 * Runs the test command in the worktree. The report is deleted first, so one left by an earlier
 * run, or written by Gemini, is never read as this run's.
 */
export async function runSuite(
  cwd: string,
  testCommand: string[],
  testReport: string | undefined,
  timeoutMs: number,
): Promise<SuiteRun> {
  const reportPath = testReport ? path.resolve(cwd, testReport) : undefined;
  if (reportPath) rmSync(reportPath, { force: true });
  const result = await runCommand(testCommand, { cwd, timeoutMs });
  if (!reportPath || !existsSync(reportPath)) return { result };
  return { result, report: readFileSync(reportPath, "utf8") };
}
