export interface Diagnostic {
  level: "error" | "warning" | "info";
  block: string;
  line: number;
  column: number;
  message: string;
  suggestion?: string;
}

export interface Diagnostics {
  add(d: Diagnostic): void;
  list(): Diagnostic[];
  hasErrors(): boolean;
}

export const createDiagnostics = (): Diagnostics => {
  const items: Diagnostic[] = [];
  return {
    add: (d) => {
      items.push(d);
    },
    list: () => [...items],
    hasErrors: () => items.some((d) => d.level === "error"),
  };
};

export interface CappedDiagnostic extends Diagnostic {
  /** How many diagnostics with this level and message were folded into this one. */
  count?: number;
}

const LEVEL_ORDER: Record<Diagnostic["level"], number> = { error: 0, warning: 1, info: 2 };

/**
 * Diagram text is untrusted and unbounded, so every report of its diagnostics
 * goes through one cap: identical (level, message) pairs fold into the first,
 * errors sort first, and long author text is clipped.
 */
export const capDiagnostics = (
  list: readonly Diagnostic[],
  { max = 200, messageChars = 300 }: { max?: number; messageChars?: number } = {},
): CappedDiagnostic[] => {
  const byKey = new Map<string, CappedDiagnostic>();
  for (const d of list) {
    const key = `${d.level}\u0000${d.message}`;
    const seen = byKey.get(key);
    if (seen) seen.count = (seen.count ?? 1) + 1;
    else byKey.set(key, { ...d });
  }
  const clip = (text: string) =>
    text.length > messageChars ? `${text.slice(0, messageChars)}…` : text;
  return [...byKey.values()]
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
    .slice(0, max)
    .map((d) => ({
      ...d,
      block: clip(d.block),
      message: clip(d.message),
      ...(d.suggestion !== undefined && { suggestion: clip(d.suggestion) }),
    }));
};
