/* =========================================================================
   Marketplace Intelligence.

   One page, two cadences that stay separate on purpose:

     * the leaderboard, generated from the marketplace database and refreshed
       monthly, reading data/explorer.json
     * the quarterly report, transcribed from the published State of the State
       and static for the life of the quarter, reading the other data/*.json

   Each carries its own date stamp. Nothing numeric lives in this file — a
   refresh of either is a data swap with no code change.
   ========================================================================= */

'use strict';

const REPORT_FILES = [
  'summary', 'state_of_market', 'net_by_category', 'new_entrants', 'departures',
  'top_gainers', 'long_tail', 'concentration', 'ratings',
];

const CONTACT_URL = 'https://alsgaardmiller.com/contact';
const MAX_GATED_ROWS = 9;
const GATED_WIDTHS = [88, 79, 71, 64, 57, 51, 45, 40, 35];

const VIEWS = {
  connections:   { slug: 'connections',   format: (v) => fmt(v) },
  growth_volume: { slug: 'growth-volume', format: (v) => (v > 0 ? '+' : '') + fmt(v) },
  growth_pct:    { slug: 'growth-pct',    format: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + '%' },
};

const LOCK_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10V7a6 6 0 0 1 12 0v3h1a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1h1zm2 0h8V7a4 4 0 0 0-8 0v3z"/></svg>';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

const fmt = (n) => n.toLocaleString('en-US');
const signed = (n) => (n > 0 ? '+' : '') + fmt(n);
const signedPct = (n) => (n > 0 ? '+' : '') + n.toFixed(1) + '%';

/** Format an ISO date without going through Date(), which would shift it by a timezone. */
function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "April 30 – July 31, 2026", dropping the repeated year when both fall in one. */
function dateRange(startIso, endIso) {
  const [sy] = startIso.split('-').map(Number);
  const [ey] = endIso.split('-').map(Number);
  const start = sy === ey ? longDate(startIso).replace(`, ${sy}`, '') : longDate(startIso);
  return `${start} – ${longDate(endIso)}`;
}

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

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ---------------------------------------------------------------------------
   Chart primitives — plain DOM, no chart library, so the styling stays exact
   and the iframe payload stays small.

   items: [{ label, value, valueText, sub, negative }]
   --------------------------------------------------------------------------- */

/**
 * Round tick values a reader would actually expect: 1, 2, 2.5 or 5 times a power of ten,
 * aiming for roughly five intervals across the axis.
 */
function niceTicks(min, max, target = 5) {
  const span = max - min;
  if (!span) return [min];
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].find((m) => raw <= m * mag) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step / 1000; v += step) {
    ticks.push(Math.abs(v) < step / 1000 ? 0 : +v.toFixed(10));
  }
  return ticks;
}

/** Gridlines behind the bars, plus a labelled axis beneath them. */
function buildAxis(ticks, toPct, format) {
  const gradient = ticks
    .map((t) => {
      const p = toPct(t);
      const c = t === 0 ? 'var(--axis-zero)' : 'var(--axis-line)';
      return `linear-gradient(to right, ${c}, ${c}) ${p}% 0 / 1px 100% no-repeat`;
    })
    .join(', ');

  const axis = el('div', 'row axis');
  axis.append(el('div', 'row-label'));
  const lane = el('div', 'axis-lane');
  ticks.forEach((t) => {
    const mark = el('span', 'axis-tick', format(t));
    mark.style.left = toPct(t) + '%';
    lane.append(mark);
  });
  axis.append(lane, el('div', 'row-values'));
  return { gradient, axis };
}

function renderBars(mountId, items, opts = {}) {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  mount.innerHTML = '';

  const wrap = el('div', 'rows' + (opts.diverging ? ' diverging' : ''));

  let zeroPct = 0;
  let span = opts.max || Math.max(...items.map((d) => Math.abs(d.value)), 1);
  if (opts.diverging) {
    const maxPos = Math.max(0, ...items.map((d) => d.value));
    const maxNeg = Math.max(0, ...items.map((d) => -d.value));
    span = maxPos + maxNeg || 1;
    zeroPct = (maxNeg / span) * 100;
  }

  // Axis: gridlines behind every bar, labels once beneath the chart.
  const axisMin = opts.diverging ? -Math.max(0, ...items.map((d) => -d.value)) : 0;
  const axisMax = opts.diverging ? Math.max(0, ...items.map((d) => d.value)) : span;

  const ticks = niceTicks(axisMin, axisMax);
  const toPct = (t) => opts.diverging
    ? zeroPct + (t / span) * 100
    : (t / span) * 100;
  const fmtTick = opts.axisFormat || ((t) => fmt(t));
  const { gradient, axis } = buildAxis(ticks, toPct, fmtTick);

  items.forEach((d, i) => {
    const row = el('div', 'row');
    const label = el('div', 'row-label', d.label);
    label.title = d.label;

    const trackEl = el('div', 'row-track');
    trackEl.style.backgroundImage = gradient;
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

  wrap.append(axis);
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
      { diverging: true,
        axisFormat: view === 'net' ? (t) => signed(t) : (t) => signedPct(t) }
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
      { positiveGreen: true,
        axisFormat: view === 'by_volume' ? (t) => fmt(t) : (t) => t + '%' }
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
  })), { max: 100, axisFormat: (t) => t + '%' });
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
   Leaderboard — monthly, database-generated
   --------------------------------------------------------------------------- */

function renderExplorer(data) {
  const catSel = document.getElementById('sel-category');
  const out = document.getElementById('explorer-result');
  // Scoped to the leaderboard: the report sections carry their own toggles.
  const buttons = [...document.querySelectorAll('#leaderboard .toggle button')];

  const names = Object.keys(data.categories).sort();
  names.forEach((c) => catSel.append(new Option(c, c)));

  let view = 'connections';

  function buildCta(category) {
    const a = el('a', 'cta', 'Request the full ranking →');
    a.target = '_top';
    a.href = `${CONTACT_URL}?category=${encodeURIComponent(category)}&view=${VIEWS[view].slug}`;
    a.addEventListener('click', () => track('gate_hit', { category, view }));
    return a;
  }

  // The connections view is a point in time; the growth views cover a window. Say which.
  function stamp() {
    const range = view === 'connections'
      ? `Data as of ${longDate(data.boundary_end)}`
      : `Growth measured ${dateRange(data.boundary_start, data.boundary_end)}`;
    return el('p', 'as-of', `Updated monthly · ${range}`);
  }

  // A second line of the date stamp, not a separate note: only the percentage view is
  // filtered, and a reader deserves to know why a partner they expected is missing.
  function footnote() {
    if (view !== 'growth_pct') return null;
    const base = data.pct_min_base;
    if (!base) return null;
    return el('p', 'footnote',
      `Percentage growth counts only partners that entered the window with ${base} or more connections.`);
  }

  function askLine() {
    return el('p', 'ask-line',
      'Want the full list, or any of this cut by specialty? Both are available on request.');
  }

  function statLine(cat) {
    const partners = `${fmt(cat.partner_count)} partners`;
    if (view === 'connections') {
      return el('p', 'slice-meta',
        `${partners} · ${fmt(cat.total_connections)} connections in this category`);
    }
    // "net" already means adds minus losses, so the sign carries the direction on its own.
    return el('p', 'slice-meta',
      `${partners} · ${signed(cat.net_change_3mo)} net connections in the last 3 months`);
  }

  function ranking(leader, rankableCount) {
    const frag = document.createDocumentFragment();

    // The leading partner, named with its real value.
    const row = el('div', 'leader');
    row.append(el('span', 'rank', '1'));
    const trackEl = el('div', 'row-track');
    const bar = el('div', 'bar');
    bar.style.width = '100%';
    bar.style.left = '0';
    trackEl.append(bar, el('span', 'leader-name',
      `${leader.name} · ${VIEWS[view].format(leader.value)}`));
    row.append(trackEl);
    frag.append(row);

    // The remainder of the ranking, available on request. Never draw more rows than there
    // are partners to rank — in the growth views only gainers are rankable, so a category
    // with 40 partners and 3 that grew shows two gated rows, not nine.
    const gatedRows = Math.min(MAX_GATED_ROWS, rankableCount - 1);
    if (gatedRows > 0) {
      const locked = el('div', 'locked-rows');
      for (let i = 0; i < gatedRows; i++) {
        const r = el('div', 'locked-row');
        r.append(el('span', 'rank', String(i + 2)));
        const b = el('div', 'locked-bar');
        b.style.width = GATED_WIDTHS[i] + '%';
        r.append(b);
        locked.append(r);
      }
      const overlay = el('div', 'locked-overlay');
      const label = gatedRows === 1 ? 'Rank 2' : `Ranks 2–${gatedRows + 1}`;
      overlay.innerHTML = LOCK_SVG + `<p>${label} available on request</p>`;
      locked.append(overlay);
      frag.append(locked);
    }

    return frag;
  }

  function draw(isUserAction) {
    const name = catSel.value;
    const cat = data.categories[name];
    out.innerHTML = '';

    if (isUserAction) track('explorer_view', { category: name, view });

    if (!cat) {
      out.append(el('p', 'thin-slice', 'No data for this category yet. Ask me about it.'),
                 stamp(), askLine(), buildCta(name));
      return;
    }

    out.append(statLine(cat));

    const block = cat[view];
    const hasLeader = block && block.leader && (view === 'connections' || block.has_gainers);

    if (hasLeader) {
      // Connections ranks every partner; the growth views rank only gainers.
      const rankable = view === 'connections' ? cat.partner_count : block.gainer_count;
      out.append(ranking(block.leader, rankable));
    } else {
      out.append(el('p', 'no-gainers', 'No gainers in this category this period'));
    }

    [stamp(), footnote(), askLine(), buildCta(name)].filter(Boolean).forEach((n2) => out.append(n2));
  }

  catSel.addEventListener('change', () => draw(true));
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      view = btn.dataset.view;
      buttons.forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      draw(true);
    });
  });

  draw(false);
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

/* ---------------------------------------------------------------------------
   Navigation.

   Everything here has to cope with the same fact: inside the embed the iframe is
   sized to its full content height, so it never scrolls. Its scroll position is
   always zero and every section is technically "in view". The parent window is
   what actually moves, so scroll position, section highlighting and click-to-jump
   all have to be driven from the offset the parent reports.

   Standalone, none of those messages arrive and the same code reads window.scrollY
   instead, so a direct visit behaves normally.
   --------------------------------------------------------------------------- */

const nav = {
  // Whether we sit inside a frame is knowable immediately; whether the parent is talking
  // to us is not. Clicks route on the first, because a reader can click before any scroll
  // event has fired. Highlighting and the rail need real scroll data, so they wait.
  inFrame: window.parent !== window,
  reporting: false,      // flips true the first time the parent reports its scroll
  parentOffsetTop: 0,    // where the iframe's top sits in the parent viewport
};

/** How far down the page the reader currently is, in page coordinates. */
function readerPosition() {
  return nav.reporting ? -nav.parentOffsetTop : window.scrollY;
}

/**
 * Highlight exactly one link: the last section whose top has passed the reading line.
 *
 * An IntersectionObserver cannot do this in the embed — with a viewport as tall as the
 * whole document every section intersects at once and every link lights up.
 */
function updateCurrentLink() {
  const line = readerPosition() + 100;

  // Only sections that actually have a link are candidates. Not every section is in the
  // nav, and reading past an unlinked one should hold the previous link rather than
  // leave nothing lit.
  const links = [...document.querySelectorAll('.jumpnav a')];
  const linked = links
    .map((a) => ({ a, section: document.getElementById(a.getAttribute('href').slice(1)) }))
    .filter((x) => x.section);
  if (!linked.length) return;

  let current = linked[0];
  for (const item of linked) {
    if (item.section.offsetTop <= line) current = item;
  }

  links.forEach((a) => a.classList.toggle('is-current', a === current.a));
}

/**
 * Where to land when jumping to a section.
 *
 * A section's box starts well above its heading — that top padding is the air between
 * charts. Scrolling the box to the top of the screen therefore parks the heading a long
 * way down and leaves the tail of the previous chart visible above it. Aim past the
 * padding instead, so the heading arrives near the top and the section before it is gone.
 */
function landingOffset(target) {
  const pad = parseFloat(getComputedStyle(target).paddingTop) || 0;
  return target.offsetTop + pad - 12;
}

/** Scroll to a section, asking the parent to do it when we are embedded. */
function goToSection(id) {
  const target = document.getElementById(id);
  if (!target) return;
  const top = landingOffset(target);

  if (nav.inFrame) {
    // A cross-origin iframe cannot scroll its parent directly, and it cannot scroll
    // itself because it has no scrollable overflow. Ask the parent instead.
    try {
      window.parent.postMessage({ type: 'marketplace-explorer:scrollto', top }, '*');
    } catch (_) { /* nothing more we can do */ }
  } else {
    window.scrollTo({ top: Math.max(0, top - 20), behavior: 'smooth' });
  }
}

function watchNav() {
  document.querySelectorAll('.jumpnav a').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href').slice(1);
      if (!document.getElementById(id)) return;
      e.preventDefault();
      goToSection(id);
    });
  });

  window.addEventListener('scroll', updateCurrentLink, { passive: true });
  updateCurrentLink();
}

/**
 * Keep the nav rail in view while the parent page scrolls.
 *
 * The iframe is sized to its full content height, so it never scrolls internally and
 * `position: sticky` has nothing to stick to — the parent window is what moves. The
 * embed snippet posts the iframe's offset from the top of the viewport on each scroll,
 * and we translate the rail by that amount instead.
 *
 * Without the snippet nothing here fires and the CSS sticky rule still works, so a
 * standalone visit behaves correctly either way.
 */
function followParentScroll() {
  const rail = document.querySelector('.jumpnav');
  const layout = document.querySelector('.layout');
  if (!rail || !layout) return;

  let pending = null;

  function place(offsetTop) {
    // offsetTop is where the iframe's top sits relative to the parent viewport: 0 while
    // the embed is at the top of the screen, negative once scrolled past. The rail also
    // starts partway down the frame, so subtract where it naturally sits.
    const home = rail.offsetTop;
    const wanted = -offsetTop + 20 - home;
    const limit = layout.offsetTop + layout.offsetHeight - home - rail.offsetHeight;
    rail.style.transform = `translateY(${Math.max(0, Math.min(wanted, Math.max(0, limit)))}px)`;
    updateCurrentLink();
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (!d || d.type !== 'marketplace-explorer:scroll' || typeof d.offsetTop !== 'number') return;

    nav.reporting = true;
    nav.parentOffsetTop = d.offsetTop;
    rail.classList.add('is-following');
    if (pending !== null) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => { pending = null; place(d.offsetTop); });
  });
}

/** Tell the Squarespace parent how tall we are, so the iframe can size itself. */
function reportHeight() {
  const send = () => {
    try {
      window.parent.postMessage(
        { type: 'marketplace-explorer:height', height: document.documentElement.scrollHeight },
        '*'
      );
    } catch (_) { /* not embedded */ }
  };
  send();
  new ResizeObserver(send).observe(document.body);
  window.addEventListener('load', send);
}

async function main() {
  const load = (f) => fetch(`data/${f}.json`, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`${f}.json → ${r.status}`);
    return r.json();
  });

  // The two halves fail independently: a broken report must not take the
  // leaderboard down with it, or vice versa.
  const [explorer, report] = await Promise.allSettled([
    load('explorer'),
    Promise.all(REPORT_FILES.map(load)).then((r) =>
      Object.fromEntries(REPORT_FILES.map((f, i) => [f, r[i]]))),
  ]);

  if (explorer.status === 'fulfilled') {
    renderExplorer(explorer.value);
  } else {
    document.getElementById('explorer-result').innerHTML =
      `<p class="error">Could not load the rankings (${escapeHtml(explorer.reason.message)}).</p>`;
  }

  if (report.status === 'fulfilled') {
    const d = report.value;
    renderHeadline(d.summary);
    renderStateOfMarket(d.state_of_market);
    renderNetByCategory(d.net_by_category);
    renderNewEntrants(d.new_entrants);
    renderDepartures(d.departures);
    renderTopGainers(d.top_gainers);
    renderLongTail(d.long_tail);
    renderConcentration(d.concentration);
    renderRatings(d.ratings);
  } else {
    document.querySelector('.report').insertAdjacentHTML('afterbegin',
      `<p class="error">Could not load the report (${escapeHtml(report.reason.message)}).</p>`);
  }

  watchNav();
  reportHeight();
  followParentScroll();

  // Deep link from a blog post. Delayed a beat so that, when embedded, the parent has
  // had a chance to report its offset and goToSection knows which route to take.
  if (location.hash && location.hash.length > 1) {
    const id = location.hash.slice(1);
    if (document.getElementById(id)) setTimeout(() => goToSection(id), 120);
  }
}

main();
