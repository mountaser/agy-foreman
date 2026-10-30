import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GateDecision, GatePolicy } from "./gate.js";

export const POLICY_FILE = "foreman-policy.json";
export const REVIEW_FILE = "foreman-review.jsonl";

export interface ReviewEntry {
  t: string;
  name: string;
  decision: "auto_approve" | "deny" | "ask_user";
  reason?: string;
  arg: string;
}

export function writePolicy(agentsDir: string, policy: GatePolicy): void {
  mkdirSync(agentsDir, { recursive: true });
  const file = path.join(agentsDir, POLICY_FILE);
  writeFileSync(file, JSON.stringify(policy, null, 2), "utf8");
}

export function readPolicy(agentsDir: string): GatePolicy {
  const file = path.join(agentsDir, POLICY_FILE);
  return JSON.parse(readFileSync(file, "utf8")) as GatePolicy;
}

export function appendReview(agentsDir: string, entry: ReviewEntry): void {
  mkdirSync(agentsDir, { recursive: true });
  const file = path.join(agentsDir, REVIEW_FILE);
  appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
}

/** All parseable entries in order; [] when the file is missing; malformed lines are skipped. */
export function readReview(agentsDir: string): ReviewEntry[] {
  const file = path.join(agentsDir, REVIEW_FILE);
  if (!existsSync(file)) return [];
  try {
    const content = readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);
    const entries: ReviewEntry[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
          entries.push(parsed as ReviewEntry);
        }
      } catch {
        // malformed lines are skipped
      }
    }
    return entries;
  } catch {
    return [];
  }
}

const SUBJECT_KEYS = [
  "TargetFile",
  "CommandLine",
  "AbsolutePath",
  "FilePath",
  "file_path",
  "filePath",
  "path",
  "Path",
  "target_file",
  "file",
  "DirectoryPath",
  "SearchDirectory",
  "SearchPath",
  "Url",
  "ServerName",
] as const;

/** What a tool call acts on: the first present of TargetFile, CommandLine, AbsolutePath,
 *  DirectoryPath, SearchDirectory, SearchPath, Url, ServerName, then the first value;
 *  stringified and cut to 200 chars. undefined for no params or an empty object. */
export function toolSubject(params: Record<string, unknown> | undefined): string | undefined {
  if (!params) return undefined;
  for (const key of SUBJECT_KEYS) {
    const val = params[key];
    if (val !== undefined && val !== null) {
      return String(val).slice(0, 200);
    }
  }
  for (const val of Object.values(params)) {
    if (val !== undefined && val !== null) {
      return String(val).slice(0, 200);
    }
  }
  return undefined;
}
