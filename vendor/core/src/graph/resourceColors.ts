import { categoryForType, type ResourceCategory } from "./resourceCategory.js";
import { ResourceType } from "./types.js";

export interface NodeColors {
  bg: string;
  border: string;
  darkBg: string;
  darkBorder: string;
}

/** One palette per `ResourceCategory`; `generic` draws `DEFAULT_COLOR`. */
export const CATEGORY_COLORS: Readonly<Record<Exclude<ResourceCategory, "generic">, NodeColors>> = {
  networking: { bg: "#fed7aa", border: "#ea580c", darkBg: "#7c2d12", darkBorder: "#fb923c" },
  compute: { bg: "#dbeafe", border: "#2563eb", darkBg: "#1e3a5f", darkBorder: "#60a5fa" },
  storage: { bg: "#dcfce7", border: "#16a34a", darkBg: "#14532d", darkBorder: "#4ade80" },
  security: { bg: "#f3e8ff", border: "#9333ea", darkBg: "#3b0764", darkBorder: "#c084fc" },
  messaging: { bg: "#fef3c7", border: "#d97706", darkBg: "#78350f", darkBorder: "#fbbf24" },
  events: { bg: "#fce7f3", border: "#db2777", darkBg: "#831843", darkBorder: "#f472b6" },
  infra: { bg: "#f8fafc", border: "#94a3b8", darkBg: "#1e293b", darkBorder: "#64748b" },
};

export const DEFAULT_COLOR: NodeColors = {
  bg: "#f1f5f9",
  border: "#64748b",
  darkBg: "#334155",
  darkBorder: "#94a3b8",
};

/**
 * The node palette the canvas and the thumbnail both paint: the palette of the
 * type's category, so a card always matches the legend entry that counts it.
 * `aws_sfn_state` is the one exception — it is compute for the legend, but its
 * card is deliberately neutral (see the frontend's `stateThemeColors.ts`).
 */
export function colorsForType(resourceType: string): NodeColors {
  if (resourceType === ResourceType.SFN_STATE) return DEFAULT_COLOR;
  const category = categoryForType(resourceType as ResourceType);
  return category === "generic" ? DEFAULT_COLOR : CATEGORY_COLORS[category];
}

/**
 * The palette a rail's TYPE TAG paints, for the rails whose folded resource
 * belongs to a different family than the card it folded onto.
 *
 * A `PROFILE` rail is the case that forces this: an instance profile is a
 * security resource folded onto a compute instance, and drawing its tag in the
 * instance's blue says the profile is compute. `DLQ`, `LOGS` and `ON FAIL` are
 * deliberately absent — a dead-letter queue is the same family as the queue it
 * folded onto, so its tag stays the card's own ink, which is what keeps a rail
 * reading as a continuation of the card rather than as a second thing.
 *
 * Keyed off the drawn tag rather than the folded node's type, because a rail is
 * all either renderer has by the time it draws one: the node is gone.
 */
export const RAIL_TAG_COLORS: Readonly<Record<string, NodeColors>> = {
  ROUTE: CATEGORY_COLORS.networking,
  PROFILE: CATEGORY_COLORS.security,
};

/** The rail tag's own border hue, or `undefined` when it takes the card's.
 * Both renderers pass the result through `nodeCardInk` exactly as they do the
 * card's, so the AA compensation is applied once, in one place. */
export function railTagBorder(label: string, isDark: boolean): string | undefined {
  const colors = RAIL_TAG_COLORS[label];
  if (!colors) return undefined;
  return isDark ? colors.darkBorder : colors.border;
}
