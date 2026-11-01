import type { ResourceNode } from "./types.js";
import { ResourceType } from "./types.js";

/**
 * Hand-authored nodes (`docs/superpowers/specs/2026-10-21-arcsync-diagram-syntax-and-interactive-embeds-design.md` §2):
 * `type: "authored"`, with `attributes.icon` (a namespaced id such as `user` or
 * `aws:lambda`), `attributes.kind` (free text such as `zone`), and any other
 * properties. Nothing here applies to an IaC-parsed node.
 */
export function isAuthored(node: Pick<ResourceNode, "type">): boolean {
  return node.type === ResourceType.AUTHORED;
}

/** Attributes an authored node carries as contract rather than as properties
 * to show: the card draws them as its icon, eyebrow and expander instead. */
export const AUTHORED_CONTRACT_KEYS: readonly string[] = [
  "icon",
  "kind",
  "authored",
  "Definition",
  "DefinitionString",
  "definition",
  "fill",
  "stroke",
  "description",
  "details",
];

/** An authored node, or a node of any type an author marked `authored: true`. */
export function isAuthoredOrMarked(node: Pick<ResourceNode, "type" | "attributes">): boolean {
  return isAuthored(node) || node.attributes?.authored === true;
}

export function stringAttr(
  node: Pick<ResourceNode, "attributes">,
  key: string,
): string | undefined {
  const value = node.attributes?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function authoredKindLabel(node: Pick<ResourceNode, "attributes">): string | undefined {
  const kind = stringAttr(node, "kind");
  return kind && kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** A container header for an authored node: `name`, or `Kind: name`. Undefined
 * for any other node, whose header keeps its type prefix. */
export function authoredHeaderLabel(node: ResourceNode, name: string): string | undefined {
  if (!isAuthored(node)) return undefined;
  const kind = authoredKindLabel(node);
  return kind ? `${kind}: ${name}` : name;
}

/** The card eyebrow an authored node shows in place of a provider type. */
export function authoredEyebrow(node: Pick<ResourceNode, "attributes">): string {
  const kind = stringAttr(node, "kind");
  if (kind) return kind;
  const icon = stringAttr(node, "icon");
  return icon ? icon.slice(icon.indexOf(":") + 1) : "";
}
