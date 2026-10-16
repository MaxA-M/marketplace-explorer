/* =========================================================================
   Marketplace Intelligence.

   One page, switched by quarter. A toggle at the top picks the quarter and
   everything on the page follows it: the leaderboard (as of quarter end) and
   the quarter's report. Each quarter is a bundle under data/<quarter>/, listed
   in data/quarters.json; adding a quarter is a data change, not a code change.

   The selected quarter lives in the URL hash so deep links carry it:
   #q3-2026, #q3-2026-top-gainers, #q3-gainers. A link with no quarter prefix
   (the older #top-gainers style) resolves to the latest quarter.

   Nothing numeric lives in this file.
   ========================================================================= */

'use strict';

const CONTACT_URL = 'https://alsgaardmiller.com/contact';
const MAX_GATED_ROWS = 9;
const GATED_WIDTHS = [88, 79, 71, 64, 57, 51, 45, 40, 35];

const VIEWS = {
  connections:   { slug: 'connections',   format: (v) => fmt(v) },
  growth_volume: { slug: 'growth-volume', format: (v) => (v > 0 ? '+' : '') + fmt(v) },
  growth_pct:    { slug: 'growth-pct',    format: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + '%' },
};

// Short names a blog post might use for a section, and the retired sections that now live
// inside another one. Anything not listed is taken as a literal section id.
const SECTION_ALIASES = {
  glance: 'headline', 'at-a-glance': 'headline', headlines: 'headline',
  categories: 'state-of-market', state: 'state-of-market',
  comparison: 'net-by-category', compare: 'net-by-category', 'q-over-q': 'net-by-category',
  net: 'net-by-category', gainers: 'top-gainers',
  'new-entrants': 'turnover', departures: 'turnover',
  'long-tail': 'headline',
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


/** Two-sided bars sharing one zero line: one row per category, `a` and `b` stacked. */
function renderPaired(mountId, rows, labels) {
  const mount = document.getElementById(mountId);
  mount.innerHTML = '';
  const lo = Math.min(0, ...rows.flatMap((r) => [r.a, r.b]));
  const hi = Math.max(0, ...rows.flatMap((r) => [r.a, r.b]));
  const span = hi - lo || 1;
  const zero = (-lo / span) * 100;

  const wrap = el('div', 'rows paired');
  rows.forEach((r, i) => {
    const row = el('div', 'row');
    const label = el('div', 'row-label', r.label);
    label.title = r.label;
    const trackEl = el('div', 'pair-track');
    trackEl.style.setProperty('--zero', zero + '%');
    [['a', r.a], ['b', r.b]].forEach(([k, v]) => {
      const w = Math.max((Math.abs(v) / span) * 100, 0.6);
      const bar = el('div', `pbar pbar-${k}` + (v < 0 ? ' neg' : ''));
      bar.style.width = w + '%';
      bar.style.left = (v < 0 ? zero - w : zero) + '%';
      bar.style.animationDelay = i * 30 + 'ms';
      bar.title = `${k === 'a' ? labels.a : labels.b}: ${signed(v)}`;
      trackEl.append(bar);
    });
    const values = el('div', 'row-values');
    values.append(el('span', 'row-sub', signed(r.a)), el('span', 'arrow', '→'),
                  el('span', 'row-value' + (r.b < 0 ? ' neg' : ''), signed(r.b)));
    row.append(label, trackEl, values);
    wrap.append(row);
  });
  mount.append(wrap);
}

/** Departures to the left of zero, new partners to the right, net as the value. */
function renderTurnover(mountId, rows) {
  const mount = document.getElementById(mountId);
  mount.innerHTML = '';
  const maxDep = Math.max(1, ...rows.map((r) => r.departed));
  const maxAdd = Math.max(1, ...rows.map((r) => r.added));
  const span = maxDep + maxAdd;
  const zero = (maxDep / span) * 100;

  const wrap = el('div', 'rows turnover');
  rows.forEach((r, i) => {
    const row = el('div', 'row');
    const label = el('div', 'row-label', r.name);
    label.title = r.name;
    const trackEl = el('div', 'row-track turnover-track');
    trackEl.style.setProperty('--zero', zero + '%');
    if (r.departed) {
      const w = (r.departed / span) * 100;
      const bar = el('div', 'bar neg');
      Object.assign(bar.style, { width: w + '%', left: zero - w + '%', animationDelay: i * 30 + 'ms' });
      bar.title = `${r.departed} departed`;
      trackEl.append(bar);
    }
    if (r.added) {
      const w = (r.added / span) * 100;
      const bar = el('div', 'bar');
      Object.assign(bar.style, { width: w + '%', left: zero + '%', animationDelay: i * 30 + 'ms' });
      bar.title = `${r.added} added`;
      trackEl.append(bar);
    }
    const net = r.added - r.departed;
    const values = el('div', 'row-values');
    values.append(el('span', 'row-value' + (net < 0 ? ' neg' : net > 0 ? ' pos' : ''),
                     net === 0 ? '0' : signed(net)),
                  el('span', 'row-sub', `+${r.added} / −${r.departed}`));
    row.append(label, trackEl, values);
    wrap.append(row);
  });
  mount.append(wrap);
}

/* ---------------------------------------------------------------------------
   The quarter's report
   --------------------------------------------------------------------------- */

const shortLabel = (label) => label.split(' ')[0];   // "Q3 2026" -> "Q3"

/** Fill every quarter-dependent label and show or hide prior-quarter sections. */
function fillLabels(report, prior) {
  const values = {
    label: report.label, short: shortLabel(report.label), months: report.months,
    'prior-label': prior ? prior.label : '', 'prior-short': prior ? shortLabel(prior.label) : '',
  };
  document.querySelectorAll('[data-q]').forEach((n) => { n.textContent = values[n.dataset.q] ?? ''; });
  document.querySelectorAll('[data-needs-prior]').forEach((n) => { n.hidden = !prior; });
}

function asteriskText(a) {
  return `${a.category}: one partner’s count fell by ${fmt(Math.abs(a.partner_change))} this ` +
         `quarter, almost all of it in a single day at quarter end. Without that partner the ` +
         `category netted ${signed(a.category_net_excluding)}.`;
}

function renderHeadline(report, prior) {
  const s = report.summary;
  const p = prior ? prior.summary : null;
  const pl = prior ? shortLabel(prior.label) : '';
  document.getElementById('framing-count').textContent = fmt(s.partners_end);

  const stats = [
    { value: signed(s.net_new_connections) + (report.asterisk ? '*' : ''), label: 'Net new partner connections',
      pos: true, was: p && signed(p.net_new_connections) },
    { value: fmt(s.connections_end), label: 'Total partner connections', was: p && fmt(p.connections_end) },
    { value: `${s.partners_added} / ${s.partners_departed}`, label: 'Partners joined / departed',
      was: p && `${p.partners_added} / ${p.partners_departed}` },
  ];
  const bar = document.getElementById('statbar');
  bar.innerHTML = '';
  stats.forEach((st) => {
    const card = el('div', 'stat');
    card.append(el('span', 'stat-value' + (st.pos ? ' pos' : ''), st.value),
                el('span', 'stat-label', st.label));
    if (st.was) card.append(el('span', 'stat-was', `${pl}: ${st.was}`));
    bar.append(card);
  });

  let note = 'Counted by company: a company with several marketplace listings counts as one ' +
             'partner, because athena reports its connections once per company.';
  if (report.published) {
    note += ` These ${report.label} figures are counted that way too, so they differ from the ` +
            `${report.label} post as originally published (${fmt(report.published.partners_end)} partners, ` +
            `${signed(report.published.net_new_connections)} net new connections).`;
  }
  const mn = document.getElementById('method-note');
  mn.textContent = note;
  if (report.asterisk) {
    mn.append(el('br'), el('span', 'ast', '* '),
      document.createTextNode('Without one partner’s quarter-end drop, net new connections were '),
      el('strong', null, signed(report.asterisk.marketplace_net_excluding)), document.createTextNode('.'));
  }
}

/** Mark the asterisked category's label, and fill or hide each chart note. */
function labelFor(report, name) {
  return report.asterisk && report.asterisk.category === name ? name + '*' : name;
}

function renderAsteriskNotes(report) {
  document.querySelectorAll('[data-asterisk-note]').forEach((n) => {
    n.hidden = !report.asterisk;
    n.textContent = report.asterisk ? '* ' + asteriskText(report.asterisk) : '';
  });
}

function renderStateOfMarket(report) {
  renderBars('chart-state-of-market', report.state_of_market.map((c) => ({
    label: c.name, value: c.connections, valueText: fmt(c.connections), sub: `${c.partners} partners`,
  })));
}

/**
 * One chart, three views: this quarter by volume, by rate, or by volume against the prior
 * quarter. The comparison view exists only when a prior quarter is in the data.
 */
function renderNetByCategory(report, prior) {
  const view = state.netView === 'prior' && !prior ? 'net' : state.netView;
  const legend = document.getElementById('net-legend');
  legend.hidden = view !== 'prior';

  if (view === 'prior') {
    const before = Object.fromEntries(prior.net_by_category.map((c) => [c.name, c.net_change]));
    legend.innerHTML =
      `<span><i class="sw sw-a"></i>${escapeHtml(prior.label)}</span>` +
      `<span><i class="sw sw-b"></i>${escapeHtml(report.label)}</span>`;
    renderPaired('chart-net-by-category', report.net_by_category.map((c) => ({
      label: labelFor(report, c.name), a: before[c.name] ?? 0, b: c.net_change,
    })), { a: prior.label, b: report.label });
    return;
  }

  const rows = [...report.net_by_category].sort((a, b) =>
    view === 'net' ? b.net_change - a.net_change : (b.rate_pct ?? -1e9) - (a.rate_pct ?? -1e9));
  renderBars('chart-net-by-category', rows.map((c) => ({
    label: labelFor(report, c.name),
    value: view === 'net' ? c.net_change : (c.rate_pct ?? 0),
    valueText: view === 'net' ? signed(c.net_change) : (c.rate_pct == null ? '—' : signedPct(c.rate_pct)),
    sub: view === 'net' ? (c.rate_pct == null ? '' : signedPct(c.rate_pct)) : signed(c.net_change),
  })), { diverging: true, axisFormat: view === 'net' ? (t) => signed(t) : (t) => signedPct(t) });
}

function renderConcentration(report) {
  renderBars('chart-concentration', report.concentration.map((c) => ({
    label: c.name, value: c.top3_share_pct, valueText: c.top3_share_pct.toFixed(1) + '%',
    sub: `${c.partners} partners`,
  })), { max: 100, axisFormat: (t) => t + '%' });
}

function renderTopGainers(report) {
  const g = report.top_gainers;
  const view = state.gainView;
  document.getElementById('gainers-dek').textContent =
    `The ten partners that grew the most this quarter. The % growth view requires at least ` +
    `${g.pct_min_base} connections at quarter start, which filters out small-number noise.`;

  const rows = g[view] || [];
  const mount = document.getElementById('chart-top-gainers');
  const head = view === 'by_pct' ? 'Growth' : 'Gained';
  let h = '<table class="gtable"><thead><tr><th class="rk"></th><th>Partner</th>' +
          `<th class="num">${escapeHtml(shortDate(report.start_date))} → ${escapeHtml(shortDate(report.end_date))}</th>` +
          `<th class="num">${head}</th></tr></thead><tbody>`;
  rows.forEach((r, i) => {
    const v = view === 'by_pct' ? signedPct(r.gain_pct) : signed(r.gain);
    h += `<tr><td class="rk">${i + 1}</td><td class="nm">${escapeHtml(r.name)}</td>` +
         `<td class="ch">${fmt(r.start)} → ${fmt(r.end)}</td><td class="gv">${v}</td></tr>`;
  });
  mount.innerHTML = h + '</tbody></table>';
}

function renderTurnoverSection(report) {
  const s = report.summary;
  document.getElementById('turnover-dek').textContent =
    `${s.partners_added} partners joined and ${s.partners_departed} left during the quarter. ` +
    `New partners on the right, departures on the left; the number is the net.`;
  document.getElementById('turnover-legend').innerHTML =
    '<span><i class="sw sw-dep"></i>Departed</span><span><i class="sw sw-add"></i>Added</span>';
  renderTurnover('chart-turnover', report.turnover);
}

function renderRatings(report) {
  const raters = report.ratings;
  document.getElementById('ratings-callout').innerHTML =
    `<strong>${report.summary.pct_zero_new_ratings}%</strong> of marketplace partners received zero ` +
    `new ratings this quarter. The ratings that did come in went to the partners below.`;

  const shown = raters.filter((r) => r.new_ratings >= 2);
  const singles = raters.length - shown.length;
  renderBars('chart-ratings', (shown.length ? shown : raters).map((r) => ({
    label: r.name, value: r.new_ratings, valueText: signed(r.new_ratings),
    sub: r.avg_end != null ? r.avg_end.toFixed(2) + ' ★' : '',
  })), { positiveGreen: true });

  const note = document.getElementById('ratings-note');
  note.textContent = (shown.length && singles ? `Plus ${singles} partners with one new rating each. ` : '') +
    'athena ratings are Bayesian averages, which protect new partners from early bad reviews ' +
    'but make the numbers hard to compare across partners.';
}

function renderBlogLink(report) {
  const p = document.getElementById('blog-link');
  p.hidden = !report.blog_url;
  if (report.blog_url) p.querySelector('a').href = report.blog_url;
}

function renderReport(report, prior) {
  renderHeadline(report, prior);
  renderAsteriskNotes(report);
  renderStateOfMarket(report);
  renderNetByCategory(report, prior);
  renderConcentration(report);
  renderTopGainers(report);
  renderTurnoverSection(report);
  renderRatings(report);
  renderBlogLink(report);
}

/** "Jun 30" — short enough for a table header. */
function shortDate(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1].slice(0, 3)} ${d}`;
}

/* ---------------------------------------------------------------------------
   Leaderboard — as of quarter end, rank 1 only
   --------------------------------------------------------------------------- */

function renderLeaderboard(data) {
  const catSel = document.getElementById('sel-category');
  const out = document.getElementById('explorer-result');

  const names = Object.keys(data.categories).sort();
  if (!names.includes(state.category)) state.category = names[0];
  catSel.innerHTML = '';
  names.forEach((c) => catSel.append(new Option(c, c, false, c === state.category)));

  const view = state.lbView;
  const name = state.category;
  const cat = data.categories[name];

  function buildCta() {
    const a = el('a', 'cta', 'Request the full ranking →');
    a.target = '_top';
    a.href = `${CONTACT_URL}?category=${encodeURIComponent(name)}&view=${VIEWS[view].slug}` +
             `&quarter=${encodeURIComponent(data.id)}`;
    a.addEventListener('click', () => track('gate_hit', { category: name, view, quarter: data.id }));
    return a;
  }

  // The connections view is a point in time; the growth views cover the quarter. Say which.
  function stamp() {
    const range = view === 'connections'
      ? `Data as of ${longDate(data.end_date)}`
      : `Growth measured ${dateRange(data.start_date, data.end_date)}`;
    return el('p', 'as-of', `Updated quarterly · ${range}`);
  }

  function footnote() {
    if (view !== 'growth_pct' || !data.pct_min_base) return null;
    return el('p', 'footnote',
      `Percentage growth counts only partners that entered the quarter with ${data.pct_min_base} or more connections.`);
  }

  function askLine() {
    return el('p', 'ask-line',
      'Want the full list, or any of this cut by specialty? Both are available on request.');
  }

  function statLine() {
    const partners = `${fmt(cat.partner_count)} partners`;
    return el('p', 'slice-meta', view === 'connections'
      ? `${partners} · ${fmt(cat.total_connections)} connections in this category`
      : `${partners} · ${signed(cat.net_change)} net connections this quarter`);
  }

  function ranking(leader, rankableCount) {
    const frag = document.createDocumentFragment();
    const row = el('div', 'leader');
    row.append(el('span', 'rank', '1'));
    const trackEl = el('div', 'row-track');
    const bar = el('div', 'bar');
    bar.style.width = '100%';
    bar.style.left = '0';
    trackEl.append(bar, el('span', 'leader-name', `${leader.name} · ${VIEWS[view].format(leader.value)}`));
    row.append(trackEl);
    frag.append(row);

    // Never draw more gated rows than there are partners to rank: in the growth views only
    // gainers are rankable.
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
      overlay.innerHTML = LOCK_SVG + `<p>${gatedRows === 1 ? 'Rank 2' : `Ranks 2–${gatedRows + 1}`} available on request</p>`;
      locked.append(overlay);
      frag.append(locked);
    }
    return frag;
  }

  out.innerHTML = '';
  if (!cat) {
    out.append(el('p', 'thin-slice', 'No data for this category yet. Ask me about it.'),
               stamp(), askLine(), buildCta());
    return;
  }
  out.append(statLine());
  const block = cat[view];
  if (block && block.leader) {
    const rankable = view === 'connections' ? cat.partner_count : block.gainer_count;
    out.append(ranking(block.leader, rankable));
  } else {
    out.append(el('p', 'no-gainers', 'No gainers in this category this quarter'));
  }
  [stamp(), footnote(), askLine(), buildCta()].filter(Boolean).forEach((n) => out.append(n));
}

/* ---------------------------------------------------------------------------
   Quarter state, data loading, hash
   --------------------------------------------------------------------------- */

const state = {
  quarters: [],        // [{id, label}], oldest first
  latest: null,
  q: null,
  category: null,
  lbView: 'connections',
  netView: 'net',
  gainView: 'by_pct',
};

const cache = {};

function fetchJson(path) {
  return fetch(path, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  });
}

function loadQuarter(id) {
  if (!cache[id]) {
    // The halves fail independently: a broken report must not take the leaderboard down.
    cache[id] = Promise.allSettled([
      fetchJson(`data/${id}/report.json`),
      fetchJson(`data/${id}/leaderboard.json`),
    ]);
  }
  return cache[id];
}

/** "#q3-2026-top-gainers" | "#q3-gainers" | "#q3-2026" | "#top-gainers" -> {q, section} */
function parseHash(hash) {
  const h = (hash || '').replace(/^#/, '').toLowerCase();
  const resolve = (s) => (s ? SECTION_ALIASES[s] || s : null);
  const m = h.match(/^(q[1-4])(?:-(\d{4}))?(?:-(.+))?$/);
  if (m) {
    const ids = state.quarters.map((q) => q.id);
    const id = m[2] ? `${m[1]}-${m[2]}`
      : [...ids].reverse().find((x) => x.startsWith(m[1] + '-'));
    if (id && ids.includes(id)) return { q: id, section: resolve(m[3]) };
    return { q: state.latest, section: resolve(m[3]) };
  }
  return { q: state.latest, section: resolve(h) || null };
}

function renderQuarterToggle() {
  const host = document.getElementById('quarter-toggle');
  host.innerHTML = '';
  state.quarters.forEach((q) => {
    const b = el('button', null, q.label);
    b.setAttribute('role', 'tab');
    b.dataset.view = q.id;
    b.setAttribute('aria-selected', String(q.id === state.q));
    b.addEventListener('click', () => {
      if (q.id === state.q) return;
      setQuarter(q.id);
      try { history.replaceState(null, '', '#' + q.id); } catch (_) { /* sandboxed */ }
      track('quarter_selected', { quarter: q.id });
    });
    host.append(b);
  });
}

let drawToken = 0;

async function setQuarter(id) {
  state.q = id;
  document.querySelectorAll('#quarter-toggle button').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.view === id)));

  const token = ++drawToken;
  const idx = state.quarters.findIndex((q) => q.id === id);
  const priorId = idx > 0 ? state.quarters[idx - 1].id : null;
  const [[report, leaderboard], priorResult] = await Promise.all([
    loadQuarter(id), priorId ? loadQuarter(priorId) : Promise.resolve(null),
  ]);
  if (token !== drawToken) return;   // a newer toggle click won

  const prior = priorResult && priorResult[0].status === 'fulfilled' ? priorResult[0].value : null;

  document.querySelectorAll('.load-error').forEach((n) => n.remove());

  // The net-change chart opens on the quarter-over-quarter view whenever there is a prior
  // quarter to compare against, and on volume otherwise.
  state.netView = prior ? 'prior' : 'net';
  document.querySelectorAll('#net-toggle button').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.view === state.netView)));
  state.prior = prior;

  if (report.status === 'fulfilled') {
    fillLabels(report.value, prior);
    renderReport(report.value, prior);
  } else {
    document.getElementById('report').insertAdjacentHTML('afterbegin',
      `<p class="error load-error">Could not load the report (${escapeHtml(report.reason.message)}).</p>`);
  }
  if (leaderboard.status === 'fulfilled') {
    state.lbData = leaderboard.value;
    renderLeaderboard(leaderboard.value);
  } else {
    document.getElementById('explorer-result').innerHTML =
      `<p class="error load-error">Could not load the rankings (${escapeHtml(leaderboard.reason.message)}).</p>`;
  }
  updateCurrentLink();
  sendHeight();
}

/** Toggles that re-draw one thing without reloading the quarter. Wired once. */
function wireControls() {
  const bind = (selector, onChange) => {
    const buttons = [...document.querySelectorAll(selector + ' button')];
    buttons.forEach((btn) => btn.addEventListener('click', () => {
      buttons.forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      onChange(btn.dataset.view);
    }));
  };
  const withReport = (fn) => loadQuarter(state.q).then(([r]) => { if (r.status === 'fulfilled') fn(r.value); });

  bind('#lb-toggle', (v) => {
    state.lbView = v;
    if (state.lbData) renderLeaderboard(state.lbData);
    track('explorer_view', { category: state.category, view: v });
  });
  document.getElementById('sel-category').addEventListener('change', (e) => {
    state.category = e.target.value;
    if (state.lbData) renderLeaderboard(state.lbData);
    track('explorer_view', { category: state.category, view: state.lbView });
  });
  bind('#net-toggle', (v) => { state.netView = v; withReport((r) => renderNetByCategory(r, state.prior)); });
  bind('#gainers-toggle', (v) => { state.gainView = v; withReport(renderTopGainers); });
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
  const links = [...document.querySelectorAll('.jumpnav a')].filter((a) => !a.hidden);
  const linked = links
    .map((a) => ({ a, section: document.getElementById(a.getAttribute('href').slice(1)) }))
    .filter((x) => x.section && !x.section.hidden);
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

/**
 * Tell the Squarespace parent how tall we are, so the iframe can size itself.
 *
 * Measure the body, not documentElement.scrollHeight: inside an iframe the document is
 * never shorter than the frame, so scrollHeight could grow the embed but never shrink it.
 * That matters now that switching quarters changes the page's length.
 */
function sendHeight() {
  try {
    window.parent.postMessage(
      { type: 'marketplace-explorer:height', height: Math.ceil(document.body.getBoundingClientRect().height) },
      '*'
    );
  } catch (_) { /* not embedded */ }
}

function reportHeight() {
  sendHeight();
  new ResizeObserver(sendHeight).observe(document.body);
  window.addEventListener('load', sendHeight);
}

async function main() {
  try {
    const idx = await fetchJson('data/quarters.json');
    state.quarters = idx.quarters;
    state.latest = idx.latest;
  } catch (err) {
    document.getElementById('explorer-result').innerHTML =
      `<p class="error">Could not load the quarter list (${escapeHtml(err.message)}).</p>`;
    return;
  }

  const target = parseHash(location.hash);
  state.q = target.q;
  renderQuarterToggle();
  wireControls();
  watchNav();
  reportHeight();
  followParentScroll();
  await setQuarter(state.q);

  // Deep link from a blog post. Delayed a beat so that, when embedded, the parent has had a
  // chance to report its offset and goToSection knows which route to take.
  if (target.section && document.getElementById(target.section)) {
    setTimeout(() => goToSection(target.section), 120);
  }
}

main();
