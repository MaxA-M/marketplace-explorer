# Marketplace Explorer

The "Marketplace Intelligence" page for alsgaardmiller.com: one static page, deployed to GitHub
Pages and embedded in Squarespace via iframe. No build step, no dependencies.

**The page is switched by quarter.** A toggle under the title (Q2 2026 · Q3 2026 …) drives the
whole page, and it defaults to the latest quarter:

| Half | What it is | As of |
|---|---|---|
| Leaderboard | Rank-1 partner per category, three views (connections, growth by volume, growth by %) | quarter end; growth views cover the quarter |
| Report | The quarter's charts | the quarter |

Cadence is **quarterly** for both halves. There is no monthly refresh any more.

- `index.html`, `app.js`, `styles.css` — the whole page.
- `data/quarters.json` — the quarter list the page reads first, oldest to newest, plus `latest`.
- `data/<quarter>/report.json` and `data/<quarter>/leaderboard.json` — one bundle per quarter,
  same schema every quarter. The only data that ships.
- `generate_data.py` — builds every bundle from the marketplace SQLite database (read-only).

## How the numbers are counted

- **By company.** athena reports connections per partner contract, so a company with several
  listings shows the same count on each. Listings that share a contract (`listing_groups` in the
  database) count as one partner carrying that count, placed in the category of its largest
  listing.
- **Every quarter is regenerated on every run** with today's categories, so quarters always
  compare like with like. That means **Q2 2026 on this page differs from the Q2 post as
  published** (which counted listings: 554 partners, +993 net). The at-a-glance note says so.
- Identity is `api_created_at`, never slug, so a partner that renames is one continuous record.
  Joins and departures are computed on companies after that matching.
- Boundary pulls are pinned per quarter in `QUARTERS` (the detail pull on each quarter-end date).

The database lives outside this repo and is never committed. The leaderboard payload carries
rank 1 only; ranks 2–10 on the page are decorative placeholders. The generator refuses to write a
leaderboard entry with any other keys. Losses only ever appear at category level, never by name;
a partner-driven footnote (the Q3 RCM asterisk) stays unnamed.

## The page, top to bottom

1. **Quarter toggle**
2. **Leaderboard** — "Updated quarterly · Data as of [quarter end]" (growth views state the
   quarter as their window)
3. Seam line: "Below: the full [quarter] marketplace report…"
4. **Report header** — "[quarter] Marketplace Report"; subhead "Tracked daily across [N]
   marketplace partners · [Month–Month YYYY]"; then "Categories follow my own taxonomy rather than
   athena's native one." The quarter-end date lives only in the leaderboard stamp.
5. The report, in this order on every quarter:
   1. **At a glance** (`#headline`) — three tiles: net new connections, total connections,
      partners joined / departed. Each shows the prior quarter's figure; methodology note below.
   2. **Net connection change by category** (`#net-by-category`) — toggle Volume · Rate ·
      vs [prior quarter]. Opens on the comparison when a prior quarter exists, otherwise on
      Volume with the comparison hidden. The comparison is volume only. The quarter's asterisk
      footnote, if any, renders once under this chart.
   3. **Top gainers** (`#top-gainers`) — one table, toggle % Growth · Connections, default
      % Growth. The % view needs 10+ connections at quarter start.
   4. **Partner turnover by category** (`#turnover`) — departures left, new partners right, net
      as the number.
   5. **The state of the marketplace** (`#state-of-market`)
   6. **Category concentration** (`#concentration`)
   7. **Ratings activity** (`#ratings`) — partners with 2+ new ratings as bars, the single-rating
      count and the Bayesian-average line beneath.
6. **Blog link** — per quarter from `blog_url`; hidden while it is `None`.

### Deep links

The quarter rides in the hash: `#q3-2026`, `#q3-2026-top-gainers`, or the short `#q3-gainers`
(latest year with that quarter). A hash with no quarter (`#top-gainers`, as older blog posts use)
opens the latest quarter. Retired sections are aliased in `SECTION_ALIASES` in `app.js`: new
entrants and departures go to turnover, the old comparison section to net change, long tail to at
a glance.

## Run it locally

```bash
python3 -m http.server 8153 --directory .
```

Then open http://localhost:8153. Opened with `file://`, the JSON fetches are blocked by CORS.
`embed-test.html` (gitignored) wraps the page in the Squarespace snippet below for testing the
embed.

## Adding a quarter

1. **Wait for the quarter-end full pull** and download the database (see the athena-databases
   runbook). Category curation is applied by the cloud refresh, so the download already has it.
2. **Check every listing at quarter end has a category.** The generator prints
   `uncategorized_end` for each quarter and it must be 0. New listings get categories through a
   committed curation file in `athena-databases/marketplace-v2/curation/`, never a hand edit.
3. **Add one entry to `QUARTERS`** in `generate_data.py`: `id`, `label`, `months`, the start and
   end boundary pulls and dates, the creation window, `blog_url` (`None` until the post is live),
   `published` (`None`), any `baseline_overrides` (a 0 that meant "not reporting yet"), and an
   `asterisk_slug` only if one partner's move dominates a category.
4. **Run the generator and read its report.**

   ```bash
   python3 generate_data.py
   ```

   It prints the at-a-glance table for every quarter and, per quarter, checks that categories
   add up to the totals and adds and departures to the headline counts. Every line should read
   `ok`. It also lists every display name it shortened; add to `DISPLAY_OVERRIDES` when one reads
   wrong.
5. **Check it locally**, both the new quarter and the one before it (the new quarter's prior
   comparison appears automatically).
6. **Commit and push.** GitHub Pages caches for about ten minutes.
7. **When the blog post is live,** set its `blog_url`, regenerate, and push.

Regenerating also restates earlier quarters if categories changed since. That is intended.

## Squarespace embed

One code block on one Squarespace page. **Both scripts matter** — the first sizes the iframe,
the second is what makes the nav rail follow the reader.

```html
<div style="position:relative;width:100%;">
  <iframe
    id="marketplace-explorer"
    src="https://MaxA-M.github.io/marketplace-explorer/"
    title="Marketplace Intelligence"
    loading="lazy"
    style="width:100%;height:6100px;border:0;display:block;"
    scrolling="no"></iframe>
</div>
<script>
(function () {
  var frame = document.getElementById('marketplace-explorer');

  // The page reports its own height, so the iframe grows and shrinks with its content
  // instead of scrolling inside itself.
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'marketplace-explorer:height') return;
    if (e.data.height) frame.style.height = e.data.height + 'px';
  });

  // Because the iframe never scrolls internally, its nav rail cannot stick on its own.
  // Tell it where it sits relative to this window and it keeps the rail in view.
  var queued = false;
  function report() {
    queued = false;
    if (frame.contentWindow) {
      frame.contentWindow.postMessage(
        { type: 'marketplace-explorer:scroll', offsetTop: frame.getBoundingClientRect().top },
        '*'
      );
    }
  }
  function onScroll() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(report);
  }
  // The page asks us to scroll when a nav link is clicked: a cross-origin iframe cannot
  // scroll its parent, and it cannot scroll itself because it has no overflow.
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'marketplace-explorer:scrollto') return;
    if (typeof e.data.top !== 'number') return;
    var y = window.scrollY + frame.getBoundingClientRect().top + e.data.top - 20;
    window.scrollTo({ top: y, behavior: 'smooth' });
  });

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  frame.addEventListener('load', report);
  report();
})();
</script>
```

The snippet does three things, and all three exist because the iframe is sized to its full
content height and therefore never scrolls internally: it sizes the frame, it reports the
parent's scroll so the rail can follow and the current section can be highlighted, and it
performs the scroll when a nav link is clicked.

The `height` in the style attribute is only a fallback for the moment before the first height
message arrives. Roughly 6100px matches the current page (Q3 2026 renders at about 6,020px
at desktop width, Q2 at about 5,790px; phones run taller); being a little over is better than
under, since too small shows a scrollbar mid-load.

**Without the script the page still works**, but the nav degrades: the rail stops following,
highlighting freezes, and nav links stop scrolling. Nothing errors, and a standalone visit to
the Pages URL behaves correctly regardless, which is the fastest way to tell a nav bug from an
embed-wiring bug.

To test embedding changes locally, `embed-test.html` simulates a Squarespace page around the
real iframe with this exact snippet. It is gitignored and never published.

## Analytics

**Off at launch, by choice.** No third-party script loads and the pages make no external
requests beyond Google Fonts.

The code already calls `umami.track()` at the useful moments, guarded so the calls no-op while
no analytics script is present. Turning it on later means uncommenting the snippet in the
`<head>` of `index.html` and pasting in a
website ID from cloud.umami.is. Nothing else changes.

The events already wired: `explorer_view` on every category or view change, `quarter_selected` on
the quarter toggle, and `gate_hit` on the CTA click. `explorer_view` is the demand signal worth reading: which categories people
look at, and whether they care about size or about growth. `gate_hit` carries the category and
view a visitor wanted badly enough to click through on.

Umami is cookieless, so no consent banner is needed if you do enable it.
