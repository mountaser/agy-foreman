// Act action handlers for JobManager (followup, finalize, cancel, quota_choice, resume_delegation, revoke_plan, lesson, promotion).
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { git } from "../pipeline/exec.js";
import type { JobSpec } from "../pipeline/index.js";
import { isDirty, mergeCheck, removeWorktree, type Worktree } from "../pipeline/worktree.js";
import { type PromoteCard } from "./approver.js";
import { LessonError, tagsFor, type Lesson } from "./lessons.js";
import { emptyProgress, isTerminal, newJobId, type JobRecord } from "./store.js";
import { DelegationPolicy, PlanGrants } from "./policy.js";
import type { JobScheduler } from "./scheduler.js";
import type { ActInput, JobManagerDeps } from "./manager.js";

export interface ActionsContext {
  deps: JobManagerDeps;
  scheduler: JobScheduler;
  policy?: DelegationPolicy;
  grants?: PlanGrants;
}

export async function startFollowup(
  ctx: ActionsContext,
  parent: JobRecord,
  feedback: string,
  bypassApproval: boolean,
): Promise<{ state: "running" | "queued"; jobId: string }> {
  const config = ctx.deps.loadConfig(parent.repoRoot);
  if (!bypassApproval) {
    let needApproval = true;
    if (parent.plan) {
      try {
        const planPath = path.isAbsolute(parent.plan.file)
          ? parent.plan.file
          : path.resolve(parent.repoRoot, parent.plan.file);
        const content = await readFile(planPath, "utf8");
        const grants = ctx.grants ?? new PlanGrants(ctx.deps.flags, ctx.deps.now);
        if (await grants.covers(parent.repoRoot, parent.plan.file, content, parent.plan.step)) {
          needApproval = false;
        }
      } catch {
        needApproval = true;
      }
    }
    if (needApproval) {
      const approved = await ctx.deps.approver.task({
        title: parent.title,
        kind: "implement",
        effort: config.project.effort,
        skills: [],
        estimate: parent.estimate,
        repoRoot: parent.repoRoot,
      });
      if (!approved) {
        throw new Error("task approval denied");
      }
    }
  }

  const newId = newJobId(ctx.deps.now());
  const newRec: JobRecord = {
    id: newId,
    kind: "implement",
    repoRoot: parent.repoRoot,
    title: parent.title,
    state: "queued",
    progress: emptyProgress(),
    createdAt: ctx.deps.now().toISOString(),
    updatedAt: ctx.deps.now().toISOString(),
    parentJobId: parent.id,
    ...(parent.plan ? { plan: parent.plan } : {}),
    ...(parent.estimate ? { estimate: parent.estimate } : {}),
    returnedChars: 0,
  };

  const spec: JobSpec = {
    jobId: newId,
    kind: "implement",
    repoRoot: parent.repoRoot,
    task: `${parent.title}\n\nFeedback:\n${feedback}`,
    contractTests: [],
    baseRef: parent.envelope?.branch ?? `agy/${parent.id}`,
    conversationId: parent.envelope?.conversationId,
    timeoutSec: config.runtime.defaultTimeoutSec,
    config: config.project,
    runtime: config.runtime,
  };

  const state = await ctx.scheduler.submit(newRec, spec);
  return { state, jobId: newId };
}

export async function handleAct(
  ctx: ActionsContext,
  i: ActInput,
): Promise<Record<string, unknown>> {
  if (i.action === "followup") {
    const parent = await ctx.deps.store.read(i.jobId);
    if (!parent) {
      return { state: "error", reason: `job not found: ${i.jobId}` };
    }
    if (!isTerminal(parent.state) || parent.kind !== "implement" || !parent.envelope?.branch) {
      return {
        state: "refused",
        reason: "parent must be terminal implement job with a branch",
      };
    }
    return await startFollowup(ctx, parent, i.feedback, false);
  }

  if (i.action === "finalize") {
    const rec = await ctx.deps.store.read(i.jobId);
    if (!rec) {
      return { state: "error", reason: `job not found: ${i.jobId}` };
    }
    if (!isTerminal(rec.state) || !rec.envelope?.branch) {
      return { state: "refused", reason: "job must be terminal with a branch" };
    }
    // Discarding never touches the main checkout, so a dirty tree is no reason to refuse it.
    const dirty = i.mode === "discard" ? false : await isDirty(rec.repoRoot);
    if (dirty) {
      return { state: "refused", reason: "working tree is dirty" };
    }

    const target = await git(["rev-parse", "--abbrev-ref", "HEAD"], rec.repoRoot);
    const branch = rec.envelope.branch;
    const wt: Worktree = {
      path: rec.envelope.worktreePath,
      branch,
      baseSha: rec.envelope.baseSha,
      repoRoot: rec.repoRoot,
      jobId: rec.id,
    };

    if (i.mode === "discard") {
      try {
        await removeWorktree(wt, { deleteBranch: true });
      } catch (err) {
        // A job refused before its worktree was made has nothing on disk to remove.
        const msg = err instanceof Error ? err.message : String(err);
        if (
          !/is not a working tree|not a valid object|branch .* not found|No such file/i.test(msg)
        ) {
          throw err;
        }
        return { state: "discarded", note: "nothing to discard" };
      }
      return { state: "discarded" };
    }

    if (i.mode === "keep") {
      return { state: "kept" };
    }

    const check = await mergeCheck(rec.repoRoot, target, branch);
    if (!check.clean) {
      return { state: "conflict", conflictingFiles: check.conflictingFiles };
    }

    if (i.mode === "squash") {
      await git(["merge", "--squash", branch], rec.repoRoot);
      const passed =
        rec.envelope.verify?.counts?.tests !== undefined
          ? rec.envelope.verify.counts.tests -
            rec.envelope.verify.counts.failures -
            rec.envelope.verify.counts.errors
          : 0;
      const total = rec.envelope.verify?.counts?.tests ?? 0;
      const commitMsg = `${rec.title}\n\nImplemented-by: ${rec.envelope.model} via agy-foreman\nVerified: ${passed}/${total} tests`;
      await git(["commit", "-m", commitMsg], rec.repoRoot);
      const commit = (await git(["rev-parse", "HEAD"], rec.repoRoot)).trim();
      await removeWorktree(wt, { deleteBranch: true });
      return { state: "merged", commit };
    }

    if (i.mode === "merge") {
      await git(["merge", "--no-ff", "-m", rec.title, branch], rec.repoRoot);
      const commit = (await git(["rev-parse", "HEAD"], rec.repoRoot)).trim();
      await removeWorktree(wt, { deleteBranch: false });
      return { state: "merged", commit };
    }

    return { state: "error", reason: `unknown finalize mode: ${(i as any).mode}` };
  }

  if (i.action === "cancel") {
    await ctx.scheduler.cancel(i.jobId);
    return { state: "cancelling" };
  }

  if (i.action === "quota_choice") {
    const policy =
      ctx.policy ?? new DelegationPolicy(ctx.deps.flags, ctx.deps.approver, ctx.deps.now);
    await policy.choose(i.choice);
    return { state: "ok", choice: i.choice };
  }

  if (i.action === "resume_delegation") {
    const policy =
      ctx.policy ?? new DelegationPolicy(ctx.deps.flags, ctx.deps.approver, ctx.deps.now);
    await policy.resume();
    return { state: "ok" };
  }

  if (i.action === "revoke_plan") {
    const grants = ctx.grants ?? new PlanGrants(ctx.deps.flags, ctx.deps.now);
    await grants.revoke(process.cwd(), i.planFile);
    return { state: "ok" };
  }

  if (i.action === "lesson") {
    let repoRoot = process.cwd();
    let rec: JobRecord | undefined;
    if (i.jobId) {
      rec = await ctx.deps.store.read(i.jobId);
      if (rec?.repoRoot) {
        repoRoot = rec.repoRoot;
      }
    } else {
      const allJobs = await ctx.deps.store.list();
      if (allJobs.length > 0 && allJobs[0].repoRoot) {
        repoRoot = allJobs[0].repoRoot;
      }
    }

    if (!ctx.deps.lessons) {
      return { state: "error", reason: "lessons not configured" };
    }

    const stores = ctx.deps.lessons(repoRoot);
    const targetStore = i.scope === "global" ? stores.global : stores.project;

    let extraTags: string[] = [];
    if (rec) {
      const files: string[] = [];
      if (rec.envelope?.diffStat) {
        for (const line of rec.envelope.diffStat.split("\n")) {
          const pipeIdx = line.indexOf("|");
          if (pipeIdx !== -1) {
            const file = line.slice(0, pipeIdx).trim();
            if (file) files.push(file);
          }
        }
      }
      extraTags = tagsFor({
        files,
        kind: rec.kind,
        category: rec.incident?.category,
      });
    }

    const tags = Array.from(new Set([...(i.tags ?? []), ...extraTags]));

    let addRes: { lesson: Lesson; merged: boolean };
    try {
      addRes = await targetStore.add({
        text: i.text,
        audience: i.audience,
        scope: i.scope,
        tags,
      });
    } catch (err) {
      if (err instanceof LessonError) {
        return { state: "refused", reason: err.message };
      }
      throw err;
    }

    const { lesson, merged } = addRes;
    let promotion: "approved" | "declined" | "suggested" | undefined;

    const skillDir = ctx.deps.skillDir?.(repoRoot);
    if (lesson.hits >= 3 && !lesson.promoted && skillDir) {
      const KNOWN_ISSUES_CATS = new Set([
        "cat:test_tampering",
        "cat:protected_file_attempt",
        "cat:env_setup",
        "cat:agy_error",
        "cat:timeout_too_short",
        "cat:quota",
      ]);

      let targetFile: string;
      if (lesson.audience === "orchestrator") {
        targetFile = path.join(skillDir, "references", "routing.md");
      } else if (lesson.tags.some((t) => KNOWN_ISSUES_CATS.has(t))) {
        targetFile = path.join(skillDir, "references", "known-issues.md");
      } else {
        targetFile = path.join(skillDir, "references", "prompting.md");
      }

      const card: PromoteCard = {
        lessonText: lesson.text,
        hits: lesson.hits,
        targetFile,
        repoRoot,
      };

      const isClient =
        ctx.deps.approver.isClientMode?.(repoRoot) ??
        ctx.deps.loadConfig(repoRoot).project.gate === "client";

      const approved = await ctx.deps.approver.promote(card);
      if (approved) {
        const todayStr = ctx.deps.now().toISOString().slice(0, 10);
        await mkdir(path.dirname(targetFile), { recursive: true });
        await appendFile(targetFile, `\n- ${lesson.text} _(learned ${todayStr})_\n`, "utf8");
        await targetStore.markPromoted(lesson.id, todayStr);
        promotion = "approved";
      } else if (isClient) {
        promotion = "suggested";
      } else {
        promotion = "declined";
      }
    }

    return {
      state: "ok",
      lesson,
      merged,
      ...(promotion !== undefined ? { promotion } : {}),
    };
  }

  return { state: "error", reason: `unknown action: ${(i as any).action}` };
}
