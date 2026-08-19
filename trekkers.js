import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

/**
 * A fixed pool of trekker rigs, created once and recycled forever.
 *
 * Two things are load-bearing:
 *
 * 1. skeletonClone, NOT model.clone(). Plain clone() shares the skeleton, so
 *    every trekker animates in lockstep. SkeletonUtils rebuilds the bone
 *    hierarchy per copy.
 *
 * 2. One AnimationMixer per clone, since the mixer owns playback time.
 *
 * If the GLB carries no animation clips - which is what Spline's exporter does
 * to skeletal animation - we fall back to driving the bones procedurally. That
 * is why the trekkers were standing in a T-pose: no clip, nothing to play.
 */

// Rig naming varies wildly between tools (Mixamo, Blender, Sketchfab, Spline),
// so these are deliberately loose: side markers can be prefix or suffix, with
// or without separators, and "001"-style duplicate suffixes are ignored.
const L = '(^|[^a-z])(l|left)([^a-z]|$)';
const R = '(^|[^a-z])(r|right)([^a-z]|$)';
const rx = (part, side) => new RegExp(`(?=.*(${part}))(?=.*${side})`, 'i');

const BONE_PATTERNS = {
  upperLegL: rx('thigh|upleg|upperleg|upper_leg|hip|femur', L),
  upperLegR: rx('thigh|upleg|upperleg|upper_leg|hip|femur', R),
  lowerLegL: rx('shin|calf|lowerleg|lower_leg|knee|tibia', L),
  lowerLegR: rx('shin|calf|lowerleg|lower_leg|knee|tibia', R),
  armL: rx('arm|shoulder|clavicle', L),
  armR: rx('arm|shoulder|clavicle', R),
  spine: /spine|chest|torso|abdomen/i,
};

/** Find bones by name so we can animate a rig that shipped without clips. */
function mapBones(root) {
  const found = {};
  const bones = [];
  root.traverse(o => {
    if (!o.isBone) return;
    bones.push(o);
    for (const [key, re] of Object.entries(BONE_PATTERNS)) {
      if (!found[key] && re.test(o.name)) found[key] = o;
    }
  });

  // Name matching failed. Fall back to geometry: legs are the bones in the
  // lower half of the rig, and the left/right pair is the two furthest apart
  // on X. Crude, but it beats a frozen T-pose.
  if (!found.upperLegL || !found.upperLegR) {
    const wp = new THREE.Vector3();
    const info = bones.map(b => {
      b.getWorldPosition(wp);
      return { bone: b, x: wp.x, y: wp.y };
    });
    if (info.length >= 4) {
      const ys = info.map(i => i.y);
      const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
      const lower = info.filter(i => i.y < midY).sort((a, b) => a.x - b.x);
      if (lower.length >= 2) {
        found.upperLegL = found.upperLegL || lower[0].bone;
        found.upperLegR = found.upperLegR || lower[lower.length - 1].bone;
      }
    }
  }
  return { found, allNames: bones.map(b => b.name) };
}

export function createTrekkerPool(sourceModel, animations, count, opts = {}) {
  const {
    scale = 1, walkClipName = null, footOffset = 0,
    yawOffset = 0, proceduralWalk = 'auto',
  } = opts;

  let walkClip = null;
  if (animations && animations.length) {
    walkClip = walkClipName
      ? THREE.AnimationClip.findByName(animations, walkClipName)
      : animations[0];
  }

  const probe = mapBones(sourceModel);
  const boneCount = probe.allNames.length;
  const matched = Object.keys(probe.found).length;

  if (walkClip) {
    console.log(`[trekkers] using clip "${walkClip.name}" (${walkClip.duration.toFixed(2)}s)`);
  } else {
    console.warn(
      `[trekkers] No animation clips in the GLB (${animations ? animations.length : 0} found). ` +
      `Spline's exporter drops skeletal animation, which is why the trekkers ` +
      `stand in a T-pose. Falling back to a procedural walk cycle.`);
    console.log(`[trekkers] skeleton: ${boneCount} bones, matched ${matched} ` +
      `(${Object.keys(probe.found).join(', ') || 'none'})`);
    if (boneCount && matched < 2) {
      console.log('[trekkers] bone names:', probe.allNames.slice(0, 40).join(', '));
      console.log('[trekkers] no recognisable leg bones - the walk will be a ' +
        'bob only. Send me those names and I can widen the patterns.');
    }
  }

  const useProcedural = proceduralWalk === true ||
                        (proceduralWalk === 'auto' && !walkClip);

  const slots = [];
  for (let i = 0; i < count; i++) {
    const model = skeletonClone(sourceModel);
    model.scale.setScalar(scale);
    model.visible = false;
    model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });

    const mixer = new THREE.AnimationMixer(model);
    let action = null;
    if (walkClip) {
      action = mixer.clipAction(walkClip);
      action.play();
      action.time = Math.random() * walkClip.duration;   // desync the steps
    }

    const bones = useProcedural ? mapBones(model).found : null;
    const rest = {};
    if (bones) {
      for (const [k, b] of Object.entries(bones)) rest[k] = b.rotation.x;
    }

    slots.push({
      model, mixer, action, bones, rest,
      agentId: null, footOffset, yawOffset,
      phase: Math.random() * Math.PI * 2,
      cycles: 0,
    });
  }

  return {
    slots,
    clipDuration: walkClip ? walkClip.duration : 1,
    hasClip: !!walkClip,
    usingProcedural: useProcedural,

    addToScene(scene) { for (const s of slots) scene.add(s.model); },

    acquire(agentId) {
      const s = slots.find(x => x.agentId === null);
      if (!s) return null;
      s.agentId = agentId;
      s.model.visible = true;
      return s;
    },

    release(agentId) {
      const s = slots.find(x => x.agentId === agentId);
      if (s) { s.agentId = null; s.model.visible = false; }
    },

    forAgent(agentId) { return slots.find(x => x.agentId === agentId) || null; },

    update(dt) { for (const s of slots) s.mixer.update(dt); },
  };
}

/**
 * Procedural walk. Two tiers:
 *
 * - Bones matched: swing legs and arms with offset sine waves, bob the body.
 * - No usable bones: animate the whole model - stride bob, a slight forward
 *   lean, a lateral sway. Reads as a determined trudge. This tier also fixes
 *   the arms on rigs whose arm bones we could not identify: a gentle whole-
 *   body roll disguises a stiff pose far better than perfect stillness.
 *
 * Amplitudes are deliberately strong; at the size these render, subtle
 * motion disappears entirely.
 */
export function stepProceduralWalk(slot, dt, cyclesPerSecond) {
  slot.phase += dt * cyclesPerSecond * Math.PI * 2;
  const p = slot.phase;
  const b = slot.bones || {};
  const r = slot.rest || {};
  const SWING = 0.85, KNEE = 0.55, ARM = 0.65;

  let animatedBones = 0;
  if (b.upperLegL) { b.upperLegL.rotation.x = (r.upperLegL || 0) + Math.sin(p) * SWING; animatedBones++; }
  if (b.upperLegR) { b.upperLegR.rotation.x = (r.upperLegR || 0) + Math.sin(p + Math.PI) * SWING; animatedBones++; }
  if (b.lowerLegL) b.lowerLegL.rotation.x = (r.lowerLegL || 0) + Math.max(0, Math.sin(p - 0.6)) * KNEE;
  if (b.lowerLegR) b.lowerLegR.rotation.x = (r.lowerLegR || 0) + Math.max(0, Math.sin(p + Math.PI - 0.6)) * KNEE;
  if (b.armL) b.armL.rotation.x = (r.armL || 0) + Math.sin(p + Math.PI) * ARM;
  if (b.armR) b.armR.rotation.x = (r.armR || 0) + Math.sin(p) * ARM;
  if (b.spine) b.spine.rotation.x = (r.spine || 0) + Math.sin(p * 2) * 0.05;

  // whole-body motion, scaled up when the skeleton gave us nothing
  const k = animatedBones >= 2 ? 0.5 : 1.0;
  slot.bobY = Math.abs(Math.sin(p)) * 0.16 * k;
  slot.leanX = 0.10 * k;                         // forward lean into the climb
  slot.rollZ = Math.sin(p) * 0.07 * k;           // step-to-step sway
}

const _pos = new THREE.Vector3();
const _tan = new THREE.Vector3();

/**
 * Place one trekker on the trail. Yaw only - tilting a walker to the slope
 * normal reads like a vehicle on a ramp; people stay upright going uphill.
 */
export function placeOnRoute(slot, route, t, laneOffset = 0) {
  route.getPoint(t, _pos);
  route.getTangent(t, _tan);

  if (laneOffset !== 0) {
    _pos.x += -_tan.z * laneOffset;
    _pos.z += _tan.x * laneOffset;
  }

  slot.model.position.copy(_pos);
  slot.model.position.y += slot.footOffset + (slot.bobY || 0);
  slot.model.rotation.set(
    slot.leanX || 0,
    Math.atan2(_tan.x, _tan.z) + slot.yawOffset,
    slot.rollZ || 0
  );
}

/** Match playback to ground speed, or the feet slide like ice skates. */
export function syncWalkSpeed(slot, groundSpeed, strideLength, clipDuration) {
  const cps = groundSpeed / Math.max(strideLength, 1e-6);
  if (slot.action) {
    slot.action.timeScale = Math.min(Math.max(cps * clipDuration, 0.1), 3);
  }
  return Math.min(Math.max(cps, 0.1), 4);
}
