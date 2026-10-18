// Execution pipeline for implement jobs (contract tests, worktree, gate, verification).
import { renderBrief, RUN_PROMPT } from "./brief.js";
import { addContractTests, NEEDS_REPORT, redCheck } from "./contract.js";
import { git, runCommand } from "./exec.js";
import { parseJUnit, type TestCounts } from "./junit.js";
import { runSuite } from "./suite.js";
import { verify, type VerifyReport } from "./verify.js";
import {
  commitAll,
  diffStat,
  mergeCheck,
  removeWorktree,
  snapshotGitState,
  type GitSnapshot,
} from "./worktree.js";
import type { Envelope, JobSpec, JobState, PipelineDeps } from "./index.js";
import {
  buildEnvelope,
  getDeniedCommands,
  makeUntrustedReport,
  mapFailureOutcome,
} from "./envelope-build.js";
import { gatedRun } from "./gated-run.js";

export async function runImplementJob(
  spec: JobSpec,
  deps: PipelineDeps,
  startTime: Date,
): Promise<Envelope> {
  // 1. prepare
  deps.onPhase?.("prepare");
  const contractPaths = (spec.contractTests ?? []).map((t) => t.path.replace(/\\/g, "/"));
  const unverifiable =
    !spec.config.testCommand || spec.config.testCommand.length === 0
      ? "config.test_command is required for implement jobs"
      : contractPaths.length > 0 && !spec.config.testReport
        ? NEEDS_REPORT
        : undefined;
  // `!spec.config.testCommand` repeats the first check so TS narrows testCommand below.
  if (unverifiable || !spec.config.testCommand) {
    let baseSha = "";
    try {
      baseSha = await git(["rev-parse", `${spec.baseRef ?? "HEAD"}^{commit}`], spec.repoRoot);
    } catch {
      baseSha = "";
    }
    return buildEnvelope(spec, deps, startTime, {
      state: "refused",
      reason: unverifiable,
      baseSha,
    });
  }

  const allowedCommands: string[] = [];
  if (spec.config.testCommand) {
    allowedCommands.push(spec.config.testCommand.join(" "));
  }
  if (spec.config.setupCommand) {
    allowedCommands.push(spec.config.setupCommand.join(" "));
  }
  for (const c of spec.config.allowedCommands) {
    allowedCommands.push(c);
  }

  // Narrowed once here: closures below (beforeRun) don't keep the guard's narrowing.
  const testCommand: string[] = spec.config.testCommand;
  // Assigned inside beforeRun; the casts stop TS from narrowing them to `undefined` here.
  let contractInfo = undefined as { redOnBase: boolean; greenAfter: boolean } | undefined;
  let baseline = undefined as TestCounts | undefined;
  let snapshot = undefined as GitSnapshot | undefined;
  let startSha: string = "";

  const runResult = await gatedRun(spec, deps, startTime, {
    agyMode: "accept-edits",
    prompt: RUN_PROMPT,
    extraPolicySettings: {
      protectedGlobs: contractPaths,
      allowedCommands,
    },
    briefText: (skills) =>
      renderBrief({
        kind: "implement",
        task: spec.task,
        date: deps.now().toISOString().slice(0, 10),
        touch: spec.touch,
        leaveUntouched: spec.leaveUntouched,
        testCommand: spec.config.testCommand,
        skills: skills.map((s) => ({ name: s.name, description: s.description })),
        lessons: spec.lessons,
        checklist: spec.checklist,
      }),
    getContractInfo: () => contractInfo,
    beforeRun: async (wt) => {
      snapshot = await snapshotGitState(spec.repoRoot, wt.branch ?? undefined);
      startSha = wt.baseSha;

      // A fresh worktree has no dependencies (node_modules, venv…): install them before any test run.
      if (spec.config.setupCommand) {
        const setup = await runCommand(spec.config.setupCommand, {
          cwd: wt.path,
          timeoutMs: 15 * 60_000,
        });
        if (setup.code !== 0 || setup.timedOut) {
          const tail = (setup.stdout + setup.stderr).slice(-1500).trim();
          return buildEnvelope(spec, deps, startTime, {
            state: "error",
            reason: `setup_command failed (${setup.timedOut ? "timed out" : `exit ${setup.code}`}): ${tail}`,
            branch: wt.branch,
            worktreePath: wt.path,
            baseSha: wt.baseSha,
          });
        }
      }

      // 2. contract
      deps.onPhase?.("contract");
      if (spec.contractTests && spec.contractTests.length > 0) {
        await addContractTests(wt, spec.contractTests);
        const rc = await redCheck(wt, {
          testCommand,
          testReport: spec.config.testReport,
          contractPaths,
          timeoutMs: spec.timeoutSec * 1000,
        });
        if (!rc.red) {
          return buildEnvelope(spec, deps, startTime, {
            state: "refused",
            reason: rc.reason,
            branch: wt.branch,
            worktreePath: wt.path,
            baseSha: wt.baseSha,
            contract: { redOnBase: false, greenAfter: false },
          });
        }
        contractInfo = { redOnBase: true, greenAfter: false };
        // The red run is the baseline: same commit, contract tests included.
        baseline = rc.counts;
      } else if (spec.config.testReport) {
        const { report } = await runSuite(
          wt.path,
          testCommand,
          spec.config.testReport,
          spec.timeoutSec * 1000,
        );
        if (report !== undefined) baseline = parseJUnit(report);
      }
    },
  });

  if ("state" in runResult) {
    return runResult;
  }

  const { outcome, worktree: wt, guardEvents, skillsUsed, nonce } = runResult;

  try {
    let jobState: JobState;
    let jobReason: string | undefined;
    let quotaData: { resetInSec?: number; resetText?: string } | undefined;
    let verifyReport: VerifyReport | undefined;

    const failure = mapFailureOutcome(outcome, guardEvents);
    if (failure) {
      jobState = failure.jobState;
      jobReason = failure.jobReason;
      quotaData = failure.quotaData;
    } else {
      // 5. verify (on success only)
      deps.onPhase?.("verify");
      // beforeRun always takes the snapshot before agy runs.
      if (!snapshot) throw new Error("internal: git snapshot missing before verify");
      verifyReport = await verify({
        wt,
        protectedGlobs: [...spec.config.protectedPaths, ...contractPaths],
        testCommand,
        testReport: spec.config.testReport,
        baseline,
        snapshot,
        ignoreBranch: wt.branch ?? undefined,
        timeoutMs: spec.timeoutSec * 1000,
        startSha,
        contractPaths,
      });
      if (contractInfo) {
        contractInfo.greenAfter = verifyReport.contractCases?.green ?? verifyReport.passed;
      }
      jobState = verifyReport.passed ? "passed" : "failed";
    }

    // 6. report
    deps.onPhase?.("report");
    const taskFirstLine = spec.task.trim().split(/\r?\n/)[0] ?? "";
    let headSha: string | undefined = undefined;
    try {
      const commitSha = await commitAll(wt, "agy: " + taskFirstLine);
      headSha = commitSha ?? (await git(["rev-parse", "HEAD"], wt.path));
    } catch {
      try {
        headSha = await git(["rev-parse", "HEAD"], wt.path);
      } catch {
        headSha = undefined;
      }
    }

    let stat: string | undefined = undefined;
    try {
      stat = await diffStat(wt);
    } catch {
      stat = undefined;
    }
    // Found live: a followup (no contract tests) re-read a stale brief, changed nothing, and the
    // unchanged suite "passed". An implement job that changes no file has not done its task.
    if (jobState === "passed" && !stat?.trim()) {
      jobState = "failed";
      jobReason = "no changes: the run finished without changing any file";
    }

    let mergeResult: { clean: boolean; conflictingFiles: string[] } | undefined = undefined;
    if (wt.branch) {
      try {
        const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], spec.repoRoot);
        mergeResult = await mergeCheck(spec.repoRoot, currentBranch, wt.branch);
      } catch {
        mergeResult = undefined;
      }
    }

    const deniedCommands = getDeniedCommands(wt.path);
    const untrustedReport = makeUntrustedReport(outcome, nonce);

    return buildEnvelope(spec, deps, startTime, {
      state: jobState,
      reason: jobReason,
      branch: wt.branch,
      worktreePath: wt.path,
      baseSha: wt.baseSha,
      headSha,
      mergeCheck: mergeResult,
      contract: contractInfo,
      verify: verifyReport,
      diffStat: stat,
      untrustedReport,
      deniedCommands,
      guardEvents,
      skillsUsed,
      quota: quotaData,
      outcome,
      nonce,
    });
  } catch (err: unknown) {
    try {
      await removeWorktree(wt);
    } catch {
      // ignore
    }
    throw err;
  }
}
