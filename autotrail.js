import * as THREE from 'three';

/**
 * Works out a walkable trail across the terrain with no user interaction.
 *
 * Builds a heightmap by reading vertex positions directly rather than casting
 * rays. Raycasting a slice grid against high-poly terrain costs thousands of
 * intersection tests and takes seconds; one pass over the vertex buffer is
 * effectively instant and cannot "miss" the surface.
 *
 * The scene is viewed front-on and the trek runs left to right, so the trail is
 * a function of X. Each depth slice is scored on how continuous and how
 * climbable it is; the best slice becomes the trail. Choosing "the highest
 * ridge" instead tends to pick a knife edge full of gaps.
 */
export function autoTrail(targets, opts = {}) {
  const {
    gridX: gridXOpt = null,   // null = derive from vertex density
    gridZ: gridZOpt = null,
    maxGrade = 1.2,          // steeper than ~50 degrees is a scramble, not a walk
    smoothPasses = 4,
    keepPoints = 28,
    climbBias = 0.5,
    marginFrac = 0.04,
    zSearch = [0.08, 0.92],  // ignore the extreme front and back slices
  } = opts;

  const list = Array.isArray(targets) ? targets : [targets];

  const bounds = new THREE.Box3();
  for (const t of list) bounds.expandByObject(t);
  const size = bounds.getSize(new THREE.Vector3());
  if (size.x <= 0 || size.z <= 0) {
    console.warn('[autoTrail] degenerate bounds');
    return null;
  }

  // Count vertices first so the grid can be sized to the data. A grid finer
  // than the vertex spacing leaves most cells empty, which reads as "no ground
  // here" and causes every slice to be rejected.
  let vertTotal = 0;
  for (const obj of list) {
    obj.traverse(node => {
      const p = node.isMesh && node.geometry && node.geometry.attributes.position;
      if (p) vertTotal += p.count;
    });
  }
  if (!vertTotal) { console.warn('[autoTrail] no vertices found'); return null; }

  const aspect = size.x / Math.max(size.z, 1e-6);
  const cells = Math.max(400, Math.min(40000, vertTotal / 3));
  const gridX = gridXOpt ?? Math.max(40, Math.min(240, Math.round(Math.sqrt(cells * aspect))));
  const gridZ = gridZOpt ?? Math.max(30, Math.min(180, Math.round(Math.sqrt(cells / aspect))));

  // ---- heightmap: max Y seen in each (x,z) cell --------------------------
  const H = new Float32Array(gridX * gridZ).fill(-Infinity);
  const v = new THREE.Vector3();
  let vertsSeen = 0;

  for (const obj of list) {
    obj.updateWorldMatrix(true, false);
    obj.traverse(node => {
      const geo = node.isMesh && node.geometry;
      const pos = geo && geo.attributes && geo.attributes.position;
      if (!pos) return;
      node.updateWorldMatrix(true, false);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(node.matrixWorld);
        const fx = (v.x - bounds.min.x) / size.x;
        const fz = (v.z - bounds.min.z) / size.z;
        if (fx < 0 || fx > 1 || fz < 0 || fz > 1) continue;
        const ix = Math.min(gridX - 1, (fx * gridX) | 0);
        const iz = Math.min(gridZ - 1, (fz * gridZ) | 0);
        const k = iz * gridX + ix;
        if (v.y > H[k]) H[k] = v.y;
        vertsSeen++;
      }
    });
  }

  if (!vertsSeen) { console.warn('[autoTrail] no vertices inside bounds'); return null; }
  console.log(`[autoTrail] grid ${gridX}x${gridZ} from ${vertTotal} verts`);

  // Fill small holes along X. Isolated empty cells are sampling artefacts, not
  // actual gaps in the terrain, so they should not count against a slice.
  const MAX_GAP = Math.max(2, Math.round(gridX * 0.04));
  for (let iz = 0; iz < gridZ; iz++) {
    const row = iz * gridX;
    let ix = 0;
    while (ix < gridX) {
      if (H[row + ix] !== -Infinity) { ix++; continue; }
      let end = ix;
      while (end < gridX && H[row + end] === -Infinity) end++;
      const gap = end - ix;
      const left = ix > 0 ? H[row + ix - 1] : -Infinity;
      const right = end < gridX ? H[row + end] : -Infinity;
      if (gap <= MAX_GAP && left !== -Infinity && right !== -Infinity) {
        for (let k = 0; k < gap; k++) {
          H[row + ix + k] = left + (right - left) * ((k + 1) / (gap + 1));
        }
      }
      ix = end;
    }
  }

  const i0 = Math.floor(gridX * marginFrac);
  const i1 = Math.ceil(gridX * (1 - marginFrac)) - 1;
  const dx = size.x / gridX;

  function sliceAt(iz) {
    const ys = [];
    let hits = 0;
    for (let ix = i0; ix <= i1; ix++) {
      const y = H[iz * gridX + ix];
      const ok = y !== -Infinity;
      if (ok) hits++;
      ys.push(ok ? y : null);
    }
    return { ys, coverage: hits / (i1 - i0 + 1) };
  }

  function score(s) {
    if (s.coverage < 0.55) return -Infinity;
    const known = s.ys.filter(y => y !== null);
    if (known.length < 6) return -Infinity;

    const climb = known[known.length - 1] - known[0];
    const span = Math.max(...known) - Math.min(...known);

    let steep = 0, n = 0;
    for (let i = 1; i < s.ys.length; i++) {
      if (s.ys[i] === null || s.ys[i - 1] === null) continue;
      n++;
      if (Math.abs(s.ys[i] - s.ys[i - 1]) / dx > maxGrade) steep++;
    }
    const steepFrac = n ? steep / n : 1;
    const climbScore = span > 1e-6 ? Math.max(0, climb) / span : 0;

    return s.coverage * (1 - climbBias) + climbScore * climbBias - steepFrac * 0.6;
  }

  let best = null;
  const zStart = Math.floor(gridZ * zSearch[0]);
  const zEnd = Math.ceil(gridZ * zSearch[1]);
  for (let iz = zStart; iz < zEnd; iz++) {
    const s = sliceAt(iz);
    const sc = score(s);
    if (!best || sc > best.score) best = { iz, score: sc, ...s };
  }

  if (!best || best.score === -Infinity) {
    console.warn('[autoTrail] no usable slice - is the terrain walkable front to back?');
    return null;
  }

  // fill gaps
  const ys = best.ys.slice();
  for (let i = 0; i < ys.length; i++) {
    if (ys[i] !== null) continue;
    let prev = null, next = null;
    for (let j = i - 1; j >= 0; j--) if (ys[j] !== null) { prev = ys[j]; break; }
    for (let j = i + 1; j < ys.length; j++) if (ys[j] !== null) { next = ys[j]; break; }
    ys[i] = prev !== null && next !== null ? (prev + next) / 2 : (prev ?? next ?? 0);
  }

  // smooth so trekkers do not jerk over every facet
  for (let p = 0; p < smoothPasses; p++) {
    for (let i = 1; i < ys.length - 1; i++) {
      ys[i] = (ys[i - 1] + ys[i] * 2 + ys[i + 1]) / 4;
    }
  }

  const zWorld = bounds.min.z + size.z * ((best.iz + 0.5) / gridZ);
  const xAt = (i) => bounds.min.x + size.x * ((i0 + i + 0.5) / gridX);

  const step = Math.max(1, Math.floor(ys.length / keepPoints));
  const points = [];
  for (let i = 0; i < ys.length; i += step) {
    points.push({ x: +xAt(i).toFixed(1), y: +ys[i].toFixed(1), z: +zWorld.toFixed(1) });
  }
  const last = ys.length - 1;
  if (points[points.length - 1].x < xAt(last) - dx) {
    points.push({ x: +xAt(last).toFixed(1), y: +ys[last].toFixed(1), z: +zWorld.toFixed(1) });
  }

  console.log(`[autoTrail] z=${zWorld.toFixed(0)} coverage=${(best.coverage*100)|0}% ` +
    `points=${points.length} climb=${(points[points.length-1].y - points[0].y).toFixed(0)}`);

  return { points, z: zWorld, coverage: best.coverage, bounds };
}

/** Nudge the trail toward the camera so trekkers are not embedded in rock. */
export function liftTowardCamera(points, camera, amount) {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  return points.map(p => ({
    x: +(p.x - dir.x * amount).toFixed(1),
    y: +(p.y - dir.y * amount).toFixed(1),
    z: +(p.z - dir.z * amount).toFixed(1),
  }));
}
