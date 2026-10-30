import type { Activity, ActivityKind } from "./types.js";

// The program must start the command or follow `&&`, `;`, `|` or `(`, so a word inside an argument
// (`git commit -m "fix tsc"`) does not count.
const TEST_COMMAND =
  /(^|&&|;|\||\()\s*(go\s+(test|vet)|gofmt|npm\s+(run\s+)?test|npx\s+(vitest|tsc|prettier)|vitest|pytest|cargo\s+test|tsc|prettier)\b/i;

const PATH_KEYS = ["TargetFile", "AbsolutePath", "DirectoryPath", "SearchDirectory", "SearchPath"];

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function targetOf(params: Record<string, unknown> | undefined): string | undefined {
  if (!params) return undefined;
  for (const key of PATH_KEYS) {
    const v = params[key];
    if (typeof v === "string" && v) {
      const name = baseName(v);
      if (name) return name;
    }
  }
  return undefined;
}

/**
 * What a tool call means in plain terms. Commands never carry their text: only whether they run
 * tests, use git or are something else. Unknown tools return undefined.
 */
export function classifyTool(
  toolName: string | undefined,
  params: Record<string, unknown> | undefined,
): { kind: ActivityKind; target?: string } | undefined {
  if (!toolName) return undefined;
  // Polling or feeding a terminal does not change what the command is.
  if (/status|terminal|input/i.test(toolName)) return undefined;
  if (/command|shell|exec/i.test(toolName)) {
    const line = String(params?.CommandLine ?? params?.command ?? "");
    if (TEST_COMMAND.test(line)) return { kind: "testing" };
    if (/^\s*git\b/i.test(line)) return { kind: "git" };
    return { kind: "command" };
  }
  const target = targetOf(params);
  if (/write|replace|edit|patch|create|delete|rename|move/i.test(toolName)) {
    return { kind: "editing", ...(target ? { target } : {}) };
  }
  if (/view|read|list|grep|find|search|open/i.test(toolName)) {
    return { kind: "reading", ...(target ? { target } : {}) };
  }
  return undefined;
}

/**
 * The activity after one stream step event. A finished step means the model is thinking until the
 * next tool starts; a tool we do not know leaves the activity as it was.
 */
export function activityFor(
  prev: Activity | undefined,
  ev: { toolName?: string; toolParams?: Record<string, unknown>; state: string },
  now: Date,
): Activity | undefined {
  if (/^done$/i.test(ev.state)) {
    return prev?.kind === "thinking" ? prev : { kind: "thinking", at: now.toISOString() };
  }
  const c = classifyTool(ev.toolName, ev.toolParams);
  return c ? { ...c, at: now.toISOString() } : prev;
}
