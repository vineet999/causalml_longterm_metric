import { METRICS, NSM_LABEL } from './sim.js';

/**
 * The control panel, rendered into named slots so the page can place the
 * pieces around the 3D stage rather than stacking them all beneath it.
 *
 * Talks only to sim.set() - never to the scene or the trekker objects. That
 * separation is what would let a 2D renderer reuse this panel unchanged.
 */
export function createControls(sim, slots) {
  const { nsm, metric, stats, buttons } = slots;

  // ---- North Star card (left of the stage) --------------------------------
  nsm.innerHTML = `
    <div class="tc-card tc-card--nsm">
      <div class="tc-card-label">North Star</div>
      <div class="tc-card-name">${NSM_LABEL}</div>
      <div class="tc-card-value tc-nsm-value">—</div>
      <div class="tc-card-def">Reached the summit <em>and</em> spent something,
        over everyone who started.</div>
    </div>`;
  const nsmValue = nsm.querySelector('.tc-nsm-value');

  // ---- chosen metric card (right of the stage) ----------------------------
  metric.innerHTML = `
    <div class="tc-card tc-card--metric">
      <div class="tc-card-label">Chosen metric</div>
      <div class="tc-card-name"></div>
      <div class="tc-card-value">—</div>
      <div class="tc-card-def"></div>
    </div>`;
  const cardName = metric.querySelector('.tc-card-name');
  const cardValue = metric.querySelector('.tc-card-value');
  const cardDef = metric.querySelector('.tc-card-def');

  // ---- stats strip (between stage and buttons) ----------------------------
  stats.innerHTML = `<div class="tc-stats"></div>`;
  const statsBox = stats.querySelector('.tc-stats');

  // ---- buttons + blurb ----------------------------------------------------
  buttons.innerHTML = `
    <div class="tc-label">Choose the primary metric</div>
    <div class="tc-metrics"></div>
    <div class="tc-blurb"></div>
    <div class="tc-buttons">
      <button class="tc-toggle">Pause</button>
      <button class="tc-reset">Restart</button>
    </div>`;
  const metricsBox = buttons.querySelector('.tc-metrics');
  const blurb = buttons.querySelector('.tc-blurb');
  const btns = {};

  for (const [key, m] of Object.entries(METRICS)) {
    const b = document.createElement('button');
    b.textContent = m.label;
    b.className = 'tc-metric';
    b.onclick = () => selectMetric(key);
    metricsBox.appendChild(b);
    btns[key] = b;
  }

  function selectMetric(key) {
    sim.set({ metric: key });
    for (const [k, b] of Object.entries(btns)) {
      b.classList.toggle('is-active', k === key);
    }
    const m = METRICS[key];
    blurb.textContent = m.blurb;
    cardName.textContent = m.label;
    cardDef.textContent = m.definition;
    render();
  }

  const toggle = buttons.querySelector('.tc-toggle');
  toggle.onclick = () => {
    const running = !sim.config.running;
    sim.set({ running });
    toggle.textContent = running ? 'Pause' : 'Play';
  };
  buttons.querySelector('.tc-reset').onclick = () => { sim.reset(); render(); };

  const fmt = (n, d = 0) => n.toLocaleString('en-IN',
    { minimumFractionDigits: d, maximumFractionDigits: d });

  function render() {
    const mv = sim.metricValue();
    cardValue.textContent = `${fmt(mv.value, mv.decimals ?? 0)} ${mv.unit}`;

    const pct = sim.nsm() * 100;
    nsmValue.textContent = `${pct.toFixed(0)}%`;
    nsmValue.classList.toggle('is-poor', pct < 25);

    const t = sim.totals;
    statsBox.innerHTML =
      `<span><b>${t.started}</b> started</span>` +
      `<span><b>${t.summited}</b> summited</span>` +
      `<span><b>${t.stoppedShort}</b> stopped short</span>` +
      `<span><b>${t.engaged}</b> spent something</span>` +
      `<span><b>${fmt(t.revenue)}</b> coins earned</span>`;
  }

  selectMetric(sim.config.metric);
  return { render };
}
