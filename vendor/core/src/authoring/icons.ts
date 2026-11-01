import { GENERIC_ICON_IDS, ICON_SUBPATHS } from "../icons/iconAssets.js";

export type IconVendor = "aws" | "gcp" | "azure" | "generic";

export interface ResolvedIcon {
  type: string;
  icon: string;
}

/** Friendly id → canonical file-stem id, for names authors reach for that the
 * icon files spell differently. Every target must be a real vendor stem. */
export const ICON_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "aws:alb": "aws:elb",
  "aws:apigateway": "aws:api-gateway",
  "aws:aurora": "aws:rds",
  "aws:firehose": "aws:kinesis-firehose",
  "aws:http-api": "aws:api-gateway",
  "aws:nlb": "aws:elb",
  "aws:rest-api": "aws:api-gateway",
  "aws:sfn": "aws:step-functions",
  "aws:subnet": "aws:vpc",
  "azure:aks": "azure:kubernetes",
  "azure:app-service": "azure:app-services",
  "azure:event-hubs": "azure:event-hub",
  "azure:functions": "azure:function-apps",
  "azure:redis": "azure:redis-cache",
  "azure:service-bus-queue": "azure:service-bus",
  "azure:sql": "azure:sql-database",
  "azure:subnet": "azure:virtual-network",
  "azure:vm": "azure:virtual-machine",
  "azure:vnet": "azure:virtual-network",
  "gcp:functions": "gcp:cloud-functions",
  "gcp:gcs": "gcp:cloud-storage",
  "gcp:load-balancer": "gcp:cloud-load-balancing",
  "gcp:spanner": "gcp:cloud-spanner",
});

const VENDOR_TYPES = new Map<string, string>();
for (const [type, subpath] of Object.entries(ICON_SUBPATHS)) {
  const id = subpath.replace("/", ":").replace(/\.svg$/, "");
  if (!VENDOR_TYPES.has(id)) VENDOR_TYPES.set(id, type);
}

const GENERIC = new Set<string>(GENERIC_ICON_IDS);
const ALIASES = new Map(Object.entries(ICON_ALIASES));

export const resolveIcon = (id: string): ResolvedIcon | undefined => {
  const key = id.trim().toLowerCase();
  const canonical = ALIASES.get(key) ?? key;
  const generic = canonical.startsWith("generic:") ? canonical.slice("generic:".length) : canonical;
  if (GENERIC.has(generic)) return { type: "authored", icon: generic };
  const type = VENDOR_TYPES.get(canonical);
  return type === undefined ? undefined : { type, icon: canonical };
};

const vendorOf = (id: string): IconVendor => {
  const prefix = id.slice(0, id.indexOf(":"));
  return prefix === "aws" || prefix === "gcp" || prefix === "azure" ? prefix : "generic";
};

const ALL_IDS: readonly string[] = [
  ...new Set([...GENERIC_ICON_IDS, ...VENDOR_TYPES.keys(), ...ALIASES.keys()]),
].sort();

const MAX_SUGGEST_LENGTH = 64;
const MAX_DISTANCE = 3;

const distance = (a: string, b: string): number => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = cur;
  }
  return prev[b.length] as number;
};

export const suggestIcon = (id: string): string | undefined => {
  const key = id.trim().toLowerCase();
  if (key.length > MAX_SUGGEST_LENGTH) return undefined;
  let best: string | undefined;
  let bestDistance = MAX_DISTANCE + 1;
  for (const candidate of ALL_IDS) {
    if (Math.abs(candidate.length - key.length) >= bestDistance) continue;
    const d = distance(key, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
};

export const listIcons = (query?: string): { id: string; vendor: IconVendor }[] => {
  const q = query?.trim().toLowerCase() ?? "";
  return ALL_IDS.filter((id) => id.includes(q)).map((id) => ({ id, vendor: vendorOf(id) }));
};
