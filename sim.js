/**
 * The simulation. Pure JS - no Spline, no DOM, no rendering.
 *
 * Each metric is a scripted scenario, not a probability soup: the table says
 * exactly how many trekkers stop where, so the sim assigns fixed outcomes and
 * only jitters timing. That keeps the visual difference between metrics legible
 * instead of leaving it to chance on any given run.
 */

/** Fractions along the route. Match these to your Spline waypoints. */
export const MILESTONES = {
  base:   0.00,
  cafe:   0.35,
  bridge: 0.55,
  flag:   0.70,
  summit: 1.00,
};

/** Coins. Only relative size matters for the story. */
export const SPEND = { cafe: 200, souvenir: 500 };

/**
 * North Star: trekkers who reach the summit AND engage (cafe and/or souvenir),
 * over everyone who started. Deliberately not a button - it is the thing every
 * button fails to optimise.
 */
export const NSM_LABEL = 'Summit + engaged / started';

/**
 * plan(n) returns one outcome per trekker:
 *   stopAt        - fraction along the route where they stop
 *   engageCafe    - spends at the cafe
 *   engageSummit  - buys a souvenir at the summit
 * Anything not stated in the source table uses naturalEngage, the rate at
 * which summit-reachers spend when nothing pushes them to.
 */
const M = MILESTONES;

export const METRICS = {
  base_starts: {
    label: '# Base starts',
    definition: 'Trekkers who started the trek from the base point',
    blurb: 'Everyone sets off, nobody is measured on finishing. Trekkers reach ' +
           'the cafe and stop. The count looks healthy; the summit is empty.',
    speedMul: 1,
    startCount: 8,
    plan: (n) => Array.from({ length: n }, () => ({
      stopAt: M.cafe, engageCafe: false, engageSummit: false })),
  },

  time_spent: {
    label: 'Time spent climbing / user',
    definition: 'Total minutes trekkers spent climbing',
    blurb: 'Rewards lingering, so everyone slows down. Some stop at the cafe, ' +
           'some at the flag, two make the summit. Time per user rises either way.',
    speedMul: 0.9,                       // 10% slower
    startCount: 8,
    plan: (n) => Array.from({ length: n }, (_, i) => {
      // 3 cafe, 3 flag, 2 summit (scaled if n differs)
      const f = i / n;
      const stopAt = f < 0.375 ? M.cafe : (f < 0.75 ? M.flag : M.summit);
      return { stopAt, engageCafe: false, engageSummit: false };
    }),
  },

  summit_completions: {
    label: '# Summit completions',
    definition: 'Trekkers who reach the summit from the base',
    blurb: 'The closest metric to the goal, and it still misses. Everyone ' +
           'climbs straight through and summits - but nothing rewards ' +
           'spending, so nobody spends, and the North Star stays at zero.',
    speedMul: 1,
    startCount: 8,
    // Explicitly zero engagement: the metric rewards arriving, nothing else,
    // so nobody spends. Summits are maximised and the NSM still reads 0%.
    plan: (n) => Array.from({ length: n }, () => ({
      stopAt: M.summit, engageCafe: false, engageSummit: false })),
  },

  avg_revenue: {
    label: 'Average revenue / user',
    definition: 'Total revenue (cafe + summit) / total trekkers at base',
    blurb: 'Rewards spending per head. Everyone stops at the cafe and spends; ' +
           'two carry on to buy souvenirs at the summit.',
    speedMul: 1,
    startCount: 8,
    plan: (n) => Array.from({ length: n }, (_, i) => ({
      stopAt: i < 2 ? M.summit : M.cafe,
      engageCafe: true,
      engageSummit: i < 2,
    })),
  },

  walk_sessions: {
    label: '# Walk sessions / user',
    definition: 'People who restarted after intermediate stops till their ' +
                'final stop / people who started the trek',
    blurb: 'Rewards restarting, so the trek fragments into little bursts. ' +
           'Trekkers pause before the cafe, again at the cafe, again at the ' +
           'bridge, then stop at the flag. Sessions per user climbs; almost ' +
           'nobody summits.',
    speedMul: 1,
    startCount: 8,
    // Four rest points, so each trekker banks five sessions on the way up.
    plan: (n) => Array.from({ length: n }, (_, i) => ({
      stopAt: i < 2 ? M.summit : M.flag,
      restStops: [0.20, M.cafe, M.bridge, M.flag],
      engageCafe: false,
      engageSummit: i < 2,
    })),
  },

  engaged_users: {
    label: '# Engaged users',
    definition: 'Trekkers who engaged with the cafe or the summit shop',
    blurb: 'Counts anyone who spends anything. A cafe stop scores the same as ' +
           'a summit purchase, so the cafe is the cheapest way to move it.',
    speedMul: 1,
    startCount: 8,
    plan: (n) => Array.from({ length: n }, (_, i) => ({
      stopAt: i < 2 ? M.summit : M.cafe,
      engageCafe: true,
      engageSummit: i < 2,
    })),
  },

  distance_per_user: {
    label: 'Distance travelled / user',
    definition: 'Distance walked during the trek, per user',
    blurb: 'A ratio, so the cheapest way to raise it is fewer starters. Only ' +
           'three set off - two summit, one stops at the flag. The average ' +
           'looks superb while the mountain sits empty.',
    speedMul: 1,
    startCount: 3,                      // the denominator shrinks
    plan: (n) => Array.from({ length: n }, (_, i) => ({
      stopAt: i < 2 ? M.summit : M.flag,
      engageCafe: false, engageSummit: false,
    })),
  },
};

export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSim(opts = {}) {
  const cfg = {
    seed: 42,
    maxTrekkers: 8,
    metric: 'base_starts',
    climbSeconds: 13,
    stopPause: 1.4,
    restPause: 1.1,          // how long a mid-climb rest lasts
    fadeSeconds: 0.5,
    respawnDelay: 1.0,
    // Spend rate for summit-reachers when a metric leaves engagement
    // unspecified. Zero by default: if nothing rewards spending, nobody spends.
    naturalEngage: 0,
    running: true,
    ...opts,
  };

  let rng = makeRng(cfg.seed);
  let agents = [];
  let plans = [];
  const spendEvents = [];    // drained by the renderer for the coin effect

  const totals = {
    started: 0, summited: 0, stoppedShort: 0,
    engaged: 0, revenue: 0, climbMinutes: 0, distance: 0,
    nsmHits: 0,             // summited AND engaged
    sessions: 0,            // one per start, plus one per resumption
  };

  function rules() { return METRICS[cfg.metric] || METRICS.base_starts; }

  function activeCount() {
    return Math.min(rules().startCount, cfg.maxTrekkers);
  }

  function spawn(a, idx) {
    const r = rules();
    const plan = plans[idx % plans.length];

    a.stopAt = plan.stopAt;
    // Rest stops are pauses mid-climb, not the end of the trek: the trekker
    // waits, then walks on. Each resumption is a new "session".
    a.restStops = (plan.restStops || []).filter(v => v < plan.stopAt);
    a.restIdx = 0;
    a.engageCafe = plan.engageCafe;
    // null means "not specified by this metric" - fall back to natural rate
    a.engageSummit = plan.engageSummit === null
      ? (plan.stopAt >= M.summit && rng() < cfg.naturalEngage)
      : plan.engageSummit;

    a.t = 0;
    a.speed = (1 / cfg.climbSeconds) * r.speedMul * (0.9 + rng() * 0.2);
    a.status = 'climbing';
    a.timer = 0;
    a.visible = true;
    a.didCafe = false;
    // must reset: a recycled rig kept its previous life's engagement flag,
    // which inflated the NSM every time a trekker respawned
    a.engagedAny = false;
    totals.started++;
    totals.sessions++;      // setting off is the first session
  }

  function rebuild() {
    rng = makeRng(cfg.seed);
    const r = rules();
    const n = activeCount();
    plans = r.plan(n);

    for (const k of Object.keys(totals)) totals[k] = 0;
    spendEvents.length = 0;

    agents = [];
    for (let i = 0; i < cfg.maxTrekkers; i++) {
      const a = { id: i, active: i < n };
      if (a.active) {
        spawn(a, i);
        // stagger the start so they do not move as one block
        a.t = 0;
        a.startDelay = i * 0.55;
        a.status = 'waiting';
        a.timer = a.startDelay;
        a.visible = false;
      } else {
        a.status = 'off'; a.visible = false; a.t = 0;
      }
      agents.push(a);
    }
  }
  rebuild();

  /** The value of whichever metric is currently selected. */
  function metricValue() {
    const s = totals;
    switch (cfg.metric) {
      case 'base_starts':       return { value: s.started, unit: 'starts' };
      case 'time_spent':        return { value: s.started ? s.climbMinutes / s.started : 0,
                                         unit: 'min/user', decimals: 1 };
      case 'summit_completions':return { value: s.summited, unit: 'summits' };
      case 'avg_revenue':       return { value: s.started ? s.revenue / s.started : 0,
                                         unit: 'coins/user', decimals: 0 };
      case 'walk_sessions':     return { value: s.started ? s.sessions / s.started : 0,
                                         unit: 'sessions/user', decimals: 1 };
      case 'engaged_users':     return { value: s.engaged, unit: 'users' };
      case 'distance_per_user': return { value: s.started ? s.distance / s.started : 0,
                                         unit: 'km/user', decimals: 2 };
      default:                  return { value: 0, unit: '' };
    }
  }

  function nsm() {
    return totals.started ? totals.nsmHits / totals.started : 0;
  }

  return {
    get agents() { return agents; },
    get totals() { return totals; },
    get config() { return { ...cfg }; },
    get milestones() { return M; },
    metricValue, nsm,

    /** Renderer drains these to float coin symbols. */
    takeSpendEvents() { return spendEvents.splice(0, spendEvents.length); },

    set(changes) {
      const structural = ('metric' in changes) || ('maxTrekkers' in changes) ||
                         ('seed' in changes);
      Object.assign(cfg, changes);
      if (structural) rebuild();
    },

    reset() { rebuild(); },

    tick(dt) {
      if (!cfg.running) return;

      for (const a of agents) {
        if (a.status === 'off') continue;

        switch (a.status) {
          case 'climbing': {
            const prev = a.t;
            a.t += a.speed * dt;
            totals.climbMinutes += dt / 6;          // 6s of sim = 1 "minute"
            totals.distance += (a.t - prev) * 12;   // route is "12 km"

            // cafe spend happens in passing, on the way through
            if (!a.didCafe && a.engageCafe && a.t >= M.cafe) {
              a.didCafe = true;
              totals.revenue += SPEND.cafe;
              totals.engaged++;
              a.engagedAny = true;
              spendEvents.push({ agentId: a.id, t: M.cafe, amount: SPEND.cafe,
                                 where: 'cafe' });
            }

            // mid-climb rest, before the end-of-trek check so a rest point
            // that coincides with the final stop does not swallow the stop
            if (a.restIdx < a.restStops.length && a.t >= a.restStops[a.restIdx]) {
              a.restIdx++;
              a.status = 'resting';
              a.timer = cfg.restPause;
              break;
            }

            if (a.t >= a.stopAt) {
              a.t = Math.min(a.stopAt, 1);
              a.status = 'stopped';
              a.timer = cfg.stopPause;

              if (a.t >= 0.999) {
                totals.summited++;
                if (a.engageSummit) {
                  totals.revenue += SPEND.souvenir;
                  if (!a.engagedAny) totals.engaged++;
                  a.engagedAny = true;
                  spendEvents.push({ agentId: a.id, t: 1, amount: SPEND.souvenir,
                                     where: 'summit' });
                }
                if (a.engagedAny) totals.nsmHits++;
              } else {
                totals.stoppedShort++;
              }
            }
            break;
          }
          case 'resting':
            a.timer -= dt;
            if (a.timer <= 0) {
              a.status = 'climbing';
              totals.sessions++;       // resuming counts as a new session
            }
            break;
          case 'stopped':
            a.timer -= dt;
            if (a.timer <= 0) { a.status = 'fading'; a.timer = cfg.fadeSeconds; }
            break;
          case 'fading':
            a.timer -= dt;
            a.visible = false;
            if (a.timer <= 0) { a.status = 'waiting'; a.timer = cfg.respawnDelay; }
            break;
          case 'waiting':
            a.timer -= dt;
            if (a.timer <= 0) { spawn(a, a.id); }
            break;
        }
      }
    },
  };
}
