import type { Diagnostics } from "./diagnostics.js";

export type MetaValue = string | number | boolean | null | MetaValue[] | { [k: string]: MetaValue };

export interface MetaPosition {
  block: string;
  line: number;
  column: number;
}

const MAX_DEPTH = 32;
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$-]/;
const WORD = /[A-Za-z_][A-Za-z0-9_-]*/y;
const LITERALS = new Map<string, MetaValue>([
  ["true", true],
  ["false", false],
  ["null", null],
]);
const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r" };

const metaError = (message: string, offset: number) =>
  Object.assign(new Error(message), { offset });

export const parseMeta = (
  text: string,
  at: MetaPosition,
  diags: Diagnostics,
): Record<string, MetaValue> | undefined => {
  let pos = 0;

  const fail = (message: string, offset = pos): never => {
    throw metaError(message, offset);
  };

  const skipSpace = () => {
    while (pos < text.length && /\s/.test(text[pos] as string)) pos++;
  };

  const parseString = (): string => {
    const start = pos;
    const quote = text[pos++];
    let out = "";
    while (pos < text.length) {
      const ch = text[pos++] as string;
      if (ch === quote) return out;
      if (ch === "\n") break;
      if (ch === "\\" && pos < text.length) {
        const next = text[pos++] as string;
        out += ESCAPES[next] ?? next;
      } else out += ch;
    }
    return fail("unterminated string", start);
  };

  const parseKey = (): string => {
    const ch = text[pos];
    if (ch === '"' || ch === "'") return parseString();
    if (ch === undefined || !IDENT_START.test(ch)) return fail("expected a key");
    const start = pos;
    while (pos < text.length && IDENT_PART.test(text[pos] as string)) pos++;
    return text.slice(start, pos);
  };

  const parseValue = (depth: number): MetaValue => {
    if (depth > MAX_DEPTH) fail("metadata is nested too deeply");
    const ch = text[pos];
    if (ch === "{") return parseObject(depth);
    if (ch === "[") return parseArray(depth);
    if (ch === '"' || ch === "'") return parseString();
    NUMBER.lastIndex = pos;
    const num = NUMBER.exec(text);
    if (num) {
      pos += num[0].length;
      return Number(num[0]);
    }
    WORD.lastIndex = pos;
    const word = WORD.exec(text)?.[0];
    if (word === undefined) return fail("expected a value");
    pos += word.length;
    return LITERALS.has(word) ? (LITERALS.get(word) as MetaValue) : word;
  };

  const parseObject = (depth: number): { [k: string]: MetaValue } => {
    pos++;
    const out: { [k: string]: MetaValue } = {};
    for (;;) {
      skipSpace();
      if (text[pos] === "}") {
        pos++;
        return out;
      }
      const key = parseKey();
      skipSpace();
      if (text[pos] !== ":") fail("expected ':'");
      pos++;
      skipSpace();
      Object.defineProperty(out, key, {
        value: parseValue(depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      skipSpace();
      if (text[pos] === ",") pos++;
      else if (text[pos] !== "}") fail("expected ',' or '}'");
    }
  };

  const parseArray = (depth: number): MetaValue[] => {
    pos++;
    const out: MetaValue[] = [];
    for (;;) {
      skipSpace();
      if (text[pos] === "]") {
        pos++;
        return out;
      }
      out.push(parseValue(depth + 1));
      skipSpace();
      if (text[pos] === ",") pos++;
      else if (text[pos] !== "]") fail("expected ',' or ']'");
    }
  };

  try {
    skipSpace();
    if (text[pos] !== "{") fail("expected '{'");
    const value = parseObject(0);
    skipSpace();
    if (pos < text.length) fail("unexpected text after '}'");
    return value;
  } catch (e) {
    if (!(e instanceof Error) || !("offset" in e)) throw e;
    const offset = e.offset as number;
    const before = text.slice(0, offset).split("\n");
    const lastLine = before[before.length - 1] as string;
    diags.add({
      level: "error",
      block: at.block,
      line: at.line + before.length - 1,
      column: before.length === 1 ? at.column + lastLine.length : lastLine.length + 1,
      message: e.message,
    });
    return undefined;
  }
};
