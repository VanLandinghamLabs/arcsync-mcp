/**
 * The library page's derivations, shared by the API (which computes them over
 * the whole library on read, #573) and the SPA (which renders from them). One
 * implementation so the server's counts and ordering cannot drift from what
 * the cards show.
 */

/** The fields every derivation here reads. List rows carry many more. */
export interface LibraryRow {
  graphId: string;
  status: string;
  repoUrl?: string;
  createdAt?: string;
  lastParsedAt?: string;
  /** LIBRARY# entries only. */
  repoKey?: string;
  /** JOB# rows only: the repoKey the parse will land on. */
  targetRepoKey?: string;
}

/** Status buckets shared by the Library status strip, the card status badge
 *  and the status filter chips. `parsing` covers pending/running so an
 *  in-flight parse renders the same way whichever API state name arrives. */
export type StatusKey = "synced" | "drift" | "failed" | "parsing" | "cancelled" | "other";

export function statusKey(status: string): StatusKey {
  if (status === "completed" || status === "synced") return "synced";
  if (status === "drift") return "drift";
  if (status === "failed") return "failed";
  if (status === "running" || status === "pending" || status === "parsing") return "parsing";
  if (status === "cancelled") return "cancelled";
  return "other";
}

/** Owner + repo path for any URL or bare string, with `.git` and trailing
 *  slashes normalized off. "https://github.com/acme/payments.git" →
 *  "acme/payments". The identity key for the connected-repo count. */
export function ownerRepoPath(repoUrl: string | undefined): string {
  // The API has shipped list items without repoUrl (upload-lane CANON rows);
  // a missing value must degrade to "no repo", not crash.
  if (!repoUrl) return "";
  const trimmed = repoUrl.replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || trimmed;
}

/** Timestamp a card dates itself by. `createdAt` on a library row is pinned
 *  when the repo is first added and never moves, so a reparse only shows up
 *  in the CANON-sourced `lastParsedAt`. */
export function lastActivityAt(item: { lastParsedAt?: string; createdAt?: string }): string {
  return item.lastParsedAt || item.createdAt || "";
}

/** Newest activity first — the order the library grid shows. */
export function byLastActivityDesc(
  a: { lastParsedAt?: string; createdAt?: string },
  b: { lastParsedAt?: string; createdAt?: string },
): number {
  return Date.parse(lastActivityAt(b)) - Date.parse(lastActivityAt(a));
}

export interface FoldedLibrary<T extends LibraryRow> {
  items: T[];
  /** library card graphId → the in-flight job graphId folded into it */
  adopted: Map<string, string>;
}

/**
 * A re-parse mints a fresh JOB# row for a repo the library already holds an
 * entry for, and the list surfaces that row as its own card until the parser
 * stamps it. Fold each in-flight job into the card it will land on so the
 * library keeps one card per repo. A settled job stays as its own row — it
 * carries the error and the retry.
 */
export function foldInFlightJobs<T extends LibraryRow>(items: T[]): FoldedLibrary<T> {
  const cardByRepoKey = new Map<string, string>();
  for (const item of items) {
    if (item.repoKey) cardByRepoKey.set(item.repoKey, item.graphId);
  }
  const adopted = new Map<string, string>();
  const kept = items.filter((item) => {
    if (item.repoKey || !item.targetRepoKey) return true;
    if (item.status !== "pending" && item.status !== "running") return true;
    const cardId = cardByRepoKey.get(item.targetRepoKey);
    if (cardId === undefined) return true;
    if (!adopted.has(cardId)) adopted.set(cardId, item.graphId);
    return false;
  });
  return { items: kept, adopted };
}

/** The library's aggregates, over every row, not one page of them. */
export interface LibrarySummary {
  /** Every row after folding, failed parses included ("N diagrams"). */
  total: number;
  /** Rows the grid pages through: `total` less the failed parses. */
  cards: number;
  synced: number;
  drift: number;
  failed: number;
  parsing: number;
  /** Distinct `owner/repo` across every row. */
  connectedRepos: number;
  /** Newest `lastActivityAt` across every row, "" when there is none. */
  lastActivityAt: string;
}

/**
 * Counts over folded rows. A row in `parsingIds` counts as parsing whatever
 * its own status says — a card with a re-parse in flight renders that way.
 */
export function summarizeLibrary(
  rows: readonly LibraryRow[],
  parsingIds: { has(graphId: string): boolean } = new Set<string>(),
): LibrarySummary {
  const summary: LibrarySummary = {
    total: rows.length,
    cards: 0,
    synced: 0,
    drift: 0,
    failed: 0,
    parsing: 0,
    connectedRepos: 0,
    lastActivityAt: "",
  };
  const repos = new Set<string>();
  let newest = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const bucket = parsingIds.has(row.graphId) ? "parsing" : statusKey(row.status);
    // "cancelled" has a pill but no strip cell and no filter chip, so it has
    // no counter — it still counts toward `cards`.
    if (bucket !== "other" && bucket !== "cancelled") summary[bucket] += 1;
    const repo = ownerRepoPath(row.repoUrl);
    if (repo) repos.add(repo);
    const at = lastActivityAt(row);
    const time = new Date(at).getTime();
    if (summary.lastActivityAt === "" || Number.isNaN(newest) || time > newest) {
      summary.lastActivityAt = at;
      newest = time;
    }
  }
  summary.cards = summary.total - summary.failed;
  summary.connectedRepos = repos.size;
  return summary;
}

export interface LibraryView<T extends LibraryRow> {
  /** Grid rows, newest activity first. A card an in-flight re-parse was
   *  folded into carries that job's id as `inFlightJobId`. */
  cards: (T & { inFlightJobId?: string })[];
  /** Failed parses: the Parse failures section, never the grid. */
  failed: T[];
  summary: LibrarySummary;
}

/** The whole library, folded, split and ordered, with its aggregates. */
export function buildLibraryView<T extends LibraryRow>(rows: T[]): LibraryView<T> {
  const folded = foldInFlightJobs(rows);
  const summary = summarizeLibrary(folded.items, folded.adopted);
  const cards: (T & { inFlightJobId?: string })[] = [];
  const failed: T[] = [];
  for (const row of folded.items) {
    if (statusKey(row.status) === "failed") {
      failed.push(row);
      continue;
    }
    const jobId = folded.adopted.get(row.graphId);
    cards.push(jobId === undefined ? row : { ...row, inFlightJobId: jobId });
  }
  cards.sort(byLastActivityDesc);
  return { cards, failed, summary };
}
