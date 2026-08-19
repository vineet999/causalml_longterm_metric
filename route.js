import * as THREE from 'three';


/**
 * Builds the trail once, at load time.
 *
 * You give it flat XZ points (the route seen from above). It draws a smooth
 * curve through them, then fires a ray straight down at ~800 places to find
 * the ground height at each. The result is a lookup table: give it a number
 * from 0 (base) to 1 (summit) and it hands back a position on the mountain.
 *
 * Doing this once at load means the render loop never raycasts. That matters:
 * raycasting 16 trekkers against high-poly terrain every frame is the kind of
 * thing that quietly costs you 20fps.
 */
export function buildRoute(terrain, shapePoints, opts = {}) {
  const { samples = 800, footOffset = 0, tension = 0.5, rayHeight = null,
          useGivenY = false } = opts;
  // useGivenY: the points already carry the height we want (they were drawn
  // against a fixed camera), so skip the downward raycast entirely.

  if (!terrain) throw new Error('[route] terrain is null - check TERRAIN_NAME');
  if (shapePoints.length < 2) throw new Error('[route] need at least 2 shape points');

  // Accept a single object, or an array of meshes to test against.
  const targets = Array.isArray(terrain) ? terrain : [terrain];
  if (targets.length === 0) throw new Error('[route] no raycast targets');

  // Start the rays above the tallest thing we might hit. A hard-coded height
  // silently fails when the model is bigger than expected: the ray starts
  // inside the geometry and every sample misses.
  let startY = rayHeight;
  if (startY === null) {
    const box = new THREE.Box3();
    for (const t of targets) box.expandByObject(t);
    startY = box.max.y + Math.max(100, (box.max.y - box.min.y) * 0.5);
  }

  const curve = new THREE.CatmullRomCurve3(
    shapePoints.map(p => new THREE.Vector3(p.x, useGivenY ? (p.y || 0) : 0, p.z)),
    false, 'catmullrom', tension
  );

  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const flat = curve.getSpacedPoints(samples);

  const pts = [];
  let missed = 0;

  if (useGivenY) {
    for (const p of flat) pts.push(new THREE.Vector3(p.x, p.y + footOffset, p.z));
  } else
  for (const p of flat) {
    raycaster.set(new THREE.Vector3(p.x, startY, p.z), down);
    const hit = raycaster.intersectObjects(targets, true)[0];
    if (hit) {
      pts.push(new THREE.Vector3(p.x, hit.point.y + footOffset, p.z));
    } else {
      missed++;
      const prevY = pts.length ? pts[pts.length - 1].y : 0;
      pts.push(new THREE.Vector3(p.x, prevY, p.z));
    }
  }

  if (missed > 0) {
    console.warn(
      `[route] ${missed}/${pts.length} samples found no ground beneath them ` +
      `(ray start y=${startY.toFixed(0)}, ${targets.length} target mesh(es)). ` +
      `If this is most of them, the raycast targets are wrong and the trail ` +
      `will come out flat.`
    );
  }

  // Re-parameterise by real 3D distance. Without this, t moves faster over
  // steep ground than flat, because the curve was spaced in XZ only.
  const cumulative = [0];
  for (let i = 1; i < pts.length; i++) {
    cumulative.push(cumulative[i - 1] + pts[i].distanceTo(pts[i - 1]));
  }
  const total = cumulative[cumulative.length - 1];
  const u = cumulative.map(d => d / total);

  function locate(t) {
    t = Math.min(Math.max(t, 0), 1);
    let lo = 0, hi = u.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (u[mid] <= t) lo = mid; else hi = mid;
    }
    const span = u[hi] - u[lo] || 1;
    return { lo, hi, f: (t - u[lo]) / span };
  }

  const _pos = new THREE.Vector3();
  const _tan = new THREE.Vector3();

  return {
    totalLength: total,

    getPoint(t, out = _pos) {
      const { lo, hi, f } = locate(t);
      return out.copy(pts[lo]).lerp(pts[hi], f);
    },

    /** Direction of travel — use this to face the trekker forward. */
    getTangent(t, out = _tan) {
      const { lo, hi } = locate(t);
      return out.copy(pts[hi]).sub(pts[lo]).normalize();
    },

    /** Steepness: rise over run. Positive uphill. Feed it to walking speed. */
    getGrade(t) {
      const { lo, hi } = locate(t);
      const run = pts[hi].distanceTo(pts[lo]) || 1e-6;
      return (pts[hi].y - pts[lo].y) / run;
    },

    /** Add this to the scene while building to see the trail as a red line. */
    debugLine(color = 0xff3355) {
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
    },

    samplePoints: pts,
  };
}
