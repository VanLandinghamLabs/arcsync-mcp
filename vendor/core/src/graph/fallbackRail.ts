import { NODE_WIDTH } from "./edgeGeometry.js";
import type { FallbackRail, ResourceNode } from "./types.js";

/**
 * The rail STRIP itself — its geometry, its type tag, and the shape a fold
 * hands a renderer. Nothing about which resources fold, or why.
 *
 * Split out of `foldFallbackNodes` when `foldNetworkGlue` became its second
 * producer, and the split is load-bearing rather than tidiness: the Mermaid
 * renderer runs the networking fold, and reaching these four helpers through
 * the dead-letter pass dragged all of it — the fallback key tables, the
 * attribute walk, the redrive-policy reader — into the lazy chunk Mermaid
 * shares with the icon registry, taking it 9.7 KB -> 12.7 KB against an
 * 11 KB budget. This module imports nothing but `NODE_WIDTH` and a type.
 *
 * Both fold passes and both renderers go through here, which is the other half
 * of the point: `fallbackRailNameLeft` is the one formula the canvas and the
 * thumbnail must agree on exactly, and it has already drifted once when each
 * side owned a copy.
 */

/** Drawn height of one collapsed rail strip. */
export const FALLBACK_RAIL_H = 24;
/** Horizontal inset used at BOTH ends of a strip: the `↳` glyph's offset from
 * the left edge, and the name column's clearance from the right one. */
export const FALLBACK_RAIL_PAD_X = 8;
/** Left edge of the type tag, after the `↳` glyph. */
export const FALLBACK_RAIL_TAG_X = 20;
/** Rail text sizes. 12px because rails draw at the detail tier, which starts
 * at 80%, and nothing may paint under 9px on screen. */
export const FALLBACK_RAIL_TAG_FONT = 12;
export const FALLBACK_RAIL_NAME_FONT = 12;
export const FALLBACK_RAIL_DETAIL_FONT = 12;
/** Advance width RESERVED per tag character. Must exceed the drawn advance at
 * `FALLBACK_RAIL_TAG_FONT` with `charSpacing: 80` (~8.16px) — that margin, not
 * the gap below, is what keeps a long tag from running into the name column. */
export const FALLBACK_RAIL_TAG_CHAR_W = 9;
/** Gap between the tag and the name that follows it. */
const FALLBACK_RAIL_TAG_GAP = 8;
/** Vertical padding around the expanded policy block (top + bottom combined). */
export const FALLBACK_RAIL_DETAIL_PAD = 14;
/** Line box for one expanded policy line. */
export const FALLBACK_RAIL_DETAIL_LINE_H = 15;

/**
 * Attribute keys that name a CloudWatch log group rather than a queue or a
 * function. A log group is hidden as a node and leaves its name on its owner's
 * rail, so the tag has to say `LOGS` and not `DLQ`.
 */
export const FALLBACK_LOG_KEYS: ReadonlySet<string> = new Set([
  "loggroup",
  "loggroupname",
  "loggingconfig",
  "logconfiguration",
]);

/** Attribute keys are compared case- and separator-insensitively, so one entry
 * covers the CloudFormation, Terraform and Pulumi spellings of a property. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

/** One property by normalized key, so a CloudFormation `MinCapacity` and a
 * Terraform `min_capacity` reach the same reader. The folds' one shared
 * reader: a fix here reaches every fold. */
export function readAttribute(bag: Record<string, unknown> | undefined, wanted: string): unknown {
  return readAttributeEntry(bag, wanted)?.value;
}

/** `readAttribute`, plus the key as the parser spelled it. */
export function readAttributeEntry(
  bag: Record<string, unknown> | undefined,
  wanted: string,
): { key: string; value: unknown } | undefined {
  if (!bag) return undefined;
  for (const [key, value] of Object.entries(bag)) {
    if (normalizeKey(key) === wanted) return { key, value };
  }
  return undefined;
}

export function readString(
  bag: Record<string, unknown> | undefined,
  wanted: string,
): string | undefined {
  const value = readAttribute(bag, wanted);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A number, accepting the string form both `jsonencode` and `!Sub` produce.
 * An unresolved interpolation (`${local.env_vars.ecs_desired}`) is NOT a
 * number and comes back undefined rather than `NaN`. */
export function readNumber(
  bag: Record<string, unknown> | undefined,
  wanted: string,
): number | undefined {
  const value = readAttribute(bag, wanted);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}

/**
 * The rail's short type tag.
 *
 * Keyed off the normalized attribute key that declared a fallback fold, or —
 * for `foldNetworkGlue`, which keys on reference edges rather than on a bag —
 * off the join RESOURCE's own name. One switch rather than a table per pass:
 * the tag drives `fallbackRailNameLeft`, so two tables is how one renderer
 * would start reserving a width the other does not.
 */
export function railLabelFor(key: string): string {
  if (FALLBACK_LOG_KEYS.has(key)) return "LOGS";
  if (key === "onfailure") return "ON FAIL";
  if (key === "route") return "ROUTE";
  if (key === "instanceprofile") return "PROFILE";
  if (key === "subscription") return "SUB";
  if (key === "target") return "TARGET";
  if (key === "ingress") return "INGRESS";
  if (key === "egress") return "EGRESS";
  if (key === "listener") return "LISTENER";
  if (key === "invokeconfig") return "ASYNC";
  return "DLQ";
}

/**
 * One rail, from the node it folds.
 *
 * Exported so every producer builds the shape through exactly this function
 * rather than assembling it by hand — `displayFilter`'s log-group
 * compensation, `foldFallbackNodes`' own fold, and `foldNetworkGlue`'s two
 * networking rails all write the same four fields, and a hand-built one is how
 * their contents would quietly start disagreeing.
 *
 * `policy` is the caller's, not derived here: a dead-letter rail expands to a
 * redrive policy, a route's to its destination and target, and there is no
 * shared reading of a folded node that produces both.
 */
export function fallbackRailFor(
  folded: Pick<ResourceNode, "id" | "name">,
  label: string,
  policy: string[],
  /** Name to draw INSTEAD of the folded node's own. A route's rail reads
   * `0.0.0.0/0 -> IGW`, which says what the route IS where its synthesised
   * logical id says nothing. `nodeId` is untouched either way, so a viewer's
   * rename and a search match still key off the real resource. */
  name?: string,
): FallbackRail {
  return { nodeId: folded.id, name: name ?? folded.name, label, policy };
}

/**
 * Left edge of a rail's NAME, in the group-local space both renderers draw in
 * (x=0 is the node box's centre) — after the `↳` glyph and the type tag.
 *
 * Lives in core, not in either renderer, because BOTH must draw the name in the
 * same column and they have no other way to agree: the canvas cannot import
 * from `packages/backend`, and the backend renderer's own tests are skipped
 * wherever the native canvas binding is missing (CI included), so a duplicated
 * formula there ships unverified. It already drifted exactly that way — the
 * thumbnail's copy was missing this function's `FALLBACK_RAIL_TAG_GAP`, putting
 * its name column 8px left of the canvas's on every rail.
 */
export function fallbackRailNameLeft(label: string, cardWidth = NODE_WIDTH): number {
  return (
    -cardWidth / 2 +
    FALLBACK_RAIL_TAG_X +
    label.length * FALLBACK_RAIL_TAG_CHAR_W +
    FALLBACK_RAIL_TAG_GAP
  );
}

/** Drawn height a node's rails add to its box, collapsed or expanded. */
export function fallbackRailHeight(node: Pick<ResourceNode, "fallbackRails">, expanded = false) {
  const rails = node.fallbackRails;
  if (!rails || rails.length === 0) return 0;
  const strips = rails.length * FALLBACK_RAIL_H;
  if (!expanded) return strips;
  const lines = rails.reduce((sum, rail) => sum + rail.policy.length, 0);
  if (lines === 0) return strips;
  return strips + FALLBACK_RAIL_DETAIL_PAD + lines * FALLBACK_RAIL_DETAIL_LINE_H;
}

/** The logical id a reference names: `{ Ref: X }`, `{ "Fn::GetAtt": [X, ...] }`,
 * `${aws_sqs_queue.x.arn}`, or a literal id. */
export function referenceToken(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (!value.startsWith("${")) return value || undefined;
    return value
      .slice(2, -1)
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\.(id|arn)$/, "");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ref = (value as Record<string, unknown>).Ref;
  if (typeof ref === "string") return ref;
  const getAtt = (value as Record<string, unknown>)["Fn::GetAtt"];
  if (Array.isArray(getAtt) && typeof getAtt[0] === "string") return getAtt[0];
  if (typeof getAtt === "string") return getAtt.split(".")[0];
  return undefined;
}

export function namesNode(token: string, node: ResourceNode): boolean {
  return (
    node.id === token ||
    node.id.endsWith(`/${token}`) ||
    node.id.endsWith(`.${token}`) ||
    node.name === token
  );
}
