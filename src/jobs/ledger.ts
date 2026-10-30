import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Estimate } from "./store.js";
import type { Incident } from "./incidents.js";

export interface LedgerEntry {
  jobId: string;
  kind: "implement" | "explore";
  state: string;
  durationSec: number;
  runSec?: number;
  estimate?: Estimate;
  /** Gemini output tokens (or report length / 4). Not what the job cost the orchestrator. */
  returnedTokens: number;
  /** All Gemini tokens the run used, whatever state it ended in. */
  usageTotal?: number;
  at: string;
  incident?: Incident;
}

export class Ledger {
  constructor(readonly file: string) {}

  async append(e: LedgerEntry): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify(e) + "\n", "utf8");
  }

  async entries(): Promise<LedgerEntry[]> {
    try {
      const data = await readFile(this.file, "utf8");
      return data
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LedgerEntry);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async medianRunSec(kind: "implement" | "explore"): Promise<number | undefined> {
    const list = await this.entries();
    const values = list
      .filter((e) => e.kind === kind && typeof e.runSec === "number")
      .map((e) => e.runSec!)
      .sort((a, b) => a - b);

    if (values.length === 0) return undefined;
    const mid = Math.floor(values.length / 2);
    if (values.length % 2 === 0) {
      return (values[mid - 1] + values[mid]) / 2;
    }
    return values[mid];
  }

  async calibration(): Promise<{ samples: number; ratio?: number }> {
    const list = await this.entries();
    const ratios = list
      .filter(
        (e) =>
          e.estimate &&
          typeof e.estimate.delegateOverheadTokens === "number" &&
          e.estimate.delegateOverheadTokens > 0,
      )
      .map((e) => e.returnedTokens / e.estimate!.delegateOverheadTokens)
      .sort((a, b) => a - b);

    if (ratios.length === 0) {
      return { samples: 0 };
    }

    const mid = Math.floor(ratios.length / 2);
    let ratio: number;
    if (ratios.length % 2 === 0) {
      ratio = (ratios[mid - 1] + ratios[mid]) / 2;
    } else {
      ratio = ratios[mid];
    }

    return { samples: ratios.length, ratio };
  }

  async stats(since: Date): Promise<{ jobs: number; passed: number; tokens: number }> {
    const list = await this.entries();
    const sinceMs = since.getTime();
    const relevant = list.filter((e) => new Date(e.at).getTime() >= sinceMs);
    const jobs = relevant.length;
    const passed = relevant.filter((e) => e.state === "passed").length;
    const tokens = relevant.reduce((sum, e) => sum + (e.usageTotal ?? 0), 0);
    return { jobs, passed, tokens };
  }
}
