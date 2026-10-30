import type { LedgerEntry } from "./jobs/ledger.js";

export interface ReportJob {
  id: string;
  returnedChars?: number;
}

export function buildReport(
  entries: LedgerEntry[],
  jobs: ReportJob[],
  opts?: { since?: Date },
): string {
  if (entries.length === 0) {
    return "no jobs\n";
  }

  const sinceMs = opts?.since?.getTime();
  const filtered =
    sinceMs !== undefined ? entries.filter((e) => new Date(e.at).getTime() >= sinceMs) : entries;

  const out: string[] = [];

  let header = `jobs: ${filtered.length}`;
  if (opts?.since) {
    const ymd = opts.since.toISOString().slice(0, 10);
    header += ` (since ${ymd})`;
  }
  out.push(header);

  const stateOrder: string[] = [];
  const stateMap = new Map<string, { count: number; tokens: number; durationSec: number }>();
  for (const e of filtered) {
    let item = stateMap.get(e.state);
    if (!item) {
      item = { count: 0, tokens: 0, durationSec: 0 };
      stateMap.set(e.state, item);
      stateOrder.push(e.state);
    }
    item.count++;
    item.tokens += e.usageTotal ?? 0;
    item.durationSec += e.durationSec ?? 0;
  }

  for (const state of stateOrder) {
    const data = stateMap.get(state)!;
    const countStr = String(data.count);
    const tokensStr = data.tokens.toLocaleString("en-US");
    const minStr = (data.durationSec / 60).toFixed(1);
    out.push(
      `${state.padEnd(12)} ${countStr.padStart(5)} ${tokensStr.padStart(10)} ${minStr.padStart(7)}`,
    );
  }

  const incidentCounts = new Map<string, number>();
  for (const e of filtered) {
    if (e.incident?.category) {
      incidentCounts.set(e.incident.category, (incidentCounts.get(e.incident.category) ?? 0) + 1);
    }
  }
  if (incidentCounts.size > 0) {
    const parts: string[] = [];
    for (const [cat, count] of incidentCounts) {
      parts.push(`${cat}=${count}`);
    }
    out.push(`incidents: ${parts.join(" ")}`);
  }

  const chars = jobs
    .map((j) => j.returnedChars)
    .filter((c): c is number => typeof c === "number" && !isNaN(c))
    .sort((a, b) => a - b);

  if (chars.length > 0) {
    const mid = Math.floor(chars.length / 2);
    const median = chars.length % 2 === 0 ? (chars[mid - 1] + chars[mid]) / 2 : chars[mid];
    const max = chars[chars.length - 1];
    out.push(
      `orchestrator chars per job: median ${Math.round(median).toLocaleString("en-US")} max ${max.toLocaleString("en-US")}`,
    );
  }

  const nonPassed = filtered
    .filter((e) => e.state !== "passed")
    .sort((a, b) => (b.usageTotal ?? 0) - (a.usageTotal ?? 0));

  if (nonPassed.length > 0) {
    out.push("costliest non-passed:");
    for (const job of nonPassed.slice(0, 5)) {
      const tokensStr = (job.usageTotal ?? 0).toLocaleString("en-US");
      const reason = job.estimate?.reason ?? "";
      out.push(
        `  ${job.jobId.padEnd(10)} ${job.state.padEnd(10)} ${tokensStr.padStart(8)}  ${reason}`,
      );
    }
  }

  return out.join("\n") + "\n";
}
