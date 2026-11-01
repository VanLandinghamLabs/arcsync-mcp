/**
 * AWS event derivations: EventBridge rules (CloudFormation and Terraform
 * spellings) and SNS subscription filter policies.
 */

import type { ResourceNode } from "../types.js";
import { ResourceType } from "../types.js";
import type { DeriveContext, DerivedEvent } from "./context.js";
import { consumersOf, soleNeighborOfType } from "./context.js";
import { parsePattern, resolveTfRef, scopedCfnRef, stringValues } from "./refs.js";

type RuleEventBase = Omit<DerivedEvent, "name" | "attributes">;

function eventsFromRulePattern(
  pattern: Record<string, unknown>,
  base: RuleEventBase,
  ruleName: string,
): DerivedEvent[] {
  const detailTypes = stringValues(pattern["detail-type"]);
  if (detailTypes) {
    return detailTypes.map((dt) => ({
      ...base,
      name: dt,
      attributes: { detailType: dt, pattern },
    }));
  }
  const sources = stringValues(pattern.source);
  if (sources) {
    return sources.map((s) => ({
      ...base,
      name: `source: ${s}`,
      attributes: { source: s, pattern },
    }));
  }
  return [{ ...base, name: `${ruleName} pattern`, attributes: { pattern } }];
}

export function deriveFromCfnRule(
  rule: ResourceNode,
  { nodeIds, eventBuses }: DeriveContext,
): DerivedEvent[] {
  const attrs = rule.attributes;
  const pattern = parsePattern(attrs.EventPattern);
  if (!pattern) return [];
  const busId =
    scopedCfnRef(attrs.EventBusName, rule.id, nodeIds) ??
    (typeof attrs.EventBusName === "string" ? (eventBuses.get(attrs.EventBusName) ?? null) : null);
  const targets: string[] = [];
  if (Array.isArray(attrs.Targets)) {
    for (const t of attrs.Targets) {
      const id = scopedCfnRef((t as Record<string, unknown>)?.Arn, rule.id, nodeIds);
      if (id) targets.push(id);
    }
  }
  return eventsFromRulePattern(
    pattern,
    { busId, targets, absorbedIds: [rule.id], derivedFrom: rule.id, provider: "aws" },
    rule.name,
  );
}

export function deriveFromTfRule(
  rule: ResourceNode,
  { nodeIds, targetsByRule, eventBuses, neighbors, nodesById }: DeriveContext,
): DerivedEvent[] {
  const pattern = parsePattern(rule.attributes.event_pattern ?? rule.attributes.eventPattern);
  if (!pattern) return [];
  const busAttr = rule.attributes.event_bus_name ?? rule.attributes.eventBusName;
  const busRef = resolveTfRef(busAttr);
  let busId = busRef && nodeIds.has(busRef) ? busRef : null;
  if (!busId && typeof busAttr === "string") busId = eventBuses.get(busAttr) ?? null;
  if (!busId && rule.resourceType === "aws:cloudwatch/eventRule:EventRule") {
    busId = soleNeighborOfType(rule.id, ResourceType.EVENTBRIDGE_BUS, neighbors, nodesById);
  }
  const linked = targetsByRule.get(rule.id) ?? { targetIds: [], absorbedIds: [] };
  return eventsFromRulePattern(
    pattern,
    {
      busId,
      targets: linked.targetIds,
      absorbedIds: [rule.id, ...linked.absorbedIds],
      derivedFrom: rule.id,
      provider: "aws",
    },
    rule.name,
  );
}

export function deriveFromSnsSubscription(
  sub: ResourceNode,
  { nodeIds, neighbors, nodesById }: DeriveContext,
): DerivedEvent[] {
  const isCfn = sub.resourceType === "AWS::SNS::Subscription";
  const isPulumi = sub.resourceType === "aws:sns/topicSubscription:TopicSubscription";
  const rawPolicy = isCfn
    ? sub.attributes.FilterPolicy
    : (sub.attributes.filter_policy ?? sub.attributes.filterPolicy);
  const policy = parsePattern(rawPolicy);
  if (!policy || Object.keys(policy).length === 0) return [];
  let topicRef = isCfn
    ? scopedCfnRef(sub.attributes.TopicArn, sub.id, nodeIds)
    : resolveTfRef(sub.attributes.topic_arn ?? sub.attributes.topic);
  let endpointRef = isCfn
    ? scopedCfnRef(sub.attributes.Endpoint, sub.id, nodeIds)
    : resolveTfRef(sub.attributes.endpoint);
  if (isPulumi) {
    topicRef ??= soleNeighborOfType(sub.id, ResourceType.SNS_TOPIC, neighbors, nodesById);
    if (!endpointRef) {
      const busId0 = topicRef && nodeIds.has(topicRef) ? topicRef : null;
      const others = consumersOf(sub.id, new Set([sub.id, busId0]), neighbors);
      endpointRef = others.length === 1 ? others[0] : null;
    }
  }
  const busId = topicRef && nodeIds.has(topicRef) ? topicRef : null;
  const targets = endpointRef && nodeIds.has(endpointRef) ? [endpointRef] : [];
  const base = {
    busId,
    targets,
    absorbedIds: [sub.id],
    derivedFrom: sub.id,
    provider: "aws" as const,
  };

  const keys = Object.keys(policy);
  const soleValues = keys.length === 1 ? stringValues(policy[keys[0]]) : null;
  if (soleValues) {
    return soleValues.map((v) => ({ ...base, name: v, attributes: { filterPolicy: policy } }));
  }
  return [{ ...base, name: `${sub.name} filter`, attributes: { filterPolicy: policy } }];
}
