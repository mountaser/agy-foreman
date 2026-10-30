import type { JobPhase } from "../jobs/store.js";
import type { QuotaSnapshot } from "../usage-quota.js";

export type ActivityKind = "reading" | "editing" | "testing" | "git" | "command" | "thinking";

export interface Activity {
  kind: ActivityKind;
  /** Base name of the file or folder, when the tool names one. Never a command line. */
  target?: string;
  /** ISO time the activity started. */
  at: string;
}

export interface DiffStat {
  files: number;
  added: number;
  deleted: number;
}

export type StepState = "passed" | "running" | "queued" | "failed" | "pending";

export interface SnapshotJob {
  id: string;
  step: number | null;
  title: string;
  state: "queued" | "running";
  phase: JobPhase;
  activity?: Activity;
}

export interface Snapshot {
  version: 1;
  updatedAt: string;
  pid: number;
  active: boolean;
  plan?: {
    file: string | null;
    steps: StepState[];
    done: number;
    failed: number;
    elapsedSec: number;
    diff?: DiffStat;
  };
  jobs: SnapshotJob[];
  quota?: QuotaSnapshot;
}
