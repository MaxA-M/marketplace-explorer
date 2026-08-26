#!/usr/bin/env python3
"""
generate_data.py — builds the static JSON payloads for the marketplace data page.

Two sources, on purpose:

  * The eight chart payloads come from published/<quarter>.json, transcribed from the
    published State of the State report. The widget accompanies that report and must
    never contradict it.

  * explorer.json is generated from the marketplace SQLite database (READ-ONLY), because
    the explorer is new — there is no published equivalent to transcribe.

The script also prints a reconciliation report comparing the published figures against
what the database produces, so drift between the two is visible rather than silent.

The database never ships. Only the fields below leave this machine.
Source of truth: docs/explorer-build-spec.md (docs/explorer-v1-handoff.md wins on conflict).
"""

import json
import os
import sqlite3
import sys
from collections import defaultdict
import calendar
from datetime import date, datetime, timezone

# --------------------------------------------------------------------------------------
# Configuration — do not change without asking Max (spec §0).
# --------------------------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
# Override with the MARKETPLACE_DB environment variable if the database lives elsewhere.
DEFAULT_DB = os.path.expanduser("~/Documents/athena-databases/marketplace-v2/marketplace_v2.db")
DB_PATH = os.environ.get("MARKETPLACE_DB", DEFAULT_DB)
PUBLISHED_PATH = os.path.join(HERE, "published", "q2-2026.json")
OUT_DIR = os.path.join(HERE, "data")

# Quarter boundary pulls (spec §3), used for the quarterly charts' reconciliation report.
START_PULL = 10   # 2026-03-31, detail, 535 listings
END_PULL = 48     # 2026-06-30, detail, 555 listings

# The explorer refreshes MONTHLY and runs off its own boundary pulls, independent of the
# quarterly charts. Boundaries are derived from the data on every run — never hardcoded:
# the most recent completed month-end, and the month-end three months before it.
GROWTH_WINDOW_MONTHS = 3

# Pulls smaller than this are partial probe runs. Pull 16 (2026-04-30) has a single row and
# sits on a boundary date, so filtering on row count rather than date matters here.
BOUNDARY_MIN_ROWS = 300

# Percentage view needs a real base — a partner going 2 -> 6 is not a 200% success story.
PCT_MIN_BASE = 10




# --------------------------------------------------------------------------------------
# Display names
#
# Marketplace listings are titled for athena's search box, not for a leaderboard: taglines
# after a colon or a dash, product descriptors, legal suffixes. Trim them so a bar reads as
# the company a reader recognises.
#
# The rule handles the common shapes. The overrides below are the ones it cannot get right,
# usually because the fluff has no separator, or because trimming would leave the wrong half
# of the name. Add to this map whenever a new partner surfaces with an awkward title — the
# generator prints anything it shortened so the list stays reviewable.
# --------------------------------------------------------------------------------------

TAGLINE_SEPARATORS = (': ', ' - ', ' – ', ' — ', ' | ')

LEGAL_SUFFIXES = (', inc.', ', inc', ' inc.', ' inc', ', llc', ' llc', ', ltd', ' ltd')

DISPLAY_OVERRIDES = {
    # descriptor with no separator to cut on
    "Assort Health Generative Voice AI":                        "Assort Health",
    "Aesto Health DataCapture Platform":                        "Aesto Health",
    "Dulcian Health Chronic Care Management":                   "Dulcian Health",
    "Schiller State-Of-The-Art Cardiopulmonary Products":       "Schiller",
    "Marvix AI Assistant for Specialty Care":                   "Marvix",
    "Aidion Health Voice AI Solutions":                         "Aidion Health",
    "Arcadia HCC Risk Suspecting Integration":                  "Arcadia",
    "Labcorp Diagnostic Assistant":                             "Labcorp",
    "Boston Scientific Cardiac Diagnostics, Inc.":              "Boston Scientific",
    "Kyruus (Epion) Attract & Engage Patients Digitally":       "Kyruus",
    "Patient Reported Outcomes (PROS) & Reputation Management": "Clinect Healthcare",

    # a second descriptor survives the first cut
    "Nura, Care Continuity Platform - Beyond CCM, RPM, RTM, AWV": "Nura",
    "Rimidi (now part of Health Recovery Solutions) | RPM, CCM, and More": "Rimidi",

    # the company is the recognisable half, and it is not the first half
    "Automated Prior Authorization (PAs) by Develop Health":    "Develop Health",
    "Patient Collections by IC System":                         "IC System",
    "LKLiveMapping for Data Migrations":                        "ELLKAY",
    "The Parachute Platform":                                   "Parachute Health",
    "CarePilot AI Scribe & Action Platform":                    "CarePilot",
    "TSI - Profit Recovery":                                    "TSI",

    # trimming would lose the brand, so leave these whole
    "Zio by iRhythm":                                           "Zio by iRhythm",
    "CallMyDoc":                                                "CallMyDoc",
}


_SHORTENED = set()


def display_name(raw):
    """Trim a marketplace listing title down to the name a reader would recognise."""
    name = (raw or "").strip()
    original = name
    if name in DISPLAY_OVERRIDES:
        return DISPLAY_OVERRIDES[name]

    for sep in TAGLINE_SEPARATORS:
        if sep in name:
            name = name.split(sep)[0].strip()
            break

    lowered = name.lower()
    for suffix in LEGAL_SUFFIXES:
        if lowered.endswith(suffix):
            name = name[: -len(suffix)].rstrip(" ,")
            break

    name = name or original
    if name != original:
        _SHORTENED.add((original, name))
    return name


def connect(path):
    if not os.path.exists(path):
        sys.exit(f"FATAL: database not found at {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


# --------------------------------------------------------------------------------------
# Chart payloads — straight from the published figures
# --------------------------------------------------------------------------------------

def build_from_published(pub, generated_at):
    s = pub["summary"]

    summary = {
        "quarter": pub["quarter"],
        "quarter_end_label": pub["quarter_end_label"],
        "basis": pub["basis"],
        "partners_added": s["partners_added"],
        "partners_departed": s["partners_departed"],
        "net_new_connections": s["net_new_connections"],
        "total_connections_end": s["total_connections_end"],
        "total_active_partners_end": s["total_active_partners_end"],
        "pct_listings_zero_new_ratings": s["pct_listings_zero_new_ratings"],
        "generated_at": generated_at,
    }

    for key in ("top_gainers_volume", "top_gainers_pct", "ratings"):
        for row in pub[key]:
            row["name"] = display_name(row["name"])

    return {
        "summary.json": summary,
        "state_of_market.json": {"categories": pub["state_of_market"],
                                 "total_connections": s["total_connections_end"],
                                 "total_partners": s["total_active_partners_end"]},
        "net_by_category.json": {"categories": pub["net_by_category"]},
        "new_entrants.json": {"categories": pub["new_entrants"],
                              "total_new": s["partners_added"]},
        "departures.json": {"by_category": pub["departures"],
                            "total_departed": s["partners_departed"]},
        "top_gainers.json": {"by_volume": pub["top_gainers_volume"],
                             "by_pct": pub["top_gainers_pct"]},
        "long_tail.json": {"buckets": pub["long_tail"]["buckets"],
                           "total_partners": s["total_active_partners_end"],
                           "pct_under_10_connections": pub["long_tail"]["pct_under_10_connections"],
                           "pct_under_30_connections": pub["long_tail"]["pct_under_30_connections"]},
        "concentration.json": {"categories": pub["concentration"]},
        "ratings.json": {"pct_zero_new_ratings": s["pct_listings_zero_new_ratings"],
                         "active_raters": pub["ratings"]},
    }


# --------------------------------------------------------------------------------------
# Explorer — generated from the database
# --------------------------------------------------------------------------------------

def month_end(year, month):
    return date(year, month, calendar.monthrange(year, month)[1])


def shift_month_end(d, months):
    """Month-end `months` before/after the month containing d."""
    m = d.month - 1 + months
    return month_end(d.year + m // 12, m % 12 + 1)


def resolve_boundaries(conn):
    """
    Derive the growth window from the data rather than hardcoding dates.

    End boundary is the most recent completed month-end; start boundary is the month-end
    GROWTH_WINDOW_MONTHS before it. For each, use the usable pull closest to that date —
    the marketplace is not always scraped exactly on the last day of a month.
    """
    rows = conn.execute(
        f"""
        SELECT ps.pull_id, date(l.pulled_at) AS d, COUNT(*) AS n
        FROM product_snapshots ps JOIN pull_log l ON l.id = ps.pull_id
        GROUP BY ps.pull_id HAVING n >= {BOUNDARY_MIN_ROWS}
        """
    ).fetchall()
    if not rows:
        sys.exit("FATAL: no usable pulls found")

    usable = [(r["pull_id"], date.fromisoformat(r["d"])) for r in rows]
    newest = max(d for _, d in usable)

    end_target = newest if newest == month_end(newest.year, newest.month) \
        else shift_month_end(newest, -1)
    start_target = shift_month_end(end_target, -GROWTH_WINDOW_MONTHS)

    def closest(target):
        pid, actual = min(usable, key=lambda t: (abs((t[1] - target).days), -t[0]))
        return {"pull_id": pid, "label": target.isoformat(), "actual": actual.isoformat(),
                "drift_days": abs((actual - target).days)}

    start, end = closest(start_target), closest(end_target)
    if start["pull_id"] == end["pull_id"]:
        sys.exit("FATAL: both boundaries resolved to the same pull")
    return start, end


def load_boundary_rows(conn, pull_id):
    """Identity -> record, using api_created_at as identity per the rename rule."""
    rows = conn.execute(
        """
        SELECT ps.api_created_at AS identity, TRIM(ps.name) AS name,
               COALESCE(ps.total_connections, 0) AS connections, cc.category
        FROM product_snapshots ps
        JOIN curated_categories cc ON cc.slug = ps.slug AND cc.is_primary = 1
        WHERE ps.pull_id = ? AND ps.api_created_at IS NOT NULL AND ps.api_created_at <> ''
        """,
        (pull_id,),
    ).fetchall()
    out = {}
    for r in rows:
        rec = dict(r)
        rec["name"] = display_name(rec["name"])
        out[rec["identity"]] = rec
    return out


def build_explorer(conn, start, end, generated_at):
    """
    One entry per category: the leading partner under each of three views, plus aggregate
    counts. Nothing below rank 1 enters this payload, in any view.

    Identity is api_created_at, so a partner that rewrote its slug inside the window is one
    continuous record rather than a departure plus an arrival.
    """
    start_rows = load_boundary_rows(conn, start["pull_id"])
    end_rows = load_boundary_rows(conn, end["pull_id"])

    # A partner's category comes from where it sits now; departed partners keep the category
    # they had at the start so their loss lands in the right bucket.
    by_category = defaultdict(list)
    for identity, e in end_rows.items():
        s_rec = start_rows.get(identity)
        by_category[e["category"]].append({
            "name": e["name"],
            "start": s_rec["connections"] if s_rec else 0,
            "end": e["connections"],
            "present_at_start": s_rec is not None,
        })
    departed = defaultdict(int)
    for identity, s_rec in start_rows.items():
        if identity not in end_rows:
            departed[s_rec["category"]] += s_rec["connections"]

    def pick(candidates, metric):
        """Rank by the view's metric, breaking ties on absolute gain then alphabetically."""
        if not candidates:
            return None
        return sorted(
            candidates,
            key=lambda r: (-metric(r), -(r["end"] - r["start"]), r["name"]),
        )[0]

    categories = {}
    for category, members in sorted(by_category.items()):
        total_end = sum(m["end"] for m in members)
        total_start = sum(m["start"] for m in members if m["present_at_start"])

        # Connections: every partner currently listed.
        conn_leader = pick(members, lambda r: r["end"])

        # Growth by volume: positive net change only. A new listing counts as a full gain.
        vol_pool = [m for m in members if m["end"] - m["start"] > 0]
        vol_leader = pick(vol_pool, lambda r: r["end"] - r["start"])

        # Growth by percentage: needs a real base at the start of the window, which also
        # excludes new listings by construction.
        pct_pool = [m for m in members
                    if m["present_at_start"] and m["start"] >= PCT_MIN_BASE and m["end"] > m["start"]]
        pct_leader = pick(pct_pool, lambda r: (r["end"] - r["start"]) / r["start"])

        categories[category] = {
            "partner_count": len(members),
            "total_connections": total_end,
            "net_change_3mo": total_end - total_start - departed.get(category, 0),
            "connections": {
                "leader": {"name": conn_leader["name"], "value": conn_leader["end"]}
            } if conn_leader else {"leader": None},
            # gainer_count caps how many gated rows the widget draws. Gainers are a subset
            # of partners, so a category can have 40 partners and 3 that grew — promising
            # "ranks 2-10" there would claim a ranking that does not exist.
            "growth_volume": {
                "has_gainers": bool(vol_pool),
                "gainer_count": len(vol_pool),
                "leader": {"name": vol_leader["name"], "value": vol_leader["end"] - vol_leader["start"]}
                if vol_leader else None,
            },
            "growth_pct": {
                "has_gainers": bool(pct_pool),
                "gainer_count": len(pct_pool),
                "leader": {"name": pct_leader["name"],
                           "value": round(100.0 * (pct_leader["end"] - pct_leader["start"]) / pct_leader["start"], 1)}
                if pct_leader else None,
            },
        }

    return {
        "generated_at": generated_at,
        "boundary_start": start["label"],
        "boundary_end": end["label"],
        # Shipped so the widget's footnote states the real threshold rather than a
        # number copied into the copy and left to drift.
        "pct_min_base": PCT_MIN_BASE,
        "categories": categories,
    }


# --------------------------------------------------------------------------------------
# Reconciliation report — published vs database, printed only, never shipped
# --------------------------------------------------------------------------------------

def reconcile(conn, pub, explorer, boundaries):
    print("\n--- reconciliation: published vs database ---")

    def line(label, published, computed):
        mark = "ok " if published == computed else "DIFF"
        print(f"  [{mark}] {label:38} published {published:>8}   database {computed:>8}")

    end_total = conn.execute(
        "SELECT SUM(COALESCE(total_connections,0)) FROM product_snapshots WHERE pull_id=?",
        (END_PULL,),
    ).fetchone()[0]
    end_count = conn.execute(
        "SELECT COUNT(*) FROM product_snapshots WHERE pull_id=?", (END_PULL,)
    ).fetchone()[0]
    start_total = conn.execute(
        "SELECT SUM(COALESCE(total_connections,0)) FROM product_snapshots WHERE pull_id=?",
        (START_PULL,),
    ).fetchone()[0]

    s = pub["summary"]
    line("total connections at quarter end", s["total_connections_end"], end_total)
    line("active partners at quarter end", s["total_active_partners_end"], end_count)
    line("net new connections", s["net_new_connections"], end_total - start_total)

    # Category connection totals are the check that matters most for the explorer, since
    # the explorer is generated from the database while its neighbouring charts are not.
    db_cat = dict(
        conn.execute(
            """
            SELECT cc.category, SUM(COALESCE(ps.total_connections,0))
            FROM product_snapshots ps
            JOIN curated_categories cc ON cc.slug = ps.slug AND cc.is_primary = 1
            WHERE ps.pull_id = ? GROUP BY cc.category
            """,
            (END_PULL,),
        ).fetchall()
    )
    print("\n  category connection totals at quarter end:")
    drift = 0
    for c in pub["state_of_market"]:
        computed = db_cat.get(c["name"], 0)
        if computed != c["connections"]:
            drift += 1
            print(f"    DIFF {c['name']:32} published {c['connections']:>6}   database {computed:>6}")
    if not drift:
        print("    all 14 categories match exactly")

    start, end = boundaries
    print("\n--- explorer ---")
    for tag, b in (("start", start), ("end", end)):
        drift = "" if not b["drift_days"] else f"  ({b['drift_days']}d from month-end)"
        print(f"  {tag:<5} boundary {b['label']}  ->  pull {b['pull_id']} pulled {b['actual']}{drift}")

    for pull_id, tag in ((start["pull_id"], "start"), (end["pull_id"], "end")):
        n = conn.execute(
            """
            SELECT COUNT(*) FROM product_snapshots
            WHERE pull_id = ? AND slug NOT IN (
                SELECT slug FROM curated_categories WHERE is_primary = 1)
            """,
            (pull_id,),
        ).fetchone()[0]
        mark = "ok  " if n == 0 else "STOP"
        print(f"  [{mark}] {tag} pull: {n} listings with no primary category")

    renames = conn.execute(
        """
        SELECT COUNT(*) FROM product_snapshots a
        JOIN product_snapshots b ON a.api_created_at = b.api_created_at AND a.slug <> b.slug
        WHERE a.pull_id = ? AND b.pull_id = ?
        """,
        (start["pull_id"], end["pull_id"]),
    ).fetchone()[0]
    print(f"  renames matched across the window: {renames}")

    cats = explorer["categories"]
    no_vol = [c for c, v in cats.items() if not v["growth_volume"]["has_gainers"]]
    no_pct = [c for c, v in cats.items() if not v["growth_pct"]["has_gainers"]]
    print(f"  categories: {len(cats)}")
    print(f"  no gainers, volume view: {len(no_vol)}" + (f"  ({', '.join(no_vol)})" if no_vol else ""))
    print(f"  no gainers, percent view: {len(no_pct)}" + (f"  ({', '.join(no_pct)})" if no_pct else ""))

    thin = [(c, v["growth_pct"]["gainer_count"]) for c, v in cats.items()
            if 0 < v["growth_pct"]["gainer_count"] < 10]
    if thin:
        print("  percent view with fewer than 10 gainers (gated rows capped accordingly):")
        for c, n in sorted(thin, key=lambda t: t[1]):
            print(f"      {c:<32} {n} gainer{'' if n == 1 else 's'}")

    shortened = sorted({(k, v) for k, v in _SHORTENED})
    if shortened:
        print(f"\n  display names shortened: {len(shortened)}")
        for raw, shown in shortened:
            print(f"      {raw[:52]:<54} -> {shown}")

    leaked = [c for c, v in cats.items()
              if set(v) - {"partner_count", "total_connections", "net_change_3mo",
                           "connections", "growth_volume", "growth_pct"}]
    print(f"  [{'ok  ' if not leaked else 'STOP'}] categories with unexpected keys: {len(leaked)}")


def main():
    if not os.path.exists(PUBLISHED_PATH):
        sys.exit(f"FATAL: published figures not found at {PUBLISHED_PATH}")
    with open(PUBLISHED_PATH, encoding="utf-8") as fh:
        pub = json.load(fh)

    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    payloads = build_from_published(pub, generated_at)

    conn = connect(DB_PATH)
    boundaries = resolve_boundaries(conn)
    explorer = build_explorer(conn, boundaries[0], boundaries[1], generated_at)
    payloads["explorer.json"] = explorer

    os.makedirs(OUT_DIR, exist_ok=True)
    for filename, payload in payloads.items():
        path = os.path.join(OUT_DIR, filename)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print(f"wrote data/{filename} ({os.path.getsize(path):,} bytes)")

    reconcile(conn, pub, explorer, boundaries)
    conn.close()


if __name__ == "__main__":
    main()
