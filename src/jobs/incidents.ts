import type { Envelope } from "../pipeline/index.js";

export type IncidentCategory =
  | "brief_missing_context"
  | "wrong_or_missing_gate"
  | "missing_config"
  | "scope_creep"
  | "protected_file_attempt"
  | "test_tampering"
  | "contract_too_weak"
  | "env_setup"
  | "timeout_too_short"
  | "task_too_big"
  | "skill_mismatch"
  | "quota"
  | "agy_error";

export interface Incident {
  category: IncidentCategory;
  evidence: string;
}

export function classifyIncident(e: Envelope, o: { hadParent: boolean }): Incident | null {
  // 1. passed and not hadParent -> null.
  if (e.state === "passed" && !o.hadParent) {
    return null;
  }

  // 2. passed and hadParent -> brief_missing_context ("passed only after follow-up").
  if (e.state === "passed" && o.hadParent) {
    return {
      category: "brief_missing_context",
      evidence: "passed only after follow-up",
    };
  }

  // 3. guard_violation -> protected_file_attempt if any guard event mentions protected, else scope_creep.
  if (e.state === "guard_violation") {
    const events = e.guardEvents ?? [];
    const mentionsProtected = events.some((ev) => ev.toLowerCase().includes("protected"));
    const evText = events.length > 0 ? events.join("; ") : (e.reason ?? "guard violation");
    return {
      category: mentionsProtected ? "protected_file_attempt" : "scope_creep",
      evidence: evText.slice(0, 300),
    };
  }

  // 4. verify.protectedRestored non-empty -> test_tampering (evidence lists them).
  if (e.verify?.protectedRestored && e.verify.protectedRestored.length > 0) {
    return {
      category: "test_tampering",
      evidence: e.verify.protectedRestored.join(", ").slice(0, 300),
    };
  }

  // 5. verify.auditFlags contains skip or process-exit -> test_tampering.
  const audit = e.verify?.auditFlags ?? [];
  if (audit.includes("skip") || audit.includes("process-exit")) {
    return {
      category: "test_tampering",
      evidence: audit.join(", ").slice(0, 300),
    };
  }

  // 6. quota -> quota.
  if (e.state === "quota") {
    const ev = e.quota?.resetText ?? e.reason ?? "quota exceeded";
    return {
      category: "quota",
      evidence: ev.slice(0, 300),
    };
  }

  // 7. timeout -> timeout_too_short.
  if (e.state === "timeout") {
    const ev = e.reason ?? "timeout";
    return {
      category: "timeout_too_short",
      evidence: ev.slice(0, 300),
    };
  }

  // 8. refused: reason matches /already pass/ -> contract_too_weak; /skill/ -> skill_mismatch; otherwise wrong_or_missing_gate.
  if (e.state === "refused") {
    const reason = e.reason ?? "";
    let category: IncidentCategory;
    if (/^config\.test_command/.test(reason)) {
      category = "missing_config";
    } else if (/already pass/i.test(reason)) {
      category = "contract_too_weak";
    } else if (/skill/i.test(reason)) {
      category = "skill_mismatch";
    } else {
      category = "wrong_or_missing_gate";
    }
    return {
      category,
      evidence: (e.reason ?? "refused").slice(0, 300),
    };
  }

  // 9. error: reason matches /setup_command/ -> env_setup, otherwise agy_error.
  if (e.state === "error") {
    const reason = e.reason ?? "";
    const category: IncidentCategory = /setup_command/i.test(reason) ? "env_setup" : "agy_error";
    return {
      category,
      evidence: (e.reason ?? "error").slice(0, 300),
    };
  }

  // 10. failed with deniedCommands non-empty -> wrong_or_missing_gate (evidence lists them).
  if (e.state === "failed" && e.deniedCommands && e.deniedCommands.length > 0) {
    return {
      category: "wrong_or_missing_gate",
      evidence: e.deniedCommands.join(", ").slice(0, 300),
    };
  }

  // 11. failed with verify.fewerTests or verify.newSkips > 0 -> test_tampering.
  if (e.state === "failed" && (e.verify?.fewerTests || (e.verify?.newSkips ?? 0) > 0)) {
    const parts: string[] = [];
    if (e.verify?.fewerTests) parts.push("fewer tests");
    if ((e.verify?.newSkips ?? 0) > 0) parts.push(`new skips: ${e.verify?.newSkips}`);
    return {
      category: "test_tampering",
      evidence: parts.join(", ").slice(0, 300),
    };
  }

  // 12. failed with more than 15 files in diffStat (count lines containing |) -> task_too_big.
  if (e.state === "failed") {
    const pipeCount = (e.diffStat ?? "").split("\n").filter((l) => l.includes("|")).length;
    if (pipeCount > 15) {
      return {
        category: "task_too_big",
        evidence: (e.diffStat ?? `diff touches ${pipeCount} files`).slice(0, 300),
      };
    }
  }

  // 13. failed -> brief_missing_context (evidence = the first three verify.failures).
  if (e.state === "failed") {
    const failures = e.verify?.failures ?? [];
    const evidence =
      failures.length > 0
        ? failures.slice(0, 3).join("\n")
        : (e.reason ?? e.verify?.outputTail ?? "failed");
    return {
      category: "brief_missing_context",
      evidence: evidence.slice(0, 300),
    };
  }

  // 14. Anything else (e.g. cancelled) -> null.
  return null;
}
