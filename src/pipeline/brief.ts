export interface BriefInput {
  kind: "implement" | "explore";
  task: string;
  date: string;
  touch?: string[];
  leaveUntouched?: string[];
  testCommand?: string[];
  skills?: { name: string; description: string }[];
  lessons?: string[];
  checklist?: string[];
}

export const RUN_PROMPT: string = "Execute the task described in .agy-task/brief.md.";

/**
 * Prompt for a resumed conversation. The model remembers the previous worktree's absolute paths
 * and tried to keep using them (found live on agy 1.4: it reported being "unable to switch" and
 * edited nothing), so say where it is now and that the old path is gone.
 */
export function resumePrompt(briefPath: string): string {
  const brief = briefPath.replace(/\\/g, "/");
  const dir = brief.replace(/\/\.agy-task\/brief\.md$/, "");
  return (
    `New instructions. Your working directory is now ${dir}. Every earlier worktree path no longer ` +
    `exists: do not use it. Read ${brief} now; it replaces every earlier brief and contains ` +
    `feedback on your previous attempt. Execute it inside ${dir} only.`
  );
}

export const EXPLORE_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["summary", "citations"],
  properties: {
    summary: { type: "string" },
    citations: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "line", "claim"],
        properties: {
          path: { type: "string" },
          line: { type: "integer" },
          claim: { type: "string" },
        },
      },
    },
    open_questions: {
      type: "array",
      items: { type: "string" },
    },
  },
};

export function renderBrief(i: BriefInput): string {
  const sections: string[] = [];

  // 1. <task>
  sections.push(`<task>\n${i.task}\n</task>`);

  // 2. <context>
  sections.push(
    `<context>\nToday is ${i.date}. Read the repository's AGENTS.md or GEMINI.md instructions if present.\n</context>`,
  );

  // 3. <scope> (implement only)
  if (i.kind === "implement") {
    const hasTouch = i.touch && i.touch.length > 0;
    const hasLeave = i.leaveUntouched && i.leaveUntouched.length > 0;
    if (hasTouch || hasLeave) {
      const scopeLines: string[] = [];
      if (hasTouch) {
        scopeLines.push("Touch:\n" + i.touch!.map((t) => `- ${t}`).join("\n"));
      }
      if (hasLeave) {
        scopeLines.push("Leave untouched:\n" + i.leaveUntouched!.map((u) => `- ${u}`).join("\n"));
      }
      sections.push(`<scope>\n${scopeLines.join("\n\n")}\n</scope>`);
    }
  }

  // 4. <constraints>
  sections.push(
    `<constraints>\n- Do not run git commit\n- Do not edit protected test files\n- Keep changes scoped to the task\n- Write and edit files only with your file tools (write_to_file, replace_file_content, multi_replace_file_content, edit_file, write_file; read with view_file or read_file); the shell cannot write files (no echo or Set-Content redirects, here-strings, python -c or node -e)\n- Do not run bash on Windows\n</constraints>`,
  );

  // 5. <verification> (implement only)
  if (i.kind === "implement" && i.testCommand && i.testCommand.length > 0) {
    sections.push(`<verification>\n${i.testCommand.join(" ")}\n</verification>`);
  }

  // 6. <skills>
  if (i.skills && i.skills.length > 0) {
    const lines = i.skills.map((s) => `- ${s.name}: ${s.description}`);
    sections.push(`<skills>\n${lines.join("\n")}\n</skills>`);
  }

  // 7. <lessons>
  if (i.lessons && i.lessons.length > 0) {
    const lines = i.lessons.map((l) => `- ${l}`);
    sections.push(`<lessons>\n${lines.join("\n")}\n</lessons>`);
  }

  // 8. <progress> (implement only)
  if (i.kind === "implement" && i.checklist && i.checklist.length > 0) {
    sections.push(
      `<progress>\nUpdate checkboxes in .agy-task/progress.md as items are completed.\n</progress>`,
    );
  }

  // 9. <report>
  if (i.kind === "explore") {
    sections.push(
      `<report>\nProvide findings conforming to the explore JSON schema, including file:line citations for each claim.\n</report>`,
    );
  } else {
    sections.push(
      `<report>\n1. What changed and why\n2. Files touched\n3. Verification outcome\n4. Open questions\n</report>`,
    );
  }

  return sections.join("\n\n") + "\n";
}

export function renderProgress(checklist: string[]): string {
  const items = checklist.map((item) => `- [ ] ${item}`).join("\n");
  return `# Progress\n\n${items}\n`;
}

export function progressFraction(markdown: string): { done: number; total: number } {
  let total = 0;
  let done = 0;
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*-\s*\[[ xX]\]/.test(line)) {
      total++;
      if (/^\s*-\s*\[[xX]\]/.test(line)) {
        done++;
      }
    }
  }
  return { done, total };
}
