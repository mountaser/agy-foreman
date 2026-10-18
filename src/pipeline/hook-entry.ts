import { readFileSync } from "node:fs";
import { decide } from "./gate.js";
import {
  appendReview,
  hookGateDir,
  readPolicy,
  toolSubject,
  type ReviewEntry,
} from "./toolcall-record.js";

function main() {
  try {
    const stdin = readFileSync(0, "utf8");
    const parsed = JSON.parse(stdin);
    const toolCall = parsed.toolCall ?? {};
    const name = String(toolCall.name ?? "");
    const args = (toolCall.args ?? {}) as Record<string, unknown>;

    const gateDir = hookGateDir();
    const policy = readPolicy(gateDir);

    const res = decide(policy, { name, args });

    const arg = toolSubject(args) ?? "";

    const logEntry: ReviewEntry = {
      t: new Date().toISOString(),
      name,
      decision: res.decision,
      ...(res.reason ? { reason: res.reason } : {}),
      arg,
    };

    appendReview(gateDir, logEntry);

    process.stdout.write(JSON.stringify(res));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      JSON.stringify({
        decision: "deny",
        reason: `foreman gate error: ${message}`,
      }),
    );
  }
}

main();
