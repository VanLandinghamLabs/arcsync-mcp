/**
 * Synthetic edge-id minting, shared by every display pass that adds edges.
 *
 * Each pass used to seed its own counter from `graph.edges.length`. That is
 * only safe while nothing has been removed: a pass that REMOVES edges (e.g.
 * `collapseIntegrations` dropping route→integration edges) leaves the array
 * shorter than the highest surviving `edge-N`, so the NEXT pass re-mints ids
 * that are still in use. Edge ids key the canvas edge map and its emphasis
 * bookkeeping, so a collision means one edge silently wins the slot — hover and
 * selection then highlight the wrong edge, or miss one entirely (#651).
 *
 * Seeding from the highest id actually present removes the coupling to array
 * length, so passes can be added, reordered, or made to remove edges without
 * reintroducing the bug.
 */

const NUMBERED_EDGE_ID = /^edge-(\d+)$/;

/**
 * Returns a minter that yields ids not present in `edges` and never repeats.
 *
 * Pass the graph's edges BEFORE any removals this pass performs: a removed id
 * is technically free again, but reusing it would make two different edges
 * share an id across a re-parse, which is worse than skipping a number.
 */
export function createEdgeIdMinter(edges: readonly { id: string }[]): () => string {
  // Seeding from the highest match of `edge-<digits>` is sufficient on its own:
  // any id that could collide with a candidate `edge-N` necessarily matches
  // that pattern, so it was already counted here. An id in some other shape
  // (`evt:a->b`, a parser's own scheme) can never equal `edge-<digits>`, so it
  // needs no guard. An earlier draft carried a `taken` set and re-tried on
  // collision; it was unreachable by construction.
  let highest = 0;
  for (const edge of edges) {
    const match = NUMBERED_EDGE_ID.exec(edge.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return () => {
    highest += 1;
    return `edge-${highest}`;
  };
}
