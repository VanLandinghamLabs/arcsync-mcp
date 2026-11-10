/**
 * Telling apart the shapes `GET /graphs/{id}` answers with. They carry no
 * discriminant on the wire, and the published clients read them as they are,
 * so these guards go by what each exit of `handleGetGraph` always writes.
 */
import type {
  CanonGraphRead,
  CanonicalFieldsView,
  GraphRead,
  JobGraphRead,
  SeedGraphRead,
} from "./apiContract.js";

/** Resolved to a CANON by its own id: the row is nested under `canonical`. */
export function isCanonRead(r: GraphRead | CanonicalFieldsView): r is CanonGraphRead {
  return "canonical" in r && typeof r.canonical === "object" && r.canonical !== null;
}

/** A JOB# id followed to its CANON: the row spread at the top level, with the
 * `repoInfo` a bare JOB# row never has. */
export function isSeedRead(r: GraphRead): r is SeedGraphRead {
  return !isCanonRead(r) && "repoInfo" in r;
}

/** The caller's own JOB# row, passed through. */
export function isJobRead(r: GraphRead): r is JobGraphRead {
  return !isCanonRead(r) && !isSeedRead(r);
}

/**
 * The CANON fields, whichever shape carries them: `canonical` on a CANON read,
 * the top level on a seed-follow read. A JOB# row answers with its own fields,
 * none of which is `lastParsedAt`, which every CANON has. Also takes a
 * `GET /gallery/{id}` answer, a CANON spread like the seed-follow one.
 */
export function canonicalFieldsOf(r: GraphRead | CanonicalFieldsView): CanonicalFieldsView {
  return isCanonRead(r) ? r.canonical : r;
}
