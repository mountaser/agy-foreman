// Gemini's answer to an explore job is meant to be one JSON object, but it often adds prose before
// or after it, or fences it. Find the object instead of failing the whole job.

/** Every top-level `{ ... }` in `text` that parses to an object, in text order, skipping prose. */
function* objectsIn(text: string): Generator<Record<string, unknown>> {
  let from = 0;
  for (let start = text.indexOf("{", from); start !== -1; start = text.indexOf("{", from)) {
    let depth = 0;
    let inString = false;
    let end = -1;
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
        end = i;
        break;
      }
    }
    if (end === -1) {
      from = start + 1;
      continue;
    }
    try {
      const v: unknown = JSON.parse(text.slice(start, end + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) {
        yield v as Record<string, unknown>;
        from = end + 1;
        continue;
      }
    } catch {
      // not JSON; look inside it for a real object
    }
    from = start + 1;
  }
}

/**
 * The first JSON object in the reply that `accept` likes (any object when omitted): the whole
 * text, or one embedded in prose or a code fence. Text order, so a leading answer beats a later
 * example.
 */
export function extractJsonObject(
  text: string,
  accept: (v: Record<string, unknown>) => boolean = () => true,
): Record<string, unknown> | undefined {
  for (const v of objectsIn(text)) {
    if (accept(v)) return v;
  }
  return undefined;
}
