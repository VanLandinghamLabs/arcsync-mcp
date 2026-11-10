import { fallbackRailFor, normalizeKey, readAttribute } from "./fallbackRail.js";
import type { ArchGraph } from "./types.js";
import { hasGraphArrays } from "./types.js";

/**
 * A budget names its subscribers inline. An SNS subscriber given as a reference
 * is already an edge to its topic; an email subscriber is not a resource, so it
 * becomes a `NOTIFY` rail on the budget. The rail counts addresses and never
 * prints one.
 */

const NOTIFY = "NOTIFY";

/** Every provider's spelling of a budget or budget action. A pattern rather than
 * a list because this pass sits in a size-budgeted lazy chunk; a non-AWS budget
 * it also matches has none of the keys read below, so it gets no rail. */
const BUDGET_TYPE = /budget/i;

/** Walks the whole bag, so one reader covers CloudFormation's
 * `NotificationsWithSubscribers[].Subscribers[]`, a budget action's top-level
 * `Subscribers`, and Terraform's and Pulumi's `subscriber_email_addresses`.
 * Keyed by JSON so an address given as a `Ref` still counts once. */
function collectEmails(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEmails(item, into);
    return;
  }
  if (!value || typeof value !== "object") return;
  const bag = value as Record<string, unknown>;
  const kind = readAttribute(bag, "subscriptiontype") ?? readAttribute(bag, "type");
  const address = readAttribute(bag, "address");
  if (String(kind).toUpperCase() === "EMAIL" && address != null) into.add(JSON.stringify(address));
  for (const [key, child] of Object.entries(bag)) {
    if (normalizeKey(key) !== "subscriberemailaddresses") collectEmails(child, into);
    else if (Array.isArray(child)) for (const a of child) into.add(JSON.stringify(a));
  }
}

export function railBudgetSubscribers(graph: ArchGraph): ArchGraph {
  if (!hasGraphArrays(graph)) return graph;
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    if (!BUDGET_TYPE.test(node.resourceType ?? "")) return node;
    if (node.fallbackRails?.some((rail) => rail.label === NOTIFY)) return node;
    const emails = new Set<string>();
    collectEmails(node.attributes, emails);
    if (emails.size === 0) return node;
    changed = true;
    const name = emails.size === 1 ? "email" : `${emails.size} emails`;
    const rail = fallbackRailFor({ ...node, id: `${node.id}#notify` }, NOTIFY, [], name);
    return { ...node, fallbackRails: [...(node.fallbackRails ?? []), rail] };
  });
  return changed ? { ...graph, nodes } : graph;
}
