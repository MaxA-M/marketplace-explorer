# Marketplace Explorer

Two static pages for alsgaardmiller.com, deployed to GitHub Pages and embedded in Squarespace
via iframe. No build step, no dependencies.

| Page | What it is | Cadence |
|---|---|---|
| `index.html` | The gated explorer widget — its own section of the site | **Monthly** |
| `quarterly.html` | The quarterly results charts | **Quarterly** (second project) |

The two refresh on different schedules and share nothing but `styles.css`. The explorer is
generated from the marketplace database; the quarterly charts are transcribed from the
published report.

- `index.html`, `app.js` — the explorer widget: one category dropdown, three ranking views
  (connections, growth by volume, growth by percentage). Currently **as of July 31, 2026**.
- `quarterly.html`, `quarterly.js` — the results charts. Currently **Q2 2026**, listings basis.
- `styles.css` — shared.
- `published/q2-2026.json` — figures transcribed from the published quarterly report. Source
  of truth for every chart, so the page and the report always agree.
- `data/*.json` — the payloads the page loads. The only data that ships.
- `generate_data.py` — copies the published figures into `data/`, generates `data/explorer.json`
  from the marketplace SQLite database (read-only), and prints a published-vs-computed
  reconciliation report.

The marketplace database lives outside this repo and is never committed. Only the aggregates
in `data/` ship: for each category, the leading partner under each of three views, plus partner
and connection counts. Nothing below rank 1, and no slug, identifier, specialty, rating,
description or raw record ever enters a payload.

Set `MARKETPLACE_DB` if your database is not at
`~/Documents/athena-databases/marketplace-v2/marketplace_v2.db`:

```bash
MARKETPLACE_DB=/path/to/marketplace_v2.db python3 generate_data.py
```

## Run it locally

```bash
python3 -m http.server 8153 --directory .
```

Then open http://localhost:8153. Open the file directly with `file://` and the JSON fetches
will be blocked by CORS — you need the server.

## Monthly refresh checklist — the explorer widget

The widget updates monthly. Boundaries are derived from the data on every run, so most months
this is: curate the new listings, run the generator, read its report, push.

1. **Curate any new listings.** New partners arrive every month and need a `curated_categories`
   row with `is_primary = 1`, or they drop out of the rankings silently. Propose assignments
   from each listing's `description` / `overview`, get them approved, then insert with a
   `source` naming the month so the batch can be rolled back cleanly. Find them with:

   ```sql
   SELECT slug, name, total_connections FROM product_snapshots
   WHERE pull_id = <END_BOUNDARY_PULL> AND slug NOT IN (
     SELECT slug FROM curated_categories WHERE is_primary = 1);
   ```

   The generator prints the end-boundary pull id, so run it once to find the pull, curate, then
   run it again.

2. **Run the generator.**

   ```bash
   python3 generate_data.py
   ```

   It resolves both boundaries itself: the end boundary is the most recent completed month-end,
   the start boundary is `GROWTH_WINDOW_MONTHS` (3) before it, and for each it takes the usable
   pull closest to that date. Nothing about the window is hardcoded — do not add dates.

3. **Read the explorer section of its report.** Four things matter:

   - **Boundary drift.** The report shows the gap between each target month-end and the pull it
     actually used. A day or two is normal — the marketplace is not always scraped on the last
     day of a month. A large gap means a pull is missing and the window is wrong.
   - **Uncategorised listings must be zero** at both boundaries.
   - **Renames matched.** Identity is `api_created_at`, never slug. If this drops to zero when
     partners have obviously rebranded, rename matching has broken and growth numbers are wrong.
   - **Thin percent views.** The report lists categories with fewer than 10 percentage gainers.
     This is informational: the widget caps its gated rows at `gainer_count`, so a category with
     three gainers shows two gated rows and says "Ranks 2–3 available on request". Never let the
     widget promise ranks that do not exist.

4. **Spot-check two categories by hand** against the database, including one small one, then
   commit and push. Remember GitHub Pages caches for ten minutes — a stale widget right after a
   push is expected, not a failure.

## Quarterly regeneration checklist — the results charts

## Quarterly regeneration checklist

Run this as part of quarterly report production, once the written report is final.

1. **Transcribe the published figures.** Copy `published/q2-2026.json` to
   `published/<quarter>.json` and update every value from the new report's charts. This file is
   the source of truth for the page — the widget must never contradict the published report.
   Update `PUBLISHED_PATH` in `generate_data.py` to point at it.

2. **Check the transcription adds up.** Category connections must sum to the headline total,
   category partner counts to the partner total, net changes to the headline net, new entrants
   to partners added, departures to partners departed, and long-tail buckets to the partner
   total. A transcription slip almost always shows up as one of these failing.

3. **Pick the boundary pull for the explorer.** The explorer is generated from the database, so
   it needs the detail pull closest to quarter end:

   ```sql
   SELECT l.id, l.pulled_at, l.pull_type, COUNT(ps.total_connections) AS with_conn
   FROM pull_log l JOIN product_snapshots ps ON ps.pull_id = l.id
   GROUP BY l.id HAVING with_conn > 0 ORDER BY l.pulled_at;
   ```

   Skip any pull with only a handful of rows — those are partial probe runs. Update
   `START_PULL` and `END_PULL` in `generate_data.py`.

4. **Curate the new quarter's joiners** into `curated_categories` with `is_primary = 1` and a
   `source` naming the quarter. Every listing present at the end boundary needs a primary
   category or it drops out of the explorer.

5. **Run the generator and read the reconciliation report.**

   ```bash
   python3 generate_data.py
   ```

   It prints published against computed for the headline figures and all 14 category totals.
   Small drift is expected and fine; a category total that moves a long way means the explorer
   and the charts are about to disagree in public, so investigate before shipping.

6. **Update the data note** in `index.html` (the `.datanote` paragraph in the footer) if the
   methodology basis changed.

7. **Commit and push.**

   ```bash
   git add data/ published/ generate_data.py index.html
   git commit -m "Refresh data for <quarter>"
   git push
   ```

8. **Verify the live embed.** Load the Squarespace page, confirm the "Data as of" stamp shows
   the new quarter, click through a few explorer slices, and check that a deep link
   (`...#top-gainers`) still scrolls to the right section.

## Squarespace embed

Each page is a separate code block on its own Squarespace page. Swap `index.html` for
`quarterly.html` (and the message `type`) for the results page.

```html
<div style="position:relative;width:100%;">
  <iframe
    id="marketplace-explorer"
    src="https://MaxA-M.github.io/marketplace-explorer/"
    title="athenahealth Marketplace Explorer"
    loading="lazy"
    style="width:100%;height:820px;border:0;display:block;"
    scrolling="no"></iframe>
</div>
<script>
  // The page posts its height on load and whenever it reflows, so the iframe
  // grows and shrinks with the content instead of scrolling inside itself.
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'marketplace-explorer:height') return;
    var f = document.getElementById('marketplace-explorer');
    if (f && e.data.height) f.style.height = e.data.height + 'px';
  });
</script>
```

The fixed `height` is a fallback for the moment before the first height message arrives.
The results page posts `marketplace-quarterly:height` instead, and wants roughly `5700px`
as its fallback.

## Analytics

**Off at launch, by choice.** No third-party script loads and the pages make no external
requests beyond Google Fonts.

The code already calls `umami.track()` at the useful moments, guarded so the calls no-op while
no analytics script is present. Turning it on later means uncommenting the snippet in the
`<head>` of `index.html` (and `quarterly.html` if you want it there too) and pasting in a
website ID from cloud.umami.is. Nothing else changes.

The events already wired: `explorer_view` on every category or view change, `gate_hit` on the
CTA click — and on the quarterly page `chart_viewed`, `filter_selected` and
`deep_link_arrival`. `explorer_view` is the demand signal worth reading: which categories
people look at, and whether they care about size or about growth. `gate_hit` carries the
category and view a visitor wanted badly enough to click through on.

Umami is cookieless, so no consent banner is needed if you do enable it.
