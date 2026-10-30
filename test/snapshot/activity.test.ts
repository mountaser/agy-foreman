import { describe, it, expect } from "vitest";
import { activityFor, classifyTool } from "../../src/snapshot/activity.js";
import type { Activity } from "../../src/snapshot/types.js";

const NOW = new Date("2026-10-30T14:30:00.000Z");

describe("classifyTool", () => {
  it("names the file for edits", () => {
    expect(
      classifyTool("write_to_file", { TargetFile: "C:\\wt\\internal\\render\\render.go" }),
    ).toEqual({ kind: "editing", target: "render.go" });
    expect(classifyTool("replace_file_content", { TargetFile: "/wt/a/b.ts" })).toEqual({
      kind: "editing",
      target: "b.ts",
    });
    expect(classifyTool("multi_replace_file_content", { TargetFile: "/wt/x.go" })).toEqual({
      kind: "editing",
      target: "x.go",
    });
  });

  it("names the file or folder for reads", () => {
    expect(classifyTool("view_file", { AbsolutePath: "/wt/.agy-task/brief.md" })).toEqual({
      kind: "reading",
      target: "brief.md",
    });
    expect(classifyTool("list_dir", { DirectoryPath: "/wt/internal" })).toEqual({
      kind: "reading",
      target: "internal",
    });
    expect(classifyTool("grep_search", { SearchPath: "/wt/src", Query: "foo" })).toEqual({
      kind: "reading",
      target: "src",
    });
    expect(classifyTool("read_url_content", { Url: "https://x.y/z" })).toEqual({
      kind: "reading",
    });
  });

  it("describes commands without ever showing them", () => {
    expect(classifyTool("run_command", { CommandLine: "go test ./..." })).toEqual({
      kind: "testing",
    });
    expect(classifyTool("run_command", { CommandLine: "npx vitest run" })).toEqual({
      kind: "testing",
    });
    expect(classifyTool("run_command", { CommandLine: "gofmt -l ." })).toEqual({
      kind: "testing",
    });
    expect(classifyTool("run_command", { CommandLine: "git status" })).toEqual({ kind: "git" });
    const odd = classifyTool("run_command", {
      CommandLine: "echo $([System.IO.File]::Delete('x'))",
    });
    expect(odd).toEqual({ kind: "command" });
    expect(JSON.stringify(odd)).not.toContain("echo");
  });

  it("recognises a test command that follows other commands", () => {
    expect(classifyTool("run_command", { CommandLine: "cd internal && go test ./..." })).toEqual({
      kind: "testing",
    });
  });

  it("does not take a word inside an argument for a test command", () => {
    expect(classifyTool("run_command", { CommandLine: 'git commit -m "fix tsc"' })).toEqual({
      kind: "git",
    });
    expect(classifyTool("run_command", { CommandLine: 'echo "go test"' })).toEqual({
      kind: "command",
    });
  });

  it("ignores tools that only poll or feed a terminal", () => {
    expect(classifyTool("command_status", { CommandId: "1" })).toBeUndefined();
    expect(classifyTool("read_terminal", {})).toBeUndefined();
    expect(classifyTool("send_command_input", { Input: "y" })).toBeUndefined();
  });

  it("returns undefined for unknown or missing tools", () => {
    expect(classifyTool("mystery_tool", {})).toBeUndefined();
    expect(classifyTool(undefined, {})).toBeUndefined();
  });
});

describe("activityFor", () => {
  it("records the tool that is running", () => {
    expect(
      activityFor(
        undefined,
        { toolName: "view_file", toolParams: { AbsolutePath: "/a/b.md" }, state: "RUNNING" },
        NOW,
      ),
    ).toEqual({ kind: "reading", target: "b.md", at: NOW.toISOString() });
  });

  it("switches to thinking when a step finishes", () => {
    const prev: Activity = { kind: "editing", target: "a.go", at: "2026-10-30T14:29:00.000Z" };
    expect(activityFor(prev, { toolName: "write_to_file", state: "DONE" }, NOW)).toEqual({
      kind: "thinking",
      at: NOW.toISOString(),
    });
  });

  it("keeps the first moment of thinking when more steps finish", () => {
    const prev: Activity = { kind: "thinking", at: "2026-10-30T14:29:50.000Z" };
    expect(activityFor(prev, { state: "done" }, NOW)).toBe(prev);
  });

  it("keeps the previous activity for unknown tools", () => {
    const prev: Activity = { kind: "editing", target: "a.go", at: "2026-10-30T14:29:00.000Z" };
    expect(activityFor(prev, { toolName: "mystery_tool", state: "RUNNING" }, NOW)).toBe(prev);
  });

  it("keeps testing while the command's status is polled", () => {
    const prev: Activity = { kind: "testing", at: "2026-10-30T14:29:00.000Z" };
    expect(activityFor(prev, { toolName: "command_status", state: "RUNNING" }, NOW)).toBe(prev);
  });

  it("starts nothing without a tool name", () => {
    expect(activityFor(undefined, { state: "RUNNING" }, NOW)).toBeUndefined();
  });
});
