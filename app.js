/* =========================================================================
   Marketplace explorer widget.

   Standalone embed: a category dropdown, three ranking views, and the leading
   partner in each. The rest of the ranking is available on request.

   Reads data/explorer.json, which the generator builds from the marketplace
   database on a monthly cadence.
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

const LOCK_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10V7a6 6 0 0 1 12 0v3h1a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1h1zm2 0h8V7a4 4 0 0 0-8 0v3z"/></svg>';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

const fmt = (n) => n.toLocaleString('en-US');
const signed = (n) => (n > 0 ? '+' : '') + fmt(n);

/** Format an ISO date without going through Date(), which would shift it by a timezone. */
function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function track(event, data) {
  try {
    if (window.umami && typeof window.umami.track === 'function') window.umami.track(event, data);
  } catch (_) { /* analytics must never break the widget */ }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderExplorer(data) {
  const catSel = document.getElementById('sel-category');
  const out = document.getElementById('explorer-result');
  const buttons = [...document.querySelectorAll('.toggle button')];

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

  function stamp() {
    return el('p', 'as-of', `Updated monthly · Data as of ${longDate(data.boundary_end)}`);
  }

  function askLine() {
    return el('p', 'ask-line',
      'Want the full top 10, or any of this cut by specialty? Both are available on request.');
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
      out.append(el('p', 'thin-slice', 'No data for this category yet — ask me about it.'),
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

    out.append(stamp(), askLine(), buildCta(name));
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
  let data;
  try {
    const res = await fetch('data/explorer.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`explorer.json → ${res.status}`);
    data = await res.json();
  } catch (err) {
    document.getElementById('explorer-result').innerHTML =
      `<p class="error">Could not load the rankings (${err.message}).</p>`;
    return;
  }

  renderExplorer(data);
  reportHeight();
}

main();
