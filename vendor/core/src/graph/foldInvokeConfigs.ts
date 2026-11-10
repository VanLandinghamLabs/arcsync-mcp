import {
  fallbackRailFor,
  namesNode,
  railLabelFor,
  readAttribute,
  readAttributeEntry,
  referenceToken,
} from "./fallbackRail.js";
import type { ArchGraph, FallbackRail, ResourceEdge, ResourceNode } from "./types.js";
import { EdgeType, hasGraphArrays, ResourceType } from "./types.js";

/**
 * Folds each Lambda async-invoke config into the function it configures, the way
 * an owned log group becomes a LOGS rail: the node goes, its settings ride on the
 * function as an ASYNC rail, and each destination it names gets an edge from the
 * function itself, since the function is what sends there.
 *
 * A destination keeps `OnFailure` as the edge's `viaProperty`, so
 * `foldFallbackNodes` still folds a dedicated failure queue onto the function as
 * an ON FAIL rail, as it did onto the config before.
 */

const INVOKE_CONFIG_TYPES: ReadonlySet<string> = new Set([
  "AWS::Lambda::EventInvokeConfig",
  "aws_lambda_function_event_invoke_config",
  "aws:lambda/functionEventInvokeConfig:FunctionEventInvokeConfig",
  "aws-native:lambda:EventInvokeConfig",
]);

const SETTING_KEYS = ["maximumretryattempts", "maximumeventageinseconds", "qualifier"] as const;

/** Every reference token in `value`: CloudFormation `Ref`/`Fn::GetAtt`, a
 * Terraform interpolation, or a plain name. */
function tokensIn(value: unknown, out: string[] = []): string[] {
  const token = referenceToken(value);
  if (token) out.push(token);
  else if (Array.isArray(value)) for (const item of value) tokensIn(item, out);
  else if (value && typeof value === "object") {
    for (const child of Object.values(value)) tokensIn(child, out);
  }
  return out;
}

/** `namesNode`, also accepting a Terraform attribute access other than `.id`/`.arn`
 * (`aws_lambda_function.fn.function_name`). */
function tokenNames(token: string, node: ResourceNode): boolean {
  if (namesNode(token, node)) return true;
  const cut = token.lastIndexOf(".");
  return cut > 0 && namesNode(token.slice(0, cut), node);
}

/** `readAttribute` through Terraform's block lists, which hcl2json wraps in arrays. */
function under(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value.map((item) => under(item, key));
  return value && typeof value === "object"
    ? readAttribute(value as Record<string, unknown>, key)
    : undefined;
}

const named = (value: unknown, node: ResourceNode): boolean =>
  tokensIn(value).some((token) => tokenNames(token, node));

function scalar(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.length > 0 && !value.startsWith("${")
    ? value
    : undefined;
}

function invokeConfigRail(
  node: ResourceNode,
  failures: ResourceNode[],
  successes: ResourceNode[],
): FallbackRail {
  const policy: string[] = [];
  for (const key of SETTING_KEYS) {
    const found = readAttributeEntry(node.attributes, key);
    const value = scalar(found?.value);
    if (found && value !== undefined) policy.push(`${found.key} ${value}`);
  }
  for (const target of failures) policy.push(`on failure → ${target.name}`);
  for (const target of successes) policy.push(`on success → ${target.name}`);

  const retries = scalar(readAttribute(node.attributes, "maximumretryattempts"));
  const age = scalar(readAttribute(node.attributes, "maximumeventageinseconds"));
  const summary = [
    retries !== undefined ? `retries ${retries}` : undefined,
    age !== undefined ? `max age ${age}s` : undefined,
  ].filter((part): part is string => part !== undefined);
  return fallbackRailFor(
    node,
    railLabelFor("invokeconfig"),
    policy,
    summary.length > 0 ? summary.join(" · ") : undefined,
  );
}

export function foldInvokeConfigs(graph: ArchGraph): ArchGraph {
  if (!hasGraphArrays(graph)) return graph;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const containerIds = new Set(
    graph.edges.filter((e) => e.type === EdgeType.CONTAINS).map((e) => e.source),
  );

  const folded = new Set<string>();
  const railsByOwner = new Map<string, FallbackRail[]>();
  const pending: ResourceEdge[] = [];

  for (const node of graph.nodes) {
    if (!INVOKE_CONFIG_TYPES.has(node.resourceType) || containerIds.has(node.id)) continue;

    const incident = graph.edges.filter(
      (e) =>
        e.type !== EdgeType.CONTAINS &&
        e.source !== e.target &&
        (e.source === node.id || e.target === node.id),
    );
    const neighbours = [
      ...new Set(incident.map((e) => (e.source === node.id ? e.target : e.source))),
    ]
      .map((id) => nodeById.get(id))
      .filter((n): n is ResourceNode => n !== undefined);

    const destinations = readAttribute(node.attributes, "destinationconfig");
    const onFailure = under(destinations, "onfailure");
    const onSuccess = under(destinations, "onsuccess");
    const fnName = readAttribute(node.attributes, "functionname");
    const lambdas = neighbours.filter((n) => n.type === ResourceType.LAMBDA_FUNCTION);
    // The function the config names; failing that (a Pulumi plan resolves the
    // reference away), the one function that is not one of its destinations.
    const owner =
      lambdas.find((n) => named(fnName, n)) ??
      (() => {
        const rest = lambdas.filter((n) => !named(destinations, n));
        return rest.length === 1 ? rest[0] : undefined;
      })();
    if (!owner) continue;

    folded.add(node.id);
    const failures: ResourceNode[] = [];
    const successes: ResourceNode[] = [];
    for (const other of neighbours) {
      if (other.id === owner.id) continue;
      const isFailure = named(onFailure, other);
      if (isFailure) failures.push(other);
      else if (named(onSuccess, other)) successes.push(other);
      // Every neighbour came from `incident`, so this always hits.
      const edge = incident.find(
        (e) => e.source === other.id || e.target === other.id,
      ) as ResourceEdge;
      const viaProperty = isFailure ? "OnFailure" : edge.viaProperty;
      pending.push({
        id: `fold-${node.id}-${other.id}`,
        source: owner.id,
        target: other.id,
        type: edge.type,
        ...(viaProperty ? { viaProperty } : {}),
      });
    }
    const rails = railsByOwner.get(owner.id) ?? [];
    rails.push(invokeConfigRail(node, failures, successes));
    railsByOwner.set(owner.id, rails);
  }

  if (folded.size === 0) return graph;

  const surviving = graph.edges.filter((e) => !folded.has(e.source) && !folded.has(e.target));
  const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const drawn = new Set(
    surviving.filter((e) => e.type !== EdgeType.CONTAINS).map((e) => pairKey(e.source, e.target)),
  );
  const minted: ResourceEdge[] = [];
  for (const edge of pending) {
    const key = pairKey(edge.source, edge.target);
    if (drawn.has(key)) continue;
    drawn.add(key);
    minted.push(edge);
  }

  return {
    ...graph,
    nodes: graph.nodes
      .filter((n) => !folded.has(n.id))
      .map((n) => {
        const rails = railsByOwner.get(n.id);
        return rails ? { ...n, fallbackRails: [...(n.fallbackRails ?? []), ...rails] } : n;
      }),
    edges: [...surviving, ...minted],
  };
}
