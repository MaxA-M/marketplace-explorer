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
from datetime import datetime, timezone

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

# The explorer refreshes MONTHLY and runs off its own pull, independent of the quarterly
# charts. Bump these two together at each monthly refresh.
EXPLORER_PULL = 69              # 2026-07-30, last pull of July, 559 listings
EXPLORER_AS_OF = "July 31, 2026"

EXPLORER_MIN_PARTNERS = 3     # spec §4.9 — thinner slices collapse to a CTA
ALL_SPECIALTIES = "All specialties"

# Specialties offered in the dropdown.
#
# athena reports 62 specialties, but most produce no ranking at this granularity — a visitor
# picking at random used to land on a real leaderboard only 46% of the time, and eight
# specialties could never show one at all. This list keeps the specialties that rank in at
# least 10 of the 14 categories, which lifts the hit rate to roughly 88%. Anyone wanting a
# specialty that is not here is exactly the inbound conversation the widget exists to start.
#
# "Other" clears the coverage bar but is deliberately excluded: it is a catch-all bucket, and
# nobody self-identifies as "Other".
#
# Revisit each quarter as the marketplace grows — coverage is checked on every run below.
SPECIALTY_ALLOWLIST = [
    "Multi Specialty",
    "Family Practice",
    "Internal Medicine",
    "Obstetrics/Gynecology",
    "FQHC",
    "Orthopedic Surgery",
    "Pediatrics",
    "Urgent Care",
    "Cardiology",
    "Direct Primary Care",
    "Pain Management Specialist",
    "Podiatry",
    "Ambulatory Surgery Center",
    "Neurology",
    "Psychiatry",
    "Urology",
    "Behavioral Health",
    "Nephrology",
    "Gastroenterology",
    "Endocrinology",
]


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

def build_explorer(conn, as_of, generated_at):
    """
    One entry per category x specialty slice: the leading vendor plus aggregate counts.
    Nothing below rank 1 enters this payload.
    """
    rows = conn.execute(
        """
        SELECT ps.slug, ps.name,
               COALESCE(ps.total_connections, 0) AS total_connections,
               ps.specialty_connections, cc.category
        FROM product_snapshots ps
        JOIN curated_categories cc ON cc.slug = ps.slug AND cc.is_primary = 1
        WHERE ps.pull_id = ?
        """,
        (EXPLORER_PULL,),
    ).fetchall()

    allowed = set(SPECIALTY_ALLOWLIST)
    slices = defaultdict(list)
    partners_in_category = defaultdict(int)
    specialties = set()

    for r in rows:
        cat = r["category"]
        partners_in_category[cat] += 1

        if r["total_connections"] > 0:
            slices[(cat, ALL_SPECIALTIES)].append((r["name"], r["total_connections"]))

        try:
            entries = json.loads(r["specialty_connections"] or "[]")
        except (TypeError, ValueError):
            entries = []
        for entry in entries or []:
            spec_name = entry.get("name")
            conns = entry.get("connections") or 0
            if spec_name in allowed and conns > 0:
                specialties.add(spec_name)
                slices[(cat, spec_name)].append((r["name"], conns))

    out = {}
    for (cat, spec), members in slices.items():
        members.sort(key=lambda t: t[1], reverse=True)
        entry = {
            # For the whole-category view, report the published partner count so the
            # explorer agrees with the state-of-market chart; per-specialty views count
            # only partners with connections in that specialty.
            "partner_count": partners_in_category[cat] if spec == ALL_SPECIALTIES else len(members),
            "total_connections": sum(c for _, c in members),
        }
        if len(members) >= EXPLORER_MIN_PARTNERS:
            entry["leader"] = {"name": members[0][0], "connections": members[0][1]}
        out[f"{cat}|{spec}"] = entry

    return {
        "as_of_label": as_of,
        "generated_at": generated_at,
        "categories": sorted(partners_in_category),
        "specialties": [ALL_SPECIALTIES] + [s for s in SPECIALTY_ALLOWLIST if s in specialties],
        "min_partners_for_leader": EXPLORER_MIN_PARTNERS,
        "slices": out,
    }


# --------------------------------------------------------------------------------------
# Reconciliation report — published vs database, printed only, never shipped
# --------------------------------------------------------------------------------------

def reconcile(conn, pub, explorer):
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

    uncategorised = conn.execute(
        """
        SELECT COUNT(*) FROM product_snapshots
        WHERE pull_id = ? AND slug NOT IN (
            SELECT slug FROM curated_categories WHERE is_primary = 1
        )
        """,
        (EXPLORER_PULL,),
    ).fetchone()[0]

    print(f"\n  explorer pull {EXPLORER_PULL}, as of {EXPLORER_AS_OF}")
    print(f"  explorer slices generated: {len(explorer['slices'])}")

    offered = [s for s in explorer["specialties"] if s != ALL_SPECIALTIES]
    ncat = len(explorer["categories"])
    combos = ncat * len(explorer["specialties"])
    rankable = sum(1 for v in explorer["slices"].values() if "leader" in v)
    print(f"  specialties offered: {len(offered)} of {len(SPECIALTY_ALLOWLIST)} allowlisted")
    print(f"  dropdown hit rate: {rankable}/{combos} combinations show a ranking "
          f"({round(100 * rankable / combos)}%)")

    missing = [s for s in SPECIALTY_ALLOWLIST if s not in offered]
    if missing:
        print(f"  [STOP] allowlisted specialties absent from the data: {', '.join(missing)}")

    thin = sorted(
        (s for s in offered
         if sum(1 for cat in explorer["categories"]
                if "leader" in explorer["slices"].get(f"{cat}|{s}", {})) < ncat * 0.6),
        key=str,
    )
    if thin:
        print(f"  [note] allowlisted specialties now ranking in under 60% of categories: "
              f"{', '.join(thin)}")
    mark = "ok  " if uncategorised == 0 else "STOP"
    print(f"  [{mark}] listings with no primary category: {uncategorised}")
    if uncategorised:
        print("         curate these before shipping or they vanish from the rankings")


# --------------------------------------------------------------------------------------

def main():
    if not os.path.exists(PUBLISHED_PATH):
        sys.exit(f"FATAL: published figures not found at {PUBLISHED_PATH}")
    with open(PUBLISHED_PATH, encoding="utf-8") as fh:
        pub = json.load(fh)

    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    payloads = build_from_published(pub, generated_at)

    conn = connect(DB_PATH)
    explorer = build_explorer(conn, EXPLORER_AS_OF, generated_at)
    payloads["explorer.json"] = explorer

    os.makedirs(OUT_DIR, exist_ok=True)
    for filename, payload in payloads.items():
        path = os.path.join(OUT_DIR, filename)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print(f"wrote data/{filename} ({os.path.getsize(path):,} bytes)")

    reconcile(conn, pub, explorer)
    conn.close()


if __name__ == "__main__":
    main()
