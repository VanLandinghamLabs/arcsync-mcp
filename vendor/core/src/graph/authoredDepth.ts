import { isAuthoredOrMarked, stringAttr } from "./authored.js";
import { normalizeKey } from "./fallbackRail.js";
import { type ResourceNode, ResourceType } from "./types.js";

/** Undefined for an IaC node: its own `description` is read by
 * `nodeDescriptionEntry`, and its `details`/`link` stay ordinary properties. */
function authoredText(
  node: Pick<ResourceNode, "type" | "attributes">,
  key: string,
): string | undefined {
  return isAuthoredOrMarked(node) ? stringAttr(node, key) : undefined;
}

export function authoredDescription(
  node: Pick<ResourceNode, "type" | "attributes">,
): string | undefined {
  return authoredText(node, "description");
}

type DescribedNode = Pick<ResourceNode, "type" | "attributes" | "cdkDefaults">;

/** Best first. `GroupDescription` is a security group's, `AlarmDescription` a
 * CloudWatch alarm's, and `Comment` what CloudFront and Route 53 call theirs. */
const IAC_DESCRIPTION_KEYS = ["description", "groupdescription", "alarmdescription", "comment"];

/** The comment CDK's `OriginAccessIdentity` sets when the author gives none. */
const CDK_OAI_DEFAULT_COMMENT = "Allows CloudFront to reach the bucket";

/** CloudFormation nests CloudFront's and Route 53's comment one level down, in
 * the resource's `*Config` property (`DistributionConfig.Comment`). CDK fills
 * a CloudFront function's with its generated `Name` when the author gave none,
 * and an origin access identity's with a stock sentence; neither describes
 * anything. */
function configComment(attributes: Record<string, unknown>): string | undefined {
  const name = attributes.Name;
  for (const [key, config] of Object.entries(attributes)) {
    if (!normalizeKey(key).endsWith("config")) continue;
    if (typeof config !== "object" || config === null || Array.isArray(config)) continue;
    for (const [inner, comment] of Object.entries(config)) {
      if (normalizeKey(inner) !== "comment" || typeof comment !== "string") continue;
      if (comment === name || comment === CDK_OAI_DEFAULT_COMMENT) continue;
      const trimmed = comment.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

/**
 * The description a node leads with, and the attribute it came from so a
 * property list can leave that one out: the author's on an authored node, the
 * resource's own on an IaC one. A nested comment has no `key`, since its parent
 * holds more than the comment. A derived event has none, and neither does a
 * value the template computes (`Fn::Sub`), which is not a string here, and
 * neither does a value CDK filled in (`cdkDefaults`).
 */
export function nodeDescriptionEntry(
  node: DescribedNode,
): { key?: string; value: string } | undefined {
  if (isAuthoredOrMarked(node)) {
    const value = authoredDescription(node);
    return value ? { key: "description", value } : undefined;
  }
  if (node.type === ResourceType.EVENT_TYPE) return undefined;
  const attributes = node.attributes ?? {};
  for (const wanted of IAC_DESCRIPTION_KEYS) {
    for (const key of Object.keys(attributes)) {
      if (normalizeKey(key) !== wanted || node.cdkDefaults?.includes(key)) continue;
      const value = stringAttr(node, key);
      if (value) return { key, value };
    }
  }
  const value = configComment(attributes);
  return value ? { value } : undefined;
}

export function nodeDescription(node: DescribedNode): string | undefined {
  return nodeDescriptionEntry(node)?.value;
}

/** The node's attributes without the one its description was read from. */
export function attributesWithoutDescription(node: DescribedNode): Record<string, unknown> {
  const hidden = nodeDescriptionEntry(node)?.key;
  return Object.fromEntries(
    Object.entries(node.attributes ?? {}).filter(([key]) => key !== hidden),
  );
}

export function authoredDetails(
  node: Pick<ResourceNode, "type" | "attributes">,
): string | undefined {
  return authoredText(node, "details");
}

const HTTP_LINK = /^https?:\/\/[^\s/?#]+/i;

/** The author's link, only when it is http(s): the value is untrusted text that
 * ends up in an `href`. */
export function authoredLink(node: Pick<ResourceNode, "type" | "attributes">): string | undefined {
  const link = authoredText(node, "link");
  if (!link || !HTTP_LINK.test(link)) return undefined;
  try {
    new URL(link);
    return link;
  } catch {
    return undefined;
  }
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The author's fill and stroke, each only when it is `#rgb` or `#rrggbb`. The
 * parser stores them unvalidated, so every renderer reads colours through here. */
export function authoredColors(node: Pick<ResourceNode, "type" | "attributes">): {
  fill?: string;
  stroke?: string;
} {
  if (!isAuthoredOrMarked(node)) return {};
  const colors: { fill?: string; stroke?: string } = {};
  for (const key of ["fill", "stroke"] as const) {
    const value = node.attributes?.[key];
    if (typeof value === "string" && HEX_COLOR.test(value)) colors[key] = value;
  }
  return colors;
}
