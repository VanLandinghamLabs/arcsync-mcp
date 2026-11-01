// Dependency-free on purpose: `containment.ts` needs `isSyntheticStateId`, and
// everything that imports containment — the Mermaid renderer among them —
// would otherwise pull the whole ASL parser in behind `expandStateMachines`.

/** Separator between a state machine's id and its synthetic state index.
 * Ids are index-based, never name-derived: ASL state names are arbitrary user
 * strings, so a name-derived id could collide with a real node id. */
export const SYNTHETIC_STATE_SEPARATOR = "#state:";

export function stateIdFor(sfnNodeId: string, index: number): string {
  return `${sfnNodeId}${SYNTHETIC_STATE_SEPARATOR}${index}`;
}

/** The tail every minted id ends with: the separator, this level's index, and
 * one `/<branch>:<index>` segment per Map/Parallel body it is nested inside
 * (see `mintGraph`'s `prefix`). Anchored at both ends of that tail so the
 * predicate below tests the SHAPE `stateIdFor`/`mintGraph` actually produce,
 * not merely the presence of the separator somewhere in the string. */
const SYNTHETIC_STATE_TAIL = new RegExp(`${SYNTHETIC_STATE_SEPARATOR}\\d+(?:/\\d+:\\d+)*$`);

/** Whether `id` names a state minted by this pass. The single predicate every
 * persistence path checks — a synthetic id must never reach
 * `DiagramOverrides`, `deletedNodes`, or a comment pin.
 *
 * Shape-matched rather than `includes`: a real node id that merely CONTAINS
 * the separator (nothing upstream forbids one — resource ids are engine- and
 * user-derived) would otherwise be refused every persisted write, which
 * fails in the quiet direction — a rename or a drag that silently does
 * nothing. Matching the full tail narrows that to an id that also ends in
 * `#state:<digits>`, which no engine can produce without deliberately
 * spelling this module's own separator. */
export function isSyntheticStateId(id: string): boolean {
  return SYNTHETIC_STATE_TAIL.test(id);
}
