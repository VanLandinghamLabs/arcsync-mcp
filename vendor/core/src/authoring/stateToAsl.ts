import { ASL_DEPTH_CAP } from "../graph/stateMachine.js";
import type { Diagnostics } from "./diagnostics.js";
import type { StateAst, StateDef, StateRegion } from "./stateDiagram.js";

export interface AslDefinition {
  StartAt: string;
  States: Record<string, unknown>;
}

interface Exit {
  to: string;
  label?: string;
}

interface RegionInfo {
  region: StateRegion;
  parent?: RegionInfo;
  owner?: StateDef;
  name: string;
}

interface Branch {
  start: string;
  ids: string[];
  set: Set<string>;
}

interface ForkMatch {
  join: string;
  branches: Branch[];
}

type ExitsOf = (id: string) => Exit[];

/** `[*]` can never be a state id, so it doubles as the "end of this region" target. */
const END = "[*]";
const START = "[*]";

/**
 * Compiles a parsed `stateDiagram-v2` into ASL that `decodeStateMachine` reads
 * and `expandStateMachines` draws. The result is drawing-only ASL: a Parallel
 * may carry `Choices`, a fork that does not resolve may emit a rule with no
 * `Condition`, and the ArcSync-only fields (`ArcSyncLabel`, `ArcSyncNextLabel`,
 * `ArcSyncEnd` rules, `ArcSyncDefaultEnd`) carry labels and ends to the
 * expander. Step Functions would accept none of these.
 */
export const stateAstToAsl = (
  ast: StateAst,
  blockId: string,
  diags: Diagnostics,
): AslDefinition => {
  const warn = (message: string, line: number) =>
    diags.add({ level: "warning", block: blockId, line, column: 1, message });

  const defs = new Map<string, StateDef>();
  const home = new Map<string, RegionInfo>();
  const infoOf = new Map<StateRegion, RegionInfo>();
  const transitions: Array<{
    from: string;
    to: string;
    label?: string;
    line: number;
    in: RegionInfo;
  }> = [];

  const walk = (info: RegionInfo) => {
    infoOf.set(info.region, info);
    for (const t of info.region.transitions) transitions.push({ ...t, in: info });
    for (const def of info.region.states.values()) {
      defs.set(def.id, def);
      home.set(def.id, info);
      const regions = def.children ?? [];
      regions.forEach((region, i) => {
        const name = regions.length > 1 ? `'${def.id}' region ${i + 1}` : `'${def.id}'`;
        walk({ region, parent: info, owner: def, name });
      });
    }
  };
  walk({ region: ast.root, name: "the diagram" });

  const exits = new Map<string, Exit[]>();
  const starts = new Map<RegionInfo, Array<{ id: string; line: number }>>();
  /** The one End exit ruling (a) gives a source leaving its composite; an explicit `[*]` exit replaces it. */
  const liftedEnds = new Map<string, Exit>();
  const addExit = (from: string, exit: Exit) => {
    const list = exits.get(from);
    if (list) list.push(exit);
    else exits.set(from, [exit]);
  };

  const homeOf = (id: string) => home.get(id) as RegionInfo;
  const ancestors = (info: RegionInfo) => {
    const chain: RegionInfo[] = [];
    for (let r: RegionInfo | undefined = info; r; r = r.parent) chain.push(r);
    return chain;
  };
  const lift = (id: string, target: RegionInfo) => {
    let current = id;
    for (let r = homeOf(current); r !== target; r = homeOf(current)) {
      current = (r.owner as StateDef).id;
    }
    return current;
  };

  for (const t of transitions.sort((a, b) => a.line - b.line)) {
    if (t.from === START && t.to === END) continue;
    if (t.from === START) {
      if (!ancestors(homeOf(t.to)).includes(t.in)) {
        warn(`[*] in ${t.in.name} cannot start at '${t.to}', which is outside it`, t.line);
        continue;
      }
      const to = lift(t.to, t.in);
      if (to !== t.to)
        warn(`transition into '${t.to}' inside composite '${to}' is drawn to '${to}'`, t.line);
      const list = starts.get(t.in) ?? [];
      list.push({ id: to, line: t.line });
      starts.set(t.in, list);
      continue;
    }
    const label = t.label === undefined ? {} : { label: t.label };
    if (t.to === END) {
      const exit = { to: END, ...label };
      const lifted = liftedEnds.get(t.from);
      const list = exits.get(t.from);
      if (lifted && list) {
        list[list.indexOf(lifted)] = exit;
        liftedEnds.delete(t.from);
      } else addExit(t.from, exit);
      continue;
    }
    const fromChain = ancestors(homeOf(t.from));
    const common = ancestors(homeOf(t.to)).find((r) => fromChain.includes(r)) as RegionInfo;
    const from = lift(t.from, common);
    const to = lift(t.to, common);
    const liftedFrom = from !== t.from;
    const liftedTo = to !== t.to;
    if (from === to && (liftedFrom || liftedTo)) {
      warn(
        liftedFrom && liftedTo
          ? `transition from '${t.from}' to '${t.to}' crosses concurrent regions of '${from}'; not drawn`
          : `transition from '${t.from}' to '${t.to}' stays inside composite '${from}'; not drawn`,
        t.line,
      );
      continue;
    }
    if (liftedFrom) {
      warn(
        `transition from '${t.from}' to '${t.to}' leaves composite '${from}'; drawn as an exit of '${from}'`,
        t.line,
      );
      if (!exits.get(t.from)?.some((e) => e.to === END)) {
        const exit = { to: END };
        liftedEnds.set(t.from, exit);
        addExit(t.from, exit);
      }
    }
    if (liftedTo)
      warn(`transition into '${t.to}' inside composite '${to}' is drawn to '${to}'`, t.line);
    addExit(from, { to, ...label });
  }

  const emitScope = (
    ids: string[],
    startAt: string,
    depth: number,
    exitsOf: ExitsOf,
  ): AslDefinition => {
    const inScope = new Set(ids);
    const kindOf = (id: string) => (defs.get(id) as StateDef).kind;
    const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
    (preds.get(startAt) as string[]).push(START);
    for (const id of ids) {
      for (const e of exitsOf(id)) preds.get(e.to)?.push(id);
    }

    const memo = new Map<string, ForkMatch | undefined>();
    const visiting = new Set<string>();

    const branchFrom = (fork: string, target: string, joins: Set<string>) => {
      const seen = new Set<string>();
      let reachesJoin = false;
      const stack = [target];
      while (stack.length > 0) {
        const s = stack.pop() as string;
        if (s === END || s === fork || !inScope.has(s)) return undefined;
        if (kindOf(s) === "join") {
          joins.add(s);
          reachesJoin = true;
          continue;
        }
        if (seen.has(s)) continue;
        seen.add(s);
        const inner = kindOf(s) === "fork" ? match(s) : undefined;
        if (inner) {
          for (const b of inner.branches) for (const id of b.ids) seen.add(id);
          seen.add(inner.join);
        }
        for (const e of exitsOf(inner ? inner.join : s)) stack.push(e.to);
      }
      return reachesJoin ? seen : undefined;
    };

    const computeMatch = (fork: string): ForkMatch | undefined => {
      const targets = exitsOf(fork).map((e) => e.to);
      if (targets.length === 0) return undefined;
      const joins = new Set<string>();
      const claimed = new Set<string>();
      const branches: Branch[] = [];
      for (const target of targets) {
        const set = branchFrom(fork, target, joins);
        if (!set || joins.has(target)) return undefined;
        for (const id of set) {
          if (claimed.has(id)) return undefined;
          claimed.add(id);
        }
        branches.push({ start: target, ids: ids.filter((id) => set.has(id)), set });
      }
      if (joins.size !== 1) return undefined;
      const join = [...joins][0] as string;
      const entered = (b: Branch) =>
        b.ids.every((id) =>
          (preds.get(id) as string[]).every((p) => b.set.has(p) || (p === fork && id === b.start)),
        );
      if (!branches.every(entered)) return undefined;
      if (!(preds.get(join) as string[]).every((p) => claimed.has(p))) return undefined;
      return { join, branches };
    };

    function match(fork: string): ForkMatch | undefined {
      if (memo.has(fork)) return memo.get(fork);
      if (visiting.has(fork)) return undefined;
      visiting.add(fork);
      const result = computeMatch(fork);
      visiting.delete(fork);
      memo.set(fork, result);
      return result;
    }

    const forks = ids.filter((id) => kindOf(id) === "fork");
    const fits = depth + 1 <= ASL_DEPTH_CAP;
    const parallels = new Map<string, ForkMatch>();
    const absorbed = new Set<string>();
    if (fits) {
      for (const f of forks) {
        const m = match(f);
        if (!m) continue;
        parallels.set(f, m);
        for (const b of m.branches) for (const id of b.ids) absorbed.add(id);
        absorbed.add(m.join);
      }
    }
    for (const f of forks) {
      if (absorbed.has(f)) parallels.delete(f);
      else if (!parallels.has(f)) {
        const reason = !fits && match(f) ? "is nested too deeply" : "has no single join";
        warn(`fork '${f}' ${reason}; drawn as separate states`, (defs.get(f) as StateDef).line);
      }
    }

    const kept = ids.filter((id) => !absorbed.has(id));
    const single = (e: Exit) => ({
      ...(e.to === END ? { End: true } : { Next: e.to }),
      ...(e.label === undefined ? {} : { ArcSyncNextLabel: e.label }),
    });
    const goTo = (e: Exit) => (e.to === END ? { ArcSyncEnd: true } : { Next: e.to });

    const rules = (def: StateDef, list: Exit[]) => {
      const unlabelled = list.filter((e) => e.label === undefined).length;
      const loose = def.kind === "fork";
      if (unlabelled > 1 && !loose) warn(`label every branch of '${def.id}'`, def.line);
      let option = 0;
      let fallback: Record<string, unknown> = {};
      const choices: Array<Record<string, unknown>> = [];
      for (const e of list) {
        if (e.label !== undefined) choices.push({ Condition: e.label, ...goTo(e) });
        else if (loose) choices.push(goTo(e));
        else if (unlabelled === 1) {
          fallback = e.to === END ? { ArcSyncDefaultEnd: true } : { Default: e.to };
        } else choices.push({ Condition: `option ${++option}`, ...goTo(e) });
      }
      return { Choices: choices, ...fallback };
    };

    const States: Record<string, unknown> = {};
    for (const id of kept) {
      const def = defs.get(id) as StateDef;
      const fork = parallels.get(id);
      const regions = (def.children ?? []).filter((r) => r.states.size > 0);
      if (regions.length > 0 && !fits) {
        warn(`composite '${id}' is nested too deeply; its states are not drawn`, def.line);
      }

      let branches: AslDefinition[] | undefined;
      let list = exitsOf(id);
      if (fork) {
        const join = fork.join;
        const inBranch: ExitsOf = (s) =>
          exitsOf(s).map((e) => (e.to === join ? { ...e, to: END } : e));
        branches = fork.branches.map((b) => emitScope(b.ids, b.start, depth + 1, inBranch));
        list = exitsOf(join);
      } else if (regions.length > 0 && fits) {
        branches = regions.map((r) => emitRegion(infoOf.get(r) as RegionInfo, depth + 1));
      }

      let shape: Record<string, unknown>;
      if (branches) {
        shape = {
          Type: "Parallel",
          Branches: branches,
          ...(list.length === 0
            ? { End: true }
            : list.length === 1
              ? single(list[0] as Exit)
              : rules(def, list)),
        };
      } else if (list.length === 0) shape = { Type: "Succeed" };
      else if (list.length === 1 && def.kind !== "choice") {
        shape = { Type: "Pass", ...single(list[0] as Exit) };
      } else shape = { Type: "Choice", ...rules(def, list) };
      States[id] = {
        ...shape,
        ...(def.label === undefined ? {} : { ArcSyncLabel: def.label }),
        ...(def.description.length > 0 ? { Comment: def.description.join("\n") } : {}),
      };
    }
    return { StartAt: startAt, States };
  };

  const emitRegion = (info: RegionInfo, depth: number): AslDefinition => {
    const ids = [...info.region.states.keys()];
    const list = starts.get(info) ?? [];
    const first = list[0];
    let startAt: string;
    if (first) {
      startAt = first.id;
      const second = list[1];
      if (second)
        warn(`more than one start in ${info.name}; starting at '${startAt}'`, second.line);
    } else {
      startAt = ids[0] as string;
      warn(
        `no start state in ${info.name}; starting at '${startAt}'`,
        (defs.get(startAt) as StateDef).line,
      );
    }
    return emitScope(ids, startAt, depth, (id) => exits.get(id) ?? []);
  };

  if (ast.root.states.size === 0) {
    warn("the diagram has no states", 1);
    return { StartAt: "End", States: { End: { Type: "Succeed" } } };
  }
  return emitRegion(infoOf.get(ast.root) as RegionInfo, 0);
};
