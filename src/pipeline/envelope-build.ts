// Shared envelope-building helpers, untrusted output fencing, and review log inspection.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { gateDirFor, readReview } from "./toolcall-record.js";
import type { AgyUsage, Outcome } from "../agy/types.js";
import type { Citation, Envelope, JobSpec, JobState, PipelineDeps } from "./index.js";
import type { VerifyReport } from "./verify.js";
import { repoHash } from "./worktree.js";

export function fenceUntrusted(text: string, nonce: string): string {
  return `<<<AGY-UNTRUSTED nonce=${nonce}>>>\n${text.slice(0, 8000)}\n<<<END nonce=${nonce}>>>`;
}

export function getDeniedCommands(worktreePath: string): string[] {
  const entries = readReview(gateDirFor(worktreePath));
  const denied: string[] = [];
  for (const entry of entries) {
    if (entry.decision === "deny" && entry.name === "run_command" && entry.arg) {
      denied.push(String(entry.arg));
    }
  }
  return denied;
}

export function makeUntrustedReport(outcome: Outcome, nonce?: string): string {
  const responseText =
    outcome.type === "success"
      ? outcome.response
      : outcome.type === "timeout"
        ? outcome.partialResponse
        : "";
  const n = nonce ?? randomBytes(4).toString("hex");
  return fenceUntrusted(responseText, n);
}

export function mapFailureOutcome(
  outcome: Outcome,
  guardEvents: string[],
): {
  jobState: JobState;
  jobReason?: string;
  quotaData?: { resetInSec?: number; resetText?: string };
} | null {
  if (outcome.type === "quota") {
    return {
      jobState: "quota",
      quotaData: { resetInSec: outcome.resetInSec, resetText: outcome.resetText },
      jobReason: outcome.resetText ?? "Quota exceeded",
    };
  }
  if (outcome.type === "timeout") {
    return { jobState: "timeout", jobReason: "Job timed out" };
  }
  if (outcome.type === "cancelled") {
    return { jobState: "cancelled", jobReason: "Job was cancelled" };
  }
  if (outcome.type === "guard_violation") {
    if (!guardEvents.includes(outcome.reason)) {
      guardEvents.push(outcome.reason);
    }
    return { jobState: "guard_violation", jobReason: outcome.reason };
  }
  if (outcome.type === "denied") {
    return { jobState: "error", jobReason: outcome.detail };
  }
  if (outcome.type === "error") {
    return { jobState: "error", jobReason: outcome.message };
  }
  return null;
}

export interface BuildEnvelopeFields {
  state: JobState;
  reason?: string;
  branch?: string | null;
  worktreePath?: string;
  baseSha?: string;
  headSha?: string;
  mergeCheck?: { clean: boolean; conflictingFiles: string[] };
  contract?: { redOnBase: boolean; greenAfter: boolean };
  verify?: VerifyReport;
  diffStat?: string;
  untrustedReport?: string;
  reportText?: string;
  nonce?: string;
  outcome?: Outcome;
  deniedCommands?: string[];
  guardEvents?: string[];
  skillsUsed?: string[];
  explore?: {
    summary: string;
    citations: Citation[];
    unverifiedCitations: Citation[];
    openQuestions: string[];
  };
  quota?: { resetInSec?: number; resetText?: string };
  conversationId?: string;
  usage?: AgyUsage;
}

export function buildEnvelope(
  spec: JobSpec,
  deps: PipelineDeps,
  startTime: Date,
  fields: BuildEnvelopeFields,
): Envelope {
  const durationSec = (deps.now().getTime() - startTime.getTime()) / 1000;
  const conversationId =
    fields.conversationId ?? fields.outcome?.conversationId ?? spec.conversationId;
  const model = spec.config.model;
  const skillsUsed = fields.skillsUsed ?? [];
  const guardEvents = fields.guardEvents ?? [];

  const worktreePath =
    fields.worktreePath ?? path.join(deps.worktreeRoot, repoHash(spec.repoRoot), spec.jobId);
  const branch =
    fields.branch !== undefined
      ? fields.branch
      : spec.kind === "explore"
        ? null
        : `agy/${spec.jobId}`;
  const baseSha = fields.baseSha ?? "";

  const deniedCommands =
    fields.deniedCommands ??
    (worktreePath && existsSync(worktreePath) ? getDeniedCommands(worktreePath) : []);

  let untrustedReport = fields.untrustedReport;
  if (!untrustedReport) {
    if (fields.outcome) {
      untrustedReport = makeUntrustedReport(fields.outcome, fields.nonce);
    } else {
      const nonce = fields.nonce ?? randomBytes(4).toString("hex");
      untrustedReport = fenceUntrusted(fields.reportText ?? "", nonce);
    }
  }

  const quota =
    fields.quota ??
    (fields.outcome?.type === "quota"
      ? { resetInSec: fields.outcome.resetInSec, resetText: fields.outcome.resetText }
      : undefined);

  const usage =
    fields.usage ?? (fields.outcome?.type === "success" ? fields.outcome.usage : undefined);

  return {
    jobId: spec.jobId,
    kind: spec.kind,
    state: fields.state,
    ...(fields.reason ? { reason: fields.reason } : {}),
    branch,
    worktreePath,
    baseSha,
    ...(fields.headSha ? { headSha: fields.headSha } : {}),
    ...(fields.mergeCheck ? { mergeCheck: fields.mergeCheck } : {}),
    ...(fields.contract ? { contract: fields.contract } : {}),
    ...(fields.verify ? { verify: fields.verify } : {}),
    ...(fields.diffStat !== undefined ? { diffStat: fields.diffStat } : {}),
    untrustedReport,
    deniedCommands,
    guardEvents,
    skillsUsed,
    ...(fields.explore ? { explore: fields.explore } : {}),
    ...(quota ? { quota } : {}),
    model,
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(usage ? { usage } : {}),
    durationSec,
  };
}
