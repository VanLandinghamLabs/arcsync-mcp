import type { Diagnostics } from "./diagnostics.js";

export const MAX_SOURCE_CHARS = 200_000;

export interface SourceLine {
  text: string;
  line: number;
}

export interface SourceBlock {
  index: number;
  kind: "flow" | "state" | "unknown";
  id: string | undefined;
  title: string | undefined;
  lines: SourceLine[];
}

const FENCE_OPEN = /^\s*```+\s*([A-Za-z0-9_-]*)/;
const FENCE_CLOSE = /^\s*```+\s*$/;
const FLOW_START = /^(?:flowchart|graph)\b/;
const STATE_START = /^stateDiagram(?:-v2)?\b/;
const ID_COMMENT = /^\s*%%\s*diagram:\s*(\S.*)$/;
const TITLE_COMMENT = /^\s*%%\s*title:\s*(\S.*)$/;
const FRONT_MATTER_TITLE = /^title:\s*(\S.*)$/;

export const normaliseSource = (source: string): string =>
  source
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ");

const normalise = (source: string): string[] => normaliseSource(source).split("\n");

const frontMatterEnd = (lines: SourceLine[]): number => {
  const first = lines.findIndex((l) => l.text.trim() !== "");
  if (first < 0 || lines[first]?.text.trim() !== "---") return -1;
  return lines.findIndex((l, i) => i > first && l.text.trim() === "---");
};

const describeBlock = (
  index: number,
  lines: SourceLine[],
  openLine: number,
  diags: Diagnostics,
): SourceBlock => {
  let id: string | undefined;
  let title: string | undefined;
  for (const { text } of lines) {
    id ??= ID_COMMENT.exec(text)?.[1]?.trimEnd();
    title ??= TITLE_COMMENT.exec(text)?.[1]?.trimEnd();
  }

  const fmEnd = frontMatterEnd(lines);
  let bodyStart = 0;
  if (fmEnd >= 0) {
    const fmStart = lines.findIndex((l) => l.text.trim() !== "");
    title ??= lines
      .slice(fmStart + 1, fmEnd)
      .map((l) => FRONT_MATTER_TITLE.exec(l.text.trim())?.[1]?.trimEnd())
      .find((t) => t !== undefined);
    bodyStart = fmEnd + 1;
  }

  const head = lines
    .slice(bodyStart)
    .find((l) => l.text.trim() !== "" && !l.text.trim().startsWith("%%"));
  const text = head?.text.trim() ?? "";
  const kind = FLOW_START.test(text) ? "flow" : STATE_START.test(text) ? "state" : "unknown";

  if (kind === "unknown") {
    diags.add({
      level: "error",
      block: id ?? `block-${index + 1}`,
      line: head?.line ?? openLine,
      column: head ? head.text.length - head.text.trimStart().length + 1 : 1,
      message: "a block must start with flowchart, graph or stateDiagram-v2",
    });
  }
  return { index, kind, id, title, lines };
};

export const splitSource = (source: string, diags: Diagnostics): SourceBlock[] => {
  if (source.length > MAX_SOURCE_CHARS) {
    diags.add({
      level: "error",
      block: "source",
      line: 1,
      column: 1,
      message: "source is larger than 200,000 characters",
    });
    return [];
  }

  const all = normalise(source).map((text, i) => ({ text, line: i + 1 }));
  const raw: { lines: SourceLine[]; openLine: number }[] = [];
  let current: { lines: SourceLine[]; openLine: number } | undefined;
  let inOther = false;
  let sawOtherFence = false;

  for (const entry of all) {
    if (current) {
      if (FENCE_CLOSE.test(entry.text)) {
        raw.push(current);
        current = undefined;
      } else current.lines.push(entry);
    } else if (inOther) {
      if (FENCE_CLOSE.test(entry.text)) inOther = false;
    } else {
      const lang = FENCE_OPEN.exec(entry.text)?.[1];
      if (lang === "arcsync") current = { lines: [], openLine: entry.line };
      else if (lang !== undefined) {
        inOther = true;
        sawOtherFence = true;
      }
    }
  }
  if (current) {
    diags.add({
      level: "warning",
      block: `block-${raw.length + 1}`,
      line: current.openLine,
      column: 1,
      message: "arcsync fence is never closed",
    });
    raw.push(current);
  }

  if (raw.length === 0) {
    if (sawOtherFence || all.every((l) => l.text.trim() === "")) {
      diags.add({
        level: "error",
        block: "source",
        line: 1,
        column: 1,
        message: "no arcsync diagram found",
      });
      return [];
    }
    raw.push({ lines: all, openLine: 1 });
  }

  return raw.map((b, i) => describeBlock(i, b.lines, b.openLine, diags));
};
