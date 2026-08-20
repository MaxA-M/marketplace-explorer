/* =========================================================================
   Quarterly results page.

   Chart values come from data/*.json, which the generator transcribes from the
   published quarterly report. No numbers live in this file — a quarterly
   refresh is a data swap with no code change.

   The gated explorer lives on its own page (index.html / app.js) and refreshes
   on a different cadence.
   ========================================================================= */

'use strict';

const FILES = [
  'summary', 'state_of_market', 'net_by_category', 'new_entrants', 'departures',
  'top_gainers', 'long_tail', 'concentration', 'ratings',
];

const fmt = (n) => n.toLocaleString('en-US');
const signed = (n) => (n > 0 ? '+' : '') + fmt(n);
const signedPct = (n) => (n > 0 ? '+' : '') + n.toFixed(1) + '%';

function track(event, data) {
  try {
    if (window.umami && typeof window.umami.track === 'function') window.umami.track(event, data);
  } catch (_) { /* analytics must never break the page */ }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/* ---------------------------------------------------------------------------
   Chart primitives — plain DOM, no chart library, so the styling stays exact
   and the iframe payload stays small.

   items: [{ label, value, valueText, sub, negative }]
   --------------------------------------------------------------------------- */

function renderBars(mountId, items, opts = {}) {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  mount.innerHTML = '';

  const wrap = el('div', 'rows' + (opts.diverging ? ' diverging' : ''));

  let zeroPct = 0;
  let span = Math.max(...items.map((d) => Math.abs(d.value)), 1);
  if (opts.diverging) {
    const maxPos = Math.max(0, ...items.map((d) => d.value));
    const maxNeg = Math.max(0, ...items.map((d) => -d.value));
    span = maxPos + maxNeg || 1;
    zeroPct = (maxNeg / span) * 100;
  }

  items.forEach((d, i) => {
    const row = el('div', 'row');
    const label = el('div', 'row-label', d.label);
    label.title = d.label;

    const trackEl = el('div', 'row-track');
    if (opts.diverging) trackEl.style.setProperty('--zero', zeroPct + '%');

    const widthPct = Math.max((Math.abs(d.value) / span) * 100, 0.8);
    const bar = el('div', 'bar' + (d.value < 0 ? ' neg' : ''));
    bar.style.width = widthPct + '%';
    bar.style.animationDelay = i * 30 + 'ms';
    if (opts.diverging) {
      bar.style.left = (d.value < 0 ? zeroPct - widthPct : zeroPct) + '%';
    } else {
      bar.style.left = '0';
    }
    trackEl.append(bar);

    const values = el('div', 'row-values');
    const v = el('span', 'row-value' + (d.value < 0 ? ' neg' : opts.positiveGreen ? ' pos' : ''),
                 d.valueText != null ? d.valueText : fmt(d.value));
    values.append(v);
    if (d.sub) values.append(el('span', 'row-sub', d.sub));

    row.append(label, trackEl, values);
    wrap.append(row);
  });

  mount.append(wrap);
}

/* ---------------------------------------------------------------------------
   Sections
   --------------------------------------------------------------------------- */

function renderHeadline(s) {
  document.getElementById('framing-count').textContent = fmt(s.total_active_partners_end);
  document.getElementById('data-stamp').textContent = s.quarter_end_label;

  const stats = [
    { value: signed(s.net_new_connections), label: 'Net new partner connections', pos: true },
    { value: fmt(s.total_connections_end),  label: 'Total partner connections' },
    { value: `${s.partners_added} / ${s.partners_departed}`, label: 'Partners joined / departed' },
    { value: s.pct_listings_zero_new_ratings + '%', label: 'Listings with zero new ratings' },
  ];

  const bar = document.getElementById('statbar');
  bar.innerHTML = '';
  stats.forEach((st) => {
    const card = el('div', 'stat');
    const v = el('span', 'stat-value' + (st.pos ? ' pos' : ''), st.value);
    card.append(v, el('span', 'stat-label', st.label));
    bar.append(card);
  });
}

function renderStateOfMarket(data) {
  renderBars('chart-state-of-market', data.categories.map((c) => ({
    label: c.name,
    value: c.connections,
    valueText: fmt(c.connections),
    sub: `${c.partners} partners`,
  })));
}

function renderNetByCategory(data) {
  let view = 'net';

  function draw() {
    const rows = [...data.categories].sort((a, b) =>
      view === 'net' ? b.net_change - a.net_change : b.rate_pct - a.rate_pct
    );
    renderBars(
      'chart-net-by-category',
      rows.map((c) => ({
        label: c.name,
        value: view === 'net' ? c.net_change : c.rate_pct,
        valueText: view === 'net' ? signed(c.net_change) : signedPct(c.rate_pct),
        sub: view === 'net' ? signedPct(c.rate_pct) : signed(c.net_change),
      })),
      { diverging: true }
    );
  }

  wireToggle('#net-by-category .toggle', (v) => {
    view = v;
    draw();
    track('filter_selected', { chart: 'net-by-category', value: v });
  });

  draw();
}

function renderNewEntrants(data) {
  document.getElementById('new-total').textContent = fmt(data.total_new);
  renderBars('chart-new-entrants', data.categories.map((c) => ({
    label: c.name, value: c.new_partners, valueText: fmt(c.new_partners),
  })));
}

function renderDepartures(data) {
  document.getElementById('dep-total').textContent = fmt(data.total_departed);
  renderBars('chart-departures', data.by_category.map((c) => ({
    label: c.name, value: c.departed, valueText: fmt(c.departed),
  })));
}

function renderTopGainers(data) {
  let view = 'by_volume';

  function draw() {
    const rows = data[view] || [];
    renderBars(
      'chart-top-gainers',
      rows.map((r) => ({
        label: r.name,
        value: view === 'by_volume' ? r.gain : r.gain_pct,
        valueText: view === 'by_volume' ? signed(r.gain) : signedPct(r.gain_pct),
        sub: `${fmt(r.start)} → ${fmt(r.end)}`,
      })),
      { positiveGreen: true }
    );
  }

  wireToggle('#top-gainers .toggle', (v) => {
    view = v;
    draw();
    track('filter_selected', { chart: 'top-gainers', value: v });
  });

  draw();
}

function renderLongTail(data) {
  renderBars('chart-long-tail', data.buckets.map((b) => ({
    label: b.label + ' connections', value: b.partners, valueText: fmt(b.partners),
  })));
  document.getElementById('long-tail-callout').textContent =
    `${data.pct_under_10_connections}% of partners have fewer than 10 connections, ` +
    `and ${data.pct_under_30_connections}% have fewer than 30.`;
}

function renderConcentration(data) {
  renderBars('chart-concentration', data.categories.map((c) => ({
    label: c.name,
    value: c.top3_share_pct,
    valueText: c.top3_share_pct.toFixed(1) + '%',
    sub: `${c.total_partners} partners`,
  })));
}

function renderRatings(data) {
  document.getElementById('ratings-callout').innerHTML =
    `<strong>${data.pct_zero_new_ratings}%</strong> of marketplace listings received zero new ` +
    `ratings this quarter. The entire ratings economy runs through the partners below.`;

  renderBars('chart-ratings', data.active_raters.map((r) => ({
    label: r.name,
    value: r.new_ratings,
    valueText: signed(r.new_ratings),
    sub: r.avg_end != null ? r.avg_end.toFixed(2) + ' ★' : '',
  })), { positiveGreen: true });
}

/* ---------------------------------------------------------------------------
   Page plumbing
   --------------------------------------------------------------------------- */

function wireToggle(selector, onChange) {
  const buttons = document.querySelectorAll(selector + ' button');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      onChange(btn.dataset.view);
    });
  });
}

/** Fire chart_viewed once per section, the first time it scrolls into view. */
function watchSections() {
  const seen = new Set();
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      const id = e.target.dataset.chart;
      if (e.isIntersecting && !seen.has(id)) {
        seen.add(id);
        track('chart_viewed', { chart: id });
      }
    });
  }, { threshold: 0.35 });
  document.querySelectorAll('[data-chart]').forEach((n) => obs.observe(n));
}

/** Highlight the sidebar link for whichever section is in view. */
function watchNav() {
  const links = new Map(
    [...document.querySelectorAll('.sidenav a')].map((a) => [a.getAttribute('href').slice(1), a])
  );
  const visible = new Set();
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) visible.add(e.target.id);
      else visible.delete(e.target.id);
    });
    links.forEach((a, id) => a.classList.toggle('is-current', visible.has(id)));
  }, { rootMargin: '-40% 0px -50% 0px' });
  document.querySelectorAll('section[id]').forEach((n) => obs.observe(n));
}

/** Tell the Squarespace parent how tall we are, so the iframe can size itself. */
function reportHeight() {
  const send = () => {
    try {
      window.parent.postMessage(
        { type: 'marketplace-quarterly:height', height: document.documentElement.scrollHeight },
        '*'
      );
    } catch (_) { /* not embedded */ }
  };
  send();
  new ResizeObserver(send).observe(document.body);
  window.addEventListener('load', send);
}

async function main() {
  let d;
  try {
    const results = await Promise.all(
      FILES.map((f) =>
        fetch(`data/${f}.json`, { cache: 'no-cache' }).then((r) => {
          if (!r.ok) throw new Error(`${f}.json → ${r.status}`);
          return r.json();
        })
      )
    );
    d = Object.fromEntries(FILES.map((f, i) => [f, results[i]]));
  } catch (err) {
    document.body.insertAdjacentHTML('afterbegin',
      `<p class="error">Could not load the data files (${err.message}).</p>`);
    return;
  }

  renderHeadline(d.summary);
  renderStateOfMarket(d.state_of_market);
  renderNetByCategory(d.net_by_category);
  renderNewEntrants(d.new_entrants);
  renderDepartures(d.departures);
  renderTopGainers(d.top_gainers);
  renderLongTail(d.long_tail);
  renderConcentration(d.concentration);
  renderRatings(d.ratings);

  watchSections();
  watchNav();
  reportHeight();

  // Deep link from a blog post: scroll to the anchor and record the arrival.
  if (location.hash && location.hash.length > 1) {
    const id = location.hash.slice(1);
    const target = document.getElementById(id);
    if (target) {
      requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      track('deep_link_arrival', { anchor: id });
    }
  }
}

main();
