// Job execution and progress tracking for JobManager (phase/event listeners, completion, quota handling).
import { readFileSync } from "node:fs";
import path from "node:path";
import type { StreamEvent } from "../agy/types.js";
import { progressFraction } from "../pipeline/brief.js";
import { toolSubject } from "../pipeline/toolcall-record.js";
import type { Envelope, JobSpec, PipelineDeps } from "../pipeline/index.js";
import { repoHash } from "../pipeline/worktree.js";
import { classifyIncident } from "./incidents.js";
import { computeProgress } from "./progress.js";
import type { JobRecord } from "./store.js";
import { firstOpenItem, isSamePath } from "./helpers.js";
import type { JobManagerDeps } from "./manager.js";
import { DelegationPolicy } from "./policy.js";
import { activityFor } from "../snapshot/activity.js";

export interface ExecuteJobContext {
  deps: JobManagerDeps;
  policy?: DelegationPolicy;
  write: (record: JobRecord) => Promise<void>;
  startFollowup: (
    parent: JobRecord,
    feedback: string,
    bypassApproval: boolean,
  ) => Promise<{ state: "running" | "queued"; jobId: string }>;
}

export async function executeJob(
  ctx: ExecuteJobContext,
  record: JobRecord,
  spec: JobSpec,
  signal: AbortSignal,
): Promise<void> {
  const jobStartTime = ctx.deps.now();
  let runStartTime: Date | undefined;
  let lastWriteTime = 0;
  const worktreePath = path.join(
    ctx.deps.pipelineDeps.worktreeRoot,
    repoHash(spec.repoRoot),
    spec.jobId,
  );

  const updateProgressAndSave = async (force: boolean) => {
    const nowMs = ctx.deps.now().getTime();
    if (!force && nowMs - lastWriteTime < 500) {
      return;
    }
    lastWriteTime = nowMs;
    const median = await ctx.deps.ledger.medianRunSec(record.kind);
    const elapsedSec = (nowMs - jobStartTime.getTime()) / 1000;
    const runElapsedSec = runStartTime ? (nowMs - runStartTime.getTime()) / 1000 : 0;
    const prog = computeProgress({
      phase: record.progress.phase,
      checklist:
        record.progress.checklistTotal > 0
          ? {
              done: record.progress.checklistDone,
              total: record.progress.checklistTotal,
            }
          : undefined,
      elapsedSec,
      runElapsedSec,
      medianRunSec: median,
    });
    record.progress.percent = prog.percent;
    record.progress.elapsedSec = elapsedSec;
    record.progress.etaSec = prog.etaSec;
    record.updatedAt = ctx.deps.now().toISOString();
    await ctx.write(record);
  };

  const onPhase = (phase: "prepare" | "contract" | "brief" | "run" | "verify" | "report") => {
    record.progress.phase = phase;
    if (phase !== "run") record.progress.activity = undefined;
    if (phase === "run" && !runStartTime) {
      runStartTime = ctx.deps.now();
    }
    updateProgressAndSave(true).catch(() => {});
  };

  const onEvent = (ev: StreamEvent) => {
    let changed = false;
    let activityChanged = false;
    if (ev.kind === "step") {
      if (ev.state === "DONE" || ev.state === "done") {
        record.progress.toolSteps++;
        changed = true;
      }
      const params = ev.toolParams;
      const prev = record.progress.activity;
      const activity = activityFor(
        prev,
        { toolName: ev.toolName, toolParams: params, state: ev.state },
        ctx.deps.now(),
      );
      if (activity !== prev) {
        record.progress.activity = activity;
        changed = true;
        // A change of what the job is doing is saved at once; the 500 ms throttle never retries.
        if (activity?.kind !== prev?.kind || activity?.target !== prev?.target) {
          activityChanged = true;
        }
      }
      const target = toolSubject(params);
      if (typeof target === "string") {
        let rel = target;
        if (path.isAbsolute(rel)) {
          const r = path.relative(worktreePath, rel);
          if (!r.startsWith("..") && !path.isAbsolute(r)) {
            rel = r;
          }
        }
        record.progress.currentFile = rel.replace(/\\/g, "/");
        changed = true;
      }
      if (ev.usage?.totalTokens) {
        record.progress.tokens = ev.usage.totalTokens;
        changed = true;
      }
      // Gemini ticks the checklist with write_to_file or (more often) replace_file_content.
      if (ev.toolName && /write_to_file|replace_file_content/.test(ev.toolName)) {
        const progressFile = path.join(worktreePath, ".agy-task", "progress.md");
        const target = params?.TargetFile ?? params?.targetFile;
        if (
          typeof target === "string" &&
          (target.endsWith("progress.md") || isSamePath(target, progressFile))
        ) {
          try {
            const content = readFileSync(progressFile, "utf8");
            const frac = progressFraction(content);
            record.progress.checklistDone = frac.done;
            record.progress.checklistTotal = frac.total;
            record.progress.currentStep = firstOpenItem(content);
            changed = true;
          } catch {
            // ignore
          }
        }
      }
    } else if (ev.kind === "result") {
      if (ev.result?.usage?.totalTokens) {
        record.progress.tokens = ev.result.usage.totalTokens;
        changed = true;
      }
    }
    if (changed) {
      updateProgressAndSave(activityChanged).catch(() => {});
    }
  };

  let envelope: Envelope | undefined;
  let runError: unknown;
  try {
    const pd: PipelineDeps = {
      ...ctx.deps.pipelineDeps,
      onPhase,
      onEvent,
      signal,
    };
    envelope = await ctx.deps.runJob(spec, pd);
  } catch (err) {
    runError = err;
  }

  if (runError !== undefined) {
    const reason = runError instanceof Error ? runError.message : String(runError);
    record.state = "error";
    // Found live: a job ended as "error" with no trace of why.
    record.errorReason = reason;
    record.progress.phase = "done";
    record.progress.percent = 100;
    record.progress.elapsedSec = (ctx.deps.now().getTime() - jobStartTime.getTime()) / 1000;
    delete record.progress.etaSec;
    record.updatedAt = ctx.deps.now().toISOString();
    await ctx.write(record);
    await ctx.deps.ledger.append({
      jobId: record.id,
      kind: record.kind,
      state: "error",
      durationSec: record.progress.elapsedSec,
      estimate: record.estimate,
      returnedTokens: 0,
      at: ctx.deps.now().toISOString(),
    });
  } else if (envelope) {
    const incident = classifyIncident(envelope, { hadParent: !!record.parentJobId });
    if (incident) {
      record.incident = incident;
    } else {
      delete record.incident;
    }
    record.envelope = envelope;
    record.state = envelope.state;
    record.progress.phase = "done";
    record.progress.percent = 100;
    record.progress.elapsedSec = envelope.durationSec;
    delete record.progress.etaSec;
    record.updatedAt = ctx.deps.now().toISOString();
    await ctx.write(record);

    const returnedTokens =
      envelope.usage?.outputTokens ?? Math.round((envelope.untrustedReport?.length ?? 0) / 4);
    await ctx.deps.ledger.append({
      jobId: record.id,
      kind: record.kind,
      state: envelope.state,
      durationSec: envelope.durationSec,
      runSec: envelope.durationSec,
      estimate: record.estimate,
      returnedTokens,
      usageTotal: envelope.usage?.totalTokens,
      at: ctx.deps.now().toISOString(),
      ...(incident ? { incident } : {}),
    });

    if (envelope.state === "quota") {
      const policy =
        ctx.policy ?? new DelegationPolicy(ctx.deps.flags, ctx.deps.approver, ctx.deps.now);
      const choice = await policy.onQuota({
        resetInSec: envelope.quota?.resetInSec,
        resetText: envelope.quota?.resetText,
        pausedJobId: record.id,
        repoRoot: record.repoRoot,
      });
      if (choice === "retry") {
        await ctx.startFollowup(
          record,
          "Continue the task; the previous run stopped at a usage limit.",
          true,
        );
      }
    }
  }
}
