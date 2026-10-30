import { describe, expect, it } from "vitest";
import { planFiles } from "../../src/apply/blocks.js";

const fence = "```";
const join = (...lines: string[]): string => lines.join("\n");

describe("planFiles", () => {
  it("takes the block after a line naming one backticked path", () => {
    const text = join(
      "### Task 1: x",
      "- Create: `src/a.ts`",
      fence + "ts",
      "export const a = 1;",
      fence,
    );
    const r = planFiles(text, ["src/a.ts"]);
    expect(r.problems).toEqual([]);
    expect(r.files).toEqual([{ path: "src/a.ts", content: "export const a = 1;\n" }]);
  });

  it("takes the path from a first-line comment and removes that line", () => {
    const text = join(fence + "ts", "// src/b.ts", "export const b = 2;", fence);
    expect(planFiles(text, []).files).toEqual([
      { path: "src/b.ts", content: "export const b = 2;\n" },
    ]);
  });

  it("does not take a shebang or a prose comment as a path", () => {
    const text = join(
      fence + "sh",
      "#!/usr/bin/env bash",
      "echo hi",
      fence,
      fence + "ts",
      "// this is an example",
      "foo();",
      fence,
    );
    expect(planFiles(text, [])).toEqual({ files: [], problems: [] });
  });

  it("finds blocks inside indented list items and removes the indent", () => {
    const text = join(
      "- Create: `src/c.ts`",
      "  " + fence + "ts",
      "  export const c = 3;",
      "    nested();",
      "  " + fence,
    );
    expect(planFiles(text, ["src/c.ts"]).files).toEqual([
      { path: "src/c.ts", content: "export const c = 3;\n  nested();\n" },
    ]);
  });

  it("includes test blocks", () => {
    const text = join("- Test: `test/a.test.ts`", fence + "ts", "it('a', () => {});", fence);
    expect(planFiles(text, ["test/a.test.ts"]).files[0]?.path).toBe("test/a.test.ts");
  });

  it("reports two blocks for one path", () => {
    const text = join(
      "- Create: `src/a.ts`",
      fence + "ts",
      "// src/a.ts",
      "1;",
      fence,
      fence + "ts",
      "// src/a.ts",
      "2;",
      fence,
    );
    const r = planFiles(text, ["src/a.ts"]);
    expect(r.files).toEqual([]);
    expect(r.problems.map((p) => p.reason)).toEqual([
      expect.stringMatching(/two blocks/),
      expect.stringMatching(/two blocks/),
    ]);
  });

  it("reports an append instruction, case-insensitively", () => {
    const text = join("Append to `src/a.test.ts`:", fence + "ts", "it('x', () => {});", fence);
    const r = planFiles(text, ["src/a.test.ts"]);
    expect(r.files).toEqual([]);
    expect(r.problems[0]?.reason).toMatch(/ambiguous instruction: append/);
  });

  it("reports a modify instruction", () => {
    const text = join("- Modify: `src/a.ts`", fence + "ts", "export const a = 2;", fence);
    expect(planFiles(text, ["src/a.ts"]).problems[0]?.reason).toMatch(
      /ambiguous instruction: modify/,
    );
  });

  it.each(["../evil.sh", "/etc/x.sh", "C:/x/y.ts", "a\\b.ts", ".git/hooks/pre-commit.sh"])(
    "rejects the path %s",
    (p) => {
      const text = join(fence + "sh", "# " + p, "x", fence);
      const r = planFiles(text, []);
      expect(r.files).toEqual([]);
      expect(r.problems).toHaveLength(1);
    },
  );

  it("ignores a block with no path", () => {
    const text = join("Example:", fence + "ts", "foo();", fence);
    expect(planFiles(text, [])).toEqual({ files: [], problems: [] });
  });

  it("numbers problems by the 1-based block index", () => {
    const text = join(
      fence + "ts",
      "// src/ok.ts",
      "1;",
      fence,
      "Append to `src/x.ts`:",
      fence + "ts",
      "2;",
      fence,
    );
    const r = planFiles(text, []);
    expect(r.files.map((f) => f.path)).toEqual(["src/ok.ts"]);
    expect(r.problems.map((p) => p.block)).toEqual([2]);
  });
});

describe("planFiles with a file list", () => {
  const list = ["- Create: `src/m.mjs`", "- Test: `test/m.test.mjs`", ""];
  it("does not guess which listed file a bare block belongs to", () => {
    const text = join(...list, fence + "js", "export const m = 1;", fence);
    const r = planFiles(text, ["src/m.mjs", "test/m.test.mjs"]);
    expect(r.files).toEqual([]);
    expect(r.problems[0]?.reason).toMatch(/several files are listed/);
  });
  it("still takes each block's path from its first-line comment", () => {
    const text = join(
      ...list,
      fence + "js",
      "// src/m.mjs",
      "export const m = 1;",
      fence,
      fence + "js",
      "// test/m.test.mjs",
      "// test",
      fence,
    );
    const r = planFiles(text, ["src/m.mjs", "test/m.test.mjs"]);
    expect(r.problems).toEqual([]);
    expect(r.files.map((f) => f.path)).toEqual(["src/m.mjs", "test/m.test.mjs"]);
  });
});
