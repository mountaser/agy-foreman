import type { Config } from "../config.js";
import type { JobSpec } from "../pipeline/index.js";
import { isSamePath } from "./helpers.js";
import type { JobRecord, JobStore } from "./store.js";

export interface SchedulerDeps {
  store: JobStore;
  loadConfig: (repoRoot: string) => Config;
  now: () => Date;
  /** Runs one job to completion and resolves when it is over (the record is already terminal). */
  run: (record: JobRecord, spec: JobSpec, signal: AbortSignal) => Promise<void>;
  isAlive?: (pid: number) => boolean;
  /** How often queued jobs are re-checked while some wait (default 60 s). */
  retryMs?: number;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

export class JobScheduler {
  private runningJobs = new Map<string, { record: JobRecord; spec: JobSpec }>();
  private queuedJobs = new Map<string, { record: JobRecord; spec: JobSpec }>();
  private abortControllers = new Map<string, AbortController>();
  private writeQueues = new Map<string, Promise<void>>();
  private idleWaiters = new Set<() => void>();
  private scheduleLock: Promise<void> = Promise.resolve();
  private retryTimer?: NodeJS.Timeout;

  private isAlive: (pid: number) => boolean;

  constructor(private deps: SchedulerDeps) {
    this.isAlive = deps.isAlive ?? defaultIsAlive;
  }

  private async runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.scheduleLock;
    let release: () => void;
    this.scheduleLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  /** Per-job serialized store write (moves JobManager.writeRecord/writeQueues here). */
  async write(record: JobRecord): Promise<void> {
    const prev = this.writeQueues.get(record.id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        await this.deps.store.write(record);
      });
    this.writeQueues.set(record.id, next);
    return next;
  }

  /** Why the job cannot start now, or undefined when it can. */
  private async blockedReason(repoRoot: string, candidate: JobRecord): Promise<string | undefined> {
    const config = this.deps.loadConfig(repoRoot);

    // 1. Concurrency: in-memory running set per repo (isSamePath)
    let runningCount = 0;
    for (const item of this.runningJobs.values()) {
      if (isSamePath(item.record.repoRoot, repoRoot)) {
        runningCount++;
      }
    }
    if (runningCount >= config.project.maxConcurrent) {
      return `waiting for a free slot: ${runningCount} job(s) already running here (max_concurrent ${config.project.maxConcurrent})`;
    }

    // 2. Hourly cap: counts jobs of that repo whose createdAt is within the last hour
    // and that have actually started (state not "queued"); candidate is not counted.
    const now = this.deps.now();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const allJobs = await this.deps.store.list();

    const startedIds = new Set<string>();
    for (const j of allJobs) {
      if (
        isSamePath(j.repoRoot, repoRoot) &&
        j.id !== candidate.id &&
        j.createdAt >= oneHourAgo &&
        j.state !== "queued"
      ) {
        startedIds.add(j.id);
      }
    }
    for (const item of this.runningJobs.values()) {
      if (
        isSamePath(item.record.repoRoot, repoRoot) &&
        item.record.id !== candidate.id &&
        item.record.createdAt >= oneHourAgo
      ) {
        startedIds.add(item.record.id);
      }
    }

    if (startedIds.size >= config.project.maxRunsPerHour) {
      return `hourly cap reached: ${startedIds.size} jobs started in the last hour (max_runs_per_hour ${config.project.maxRunsPerHour} in .agy-foreman.json); rechecked every minute`;
    }

    return undefined;
  }

  private startJob(record: JobRecord, spec: JobSpec): void {
    this.runningJobs.set(record.id, { record, spec });
    const controller = new AbortController();
    this.abortControllers.set(record.id, controller);

    void (async () => {
      try {
        await this.deps.run(record, spec, controller.signal);
      } catch {
        // Run errors are expected to be recorded in terminal state, but catch any unexpected error.
      } finally {
        this.runningJobs.delete(record.id);
        this.abortControllers.delete(record.id);
        this.writeQueues.delete(record.id);
        await this.drain();
        this.checkIdle();
      }
    })();
  }

  private async drain(): Promise<void> {
    await this.runSerialized(async () => {
      for (const [id, queued] of this.queuedJobs.entries()) {
        const blocked = await this.blockedReason(queued.record.repoRoot, queued.record);
        if (blocked) {
          if (queued.record.queuedReason !== blocked) {
            queued.record.queuedReason = blocked;
            await this.write(queued.record);
          }
        } else {
          this.queuedJobs.delete(id);
          delete queued.record.queuedReason;
          queued.record.state = "running";
          queued.record.ownerPid = process.pid;
          queued.record.updatedAt = this.deps.now().toISOString();
          await this.write(queued.record);
          this.startJob(queued.record, queued.spec);
        }
      }
      this.scheduleRetry();
    });
  }

  /**
   * Found live: a job blocked by the hourly cap while nothing ran was never re-checked, because
   * draining only happened when a running job finished. While jobs wait, re-check periodically.
   */
  private scheduleRetry(): void {
    if (this.queuedJobs.size === 0 || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.drain();
    }, this.deps.retryMs ?? 60_000);
    this.retryTimer.unref();
  }

  /** Writes the record as "running" or "queued" and starts it when the repo has a free slot. */
  async submit(record: JobRecord, spec: JobSpec): Promise<"running" | "queued"> {
    return this.runSerialized(async () => {
      const blocked = await this.blockedReason(record.repoRoot, record);
      const state: "running" | "queued" = blocked ? "queued" : "running";
      record.state = state;
      if (blocked) record.queuedReason = blocked;
      record.ownerPid = process.pid;
      record.updatedAt = this.deps.now().toISOString();
      await this.write(record);

      if (state === "running") {
        this.startJob(record, spec);
      } else {
        this.queuedJobs.set(record.id, { record, spec });
        this.scheduleRetry();
      }

      return state;
    });
  }

  /** Running job: aborts its signal. Queued job: marks it "cancelled" and drops it. Unknown: false. */
  async cancel(jobId: string): Promise<boolean> {
    return this.runSerialized(async () => {
      const queued = this.queuedJobs.get(jobId);
      if (queued) {
        this.queuedJobs.delete(jobId);
        queued.record.state = "cancelled";
        queued.record.progress.phase = "done";
        queued.record.progress.percent = 100;
        queued.record.updatedAt = this.deps.now().toISOString();
        await this.write(queued.record);
        this.checkIdle();
        return true;
      }
      if (this.runningJobs.has(jobId)) {
        const controller = this.abortControllers.get(jobId);
        if (controller) {
          controller.abort();
        }
        return true;
      }
      return false;
    });
  }

  /** Resolves when no submitted job is queued or running. */
  async idle(): Promise<void> {
    if (this.runningJobs.size === 0 && this.queuedJobs.size === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  private checkIdle(): void {
    if (this.runningJobs.size === 0 && this.queuedJobs.size === 0) {
      for (const resolve of this.idleWaiters) {
        resolve();
      }
      this.idleWaiters.clear();
    }
  }

  /** Marks "queued"/"running" records this process does not own as "error" with errorReason
   *  "orphaned: the server restarted before the job finished". Returns their ids. Call once at startup. */
  async recoverOrphans(): Promise<string[]> {
    return this.runSerialized(async () => {
      const allJobs = await this.deps.store.list();
      const orphaned: string[] = [];
      for (const job of allJobs) {
        if (
          (job.state === "queued" || job.state === "running") &&
          !this.runningJobs.has(job.id) &&
          !this.queuedJobs.has(job.id) &&
          (job.ownerPid === undefined ||
            job.ownerPid === process.pid ||
            !this.isAlive(job.ownerPid))
        ) {
          job.state = "error";
          job.errorReason = "orphaned: the server restarted before the job finished";
          job.progress.phase = "done";
          job.progress.percent = 100;
          job.updatedAt = this.deps.now().toISOString();
          await this.write(job);
          orphaned.push(job.id);
        }
      }
      return orphaned;
    });
  }
}
