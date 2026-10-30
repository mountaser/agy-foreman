import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "../jobs/fsutil.js";
import type { JobRecord } from "../jobs/store.js";
import type { QuotaSnapshot } from "../usage-quota.js";
import { buildSnapshot } from "./build.js";
import type { DiffStat } from "./types.js";

export interface SnapshotWriterDeps {
  file: string;
  listJobs: () => Promise<JobRecord[]>;
  readQuota: () => QuotaSnapshot | undefined;
  liveDiff: (job: JobRecord) => Promise<DiffStat | undefined>;
  planSteps: (planFile: string, repoRoot: string) => number | undefined;
  now: () => Date;
  pid: number;
  heartbeatMs?: number;
  debounceMs?: number;
  write?: (file: string, text: string) => Promise<void>;
}

const DIFF_TTL_MS = 5000;

async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, "utf8");
  await renameWithRetry(tmp, file);
}

/**
 * Keeps `status.json` current while jobs run. It holds the job records in memory, so a job file
 * that cannot be read for a moment never drops a job, and it never waits for git. Failures are
 * ignored: it must never stop a job.
 */
export class SnapshotWriter {
  private heartbeat?: NodeJS.Timeout;
  private pending?: NodeJS.Timeout;
  private lastActive = false;
  private writing = false;
  private seeded = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly records = new Map<string, JobRecord>();
  private readonly diffs = new Map<string, { at: number; busy: boolean; value?: DiffStat }>();

  constructor(private readonly d: SnapshotWriterDeps) {}

  /** Starts the once-a-second rewrite that keeps `updatedAt` fresh while a job is active. */
  start(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      if (this.lastActive && !this.writing) void this.writeNow();
    }, this.d.heartbeatMs ?? 1000);
    this.heartbeat.unref();
  }

  /** Remembers a record and asks for a write soon. Several calls inside the window give one write. */
  notify(rec?: JobRecord): void {
    if (rec) this.records.set(rec.id, rec);
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void this.writeNow();
    }, this.d.debounceMs ?? 200);
    this.pending.unref();
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.pending) clearTimeout(this.pending);
    this.heartbeat = undefined;
    this.pending = undefined;
  }

  writeNow(): Promise<void> {
    this.chain = this.chain.then(() => this.doWrite()).catch(() => {});
    return this.chain;
  }

  /** Starts a background measurement for each running job whose last one is old enough. */
  private refreshDiffs(jobs: JobRecord[], nowMs: number): void {
    for (const j of jobs) {
      if (j.state !== "running") {
        this.diffs.delete(j.id);
        continue;
      }
      const c = this.diffs.get(j.id);
      if (c && (c.busy || nowMs - c.at < DIFF_TTL_MS)) continue;
      this.diffs.set(j.id, { at: nowMs, busy: true, value: c?.value });
      void this.d
        .liveDiff(j)
        .catch(() => undefined)
        .then((value) => {
          const cur = this.diffs.get(j.id);
          if (cur) {
            this.diffs.set(j.id, {
              at: this.d.now().getTime(),
              busy: false,
              value: value ?? cur.value,
            });
          }
        });
    }
  }

  private async doWrite(): Promise<void> {
    this.writing = true;
    try {
      if (!this.seeded) {
        for (const r of await this.d.listJobs()) {
          if (!this.records.has(r.id)) this.records.set(r.id, r);
        }
        this.seeded = true;
      }
      const now = this.d.now();
      const jobs = [...this.records.values()];
      this.refreshDiffs(jobs, now.getTime());
      const live = new Map<string, DiffStat>();
      for (const [id, c] of this.diffs) if (c.value) live.set(id, c.value);
      const snap = buildSnapshot({
        jobs,
        now,
        pid: this.d.pid,
        quota: this.d.readQuota(),
        planSteps: this.d.planSteps,
        liveDiff: live,
      });
      this.lastActive = snap.active;
      await (this.d.write ?? atomicWrite)(this.d.file, JSON.stringify(snap, null, 2) + "\n");
    } finally {
      this.writing = false;
    }
  }
}
