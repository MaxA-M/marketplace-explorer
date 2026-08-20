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

- `index.html`, `app.js` — the explorer widget. Currently **as of July 31, 2026**.
- `quarterly.html`, `quarterly.js` — the results charts. Currently **Q2 2026**, listings basis.
- `styles.css` — shared.
- `published/q2-2026.json` — figures transcribed from the published quarterly report. Source
  of truth for every chart, so the page and the report always agree.
- `data/*.json` — the payloads the page loads. The only data that ships.
- `generate_data.py` — copies the published figures into `data/`, generates `data/explorer.json`
  from the marketplace SQLite database (read-only), and prints a published-vs-computed
  reconciliation report.

The marketplace database lives outside this repo and is never committed. Only the aggregates
in `data/` ship: one named leading vendor per category-and-specialty slice, plus partner and
connection counts. Nothing below rank 1, and no slug, identifier, rating, description or raw
record ever enters a payload.

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

The widget updates monthly. Run this at the start of each month.

1. **Pick the pull.** The last usable pull of the month just ended:

   ```sql
   SELECT l.id, date(l.pulled_at) d, l.pull_type, COUNT(*) rows
   FROM pull_log l JOIN product_snapshots ps ON ps.pull_id = l.id
   WHERE date(l.pulled_at) BETWEEN '<YYYY-MM-25>' AND '<YYYY-MM-31>'
   GROUP BY l.id ORDER BY l.pulled_at;
   ```

   Catalog pulls are fine — they carry `specialty_connections` like detail pulls do. Skip any
   pull with only a handful of rows; those are partial probe runs.

2. **Update `EXPLORER_PULL` and `EXPLORER_AS_OF`** at the top of `generate_data.py`. The
   as-of label is what renders in grey beneath the ranking, so it is visitor-facing.

3. **Curate any new listings.** New partners arrive every month and need a `curated_categories`
   row with `is_primary = 1`, or they vanish from the rankings. Propose assignments from each
   listing's `description` / `overview`, get them approved, then insert with a `source` naming
   the month. Find them with:

   ```sql
   SELECT slug, name, total_connections FROM product_snapshots
   WHERE pull_id = <PULL> AND slug NOT IN (
     SELECT slug FROM curated_categories WHERE is_primary = 1);
   ```

4. **Run the generator.** Check three things in its output: the uncategorised count must be
   zero, every allowlisted specialty must still be present, and the dropdown hit rate should
   stay near 89%.

   ```bash
   python3 generate_data.py
   ```

   The specialty dropdown is an allowlist of 20 (`SPECIALTY_ALLOWLIST`), chosen because most of
   athena's 62 specialties produce no ranking at this granularity. Revisit it each quarter as
   the marketplace grows — the generator flags any allowlisted specialty that has gone thin.

5. **Spot-check a few slices**, including a thin one, then commit and push.

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
    style="width:100%;height:640px;border:0;display:block;"
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

The events already wired: `explorer_slice` on every dropdown selection, `gate_hit` on the CTA
click, `widget_viewed` on load — and on the quarterly page `chart_viewed`, `filter_selected`
and `deep_link_arrival`. The `explorer_slice` events are the demand signal worth reading:
which category and specialty combinations people ask for tells you what to publish next, and
`gate_hit` carries the slice a visitor wanted badly enough to click through on.

Umami is cookieless, so no consent banner is needed if you do enable it.
