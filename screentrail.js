import * as THREE from 'three';

/**
 * Turn a hand-drawn path into a trail on the terrain.
 *
 * Points arrive as (u,v) fractions of the rendered scene's bounding box, taken
 * from a marked-up screenshot. Here the terrain's projected bounds are measured
 * on screen, the same box is reconstructed, and each (u,v) becomes a real
 * screen position that is raycast onto the mountain.
 *
 * Because the box is recomputed from the live projection, the drawing maps
 * correctly regardless of the screenshot's size or the current window size.
 */
export function screenTrailToWorld(screenPoints, camera, renderer, targets, opts = {}) {
  const { lift = 0, fallbackToPlane = true, snapToGround = true } = opts;
  const list = Array.isArray(targets) ? targets : [targets];

  const size = new THREE.Vector2();
  renderer.getSize(size);

  // --- projected bounding box of the terrain, in pixels -------------------
  const box = new THREE.Box3();
  for (const t of list) box.expandByObject(t);
  const c = [
    new THREE.Vector3(box.min.x, box.min.y, box.min.z),
    new THREE.Vector3(box.max.x, box.min.y, box.min.z),
    new THREE.Vector3(box.min.x, box.max.y, box.min.z),
    new THREE.Vector3(box.max.x, box.max.y, box.min.z),
    new THREE.Vector3(box.min.x, box.min.y, box.max.z),
    new THREE.Vector3(box.max.x, box.min.y, box.max.z),
    new THREE.Vector3(box.min.x, box.max.y, box.max.z),
    new THREE.Vector3(box.max.x, box.max.y, box.max.z),
  ];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const p = new THREE.Vector3();
  for (const corner of c) {
    p.copy(corner).project(camera);
    const sx = (p.x * 0.5 + 0.5) * size.x;
    const sy = (-p.y * 0.5 + 0.5) * size.y;
    minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
    minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
  }
  const bw = maxX - minX, bh = maxY - minY;
  console.log(`[screenTrail] terrain projects to ${bw.toFixed(0)}x${bh.toFixed(0)}px ` +
              `at (${minX.toFixed(0)},${minY.toFixed(0)})`);

  // --- raycast each drawn point onto the mountain -------------------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);

  const midZ = (box.min.z + box.max.z) / 2;

  // Ground probe: highest surface under a given (x, z).
  const up = new THREE.Vector3(0, -1, 0);
  const probeStart = box.max.y + Math.max(200, (box.max.y - box.min.y) * 0.5);
  function groundY(x, z) {
    raycaster.set(new THREE.Vector3(x, probeStart, z), up);
    const hit = raycaster.intersectObjects(list, true)[0];
    return hit ? hit.point.y : null;
  }

  const out = [];
  let missed = 0, snapped = 0;

  for (const sp of screenPoints) {
    const sx = minX + bw * sp.u;
    const sy = minY + bh * sp.v;
    ndc.x = (sx / size.x) * 2 - 1;
    ndc.y = -(sy / size.y) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);

    const hit = raycaster.intersectObjects(list, true)[0];
    let p;
    if (hit) {
      p = hit.point.clone();
    } else if (fallbackToPlane) {
      missed++;
      const o = raycaster.ray.origin, d = raycaster.ray.direction;
      const t = Math.abs(d.z) > 1e-6 ? (midZ - o.z) / d.z : 0;
      p = o.clone().addScaledVector(d, t);
    } else { missed++; continue; }

    // The drawing gives the route; the terrain gives the height. Drop each
    // point onto the rock below it, so a trace that drifted off the silhouette
    // (a different window framing, a hasty stroke) cannot leave trekkers
    // walking on air.
    if (snapToGround) {
      const gy = groundY(p.x, p.z);
      if (gy !== null) { p.y = gy; snapped++; }
      else {
        // Nothing below at this exact depth: pull the point in toward the
        // scene centre in Z until there is rock under it.
        const zc = (box.min.z + box.max.z) / 2;
        for (let f = 0.25; f <= 1.0; f += 0.25) {
          const zTry = p.z + (zc - p.z) * f;
          const gy2 = groundY(p.x, zTry);
          if (gy2 !== null) { p.z = zTry; p.y = gy2; snapped++; break; }
        }
      }
    }
    out.push(p.addScaledVector(camDir, -lift));
  }

  console.log(`[screenTrail] ${out.length} points, ${snapped} snapped to ground, ` +
              `${missed} rays missed the silhouette`);

  return out.map(v => ({ x: +v.x.toFixed(1), y: +v.y.toFixed(1), z: +v.z.toFixed(1) }));
}
