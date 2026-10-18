import type { Config, Effort } from "../config.js";
import { git } from "../pipeline/exec.js";
import type { Envelope, JobSpec, PipelineDeps } from "../pipeline/index.js";
import type { Approver } from "./approver.js";
import type { FlagStore } from "./flags.js";
import { compactRecord, firstOpenItem, isSamePath } from "./helpers.js";
import { Ledger } from "./ledger.js";
import { selectLessons, type Audience, type LessonStore } from "./lessons.js";
import { renderProgressLine } from "./progress.js";
import { type Estimate, type JobRecord, type JobStore } from "./store.js";
import { watchJob } from "./watch.js";
import { prepareStartJob } from "./start.js";
import { executeJob } from "./execute.js";
import { handleAct, startFollowup, type ActionsContext } from "./actions.js";
import { DelegationPolicy, PlanGrants } from "./policy.js";
import { JobScheduler } from "./scheduler.js";
import type { ContractTest } from "../pipeline/contract.js";

export { compactRecord, firstOpenItem };

export interface StartInput {
  repoRoot: string;
  kind: "implement" | "explore";
  task?: string;
  plan?: { file: string; step: number; delegateSteps?: number[] };
  contractTests?: ContractTest[];
  skills?: string[];
  estimate?: Estimate;
  effort?: Effort;
  dryRun?: boolean;
  baseRef?: string;
  timeoutSec?: number;
}

export type StartResult =
  | { state: "queued" | "running"; jobId: string; waitHint: string; lessonsInjected?: number }
  | { state: "refused" | "denied"; reason: string }
  | {
      state: "quota";
      reason: string;
      quota: { resetText?: string; resetAt?: string };
      options: ("retry" | "continue_without" | "wait")[];
    }
  | {
      state: "dry_run";
      brief: string;
      command: string[];
      skills: { name: string; claudeOnlyRefs: string[] }[];
      contractTests: string[];
      redOnBase?: boolean;
      /** Why the contract tests are not red on the base. */
      redReason?: string;
    };

export interface GetOptions {
  waitSec?: number;
  diffMode?: "stat" | "full" | "paths";
  paths?: string[];
  maxDiffTokens?: number;
}

export type ActInput =
  | { action: "followup"; jobId: string; feedback: string }
  | { action: "finalize"; jobId: string; mode: "squash" | "merge" | "discard" | "keep" }
  | { action: "cancel"; jobId: string }
  | { action: "quota_choice"; choice: "retry" | "continue_without" | "wait" }
  | { action: "resume_delegation" }
  | { action: "revoke_plan"; planFile: string }
  | {
      action: "lesson";
      text: string;
      audience: Audience;
      scope: "project" | "global";
      tags?: string[];
      jobId?: string;
    };

export interface JobManagerDeps {
  store: JobStore;
  ledger: Ledger;
  flags: FlagStore;
  approver: Approver;
  runJob: (spec: JobSpec, deps: PipelineDeps) => Promise<Envelope>;
  pipelineDeps: Omit<PipelineDeps, "onEvent" | "onPhase" | "signal">;
  loadConfig: (repoRoot: string) => Config;
  now: () => Date;
  lessons?: (repoRoot: string) => { project: LessonStore; global: LessonStore };
  skillDir?: (repoRoot: string) => string | undefined;
}

export class JobManager {
  private scheduler: JobScheduler;
  private policy: DelegationPolicy;
  private grants: PlanGrants;

  constructor(private deps: JobManagerDeps) {
    this.policy = new DelegationPolicy(deps.flags, deps.approver, deps.now);
    this.grants = new PlanGrants(deps.flags, deps.now);
    this.scheduler = new JobScheduler({
      store: deps.store,
      loadConfig: deps.loadConfig,
      now: deps.now,
      run: (record, spec, signal) =>
        executeJob(
          {
            deps: this.deps,
            policy: this.policy,
            write: (r) => this.scheduler.write(r),
            startFollowup: (parent, feedback, bypassApproval) =>
              startFollowup(this.getActionsContext(), parent, feedback, bypassApproval),
          },
          record,
          spec,
          signal,
        ),
    });
  }

  private getActionsContext(): ActionsContext {
    return {
      deps: this.deps,
      scheduler: this.scheduler,
      policy: this.policy,
      grants: this.grants,
    };
  }

  async start(i: StartInput): Promise<StartResult> {
    const prep = await prepareStartJob(this.deps, i, {
      policy: this.policy,
      grants: this.grants,
    });
    if (prep.type === "result") {
      return prep.result;
    }
    const { record, spec, lessonsInjected } = prep;
    const state = await this.scheduler.submit(record, spec);

    return {
      state,
      jobId: record.id,
      waitHint: `agy-foreman wait ${record.id}`,
      lessonsInjected,
    };
  }

  async idle(): Promise<void> {
    return this.scheduler.idle();
  }

  async recoverOrphans(): Promise<string[]> {
    return this.scheduler.recoverOrphans();
  }

  async peek(jobId: string): Promise<JobRecord | undefined> {
    const rec = await this.deps.store.read(jobId);
    if (!rec) return undefined;
    return compactRecord(rec);
  }

  async get(jobId: string, o?: GetOptions): Promise<(JobRecord & { diff?: string }) | undefined> {
    const rec =
      o?.waitSec && o.waitSec > 0
        ? await watchJob(this.deps.store, jobId, { timeoutMs: o.waitSec * 1000 })
        : await this.deps.store.read(jobId);
    if (!rec) return undefined;

    let diff: string | undefined;
    if (o?.diffMode === "stat") {
      diff = rec.envelope?.diffStat;
    } else if (o?.diffMode === "full" || o?.diffMode === "paths") {
      if (rec.envelope?.baseSha && rec.envelope?.headSha && rec.envelope.worktreePath) {
        try {
          const diffArgs = ["diff", `${rec.envelope.baseSha}..${rec.envelope.headSha}`];
          if (o.diffMode === "paths" && o.paths && o.paths.length > 0) {
            diffArgs.push("--", ...o.paths);
          }
          let fullDiff = await git(diffArgs, rec.envelope.worktreePath);
          const maxTokens = o.maxDiffTokens ?? 2000;
          const maxChars = maxTokens * 4;
          if (fullDiff.length > maxChars) {
            fullDiff = fullDiff.slice(0, maxChars) + "\n[truncated]";
          }
          diff = fullDiff;
        } catch {
          diff = undefined;
        }
      }
    }

    const result: JobRecord & { diff?: string } = {
      ...compactRecord(rec),
      // diffStat already sits in the envelope; only full/paths diffs are added.
      ...(diff !== undefined && o?.diffMode !== "stat" ? { diff } : {}),
    };
    const jsonChars = JSON.stringify(result).length;
    rec.returnedChars = (rec.returnedChars ?? 0) + jsonChars;
    result.returnedChars = rec.returnedChars;
    await this.scheduler.write(rec);

    return result;
  }

  async act(i: ActInput): Promise<Record<string, unknown>> {
    return await handleAct(this.getActionsContext(), i);
  }

  async status(repoRoot?: string): Promise<Record<string, unknown>> {
    const { delegation, cooldown } = await this.policy.state();

    const allJobs = await this.deps.store.list();
    const filteredJobs = repoRoot
      ? allJobs.filter((j) => isSamePath(j.repoRoot, repoRoot))
      : allJobs;

    const running = filteredJobs
      .filter((j) => j.state === "running")
      .map((j) => ({ id: j.id, line: renderProgressLine(j) }));
    const queued = filteredJobs.filter((j) => j.state === "queued").map((j) => j.id);

    const nowDate = this.deps.now();
    const startOfToday = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate(),
      0,
      0,
      0,
      0,
    );
    const today = await this.deps.ledger.stats(startOfToday);
    const calibration = await this.deps.ledger.calibration();

    let lessons: string[] = [];
    if (this.deps.lessons) {
      const rRoot = repoRoot ?? filteredJobs[0]?.repoRoot ?? process.cwd();
      const stores = this.deps.lessons(rRoot);
      lessons = await selectLessons(stores, "orchestrator", [], 5);
    }

    return {
      delegation,
      ...(cooldown ? { cooldown } : {}),
      running,
      queued,
      today,
      calibration,
      lessons,
    };
  }
}
