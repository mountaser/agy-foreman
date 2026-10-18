import { describe, it, expect } from "vitest";
import {
  renderBrief,
  renderProgress,
  progressFraction,
  RUN_PROMPT,
  EXPLORE_SCHEMA,
} from "../../src/pipeline/brief.js";

const full = renderBrief({
  kind: "implement",
  task: "Add refresh-token rotation.",
  date: "2026-10-17",
  touch: ["src/auth.ts"],
  leaveUntouched: ["src/db/"],
  testCommand: ["npm", "test"],
  skills: [{ name: "tdd", description: "Test first" }],
  lessons: ["Models live in src/db/models."],
  checklist: ["write code", "run tests"],
});

describe("renderBrief", () => {
  it("emits all blocks in order", () => {
    const order = [
      "<task>",
      "<context>",
      "<scope>",
      "<constraints>",
      "<verification>",
      "<skills>",
      "<lessons>",
      "<progress>",
      "<report>",
    ];
    const idx = order.map((t) => full.indexOf(t));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
  it("carries the key facts and rules", () => {
    for (const s of [
      "Add refresh-token rotation.",
      "Today is 2026-10-17.",
      "src/auth.ts",
      "src/db/",
      "npm test",
      "tdd",
      "Models live in src/db/models.",
      ".agy-task/progress.md",
      "Do not run git commit",
      "Do not edit tests, test-runner config",
      "Run one plain command per call",
    ]) {
      expect(full).toContain(s);
    }
  });
  it("never sets word or length limits", () => {
    expect(full).not.toMatch(/\bwords?\b|\bunder \d+|\bat most \d+/i);
  });
  it("omits optional blocks and uses the JSON answer format for explore", () => {
    const ex = renderBrief({ kind: "explore", task: "How does auth work?", date: "2026-10-17" });
    for (const t of ["<scope>", "<verification>", "<skills>", "<lessons>", "<progress>"])
      expect(ex).not.toContain(t);
    expect(ex).toMatch(/JSON/);
    expect(ex).toMatch(/file:line/);
  });
});

describe("progress and constants", () => {
  it("renders and measures the checklist", () => {
    const md = renderProgress(["a", "b", "c"]);
    expect(progressFraction(md)).toEqual({ done: 0, total: 3 });
    expect(
      progressFraction(md.replace("- [ ] a", "- [x] a").replace("- [ ] b", "- [X] b")),
    ).toEqual({ done: 2, total: 3 });
  });
  it("exports the run prompt and the explore schema", () => {
    expect(RUN_PROMPT).toBe("Execute the task described in .agy-task/brief.md.");
    expect(EXPLORE_SCHEMA).toMatchObject({ type: "object", required: ["summary", "citations"] });
  });
});
