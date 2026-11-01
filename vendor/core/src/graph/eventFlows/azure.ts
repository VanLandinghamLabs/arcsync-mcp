/**
 * Azure event derivations: Event Grid subscription filters and Service Bus
 * subscription rules (SQL filters).
 */
import { deriveEventNames, parseSqlFilter } from "../filterExpr.js";
import type { ResourceNode } from "../types.js";
import type { DeriveContext, DerivedEvent } from "./context.js";
import { consumersOf, eventsFromFilter, firstBlock, subscriptionBase } from "./context.js";
import { resolveTfRef, stringValues } from "./refs.js";

export function armIncludedEventTypes(attrs: Record<string, unknown>): string[] | null {
  const filter = attrs.filter;
  if (filter == null || typeof filter !== "object" || Array.isArray(filter)) return null;
  return stringValues((filter as Record<string, unknown>).includedEventTypes);
}

export function armSubjectFilter(filter: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (typeof filter.subjectBeginsWith === "string")
    out.subjectBeginsWith = filter.subjectBeginsWith;
  if (typeof filter.subjectEndsWith === "string") out.subjectEndsWith = filter.subjectEndsWith;
  return Object.keys(out).length > 0 ? out : null;
}

export function deriveFromEventGridSubscription(
  sub: ResourceNode,
  { nodeIds, containsParent, neighbors }: DeriveContext,
): DerivedEvent[] {
  const attrs = sub.attributes;
  const isTf = sub.resourceType === "azurerm_eventgrid_event_subscription";
  const eventTypes = isTf ? stringValues(attrs.included_event_types) : armIncludedEventTypes(attrs);
  if (!eventTypes) return [];
  let busId: string | null;
  let subjectFilter: unknown;
  if (isTf) {
    const busRef = resolveTfRef(attrs.scope) ?? resolveTfRef(attrs.topic_id);
    busId = busRef && nodeIds.has(busRef) ? busRef : null;
    subjectFilter = attrs.subject_filter;
  } else {
    busId = containsParent.get(sub.id) ?? null;
    // Guaranteed a valid non-null object here: armIncludedEventTypes above only
    // returns non-null when attrs.filter passed the same object/array checks.
    subjectFilter = armSubjectFilter(attrs.filter as Record<string, unknown>);
  }
  const base = subscriptionBase(sub.id, busId, "azure", neighbors);
  return eventTypes.map((v) => ({
    ...base,
    name: v,
    attributes: {
      eventType: v,
      ...(subjectFilter !== undefined && subjectFilter !== null ? { subjectFilter } : {}),
    },
  }));
}

export function sqlExpressionOf(attrs: Record<string, unknown>, isTf: boolean): string | null {
  if (isTf) return typeof attrs.sql_filter === "string" ? attrs.sql_filter : null;
  const sqlFilter = firstBlock(attrs.sqlFilter);
  const expr = sqlFilter?.sqlExpression;
  return typeof expr === "string" ? expr : null;
}

export function deriveFromServiceBusRule(
  rule: ResourceNode,
  { nodeIds, containsParent, subTopicOf, neighbors }: DeriveContext,
): DerivedEvent[] {
  const attrs = rule.attributes;
  const isTf = rule.resourceType === "azurerm_servicebus_subscription_rule";
  const rawSubId = isTf
    ? resolveTfRef(attrs.subscription_id)
    : (containsParent.get(rule.id) ?? null);
  const subId = rawSubId && nodeIds.has(rawSubId) ? rawSubId : null;
  const topicRef = subId ? subTopicOf(subId) : null;
  const topicId = topicRef && nodeIds.has(topicRef) ? topicRef : null;

  const base = {
    busId: topicId,
    targets: subId ? consumersOf(subId, new Set([rule.id, subId, topicId]), neighbors) : [],
    absorbedIds: subId ? [rule.id, subId] : [rule.id],
    derivedFrom: rule.id,
    provider: "azure" as const,
  };

  const correlation = firstBlock(isTf ? attrs.correlation_filter : attrs.correlationFilter);
  if (correlation) {
    const label = correlation.label;
    if (typeof label === "string") {
      return [{ ...base, name: label, attributes: { eventType: label, filter: correlation } }];
    }
    const properties = firstBlock(correlation.properties);
    const propKeys = properties ? Object.keys(properties) : [];
    if (propKeys.length === 1 && typeof properties?.[propKeys[0]] === "string") {
      const value = properties[propKeys[0]] as string;
      return [{ ...base, name: value, attributes: { eventType: value, filter: correlation } }];
    }
    return [{ ...base, name: `${rule.name} filter`, attributes: { filter: correlation } }];
  }

  const sqlExpr = sqlExpressionOf(attrs, isTf);
  if (sqlExpr) {
    const ast = parseSqlFilter(sqlExpr);
    return eventsFromFilter(sqlExpr, ast ? deriveEventNames(ast) : null, base, rule.name);
  }

  return [];
}
