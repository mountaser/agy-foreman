import path from "node:path";
import type { JobRecord } from "./store.js";

export function isSamePath(p1: string, p2: string): boolean {
  const norm1 = path.resolve(p1);
  const norm2 = path.resolve(p2);
  return process.platform === "win32"
    ? norm1.toLowerCase() === norm2.toLowerCase()
    : norm1 === norm2;
}

/** Text of the first unticked "- [ ] item" in a progress checklist, if any. */
export function firstOpenItem(markdown: string): string | undefined {
  const m = /^\s*[-*]\s+\[ \]\s+(.+)$/m.exec(markdown);
  return m ? m[1].trim() : undefined;
}

/**
 * What agy_get returns: the record without bulky fields the orchestrator rarely needs. A passed
 * job drops the test-output tail; a failed one keeps its last 1500 chars. The untrusted report is
 * capped. (Found live: a passed job returned ~6k tokens, mostly test output.)
 */
export function compactRecord(rec: JobRecord): JobRecord {
  const e = rec.envelope;
  if (!e) return rec;
  const verify = e.verify
    ? e.state === "passed"
      ? (({ outputTail: _tail, ...v }) => v)(e.verify)
      : { ...e.verify, outputTail: e.verify.outputTail.slice(-1500) }
    : undefined;
  const report =
    e.untrustedReport.length > 3000
      ? [
          e.untrustedReport.slice(0, 2600),
          "[… report truncated …]",
          e.untrustedReport.slice(e.untrustedReport.lastIndexOf("<<<END")),
        ].join("\n")
      : e.untrustedReport;
  // Denied commands can hold whole pasted file bodies; the first few show the pattern.
  const all = e.deniedCommands ?? [];
  const denied = all.map((c) => c.slice(0, 200));
  const cut = denied.length > 5 || all.some((c) => c.length > 200);
  return {
    ...rec,
    envelope: {
      ...e,
      ...(verify ? { verify: verify as typeof e.verify } : {}),
      untrustedReport: report,
      deniedCommands: denied.slice(0, 5),
      ...(cut ? { deniedCommandsTotal: all.length } : {}),
    },
  };
}
