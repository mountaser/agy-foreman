import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KeyedQueue, readFileWithRetry, renameWithRetry } from "./fsutil.js";
import type { Envelope, JobState } from "../pipeline/index.js";
import type { Incident } from "./incidents.js";
import type { Activity } from "../snapshot/types.js";

export type JobPhase =
  | "queued"
  | "awaiting_approval"
  | "prepare"
  | "contract"
  | "brief"
  | "run"
  | "verify"
  | "report"
  | "done";

export type RecordState = JobState | "queued" | "running";

export interface Estimate {
  directTokens: number;
  delegateOverheadTokens: number;
  reason: string;
}

export interface Progress {
  percent: number;
  phase: JobPhase;
  checklistDone: number;
  checklistTotal: number;
  currentStep?: string;
  currentFile?: string;
  toolSteps: number;
  tokens: number;
  elapsedSec: number;
  etaSec?: number;
  activity?: Activity;
}

export interface JobRecord {
  id: string;
  kind: "implement" | "explore";
  repoRoot: string;
  title: string;
  state: RecordState;
  progress: Progress;
  createdAt: string;
  updatedAt: string;
  plan?: { file: string; step: number; delegateSteps?: number[] };
  estimate?: Estimate;
  parentJobId?: string;
  /** 1 for a first try; counts follow-ups and restarts of a failed or timed-out plan step. */
  attempt?: number;
  envelope?: Envelope;
  returnedChars: number;
  incident?: Incident;
  errorReason?: string;
  ownerPid?: number;
}

export function isTerminal(state: RecordState): boolean {
  return state !== "queued" && state !== "running";
}

export function newJobId(now: Date, rand?: () => string): string {
  const ts = now.getTime().toString(36);
  const suffix = rand ? rand() : randomBytes(2).toString("hex");
  return `t-${ts}-${suffix}`;
}

export function emptyProgress(): Progress {
  return {
    percent: 0,
    phase: "queued",
    checklistDone: 0,
    checklistTotal: 0,
    toolSteps: 0,
    tokens: 0,
    elapsedSec: 0,
  };
}

export class JobStore {
  constructor(
    readonly dir: string,
    private readonly onWrite?: (rec: JobRecord) => void,
  ) {}

  private queue = new KeyedQueue();

  /** Atomic, serialized per job, and retried on Windows' transient rename locks. */
  async write(rec: JobRecord): Promise<void> {
    const snapshot = JSON.stringify(rec, null, 2);
    await this.queue.run(rec.id, async () => {
      await mkdir(this.dir, { recursive: true });
      const finalPath = path.join(this.dir, `${rec.id}.json`);
      const tmpPath = `${finalPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmpPath, snapshot, "utf8");
      await renameWithRetry(tmpPath, finalPath);
    });
    try {
      this.onWrite?.(rec);
    } catch {
      // observers must never break a write
    }
  }

  async read(id: string): Promise<JobRecord | undefined> {
    const filePath = path.join(this.dir, `${id}.json`);
    try {
      const data = await readFileWithRetry(filePath);
      return JSON.parse(data) as JobRecord;
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }

  async list(): Promise<JobRecord[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
    const jsonFiles = files.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
    const records: JobRecord[] = [];
    for (const f of jsonFiles) {
      try {
        const data = await readFile(path.join(this.dir, f), "utf8");
        records.push(JSON.parse(data) as JobRecord);
      } catch {
        // ignore unreadable/corrupt files
      }
    }
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return records;
  }
}
