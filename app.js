/* =========================================================================
   Marketplace explorer widget.

   Standalone embed: two dropdowns, the leading vendor for the selected
   category and specialty, and the rest of the ranking available on request.

   Reads data/explorer.json, which the generator builds from the marketplace
   database on a monthly cadence.
   ========================================================================= */

'use strict';

const CONTACT_URL = 'https://alsgaardmiller.com/contact';
const ALL_SPECIALTIES = 'All specialties';
const MAX_GATED_ROWS = 9;
const GATED_WIDTHS = [88, 79, 71, 64, 57, 51, 45, 40, 35];

const LOCK_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10V7a6 6 0 0 1 12 0v3h1a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1h1zm2 0h8V7a4 4 0 0 0-8 0v3z"/></svg>';

const fmt = (n) => n.toLocaleString('en-US');

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
  const specSel = document.getElementById('sel-specialty');
  const out = document.getElementById('explorer-result');

  data.categories.forEach((c) => catSel.append(new Option(c, c)));
  data.specialties.forEach((s) => specSel.append(new Option(s, s)));
  specSel.value = ALL_SPECIALTIES;

  function buildCta(cat, spec) {
    const a = el('a', 'cta', 'Request the full ranking →');
    a.target = '_top';
    a.href = `${CONTACT_URL}?slice=${encodeURIComponent(cat + ' x ' + spec)}`;
    a.addEventListener('click', () => track('gate_hit', { category: cat, specialty: spec }));
    return a;
  }

  function stamp() {
    return el('p', 'as-of', `Updated as of ${data.as_of_label}`);
  }

  // The two things this ranking deliberately does not show, offered as a reason to get in
  // touch. Growth at this granularity moves by single connections month to month, so it is
  // worth a conversation rather than a chart; and the specialty list is pruned to the ones
  // that reliably rank, so the rest arrive by request.
  function askLine() {
    return el('p', 'ask-line',
      'Want to know who is growing fastest in this slice, or need a specialty that is not ' +
      'in the list? Both are available on request.');
  }

  function draw(isUserAction) {
    const cat = catSel.value;
    const spec = specSel.value;
    const slice = data.slices[`${cat}|${spec}`];
    out.innerHTML = '';

    if (isUserAction) track('explorer_slice', { category: cat, specialty: spec });

    if (!slice || !slice.leader) {
      const n = slice ? slice.partner_count : 0;
      out.append(
        el('p', 'thin-slice', n
          ? `Only ${n} partner${n === 1 ? ' serves' : 's serve'} this slice — not enough for a ranking. Ask me about it.`
          : 'No partners recorded in this slice yet — ask me about it.'),
        stamp(),
        askLine(),
        buildCta(cat, spec)
      );
      return;
    }

    out.append(el('p', 'slice-meta',
      `${fmt(slice.partner_count)} partners · ${fmt(slice.total_connections)} connections in this slice`));

    // The leading vendor for this slice.
    const leader = el('div', 'leader');
    leader.append(el('span', 'rank', '1'));
    const trackEl = el('div', 'row-track');
    const bar = el('div', 'bar');
    bar.style.width = '100%';
    bar.style.left = '0';
    trackEl.append(bar, el('span', 'leader-name',
      `${slice.leader.name} — ${fmt(slice.leader.connections)}`));
    leader.append(trackEl);
    out.append(leader);

    // The remainder of the ranking, available on request.
    // Never draw more rows than there are vendors in the slice — the partner count is
    // stated directly above, and the two must agree.
    const gatedRows = Math.min(MAX_GATED_ROWS, slice.partner_count - 1);
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
    const lastRank = gatedRows + 1;
    overlay.innerHTML = LOCK_SVG +
      `<p>${gatedRows === 1 ? 'Rank 2' : `Ranks 2–${lastRank}`} available on request</p>`;
    locked.append(overlay);
    out.append(locked, stamp(), askLine(), buildCta(cat, spec));
  }

  catSel.addEventListener('change', () => draw(true));
  specSel.addEventListener('change', () => draw(true));
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
  track('widget_viewed', { widget: 'explorer' });
}

main();
