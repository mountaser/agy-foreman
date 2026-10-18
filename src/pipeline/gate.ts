import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gateDirFor, hookScript, POLICY_FILE, writePolicy } from "./toolcall-record.js";

export interface GatePolicy {
  mode: "implement" | "explore";
  worktree: string; // absolute
  readOnlyDirs: string[]; // absolute, readable but never writable
  protectedGlobs: string[]; // posix globs relative to worktree
  allowedCommands: string[]; // full command prefixes, e.g. "npm test", "npx vitest run"
  unknownCommands: "deny" | "allow" | "ask_user";
  allowedMcp: string[]; // "server/tool" or "server/*"
  web: boolean;
}

export interface GateDecision {
  decision: "auto_approve" | "deny";
  reason?: string;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

const HOOK_SCRIPT = "foreman-hook.mjs";
export const HOOK_COMMAND = `node ${HOOK_SCRIPT}`;

export interface InstalledGate {
  /** The job's gate folder (policy and review log), outside the worktree. */
  dir: string;
  /** gateFingerprint() right after installing. */
  fingerprint: string;
}

export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/");
  let re = "";
  let i = 0;
  while (i < g.length) {
    if (g.slice(i, i + 3) === "/**") {
      re += "(?:/.*)?";
      i += 3;
    } else if (g.slice(i, i + 3) === "**/") {
      re += "(?:.+/|^)";
      i += 3;
    } else if (g.slice(i, i + 2) === "**") {
      re += ".*";
      i += 2;
    } else if (g[i] === "*") {
      re += "[^/]*";
      i += 1;
    } else if (g[i] === "?") {
      re += "[^/]";
      i += 1;
    } else if (/[.+^$()[\]{}|\\]/.test(g[i])) {
      re += "\\" + g[i];
      i += 1;
    } else {
      re += g[i];
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The resolved path with symlinks resolved on its longest existing prefix. Found in CI: on macOS
 * the temp worktree is /var/... while agy reports /private/var/..., the same folder.
 */
function canonical(p: string): string {
  let head = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(head), ...rest.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(p);
      rest.push(path.basename(head));
      head = parent;
    }
  }
}

function isInside(root: string, target: string): boolean {
  const norm = (p: string) =>
    process.platform === "win32" ? canonical(p).toLowerCase() : canonical(p);
  const r = norm(root);
  const t = norm(target);
  return t === r || t.startsWith(r + (r.endsWith(path.sep) ? "" : path.sep));
}

function resolveTarget(worktree: string, targetPath: string): string {
  if (path.isAbsolute(targetPath)) {
    return path.resolve(targetPath);
  }
  return path.resolve(worktree, targetPath);
}

function getRelPosix(worktree: string, resolvedPath: string): string {
  const rel = path.relative(canonical(worktree), canonical(resolvedPath));
  return rel.split(path.sep).join("/");
}

// Stream merges and discards that write nothing anywhere: 2>&1, >&2, 2>/dev/null, >$null, >NUL.
const HARMLESS_REDIRECT = /(^|\s)(?:\d?>&\d|(?:\d|&)?>>?\s*(?:\/dev\/null|\$null|NUL))(?=\s|$)/gi;

/**
 * Returns the first path-like token in a command line that points outside the worktree
 * (absolute paths, `..` escapes, home or environment-variable expansions), or null.
 * Redirection operators are stripped first, so `>../x` is checked as `../x`.
 */
function pathOutsideWorktree(worktree: string, cmdLine: string): string | null {
  const tokens = cmdLine
    .replace(HARMLESS_REDIRECT, "$1")
    .split(/[\s,=]+/)
    .map((t) => t.replace(/^\d*[<>]+&?/, "").replace(/^["'(]+|["')]+$/g, ""));
  for (const tok of tokens) {
    if (!tok) continue;
    if (/^(~|\$[A-Za-z_{]|%[A-Za-z_]+%)/.test(tok)) return tok;
    // Drive paths, POSIX roots, UNC paths and `..` escapes. A lone leading backslash is left
    // alone: it is far more often a string escape (node -e '…\"x\"…') than a root-relative path.
    // A drive path can never be inside a worktree on Linux or macOS (there it would otherwise
    // resolve as a relative path; found in CI).
    if (/^[A-Za-z]:[\\/]/.test(tok) && process.platform !== "win32") return tok;
    if (/^([A-Za-z]:[\\/]|\/|\\\\|\.\.([\\/]|$))/.test(tok)) {
      if (!isInside(worktree, resolveTarget(worktree, tok))) return tok;
    }
  }
  return null;
}

/**
 * Splits a command line on &&, ||, ;, |, a lone & and line breaks outside of quotes, so a quoted
 * regex like -Pattern "A|B" stays one segment (found live: the gate denied a harmless
 * Select-String) and every command in the line is checked on its own.
 */
export function splitCommandSegments(cmdLine: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmdLine.length; i++) {
    const c = cmdLine[i];
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    const two = cmdLine.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "\r") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * The first shell construct in a command line that lets a command run another program, write or
 * read a file the gate never sees, or hide a second command: redirection (> <), a lone &,
 * grouping and subexpressions ( ( ) { } ), backticks, $( and ${, line breaks, and escaped quotes
 * (bash and PowerShell disagree on them). Single quotes make everything literal; double quotes
 * keep only backticks, $( and ${ live. Returns null when there is none.
 */
export function shellConstruct(cmdLine: string): string | null {
  const line = cmdLine.replace(HARMLESS_REDIRECT, "$1");
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1] ?? "";
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === "`") return "`";
    if (c === "$" && (next === "(" || next === "{")) return c + next;
    if (quote === '"') {
      if (c === '"') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "\\" && (next === '"' || next === "'")) return c + next;
    if (c === "\n" || c === "\r") return "a line break";
    if (c === "&") {
      if (next === "&") {
        i++;
        continue;
      }
      return c;
    }
    if (/[<>(){}]/.test(c)) return c;
  }
  return null;
}

export function decide(policy: GatePolicy, call: ToolCall): GateDecision {
  const name = call.name;
  const args = call.args ?? {};

  // 2. Writes
  if (
    name === "write_to_file" ||
    name === "replace_file_content" ||
    name === "multi_replace_file_content"
  ) {
    if (policy.mode === "explore") {
      return { decision: "deny", reason: "Writes are not allowed in explore mode." };
    }
    const targetFile = args.TargetFile;
    if (typeof targetFile !== "string" || !targetFile.trim()) {
      return { decision: "deny", reason: "TargetFile is required." };
    }
    const resolved = resolveTarget(policy.worktree, targetFile);
    if (!isInside(policy.worktree, resolved)) {
      return { decision: "deny", reason: "Writes outside the worktree are not allowed." };
    }

    const rel = getRelPosix(policy.worktree, resolved);
    const relNorm = rel.toLowerCase();

    if (relNorm === ".agy-task/progress.md") {
      // Allowed specifically
    } else if (/^(\.git|\.agents|\.agy-task)(\/|$)/i.test(relNorm)) {
      return {
        decision: "deny",
        reason: `Writing to internal directory (${rel}) is not allowed.`,
      };
    }

    for (const glob of policy.protectedGlobs) {
      if (globToRegExp(glob).test(rel)) {
        return {
          decision: "deny",
          reason: `Target file matches protected pattern: ${glob}`,
        };
      }
    }

    return { decision: "auto_approve" };
  }

  // 3. Reads
  if (
    name === "view_file" ||
    name === "list_dir" ||
    name === "find_by_name" ||
    name === "grep_search"
  ) {
    const p = args.AbsolutePath ?? args.DirectoryPath ?? args.SearchDirectory ?? args.SearchPath;
    if (p === undefined || p === null || String(p).trim() === "") {
      return { decision: "auto_approve" };
    }
    const resolved = resolveTarget(policy.worktree, String(p));
    const insideWorktree = isInside(policy.worktree, resolved);
    const insideReadOnly = policy.readOnlyDirs.some((dir) => isInside(dir, resolved));
    if (insideWorktree || insideReadOnly) {
      return { decision: "auto_approve" };
    }
    return { decision: "deny", reason: "Reading outside the worktree is not allowed." };
  }

  // 4. run_command
  if (name === "run_command") {
    const cmdLine = String(args.CommandLine ?? "").trim();
    const danger =
      /\bgit\s+(push|commit|reset|checkout|switch|rebase|merge|remote|config|clean|stash|worktree|branch|tag)\b|\b(curl|wget|irm|iwr|Invoke-WebRequest|Invoke-RestMethod|iex|Invoke-Expression)\b|\brm\s+-rf\b|\bRemove-Item\b.*?\b-Recurse\b|\brmdir\s+\/s\b|\bdel\s+\/s\b|\bshutdown\b|(^|[;&|]\s*)format\s+[A-Za-z]:/i;

    if (danger.test(cmdLine)) {
      return { decision: "deny", reason: "Dangerous command not allowed." };
    }

    const cwd = args.Cwd === undefined ? undefined : String(args.Cwd);
    if (cwd && !isInside(policy.worktree, resolveTarget(policy.worktree, cwd))) {
      return {
        decision: "deny",
        reason: "Commands must run inside the worktree (Cwd is outside).",
      };
    }
    const outside = pathOutsideWorktree(policy.worktree, cmdLine);
    if (outside) {
      return {
        decision: "deny",
        reason: `Commands may only reference paths inside the worktree (found ${outside}).`,
      };
    }

    // `unknown_commands: "allow"` already lets any program run; everywhere else, a construct like
    // `echo $(node x.js)` or `echo x > .agents/hooks.json` would run or write past the allowlist.
    if (policy.mode === "explore" || policy.unknownCommands !== "allow") {
      const construct = shellConstruct(cmdLine);
      if (construct) {
        return {
          decision: "deny",
          reason: `Shell construct not allowed: ${construct}. Run one plain command per call (2>&1 is fine), and write files with the file tools.`,
        };
      }
    }

    // Without 2>&1 and friends, whose & would otherwise split off a "command" named 1.
    const segments = splitCommandSegments(cmdLine.replace(HARMLESS_REDIRECT, "$1"));

    // Every prefix must end at a space or the end: `npx tsc` must not allow `npx tsc-evil`, which
    // npx would download and run without asking in a headless run.
    const readOnlyGit = /^git\s+(status|diff|log|show|ls-files|rev-parse|grep|blame)(?=\s|$)/i;
    const listings =
      /^(ls|dir|cat|type|echo|pwd|Get-ChildItem|Get-Content|Test-Path|Select-String)(?=\s|$)/i;

    for (const seg of segments) {
      if (policy.mode === "explore") {
        const isOk = readOnlyGit.test(seg) || listings.test(seg);
        if (!isOk) {
          return { decision: "deny", reason: "Command not allowed in explore mode." };
        }
      } else {
        const isAllowedPrefix = policy.allowedCommands.some((cmd) =>
          new RegExp(`^${escapeRegex(cmd.trim())}(?=\\s|$)`, "i").test(seg),
        );
        const isOk = isAllowedPrefix || readOnlyGit.test(seg) || listings.test(seg);
        if (!isOk) {
          if (policy.unknownCommands === "allow") {
            continue;
          }
          return {
            decision: "deny",
            reason: `Command not on allowlist: ${seg}`,
          };
        }
      }
    }

    return { decision: "auto_approve" };
  }

  // 5. call_mcp_tool
  if (name === "call_mcp_tool") {
    const server = String(args.ServerName ?? "");
    const tool = String(args.ToolName ?? "");
    const allowed =
      policy.allowedMcp.includes(`${server}/${tool}`) || policy.allowedMcp.includes(`${server}/*`);
    if (allowed) {
      return { decision: "auto_approve" };
    }
    return { decision: "deny", reason: `MCP tool ${server}/${tool} not allowed` };
  }

  // 6. web
  if (name === "search_web" || name === "read_url_content") {
    if (policy.web) {
      return { decision: "auto_approve" };
    }
    return { decision: "deny", reason: "Web access is disabled." };
  }

  // 7. questions
  if (name === "ask_question" || name === "ask_permission") {
    return {
      decision: "deny",
      reason:
        "No human is available in this run. Decide using the brief, or stop and report what you need.",
    };
  }

  // 8. Anything else
  return { decision: "deny", reason: `Tool ${name} is not allowed.` };
}

/**
 * One hash over the files that decide tool calls: `.agents/hooks.json`, the hook script and the
 * policy. If it changes during a run, something rewrote the gate (the guard then stops the run).
 */
export function gateFingerprint(worktree: string): string {
  const h = createHash("sha256");
  for (const file of [
    path.join(worktree, ".agents", "hooks.json"),
    path.join(worktree, ".agents", HOOK_SCRIPT),
    path.join(gateDirFor(worktree), POLICY_FILE),
  ]) {
    let content: Buffer | string = "(missing)";
    try {
      content = readFileSync(file);
    } catch {
      // a deleted file changes the hash too
    }
    h.update(file).update("\0").update(content).update("\0");
  }
  return h.digest("hex");
}

export async function installGate(
  worktree: string,
  policy: GatePolicy,
  hookBundlePath: string,
): Promise<InstalledGate> {
  const agentsDir = path.join(worktree, ".agents");
  mkdirSync(agentsDir, { recursive: true });

  const gateDir = gateDirFor(worktree);
  writeFileSync(
    path.join(agentsDir, HOOK_SCRIPT),
    hookScript(readFileSync(hookBundlePath, "utf8"), gateDir),
    "utf8",
  );
  writePolicy(gateDir, policy);

  const hooksPath = path.join(agentsDir, "hooks.json");
  let existingHooks: Record<string, unknown> = {};
  if (existsSync(hooksPath)) {
    try {
      existingHooks = JSON.parse(readFileSync(hooksPath, "utf8"));
    } catch {
      existingHooks = {};
    }
  }

  existingHooks["foreman-gate"] = {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: HOOK_COMMAND,
            timeout: 60,
          },
        ],
      },
    ],
  };

  writeFileSync(hooksPath, JSON.stringify(existingHooks, null, 2), "utf8");
  return { dir: gateDir, fingerprint: gateFingerprint(worktree) };
}
