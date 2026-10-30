import { isTerminal, type JobRecord } from "../jobs/store.js";
import type { QuotaSnapshot } from "../usage-quota.js";
import type { DiffStat, Snapshot, SnapshotJob, StepState } from "./types.js";

/** Plain-text title: drops the `Task N:` prefix, Markdown emphasis and code ticks. */
export function cleanTitle(title: string): string {
  return title
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/^task\s+\d+[:.]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reads `N files changed, A insertions(+), D deletions(-)` from the end of a `git diff --stat`. */
export function parseShortstat(text: string): DiffStat | undefined {
  const m = text.match(
    /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/,
  );
  if (!m) return undefined;
  return { files: Number(m[1]), added: Number(m[2] ?? 0), deleted: Number(m[3] ?? 0) };
}

export interface BuildInput {
  jobs: JobRecord[];
  now: Date;
  pid: number;
  quota?: QuotaSnapshot;
  /** Number of steps in a plan file, when it can be read. */
  planSteps?: (planFile: string, repoRoot: string) => number | undefined;
  /** Live diff of running jobs, by job id. */
  liveDiff?: ReadonlyMap<string, DiffStat>;
}

const byCreated = (a: JobRecord, b: JobRecord) => a.createdAt.localeCompare(b.createdAt);

/** Two neighbouring jobs of a plan more than this far apart belong to different runs. */
const RUN_GAP_MS = 2 * 60 * 60 * 1000;

/**
 * The jobs of the shown plan that belong to the current run: everything from the oldest active job
 * on, plus the earlier jobs that lead up to it without a gap of more than two hours. Older jobs
 * of the same plan are history.
 */
function currentRun(shown: JobRecord, jobs: JobRecord[]): JobRecord[] {
  const samePlan = jobs
    .filter((j) =>
      shown.plan
        ? j.plan?.file === shown.plan.file && j.repoRoot === shown.repoRoot
        : j.id === shown.id,
    )
    .sort(byCreated);
  if (!shown.plan) return samePlan;
  let start = Math.max(
    0,
    samePlan.findIndex((j) => !isTerminal(j.state)),
  );
  while (
    start > 0 &&
    Date.parse(samePlan[start].createdAt) - Date.parse(samePlan[start - 1].createdAt) <= RUN_GAP_MS
  ) {
    start--;
  }
  return samePlan.slice(start);
}

function stepState(mine: JobRecord[]): StepState {
  if (mine.some((j) => j.state === "passed")) return "passed";
  if (mine.some((j) => j.state === "running")) return "running";
  if (mine.some((j) => j.state === "queued")) return "queued";
  return mine.length > 0 ? "failed" : "pending";
}

function stepNumbers(shown: JobRecord, group: JobRecord[], i: BuildInput): number[] | undefined {
  if (!shown.plan) return undefined;
  const listed = [...group].reverse().find((j) => j.plan?.delegateSteps?.length);
  if (listed?.plan?.delegateSteps) return listed.plan.delegateSteps;
  const n = i.planSteps?.(shown.plan.file, shown.repoRoot);
  if (n && n > 0) return Array.from({ length: n }, (_, k) => k + 1);
  return [...new Set(group.map((j) => j.plan!.step))].sort((a, b) => a - b);
}

const SOLO_TITLE_MAX = 40;

/** A job without a plan is titled by its task text, which can be long. */
function shortTitle(title: string): string {
  return title.length > SOLO_TITLE_MAX ? title.slice(0, SOLO_TITLE_MAX - 1).trimEnd() + "…" : title;
}

function toSnapshotJob(j: JobRecord): SnapshotJob {
  return {
    id: j.id,
    step: j.plan?.step ?? null,
    title: j.plan ? cleanTitle(j.title) : shortTitle(cleanTitle(j.title)),
    state: j.state === "queued" ? "queued" : "running",
    phase: j.progress.phase,
    ...(j.progress.phase === "run" && j.progress.activity ? { activity: j.progress.activity } : {}),
  };
}

/** The snapshot for the plan of the oldest running job (or the oldest queued one). */
export function buildSnapshot(i: BuildInput): Snapshot {
  const base = { version: 1 as const, updatedAt: i.now.toISOString(), pid: i.pid };
  const quota = i.quota ? { quota: i.quota } : {};
  const active = i.jobs.filter((j) => !isTerminal(j.state)).sort(byCreated);
  if (active.length === 0) return { ...base, active: false, jobs: [], ...quota };

  const shown = active.find((j) => j.state === "running") ?? active[0];
  const group = currentRun(shown, i.jobs);

  const numbers = stepNumbers(shown, group, i);
  const steps = numbers
    ? numbers.map((n) => stepState(group.filter((j) => j.plan?.step === n)))
    : [stepState(group)];

  const diffs = group
    .map((j) =>
      j.state === "running"
        ? i.liveDiff?.get(j.id)
        : j.envelope?.diffStat
          ? parseShortstat(j.envelope.diffStat)
          : undefined,
    )
    .filter((d): d is DiffStat => d !== undefined);
  const diff = diffs.length
    ? diffs.reduce((a, d) => ({
        files: a.files + d.files,
        added: a.added + d.added,
        deleted: a.deleted + d.deleted,
      }))
    : undefined;

  return {
    ...base,
    active: true,
    plan: {
      file: shown.plan?.file ?? null,
      steps,
      done: steps.filter((s) => s === "passed").length,
      failed: steps.filter((s) => s === "failed").length,
      elapsedSec: Math.max(
        0,
        Math.round((i.now.getTime() - Date.parse(group[0].createdAt)) / 1000),
      ),
      ...(diff ? { diff } : {}),
    },
    jobs: group.filter((j) => !isTerminal(j.state)).map(toSnapshotJob),
    ...quota,
  };
}
