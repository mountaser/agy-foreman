import type { StreamEvent } from "../agy/types.js";
import { decide, gateFingerprint, type GatePolicy, type InstalledGate } from "./gate.js";
import { toolSubject } from "./toolcall-record.js";

/**
 * The stream guard: re-decides every finished tool call with the server's own copy of the policy,
 * and, given the installed gate, stops the run when a tool call changed the gate's files (a
 * rewritten hooks.json or policy would let later calls through the hook).
 */
export function makeGuard(
  policy: GatePolicy,
  gate?: InstalledGate,
): (ev: StreamEvent) => string | null {
  return (ev: StreamEvent): string | null => {
    if (ev.kind !== "step" || ev.stepType !== "tool" || ev.state !== "DONE" || !ev.toolName) {
      return null;
    }
    const toolParams = ev.toolParams ?? {};
    const arg = toolSubject(toolParams) ?? "";
    const firstArg = arg ? ` ${arg}` : "";
    if (gate && gateFingerprint(policy.worktree) !== gate.fingerprint) {
      return `guard: ${ev.toolName}${firstArg}: the gate's hooks.json, hook script or policy changed`;
    }
    const decision = decide(policy, { name: ev.toolName, args: toolParams });
    if (decision.decision !== "deny") {
      return null;
    }
    return `guard: ${ev.toolName}${firstArg}: ${decision.reason ?? "denied"}`;
  };
}
