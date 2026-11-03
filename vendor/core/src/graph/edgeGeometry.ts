export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CubicSegment {
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
  straight?: boolean;
}

/** The resource card's fixed shell width. Every card is this wide regardless
 * of its content, so a column of them lands on one reading edge and edges
 * attach at predictable anchors. See `nodeCardLayout.ts`. */
export const NODE_WIDTH = 288;
/** The SHORTEST card: identity row + footer, no property rows. Used as the
 * dimension fallback for a node nothing has sized yet. Literal rather than
 * derived because `nodeCardLayout.ts` imports NODE_WIDTH from here and the
 * dependency cannot run both ways; `nodeCardLayout.test.ts` asserts the two
 * agree. */
export const NODE_HEIGHT = 79;
export const ARROW_SIZE = 10;

const TENSION = 1 / 6;

export function catmullRomToBezier(points: Point[]): CubicSegment[] {
  if (points.length < 2) return [];

  if (points.length === 2) {
    const [p0, p3] = points;
    return [
      {
        p0,
        p1: { x: p0.x + (p3.x - p0.x) / 3, y: p0.y + (p3.y - p0.y) / 3 },
        p2: { x: p0.x + (2 * (p3.x - p0.x)) / 3, y: p0.y + (2 * (p3.y - p0.y)) / 3 },
        p3,
      },
    ];
  }

  const segments: CubicSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    segments.push({
      p0: p1,
      p1: {
        x: p1.x + (p2.x - p0.x) * TENSION,
        y: p1.y + (p2.y - p0.y) * TENSION,
      },
      p2: {
        x: p2.x - (p3.x - p1.x) * TENSION,
        y: p2.y - (p3.y - p1.y) * TENSION,
      },
      p3: p2,
    });
  }
  return segments;
}

export function pointsToCubicPath(points: Point[]): string {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }
  const segments = catmullRomToBezier(points);
  let d = `M ${segments[0].p0.x} ${segments[0].p0.y}`;
  for (const seg of segments) {
    d += ` C ${seg.p1.x} ${seg.p1.y} ${seg.p2.x} ${seg.p2.y} ${seg.p3.x} ${seg.p3.y}`;
  }
  return d;
}

/**
 * The cubic segments a basis spline is drawn from. `pointsToBasisCommands`
 * emits exactly these; sampling them is the only way to measure the curve
 * the canvas actually renders rather than its control polyline. The leading and
 * trailing straight `L` commands are modelled as degenerate segments so the
 * sampled path starts and ends where the drawn path does.
 */
export function basisSplineSegments(points: Point[]): CubicSegment[] {
  if (points.length < 2) return [];
  if (points.length === 2) {
    const [a, b] = points;
    return [
      {
        p0: a,
        p1: { x: (2 * a.x + b.x) / 3, y: (2 * a.y + b.y) / 3 },
        p2: { x: (a.x + 2 * b.x) / 3, y: (a.y + 2 * b.y) / 3 },
        p3: b,
        straight: true,
      },
    ];
  }

  const segs: CubicSegment[] = [];
  let x0 = Number.NaN;
  let y0 = Number.NaN;
  let x1 = Number.NaN;
  let y1 = Number.NaN;
  let state = 0;
  let cursor: Point = points[0];

  const cubicTo = (x: number, y: number) => {
    const seg: CubicSegment = {
      p0: cursor,
      p1: { x: (2 * x0 + x1) / 3, y: (2 * y0 + y1) / 3 },
      p2: { x: (x0 + 2 * x1) / 3, y: (y0 + 2 * y1) / 3 },
      p3: { x: (x0 + 4 * x1 + x) / 6, y: (y0 + 4 * y1 + y) / 6 },
    };
    segs.push(seg);
    cursor = seg.p3;
  };

  for (const { x, y } of points) {
    if (state === 0) {
      state = 1;
    } else if (state === 1) {
      state = 2;
    } else if (state === 2) {
      state = 3;
      const lineEnd = { x: (5 * x0 + x1) / 6, y: (5 * y0 + y1) / 6 };
      segs.push({ p0: points[0], p1: points[0], p2: lineEnd, p3: lineEnd, straight: true });
      cursor = lineEnd;
      cubicTo(x, y);
    } else {
      cubicTo(x, y);
    }
    x0 = x1;
    x1 = x;
    y0 = y1;
    y1 = y;
  }

  cubicTo(x1, y1);
  const last = { x: x1, y: y1 };
  segs.push({ p0: cursor, p1: cursor, p2: last, p3: last, straight: true });
  return segs;
}

export type BasisPathCommand =
  | ["M", number, number]
  | ["L", number, number]
  | ["C", number, number, number, number, number, number];

/**
 * A polyline as a uniform cubic B-spline, faithfully matching d3-shape's
 * `curveBasis` — the curve mermaid.js uses for flowchart edges (its default
 * `flowchart.curve: "basis"`).
 *
 * Unlike `pointsToCubicPath` (Catmull-Rom, which passes through every point),
 * a basis spline only *approaches* the interior points; it interpolates just
 * the first and last. The rendered curve type therefore emerges from the point
 * count, exactly as in mermaid: 2 points → a straight `L`; 3+ → a chain of
 * cubic `C` segments. No geometry special-casing is required.
 *
 * Returned as Fabric's absolute path-command arrays, which a `Path` takes
 * as-is, so the canvas never builds a string for Fabric to regex-parse back
 * (#2392). Values keep the 3-decimal rounding the string form always had.
 */
export function pointsToBasisCommands(points: Point[]): BasisPathCommand[] {
  if (points.length < 2) return [];

  const f = (n: number) => Number(n.toFixed(3));
  const segments = basisSplineSegments(points);

  const commands: BasisPathCommand[] = [["M", f(segments[0].p0.x), f(segments[0].p0.y)]];
  for (const seg of segments) {
    commands.push(
      seg.straight === true
        ? ["L", f(seg.p3.x), f(seg.p3.y)]
        : ["C", f(seg.p1.x), f(seg.p1.y), f(seg.p2.x), f(seg.p2.y), f(seg.p3.x), f(seg.p3.y)],
    );
  }
  return commands;
}

/** `pointsToBasisCommands` as an SVG path string. */
export function pointsToBasisPath(points: Point[]): string {
  return pointsToBasisCommands(points)
    .map((command) => command.join(" "))
    .join(" ");
}

/**
 * Dagre's intersectRect — finds where a line from a rectangle's center to a
 * target point intersects the rectangle's border. Ported directly from
 * dagre/lib/util.js `intersectRect`.
 */
export function intersectRect(rect: Rect, point: Point): Point {
  const dx = point.x - rect.x;
  const dy = point.y - rect.y;
  const w = rect.width / 2;
  const h = rect.height / 2;

  if (!dx && !dy) {
    return { x: rect.x, y: rect.y + h };
  }

  let sx: number;
  let sy: number;
  if (Math.abs(dy) * w > Math.abs(dx) * h) {
    sy = dy < 0 ? -h : h;
    sx = (sy * dx) / dy;
  } else {
    sx = dx < 0 ? -w : w;
    sy = (sx * dy) / dx;
  }

  return { x: rect.x + sx, y: rect.y + sy };
}

export interface NodeDims {
  width: number;
  height: number;
}

const DEFAULT_DIMS: NodeDims = { width: NODE_WIDTH, height: NODE_HEIGHT };

/**
 * Compute edge waypoints that match Dagre's edge routing algorithm:
 *
 * 1. Compute intermediate waypoints between source and target centers
 *    (mimicking Dagre's dummy node chain at the rank midpoint)
 * 2. Use intersectRect to compute where the edge exits the source border
 *    and enters the target border (Dagre's assignNodeIntersects step)
 * 3. Return [srcBorder, ...midpoints..., tgtBorder] — same structure
 *    as Dagre's edge.points output
 *
 * `srcDims`/`tgtDims` are per-endpoint so variable-height nodes anchor their
 * borders correctly. Defaults to the legacy fixed `NODE_WIDTH × NODE_HEIGHT`
 * for callers that don't know per-node sizes (e.g. unit tests).
 */
export function dagreStyleEdgePath(
  srcCenter: Point,
  tgtCenter: Point,
  srcDims: NodeDims = DEFAULT_DIMS,
  tgtDims: NodeDims = DEFAULT_DIMS,
): { path: string; waypoints: Point[] } {
  const srcRect: Rect = {
    x: srcCenter.x,
    y: srcCenter.y,
    width: srcDims.width,
    height: srcDims.height,
  };
  const tgtRect: Rect = {
    x: tgtCenter.x,
    y: tgtCenter.y,
    width: tgtDims.width,
    height: tgtDims.height,
  };

  const midY = (srcCenter.y + tgtCenter.y) / 2;
  const midX = (srcCenter.x + tgtCenter.x) / 2;
  const absDx = Math.abs(tgtCenter.x - srcCenter.x);
  const absDy = Math.abs(tgtCenter.y - srcCenter.y);

  let intermediates: Point[];
  if (absDy < 1 && absDx < 1) {
    intermediates = [];
  } else if (absDy >= absDx) {
    intermediates = [
      { x: srcCenter.x, y: midY },
      { x: tgtCenter.x, y: midY },
    ];
  } else {
    intermediates = [
      { x: midX, y: srcCenter.y },
      { x: midX, y: tgtCenter.y },
    ];
  }

  const firstWaypoint = intermediates.length > 0 ? intermediates[0] : tgtCenter;
  const lastWaypoint =
    intermediates.length > 0 ? intermediates[intermediates.length - 1] : srcCenter;

  const srcBorder = intersectRect(srcRect, firstWaypoint);
  const tgtBorder = intersectRect(tgtRect, lastWaypoint);

  const waypoints = [srcBorder, ...intermediates, tgtBorder];
  const path = pointsToCubicPath(waypoints);

  return { path, waypoints };
}

const BORDER_SLOP = 2;

// A correctly-routed endpoint sits on its node's rectangle border. A
// half-diagonal radius is not enough: on a wide, short node it admits points
// well above or below the box, and every point buried inside it.
export function onBorder(p: Point, center: Point, dims: NodeDims): boolean {
  const dx = Math.abs(p.x - center.x) - dims.width / 2;
  const dy = Math.abs(p.y - center.y) - dims.height / 2;
  return Math.max(dx, dy) >= -BORDER_SLOP && dx <= BORDER_SLOP && dy <= BORDER_SLOP;
}

/**
 * Pick the waypoints to draw an edge through.
 *
 * Prefers the real Dagre-routed polyline — `layoutGraph` stores it on
 * `ResourceEdge.points` — so the canvas follows the same routing mermaid
 * renders in the diagram view. Falls back to a synthetic source→target path
 * when the routed polyline is missing or no longer trustworthy.
 *
 * Trust is verified geometrically: the routed endpoints must land on the
 * source and target node borders. They will not when the endpoint is a
 * container (excluded from the flat Dagre layout and positioned separately)
 * or a node the user has moved since layout ran — in both cases the routed
 * polyline points at a stale location, so the synthetic path is used instead.
 * A move along a border's own axis can leave that endpoint on the border; the
 * edge then stays attached and keeps its old route.
 */
export function resolveEdgeWaypoints(
  routedPoints: Point[] | undefined,
  srcCenter: Point,
  tgtCenter: Point,
  srcDims: NodeDims = DEFAULT_DIMS,
  tgtDims: NodeDims = DEFAULT_DIMS,
): Point[] {
  if (routedPoints && routedPoints.length >= 2) {
    const first = routedPoints[0];
    const last = routedPoints[routedPoints.length - 1];
    if (onBorder(first, srcCenter, srcDims) && onBorder(last, tgtCenter, tgtDims)) {
      return routedPoints;
    }
  }
  return dagreStyleEdgePath(srcCenter, tgtCenter, srcDims, tgtDims).waypoints;
}

export function endTangentAngle(points: Point[]): number {
  if (points.length < 2) return 0;
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  return Math.atan2(last.y - prev.y, last.x - prev.x) * (180 / Math.PI);
}

export function startTangentAngle(points: Point[]): number {
  if (points.length < 2) return 0;
  const first = points[0];
  const second = points[1];
  return Math.atan2(first.y - second.y, first.x - second.x) * (180 / Math.PI);
}
