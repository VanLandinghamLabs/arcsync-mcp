const AZAPI_RESOURCE_TYPES = new Set(["azapi_resource", "azapi_data_plane_resource"]);
const ARM_TYPE = /^(Microsoft\.[A-Za-z0-9]+\/[A-Za-z0-9/]+)(?:@[\w.-]+)?$/i;

/** The ARM type an `azapi_resource` names in its `type = "<ns>/<type>@<api>"`,
 * without the API version. Undefined for any other node, or when the value is
 * not a literal ARM type (an interpolation, say). */
export function azapiArmType(
  resourceType: unknown,
  attributes: Record<string, unknown> | undefined,
): string | undefined {
  if (typeof resourceType !== "string" || !AZAPI_RESOURCE_TYPES.has(resourceType)) return undefined;
  const type = attributes?.type;
  return typeof type === "string" ? ARM_TYPE.exec(type)?.[1] : undefined;
}
