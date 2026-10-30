// Execution pipeline for explore jobs (detached worktree, schema-guided plan, citation verification).
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { EXPLORE_SCHEMA, renderBrief, RUN_PROMPT } from "./brief.js";
import { removeWorktree } from "./worktree.js";
import type { Citation, Envelope, JobSpec, JobState, PipelineDeps } from "./index.js";
import {
  buildEnvelope,
  getDeniedCommands,
  makeUntrustedReport,
  mapFailureOutcome,
} from "./envelope-build.js";
import { gatedRun } from "./gated-run.js";
import { extractJsonObject } from "./json-extract.js";

export async function runExploreJob(
  spec: JobSpec,
  deps: PipelineDeps,
  startTime: Date,
): Promise<Envelope> {
  const runResult = await gatedRun(spec, deps, startTime, {
    agyMode: "plan",
    prompt: RUN_PROMPT,
    detached: true,
    jsonSchema: EXPLORE_SCHEMA,
    briefText: (skills) =>
      renderBrief({
        kind: "explore",
        task: spec.task,
        date: deps.now().toISOString().slice(0, 10),
        skills: skills.map((s) => ({ name: s.name, description: s.description })),
        lessons: spec.lessons,
      }),
  });

  if ("state" in runResult) {
    return runResult;
  }

  const { outcome, worktree: wt, guardEvents, skillsUsed, nonce } = runResult;

  try {
    // 4. report & check citations
    deps.onPhase?.("report");
    const deniedCommands = getDeniedCommands(wt.path);

    let jobState: JobState = "error";
    let jobReason: string | undefined;
    let quotaData: { resetInSec?: number; resetText?: string } | undefined;
    let exploreData:
      | {
          summary: string;
          citations: Citation[];
          unverifiedCitations: Citation[];
          openQuestions: string[];
        }
      | undefined = undefined;

    const failure = mapFailureOutcome(outcome, guardEvents);
    if (failure) {
      jobState = failure.jobState;
      jobReason = failure.jobReason;
      quotaData = failure.quotaData;
    } else if (outcome.type === "success") {
      // agy 1.4 returns a structuredOutput that is not our schema (an empty object, for one), so
      // only trust it when it has the fields we asked for; otherwise read the reply text.
      const looksRight = (v: unknown): v is Record<string, unknown> =>
        !!v &&
        typeof v === "object" &&
        (typeof (v as { summary?: unknown }).summary === "string" ||
          Array.isArray((v as { citations?: unknown }).citations));
      let parsed: any = looksRight(outcome.structuredOutput) ? outcome.structuredOutput : undefined;
      if (!parsed && outcome.response) {
        parsed = extractJsonObject(outcome.response, looksRight);
      }

      if (!parsed || typeof parsed !== "object") {
        jobState = "error";
        jobReason = "No parseable JSON in explore response";
      } else {
        jobState = "passed";
        const citations: Citation[] = [];
        const unverifiedCitations: Citation[] = [];

        const rawCitations = Array.isArray(parsed.citations) ? parsed.citations : [];
        for (const raw of rawCitations) {
          const cPath = typeof raw.path === "string" ? raw.path : "";
          const cLine = typeof raw.line === "number" ? raw.line : -1;
          const cClaim = typeof raw.claim === "string" ? raw.claim : "";
          const citation: Citation = { path: cPath, line: cLine, claim: cClaim };

          let valid = false;
          if (cPath && !path.isAbsolute(cPath) && cLine >= 1) {
            const full = path.resolve(wt.path, cPath);
            const rel = path.relative(wt.path, full);
            if (!rel.startsWith("..") && !path.isAbsolute(rel) && existsSync(full)) {
              try {
                const stat = statSync(full);
                if (stat.isFile()) {
                  const content = readFileSync(full, "utf8");
                  const lineCount = content.split(/\r?\n/).length;
                  if (cLine <= lineCount) {
                    valid = true;
                  }
                }
              } catch {
                valid = false;
              }
            }
          }

          if (valid) {
            citations.push(citation);
          } else {
            unverifiedCitations.push(citation);
          }
        }

        const openQuestions = Array.isArray(parsed.open_questions)
          ? parsed.open_questions.map(String)
          : Array.isArray(parsed.openQuestions)
            ? parsed.openQuestions.map(String)
            : [];

        exploreData = {
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          citations,
          unverifiedCitations,
          openQuestions,
        };
      }
    }

    const untrustedReport = makeUntrustedReport(outcome, nonce);

    return buildEnvelope(spec, deps, startTime, {
      state: jobState,
      reason: jobReason,
      branch: null,
      worktreePath: wt.path,
      baseSha: wt.baseSha,
      untrustedReport,
      deniedCommands,
      guardEvents,
      skillsUsed,
      explore: exploreData,
      quota: quotaData,
      outcome,
      nonce,
    });
  } finally {
    // Always remove the worktree for explore jobs
    try {
      await removeWorktree(wt);
    } catch {
      // ignore
    }
  }
}
