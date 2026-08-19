/**
 * The trail, in two segments:
 *
 * 1. TRAIL_UV - the path traced from the cursor video, as fractions of the
 *    mountain's screen box. This part of the route is known-good.
 * 2. A stair extension appended at runtime, carrying the route from where the
 *    trace ended (the old summit position) up to the monastery's true
 *    position, which the summit anchor pins exactly.
 *
 * The mapping is calibrated on the TRACED portion only: base anchor = first
 * traced point, and the traced climb spans a fixed fraction of the full
 * base-to-summit height. Calibrating on the extension's endpoint instead would
 * let a guessed point stretch the entire known-good route.
 */
export const TRAIL_UV = [
  { u: 0.051, v: 0.9307 },
  { u: 0.0776, v: 0.8901 },
  { u: 0.0994, v: 0.8459 },
  { u: 0.1185, v: 0.8003 },
  { u: 0.1363, v: 0.7532 },
  { u: 0.1532, v: 0.7058 },
  { u: 0.1714, v: 0.6595 },
  { u: 0.1855, v: 0.6106 },
  { u: 0.2053, v: 0.5642 },
  { u: 0.2352, v: 0.5267 },
  { u: 0.2808, v: 0.5194 },
  { u: 0.2808, v: 0.5016 },
  { u: 0.3263, v: 0.5117 },
  { u: 0.3714, v: 0.5182 },
  { u: 0.4159, v: 0.5049 },
  { u: 0.4612, v: 0.5145 },
  { u: 0.5072, v: 0.5203 },
  { u: 0.5475, v: 0.5177 },
  { u: 0.5823, v: 0.5502 },
  { u: 0.6024, v: 0.5214 },
  { u: 0.6202, v: 0.4741 },
  { u: 0.633, v: 0.4246 },
  { u: 0.6536, v: 0.3802 },
  { u: 0.6615, v: 0.3353 },
];

/**
 * How much of the total base->summit rise the traced portion covers. The
 * trace ended at the old, lower monastery; the rebuilt one sits higher. 0.72
 * means: the trace climbs 72% of the way, the stair extension does the rest.
 * If trekkers turn uphill too early or too late, this is the knob.
 */
export const TRACED_CLIMB_FRACTION = 0.72;

export function buildTrail(anchors) {
  const { baseX, baseY, summitX, summitY } = anchors;
  const first = TRAIL_UV[0];
  const last = TRAIL_UV[TRAIL_UV.length - 1];

  // scale so the traced portion spans its fraction of the full climb
  const sx = (summitX - baseX) * 0.92 / (last.u - first.u);
  const sy = (summitY - baseY) * TRACED_CLIMB_FRACTION / (last.v - first.v);

  const pts = TRAIL_UV.map(p => ({
    x: baseX + (p.u - first.u) * sx,
    y: baseY + (p.v - first.v) * sy,
  }));

  // stair extension: smooth curve from the trace's end to the exact summit
  const end = pts[pts.length - 1];
  const STAIR_STEPS = 6;
  for (let i = 1; i <= STAIR_STEPS; i++) {
    const f = i / STAIR_STEPS;
    const ease = f * f * (3 - 2 * f);              // smoothstep: steepens in
    pts.push({
      x: end.x + (summitX - end.x) * f,
      y: end.y + (summitY - end.y) * ease,
    });
  }

  // arc-length parameterisation for constant speed
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x,
                                     pts[i].y - pts[i - 1].y));
  }
  const total = cum[cum.length - 1];

  return {
    totalLength: total,
    points: pts,
    at(t) {
      const d = Math.min(Math.max(t, 0), 1) * total;
      let i = 1;
      while (i < cum.length - 1 && cum[i] < d) i++;
      const f = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f,
      };
    },
  };
}


/**
 * Build the trail directly through explicit points (Spline waypoint objects).
 * Same interface as buildTrail, but no uv mapping and no anchors: the points
 * ARE the route. A Catmull-Rom pass smooths the corners so trekkers do not
 * turn on a dime at each waypoint.
 */
export function buildTrailFromPoints(raw, smoothing = 8) {
  if (raw.length < 2) throw new Error('[trail] need at least 2 points');

  // Catmull-Rom through the waypoints
  const pts = [];
  const P = (i) => raw[Math.min(Math.max(i, 0), raw.length - 1)];
  for (let i = 0; i < raw.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let s = 0; s < smoothing; s++) {
      const t = s / smoothing, t2 = t * t, t3 = t2 * t;
      pts.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
             (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
             (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t +
             (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
             (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  pts.push({ x: raw[raw.length - 1].x, y: raw[raw.length - 1].y });

  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x,
                                     pts[i].y - pts[i - 1].y));
  }
  const total = cum[cum.length - 1];

  return {
    totalLength: total,
    points: pts,
    at(t) {
      const d = Math.min(Math.max(t, 0), 1) * total;
      let i = 1;
      while (i < cum.length - 1 && cum[i] < d) i++;
      const f = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f,
      };
    },
  };
}
