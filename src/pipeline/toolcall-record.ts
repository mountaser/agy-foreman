import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GateDecision, GatePolicy } from "./gate.js";

export const POLICY_FILE = "foreman-policy.json";
export const REVIEW_FILE = "foreman-review.jsonl";
/** The global the copied hook script sets before the bundle runs: the job's gate folder. */
export const GATE_DIR_GLOBAL = "__foremanGateDir";

/**
 * The job's gate folder, holding the policy and the review log: a sibling of the worktree, so
 * commands Gemini runs inside the worktree can't rewrite its own rules (the gate denies paths
 * outside the worktree). agy only runs hooks from `<worktree>/.agents/`, so the hook script stays
 * there and is told this folder by the line hookScript() puts in front of the bundle.
 */
export function gateDirFor(worktree: string): string {
  return `${path.resolve(worktree)}.gate`;
}

/** The hook bundle with the gate folder set first (after a shebang line, if any). */
export function hookScript(bundle: string, gateDir: string): string {
  const line = `globalThis.${GATE_DIR_GLOBAL} = ${JSON.stringify(gateDir)};\n`;
  if (!bundle.startsWith("#!")) return line + bundle;
  const eol = bundle.indexOf("\n") + 1 || bundle.length;
  return bundle.slice(0, eol) + line + bundle.slice(eol);
}

/** The gate folder the running hook was given, or an error (the hook then denies the call). */
export function hookGateDir(): string {
  const dir = (globalThis as Record<string, unknown>)[GATE_DIR_GLOBAL];
  if (typeof dir !== "string" || !dir) throw new Error("gate folder not set");
  return dir;
}

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
