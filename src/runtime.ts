import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./agy/index.js";
import { loadConfig, loadRuntimeConfig } from "./config.js";
import { RepoApprover, type Approver } from "./jobs/approver.js";
import { FlagStore } from "./jobs/flags.js";
import { Ledger } from "./jobs/ledger.js";
import { LessonStore } from "./jobs/lessons.js";
import { JobManager, type JobManagerDeps } from "./jobs/manager.js";
import { countPlanSteps } from "./jobs/plan.js";
import { JobStore } from "./jobs/store.js";
import { jobsDir, stateDir, statusFile, worktreeRoot } from "./paths.js";
import { runJob } from "./pipeline/index.js";
import { repoHash } from "./pipeline/worktree.js";
import { diffStat } from "./snapshot/diff.js";
import { SnapshotWriter } from "./snapshot/writer.js";
import { quotaFile, readQuotaCache } from "./usage-quota.js";

export function hookBundlePath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "foreman-hook.js");
}

export function createRuntime(o: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  approverFor: (gate: "elicitation" | "client") => Approver;
}): { manager: JobManager; store: JobStore; snapshot: SnapshotWriter } {
  let snapshot: SnapshotWriter | undefined;
  const store = new JobStore(jobsDir({ env: o.env }), (rec) => snapshot?.notify(rec));
  snapshot = new SnapshotWriter({
    file: statusFile({ env: o.env }),
    listJobs: () => store.list(),
    readQuota: () => readQuotaCache(quotaFile(o.env)),
    liveDiff: (job) =>
      diffStat(path.join(worktreeRoot({ env: o.env }), repoHash(job.repoRoot), job.id)),
    planSteps: (planFile, repoRoot) => {
      try {
        return countPlanSteps(readFileSync(path.resolve(repoRoot, planFile), "utf8")) || undefined;
      } catch {
        return undefined;
      }
    },
    now: () => new Date(),
    pid: process.pid,
  });
  snapshot.start();
  const sDir = stateDir({ env: o.env });
  const ledger = new Ledger(path.join(sDir, "ledger.jsonl"));
  const flags = new FlagStore(path.join(sDir, "flags.json"));

  const elicitation = o.approverFor("elicitation");
  const client = o.approverFor("client");
  const approver = new RepoApprover({
    gateFor: (r) => loadConfig({ repoRoot: r, env: o.env }).project.gate,
    elicitation,
    client,
    defaultRepoRoot: o.cwd,
  });

  const runtimeCfg = loadRuntimeConfig(o.env);

  const deps: JobManagerDeps = {
    store,
    ledger,
    flags,
    approver,
    runJob,
    pipelineDeps: {
      agyRun: run,
      agyCommand: {
        command: runtimeCfg.agyPath,
      },
      hookBundlePath: hookBundlePath(),
      worktreeRoot: worktreeRoot({ env: o.env }),
      home: os.homedir(),
      now: () => new Date(),
    },
    loadConfig: (repoRoot: string) => loadConfig({ repoRoot, env: o.env }),
    now: () => new Date(),
    lessons: (repoRoot: string) => ({
      project: new LessonStore(path.join(repoRoot, ".agy-foreman", "lessons.json")),
      global: new LessonStore(path.join(sDir, "lessons.json")),
    }),
    skillDir: (repoRoot: string) => {
      const candidates = [
        path.join(repoRoot, ".claude", "skills", "gemini-delegation"),
        path.join(os.homedir(), ".claude", "skills", "gemini-delegation"),
      ];
      for (const cand of candidates) {
        if (existsSync(cand)) return cand;
      }
      return undefined;
    },
  };

  const manager = new JobManager(deps);
  return { manager, store, snapshot };
}
