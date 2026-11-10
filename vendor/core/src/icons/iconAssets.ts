import { lookupByType } from "../graph/typeLookup.js";
import { type ResourceNode, ResourceType } from "../graph/types.js";
import { azapiArmType } from "../parsers/terraform/azapiType.js";
import { AWS_ICON_FILENAMES } from "./awsIconRegistry.js";
import { AZURE_ICON_FILENAMES } from "./azureIconRegistry.js";
import { GCP_ICON_FILENAMES } from "./gcpIconRegistry.js";
import { unknownIconSubpath } from "./unknownIconFallback.js";

export { FALLBACK_ICON_SUBPATHS, unknownIconSubpath } from "./unknownIconFallback.js";

/** Drawn size of a node's service icon, in scene units. Both renderers scale
 *  the loaded bitmap to this box, so it also sets the text column's width
 *  (`estimateNodeHeight`'s `hasIcon` branch). */
export const ICON_SIZE = 32;

/**
 * `resourceType` → `<vendor>/<file>.svg`, relative to wherever the icon assets
 * happen to be rooted — `/icons/` over HTTP for the SPA, a directory on disk
 * for the thumbnail renderer. The vendor prefix is the only thing the three
 * registries don't already carry, and it is exactly what both renderers used
 * to bolt on themselves.
 *
 * Lives in core because the SPA canvas and the server-side thumbnail draw the
 * same node from the same registries and must not disagree about which file
 * that is — the drift class described in `estimateNodeHeight.ts`'s header, and
 * the reason `ICON_MAP` was moved off its hand-written GCP/Azure tables in
 * #719. A type absent here has no icon on either surface.
 */
export const ICON_SUBPATHS: Record<string, string> = {};

for (const [resourceType, filename] of Object.entries(AWS_ICON_FILENAMES)) {
  ICON_SUBPATHS[resourceType] = `aws/${filename}`;
}
for (const [resourceType, filename] of Object.entries(GCP_ICON_FILENAMES)) {
  ICON_SUBPATHS[resourceType] = `gcp/${filename}`;
}
for (const [resourceType, filename] of Object.entries(AZURE_ICON_FILENAMES)) {
  ICON_SUBPATHS[resourceType] = `azure/${filename}`;
}

export function iconSubpathFor(type: string): string | undefined {
  return lookupByType(ICON_SUBPATHS, type);
}

/** The generic icon set for hand-authored, non-cloud nodes. An id is the file
 * stem under `generic/`, written bare (`user`) or as `generic:user`. */
export const GENERIC_ICON_IDS = [
  "user",
  "browser",
  "mobile",
  "database",
  "queue",
  "service",
  "external",
] as const;

/** What an authored node draws when neither its icon nor its kind names one. */
export const DEFAULT_AUTHORED_ICON = "generic/service.svg";

const GENERIC_IDS: ReadonlySet<string> = new Set(GENERIC_ICON_IDS);

/** `aws:lambda` → `aws/lambda.svg`: every vendor asset the registries already
 * ship, addressed by its file stem, so authored icons reuse the IaC set. */
const VENDOR_ICON_IDS = new Map<string, string>(
  Object.values(ICON_SUBPATHS).map((subpath) => [
    subpath.replace("/", ":").replace(/\.svg$/, ""),
    subpath,
  ]),
);

function iconIdSubpath(id: unknown): string | undefined {
  if (typeof id !== "string") return undefined;
  const key = id.trim().toLowerCase();
  const generic = key.startsWith("generic:") ? key.slice("generic:".length) : key;
  if (GENERIC_IDS.has(generic)) return `generic/${generic}.svg`;
  return VENDOR_ICON_IDS.get(key);
}

/** An authored node's icon: its `icon` id, else its `kind` when that names a
 * generic icon, else the neutral default. Never undefined. */
export function authoredIconSubpath(attributes: Record<string, unknown> | undefined): string {
  return (
    iconIdSubpath(attributes?.icon) ?? iconIdSubpath(attributes?.kind) ?? DEFAULT_AUTHORED_ICON
  );
}

/** `iconSubpathFor` for a whole node: an authored node resolves its icon from
 * its attributes, an unknown one from its raw `resourceType`'s namespace, and
 * every other node from its type. */
export function iconSubpathForNode(
  node: Pick<ResourceNode, "type" | "attributes"> & Partial<Pick<ResourceNode, "resourceType">>,
): string | undefined {
  if (node.type === ResourceType.AUTHORED) return authoredIconSubpath(node.attributes);
  if (node.type === ResourceType.UNKNOWN)
    return unknownIconSubpath(
      azapiArmType(node.resourceType, node.attributes) ?? node.resourceType,
    );
  return iconSubpathFor(node.type);
}
