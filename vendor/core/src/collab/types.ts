/**
 * The comment, sticky-note and collaboration-socket wire contract, shared by
 * `ws-default/handler.ts`, the comment store and the canvas overlays. Type-only,
 * on its own subpath so no consumer has to reach the root barrel for it.
 */

export interface CommentReply {
  id: string;
  text: string;
  author: string;
  createdAt: string;
  updatedAt?: string;
}

export interface CommentPin {
  id: string;
  kind: "node" | "free";
  nodeId?: string;
  /** Free pins: the anchor point. Node pins: last-known node center, kept as a
   * fallback so the thread survives (orphaned) if the node is later removed. */
  x?: number;
  y?: number;
  text: string;
  author: string;
  createdAt: string;
  updatedAt?: string;
  /** Keyed (not array) so jsondiffpatch produces clean per-reply deltas. */
  replies?: Record<string, CommentReply>;
  /** Root-message acks: emoji -> authors who reacted. */
  reactions?: Record<string, string[]>;
  resolvedAt?: string;
  resolvedBy?: string;
}

/** A reply on a shared comment thread as returned by the comments API (#460). */
export interface CommentThreadReply extends CommentReply {
  /** Avatar URL snapshot of the reply author; may be absent. */
  authorAvatar?: string;
  /** Authenticated reads only: the caller authored this reply. */
  isMine?: boolean;
}

/**
 * A shared comment thread as returned by the comments API (#460). Extends the
 * CommentPin shape so the overlay/panel render path is unchanged. Author
 * identity (Auth0 `sub`) never crosses the wire — the server computes
 * `isMine`/`myReactions` per caller instead; `author` is a display-name
 * snapshot taken server-side at write time.
 */
export interface CommentThread extends CommentPin {
  replies?: Record<string, CommentThreadReply>;
  /** Avatar URL snapshot of the thread author; may be empty. */
  authorAvatar?: string;
  /** Authenticated reads only: the caller authored the root message. */
  isMine?: boolean;
  /** Authenticated reads only: emoji the caller has reacted with. */
  myReactions?: string[];
}

/** Client input for creating a thread — the server stamps id/author/createdAt. */
export interface CommentCreateInput {
  kind: "node" | "free";
  nodeId?: string;
  x?: number;
  y?: number;
  text: string;
}

export type StickyColor = "yellow" | "green" | "blue" | "pink";
export type StickySize = "s" | "m" | "l";

export interface StickyNote {
  id: string;
  x: number;
  y: number;
  text: string;
  color: StickyColor;
  size: StickySize;
  /** Set when the sticky is tethered to a node — it then follows the node. */
  nodeId?: string;
  author: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * Sent to the rest of a room after a `persist_unknown` (#2051): the edit may
 * have landed, but no ack or delta will announce it, so each recipient
 * re-reads the layout. A client that predates it ignores the unknown type.
 */
export interface WsResyncFrame {
  type: "resync";
  graphId: string;
}

/**
 * One slice of a `sync` frame too large for a single @connections post. `data`
 * is a slice of that frame's JSON text; the parts sharing a `syncId` join into
 * it. A client that predates this ignores the unknown type.
 */
export interface WsSyncPartFrame {
  type: "sync-part";
  syncId: string;
  index: number;
  total: number;
  data: string;
}

/**
 * The `code` field of the collaboration WebSocket's `error` frame — the wire
 * contract between `ws-default/handler.ts` (which posts it) and
 * `collaboration.ts` (which reads it). It lives here so renaming a code
 * breaks the build on both sides instead of silently on one.
 *
 * Client-side persistence failures that never travel the wire (a closed
 * socket) are NOT members: this union describes only what the server sends.
 */
export type WsErrorCode =
  | "lookup_truncated"
  | "graph_not_found"
  | "not_in_library"
  | "not_subscribed"
  | "session_expired"
  | "invalid_delta"
  | "persist_failed"
  /**
   * The write itself failed in a way that does not prove it did not land: a
   * timeout or reset after the request left, or a conditional check refusing
   * an SDK retry, which can be the first attempt's own commit. Retryable like
   * `version_conflict`, only after a resync: a resend could apply it twice.
   */
  | "persist_unknown"
  /**
   * Another write moved `overridesVersion` before this delta landed, so it was
   * computed against state the server has already replaced. Retryable, but only
   * after a resync: replaying the same delta would conflict again.
   */
  | "version_conflict"
  /**
   * The caller's role in the acting org is below Editor (spec §5.2). Never
   * retryable — the server decides the same way for every frame — so the
   * client should stop streaming edits. The frame also carries the REST 403
   * body (`errorCode: "ROLE_REQUIRED"`, `minimum`, `actual`) so one branch
   * serves both transports.
   */
  | "role_required"
  /**
   * The shared team layout would exceed its 300 KB cap after this edit. Never
   * retryable: the same edit is refused the same way until something is removed.
   */
  | "layout_too_large"
  /**
   * The connection already holds the per-connection cap of graph
   * subscriptions. Never retryable on this socket; a new one starts at zero,
   * which a reload gives it.
   */
  | "subscription_limit";
