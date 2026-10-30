import type { run } from "../agy/index.js";
import type { AgyUsage, StreamEvent } from "../agy/types.js";
import type { Effort, ProjectConfig, RuntimeConfig } from "../config.js";
import type { ContractTest } from "./contract.js";
import type { VerifyReport } from "./verify.js";
import { fenceUntrusted, buildEnvelope } from "./envelope-build.js";
import { gatedRun } from "./gated-run.js";
import { runImplementJob } from "./implement.js";
import { runExploreJob } from "./explore.js";

export { fenceUntrusted, buildEnvelope, gatedRun };

export type JobState =
  "passed" | "failed" | "refused" | "quota" | "timeout" | "cancelled" | "error" | "guard_violation";

export interface JobSpec {
  jobId: string;
  kind: "implement" | "explore";
  repoRoot: string;
  task: string;
  contractTests?: ContractTest[];
  skills?: string[];
  lessons?: string[];
  checklist?: string[];
  touch?: string[];
  leaveUntouched?: string[];
  effort?: Effort;
  baseRef?: string;
  timeoutSec: number;
  conversationId?: string;
  config: ProjectConfig;
  runtime: RuntimeConfig;
}

export interface PipelineDeps {
  agyRun: typeof run;
  agyCommand: { command: string; prefixArgs?: string[] };
  hookBundlePath: string;
  worktreeRoot: string;
  home: string;
  now: () => Date;
  onEvent?: (ev: StreamEvent) => void;
  onPhase?: (phase: "prepare" | "contract" | "brief" | "run" | "verify" | "report") => void;
  signal?: AbortSignal;
}

export interface Citation {
  path: string;
  line: number;
  claim: string;
}

export interface Envelope {
  jobId: string;
  kind: "implement" | "explore";
  state: JobState;
  reason?: string;
  branch: string | null;
  worktreePath: string;
  baseSha: string;
  headSha?: string;
  mergeCheck?: { clean: boolean; conflictingFiles: string[] };
  contract?: { redOnBase: boolean; greenAfter: boolean };
  verify?: VerifyReport;
  diffStat?: string;
  untrustedReport: string;
  deniedCommands: string[];
  /** Set by `agy_get` when it cut `deniedCommands` short: how many there were. */
  deniedCommandsTotal?: number;
  guardEvents: string[];
  skillsUsed: string[];
  explore?: {
    summary: string;
    citations: Citation[];
    unverifiedCitations: Citation[];
    openQuestions: string[];
  };
  quota?: { resetInSec?: number; resetText?: string };
  model: string;
  conversationId?: string;
  usage?: AgyUsage;
  durationSec: number;
}

export async function runJob(spec: JobSpec, deps: PipelineDeps): Promise<Envelope> {
  const startTime = deps.now();
  if (spec.kind === "explore") {
    return await runExploreJob(spec, deps, startTime);
  }
  return await runImplementJob(spec, deps, startTime);
}
