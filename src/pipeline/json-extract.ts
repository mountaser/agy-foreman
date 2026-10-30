// Gemini's answer to an explore job is meant to be one JSON object, but it often adds prose before
// or after it, or fences it. Find the object instead of failing the whole job.

/** The first top-level `{ ... }` in `text` that parses to an object, scanning past prose and strings. */
function firstObject(text: string): Record<string, unknown> | undefined {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const v: unknown = JSON.parse(text.slice(start, i + 1));
          if (v && typeof v === "object" && !Array.isArray(v)) {
            return v as Record<string, unknown>;
          }
        } catch {
          // not JSON; try the next "{"
        }
        break;
      }
    }
  }
  return undefined;
}

/** An object from the whole text, a fenced block, or the first object embedded in prose. */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  for (const m of text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g)) {
    const inner = firstObject(m[1]);
    if (inner) return inner;
  }
  return firstObject(text);
}
