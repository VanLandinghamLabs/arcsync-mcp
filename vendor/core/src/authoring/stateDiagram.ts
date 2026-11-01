import type { Diagnostic, Diagnostics } from "./diagnostics.js";
import type { SourceBlock } from "./source.js";

export interface StateDef {
  id: string;
  label?: string;
  description: string[];
  kind: "state" | "choice" | "fork" | "join";
  children?: StateRegion[];
  line: number;
}

export interface StateRegion {
  states: Map<string, StateDef>;
  transitions: StateTransition[];
}

export interface StateTransition {
  from: string;
  to: string;
  label?: string;
  line: number;
}

export interface StateAst {
  root: StateRegion;
}

interface Frame {
  def: StateDef;
  region: StateRegion;
  line: number;
  column: number;
}

type Ref = { kind: "start" | "history" | "id"; id: string; offset: number };

export const MAX_AUTHORED_STATES = 2_000;
export const MAX_AUTHORED_TRANSITIONS = 20_000;

/** Shared by every state block of one diagram, so repeating a block cannot multiply the caps. */
export interface StateBudget {
  states: number;
  transitions: number;
  statesCapped: boolean;
  transitionsCapped: boolean;
}

export const stateBudget = (): StateBudget => ({
  states: MAX_AUTHORED_STATES,
  transitions: MAX_AUTHORED_TRANSITIONS,
  statesCapped: false,
  transitionsCapped: false,
});
const MAX_DEPTH = 32;
const KINDS = new Set(["choice", "fork", "join"]);

const HEADER = /stateDiagram(?:-v2)?(?=\s|$)/y;
const KEYWORD = /(state|style|note|direction|classDef|class)(?=\s|$)/y;
const END_NOTE = /end +note *$/y;
const NOTE_SIDE = /(?:left|right) +of(?=\s)/y;
const AS = /as(?=\s)/y;
const ACCESSIBILITY = /(accTitle|accDescr) *([:{])/y;
const ID_CHAR = /[\p{L}\p{N}_]/u;

const newRegion = (): StateRegion => ({ states: new Map(), transitions: [] });

const stripComment = (text: string) => {
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quote = !quote;
    else if (!quote && ch === "%" && text[i + 1] === "%") return text.slice(0, i);
  }
  return text;
};

const stripMarkdown = (label: string) =>
  label.length >= 2 && label.startsWith("`") && label.endsWith("`") ? label.slice(1, -1) : label;

const parseError = (message: string, offset: number) =>
  Object.assign(new Error(message), { offset });

export const parseStateDiagram = (
  block: SourceBlock,
  diags: Diagnostics,
  budget: StateBudget = stateBudget(),
): StateAst => {
  const blockName = block.id ?? `block-${block.index + 1}`;
  const root = newRegion();
  const all = new Map<string, StateDef>();
  const stack: Frame[] = [];
  let skipDepth = 0;
  let accBlock = false;
  let note:
    | { def: StateDef | undefined; lines: string[]; line: number; column: number }
    | undefined;

  const report = (level: Diagnostic["level"], message: string, line: number, column: number) =>
    diags.add({ level, block: blockName, line, column, message });

  const current = () => stack[stack.length - 1]?.region ?? root;

  const ensure = (id: string, line: number, column: number): StateDef | undefined => {
    const existing = all.get(id);
    if (existing) return existing;
    if (budget.states <= 0) {
      if (!budget.statesCapped)
        report("error", "too many states in this diagram (over 2,000)", line, column);
      budget.statesCapped = true;
      return undefined;
    }
    budget.states--;
    const def: StateDef = { id, description: [], kind: "state", line };
    current().states.set(id, def);
    all.set(id, def);
    return def;
  };

  const parseLine = (t: string, line: number, lead: number) => {
    let p = lead;
    const column = lead + 1;
    const fail = (message: string, offset = p): never => {
      throw parseError(message, offset);
    };
    const skipSpace = () => {
      while (t[p] === " ") p++;
    };
    const atEnd = () => {
      skipSpace();
      return p >= t.length;
    };
    const rest = () => t.slice(p).trim();
    const sticky = (re: RegExp) => {
      re.lastIndex = p;
      const m = re.exec(t);
      if (m) p = re.lastIndex;
      return m;
    };
    const readId = () => {
      const start = p;
      while (p < t.length) {
        const ch = t[p] as string;
        if (ID_CHAR.test(ch)) p++;
        else if (ch === "-" && p > start && !t.startsWith("->", p + 1)) p++;
        else if (ch === "." && p > start) p++;
        else break;
      }
      return t.slice(start, p);
    };
    const readRef = (): Ref => {
      const offset = p;
      if (t.startsWith("[*]", p)) {
        p += 3;
        return { kind: "start", id: "[*]", offset };
      }
      for (const h of ["[H]", "[H*]"]) {
        if (t.startsWith(h, p)) {
          p += h.length;
          return { kind: "history", id: h, offset };
        }
      }
      const id = readId();
      if (!id) fail("expected a state id");
      if (t.startsWith(":::", p)) {
        report("warning", "::: is ignored on state diagrams", line, p + 1);
        p += 3;
        readId();
      }
      return { kind: "id", id, offset };
    };
    const warnHistory = (ref: Ref) => {
      if (ref.kind !== "history") return false;
      report("warning", "history states are not drawn", line, ref.offset + 1);
      return true;
    };
    const describe = (def: StateDef | undefined) => {
      p++;
      const text = rest();
      if (def && text) def.description.push(text);
    };

    const trimmed = t.trim();
    if (trimmed === "}") {
      if (!stack.pop()) fail("'}' has no matching state");
      return;
    }
    if (trimmed === "--") {
      const top = stack[stack.length - 1];
      if (!top) {
        report("warning", "concurrency outside a composite state is ignored", line, column);
        return;
      }
      top.region = newRegion();
      (top.def.children as StateRegion[]).push(top.region);
      return;
    }
    if (sticky(END_NOTE)) fail("'end note' has no matching note", lead);
    const acc = sticky(ACCESSIBILITY);
    if (acc) {
      report("warning", `${acc[1]} is ignored`, line, column);
      accBlock = acc[2] === "{" && !t.includes("}", p);
      return;
    }

    const keyword = sticky(KEYWORD)?.[1];
    if (keyword === "direction") {
      report("info", "direction is ignored", line, column);
      return;
    }
    if (keyword === "classDef" || keyword === "class" || keyword === "style") {
      report("warning", `${keyword} is ignored on state diagrams`, line, column);
      return;
    }
    if (keyword === "note") {
      skipSpace();
      if (t[p] === '"') {
        report("warning", "floating notes are not drawn", line, column);
        return;
      }
      if (!sticky(NOTE_SIDE)) fail("expected 'note left of' or 'note right of'");
      skipSpace();
      const idAt = p;
      const id = readId();
      if (!id) fail("expected a state id");
      skipSpace();
      if (t[p] === ":") describe(ensure(id, line, idAt + 1));
      else if (atEnd()) {
        const def = ensure(id, line, idAt + 1);
        note = { def, lines: [], line, column };
      } else fail(`unexpected text '${rest()}'`);
      return;
    }
    if (keyword === "state") {
      skipSpace();
      let label: string | undefined;
      if (t[p] === '"') {
        const close = t.indexOf('"', p + 1);
        if (close < 0) fail("unterminated string");
        label = stripMarkdown(t.slice(p + 1, close));
        p = close + 1;
        skipSpace();
        if (!sticky(AS)) fail("expected 'as'");
        skipSpace();
      }
      const idAt = p;
      const id = readId();
      if (!id) fail("expected a state id");
      skipSpace();
      let kind: StateDef["kind"] | undefined;
      if (t.startsWith("<<", p)) {
        const close = t.indexOf(">>", p + 2);
        if (close < 0) fail("expected '>>'");
        const name = t.slice(p + 2, close);
        if (!KINDS.has(name)) fail(`unknown state type '<<${name}>>'`);
        kind = name as StateDef["kind"];
        p = close + 2;
        skipSpace();
      }
      const opens = t[p] === "{";
      if (opens) {
        if (kind) fail(`a ${kind} state cannot have children`);
        p++;
      }
      if (t[p] !== ":" && !atEnd()) fail(`unexpected text '${rest()}'`);
      if (opens && stack.length >= MAX_DEPTH) {
        report("error", `states nested deeper than ${MAX_DEPTH}`, line, column);
        skipDepth = 1;
        return;
      }
      const def = ensure(id, line, idAt + 1);
      if (!def) return;
      if (label !== undefined) def.label = label;
      if (kind) def.kind = kind;
      if (t[p] === ":") describe(def);
      if (opens) {
        def.children ??= [newRegion()];
        stack.push({
          def,
          region: def.children[def.children.length - 1] as StateRegion,
          line,
          column,
        });
      }
      return;
    }

    const from = readRef();
    skipSpace();
    if (t.startsWith("-->", p)) {
      p += 3;
      skipSpace();
      const to = readRef();
      skipSpace();
      let label: string | undefined;
      if (t[p] === ":") {
        p++;
        label = rest() || undefined;
      } else if (!atEnd()) fail(`unexpected text '${rest()}'`);
      const history = warnHistory(from);
      if (warnHistory(to) || history) return;
      const ok = [from, to].every((r) => r.kind === "start" || ensure(r.id, line, r.offset + 1));
      if (!ok) return;
      if (budget.transitions <= 0) {
        if (!budget.transitionsCapped)
          report("error", "too many transitions in this diagram (over 20,000)", line, column);
        budget.transitionsCapped = true;
        return;
      }
      budget.transitions--;
      const transition: StateTransition = { from: from.id, to: to.id, line };
      if (label !== undefined) transition.label = label;
      current().transitions.push(transition);
      return;
    }
    if (from.kind === "start") fail("[*] can only be used in a transition", from.offset);
    if (warnHistory(from)) return;
    if (t[p] === ":") describe(ensure(from.id, line, from.offset + 1));
    else if (atEnd()) ensure(from.id, line, from.offset + 1);
    else fail(`unexpected text '${rest()}'`);
  };

  let sawHeader = false;
  let frontMatter: "none" | "in" | "done" = "none";
  for (const { text, line } of block.lines) {
    const trimmed = text.trim();
    const lead = text.length - text.trimStart().length;
    if (note) {
      END_NOTE.lastIndex = lead;
      if (END_NOTE.test(text)) {
        if (note.def && note.lines.length > 0) note.def.description.push(note.lines.join("\n"));
        note = undefined;
      } else if (trimmed) note.lines.push(trimmed);
      continue;
    }
    if (accBlock) {
      accBlock = !text.includes("}");
      continue;
    }
    if (!sawHeader && frontMatter !== "done" && trimmed === "---") {
      frontMatter = frontMatter === "none" ? "in" : "done";
      continue;
    }
    if (frontMatter === "in") continue;
    if (trimmed === "") continue;
    if (trimmed.startsWith("%%")) {
      if (trimmed.startsWith("%%{")) report("warning", "%%{init}%% is ignored", line, lead + 1);
      continue;
    }
    const code = stripComment(text);
    const body = code.trim();
    if (!sawHeader) {
      sawHeader = true;
      HEADER.lastIndex = lead;
      const match = HEADER.exec(code);
      if (!match) {
        report("error", "a state diagram must start with stateDiagram-v2", line, lead + 1);
        return { root };
      }
      const after = code.slice(HEADER.lastIndex);
      const word = after.trim();
      if (word) {
        const at = HEADER.lastIndex + after.indexOf(word) + 1;
        report("error", `unexpected text '${word}'`, line, at);
      }
      continue;
    }
    if (skipDepth > 0) {
      if (body === "}") skipDepth--;
      else if (body.endsWith("{")) skipDepth++;
      continue;
    }
    try {
      parseLine(code, line, lead);
    } catch (e) {
      if (!(e instanceof Error) || !("offset" in e)) throw e;
      report("error", e.message, line, (e.offset as number) + 1);
    }
  }

  if (note) report("error", "note is never closed (expected end note)", note.line, note.column);
  for (const open of stack) {
    report("error", `state '${open.def.id}' has no matching }`, open.line, open.column);
  }
  return { root };
};
