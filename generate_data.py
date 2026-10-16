#!/usr/bin/env python3
"""
generate_data.py — builds the static JSON bundles for the Marketplace Intelligence page.

One bundle per quarter, all generated from the marketplace SQLite database (READ-ONLY):

    data/quarters.json            the quarter list the page reads first
    data/<quarter>/leaderboard.json   rank-1 leaders per category, as of quarter end
    data/<quarter>/report.json        the quarter's report charts

COMPANY BASIS. athena reports connections per partner contract, so a company with several
listings shows the same count on each. Every figure counts each company once: listings that
share a contract (listing_groups) collapse to one partner carrying the MAX of their counts,
and that partner sits in the category of its largest listing. Every quarter is regenerated
on every run with today's categories, so quarters always compare like with like. Q2 figures
therefore differ from the Q2 post as published (listings basis); the page says so.

Identity is api_created_at, never slug: it survives renames, and listing_groups maps it to a
company. Joins and departures are computed on companies, after that matching.

Adding a quarter = one entry in QUARTERS, then run this script. No page code changes.

The database never ships. Only the fields written below leave this machine.
"""

import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

# --------------------------------------------------------------------------------------
# Configuration — do not change thresholds or guardrails without asking Max.
# --------------------------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = os.path.expanduser("~/Documents/athena-databases/marketplace-v2/marketplace_v2.db")
DB_PATH = os.environ.get("MARKETPLACE_DB", DEFAULT_DB)
OUT_DIR = os.path.join(HERE, "data")

# Oldest first. Boundary pulls are pinned: the detail pull on each quarter-end date.
QUARTERS = [
    {
        "id": "q2-2026", "label": "Q2 2026", "months": "April–June 2026",
        "start_pull": 10, "end_pull": 48,
        "start_date": "2026-03-31", "end_date": "2026-06-30",
        "created_from": "2026-04-01", "created_to": "2026-07-01",
        "blog_url": "https://alsgaardmiller.com/blog/q2-2026-athenahealth-marketplace-state-of-the-state",
        # The Q2 post was published on a listings basis; the page tells readers why it differs.
        "published": {"partners_end": 554, "net_new_connections": 993},
        # 0 across pulls 2-10, then 61 on 2026-04-08: not reporting yet, not zero customers.
        "baseline_overrides": {"casetabs": 61},
        "asterisk_slug": None,
    },
    {
        "id": "q3-2026", "label": "Q3 2026", "months": "July–September 2026",
        "start_pull": 48, "end_pull": 113,
        "start_date": "2026-06-30", "end_date": "2026-09-30",
        "created_from": "2026-07-01", "created_to": "2026-10-01",
        "blog_url": None,   # hidden on the page until the Q3 post is live
        "published": None,
        # 2017 listing reporting 0 until 2026-07-30, then 78 and flat.
        "baseline_overrides": {"ic-system-healthcare-recovery-services": 78},
        # One partner's single-day drop dominates its category. Reported unnamed, never by name.
        "asterisk_slug": "tsi-profit-recovery",
    },
]

# Percentage growth needs a real base — a partner going 2 -> 6 is not a 200% success story.
PCT_MIN_BASE = 10
TOP_GAINERS = 10

# --------------------------------------------------------------------------------------
# Display names
#
# Marketplace listings are titled for athena's search box, not for a chart: taglines after a
# colon or a dash, product descriptors, legal suffixes. Trim them so a bar reads as the
# company a reader recognises. The overrides are the titles the rule cannot get right. The
# generator prints everything it shortened so the list stays reviewable.
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
    "Weave Patient Engagement & Communications Platform":       "Weave",
    "eFax® Integration with athenaOne®":                        "eFax",
    "Sporo Health Google Calendar Sync":                        "Sporo Health",
    "ThoroughCare Digital Care Coordination Solutions":         "ThoroughCare",
    "ReactDx Remote Cardiac Monitoring and Home Sleep Tests":   "ReactDx",
    "The Agentic Operating System for Healthcare":              "XCaliber Health",
    "Boostlingo On-Demand":                                     "Boostlingo",
    "Persivia CareTrak":                                        "Persivia",

    # a second descriptor survives the first cut
    "Nura, Care Continuity Platform - Beyond CCM, RPM, RTM, AWV": "Nura",
    "Rimidi (now part of Health Recovery Solutions) | RPM, CCM, and More": "Rimidi",

    # the company is the recognisable half, and it is not the first half
    "Automated Prior Authorization (PAs) by Develop Health":    "Develop Health",
    "Patient Collections by IC System":                         "IC System",
    "LKLiveMapping for Data Migrations":                        "ELLKAY",
    "The Parachute Platform":                                   "Parachute Health",
    "CarePilot AI Scribe & Action Platform":                    "CarePilot",
    "AI Scribe - Ambient Note & Coding Assistant":              "CarePilot",
    "TSI - Profit Recovery":                                    "TSI",
    "Intelligent Scheduling by Relatient":                      "Relatient",

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
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


# --------------------------------------------------------------------------------------
# Company roster at one pull
# --------------------------------------------------------------------------------------

def companies_at(conn, pull_id, overrides=None):
    """company key -> record. Mirror listings collapse to MAX; category = largest listing's."""
    overrides = overrides or {}
    rows = conn.execute("""
        SELECT lr.slug, lr.api_created_at, lr.group_key, lr.is_group_primary,
               COALESCE(lr.total_connections, 0), ps.name, lg.display_name,
               COALESCE(ps.total_ratings, 0), ps.bayesian_average, cc.category
        FROM listing_roster lr
        JOIN product_snapshots ps ON ps.pull_id = lr.pull_id AND ps.slug = lr.slug
        LEFT JOIN listing_groups lg ON lg.api_created_at = lr.api_created_at
        LEFT JOIN curated_categories cc ON cc.slug = lr.slug AND cc.is_primary = 1
        WHERE lr.pull_id = ?""", (pull_id,)).fetchall()
    out = {}
    for slug, api, key, primary, conns, name, group_name, ratings, avg, category in rows:
        if conns == 0 and slug in overrides:
            conns = overrides[slug]
        co = out.setdefault(key, {"conns": 0, "created": api, "ratings": 0, "slugs": [],
                                  "name": None, "category": None, "avg": None})
        co["conns"] = max(co["conns"], conns)
        co["created"] = min(co["created"], api)
        co["ratings"] += ratings
        co["slugs"].append(slug)
        if primary:
            co["name"] = display_name(group_name or name or slug)
            co["category"] = category
            co["avg"] = avg
    return out


# --------------------------------------------------------------------------------------
# One quarter
# --------------------------------------------------------------------------------------

def build_quarter(conn, q):
    S = companies_at(conn, q["start_pull"], q["baseline_overrides"])
    E = companies_at(conn, q["end_pull"])

    def cat(k):
        return (E.get(k) or S.get(k))["category"]

    def name(k):
        return (E.get(k) or S.get(k))["name"]

    added = [k for k in E if k not in S and q["created_from"] <= E[k]["created"] < q["created_to"]]
    departed = [k for k in S if k not in E]
    both = [k for k in S if k in E]
    net = sum(v["conns"] for v in E.values()) - sum(v["conns"] for v in S.values())
    zero = sum(1 for k in both if E[k]["ratings"] <= S[k]["ratings"])

    categories = sorted({cat(k) for k in list(S) + list(E) if cat(k)})
    cs = {c: 0 for c in categories}
    ce = {c: 0 for c in categories}
    members = {c: [] for c in categories}
    for k, v in S.items():
        if cat(k):
            cs[cat(k)] += v["conns"]
    for k, v in E.items():
        if cat(k):
            ce[cat(k)] += v["conns"]
            members[cat(k)].append(k)

    def count_by_cat(keys):
        t = {c: 0 for c in categories}
        for k in keys:
            if cat(k):
                t[cat(k)] += 1
        return t

    adds, deps = count_by_cat(added), count_by_cat(departed)
    gains = [(k, E[k]["conns"] - S[k]["conns"]) for k in both]

    # ---- report ----
    def gainer(k, g):
        return {"name": name(k), "start": S[k]["conns"], "end": E[k]["conns"], "gain": g,
                "gain_pct": round(100.0 * g / S[k]["conns"], 1) if S[k]["conns"] else None}

    by_vol = sorted((x for x in gains if x[1] > 0), key=lambda x: (-x[1], name(x[0])))[:TOP_GAINERS]
    by_pct = sorted((x for x in gains if x[1] > 0 and S[x[0]]["conns"] >= PCT_MIN_BASE),
                    key=lambda x: (-x[1] / S[x[0]]["conns"], name(x[0])))[:TOP_GAINERS]

    asterisk = None
    if q["asterisk_slug"]:
        k = next(k for k, v in E.items() if q["asterisk_slug"] in v["slugs"])
        d = E[k]["conns"] - S[k]["conns"]
        asterisk = {"category": cat(k), "partner_change": d,
                    "category_net_excluding": ce[cat(k)] - cs[cat(k)] - d,
                    "marketplace_net_excluding": net - d}

    report = {
        "summary": {
            "partners_added": len(added), "partners_departed": len(departed),
            "net_new_connections": net,
            "pct_zero_new_ratings": round(100.0 * zero / len(both), 1),
            "partners_end": len(E),
            "connections_end": sum(v["conns"] for v in E.values()),
        },
        "state_of_market": sorted(
            ({"name": c, "connections": ce[c], "partners": len(members[c])} for c in categories),
            key=lambda d: -d["connections"]),
        "net_by_category": sorted(
            ({"name": c, "net_change": ce[c] - cs[c],
              "rate_pct": round(100.0 * (ce[c] - cs[c]) / cs[c], 1) if cs[c] else None}
             for c in categories), key=lambda d: -d["net_change"]),
        "turnover": sorted(
            ({"name": c, "added": adds[c], "departed": deps[c]} for c in categories
             if adds[c] or deps[c]), key=lambda d: (-(d["added"] - d["departed"]), -d["added"], d["name"])),
        "top_gainers": {"by_volume": [gainer(k, g) for k, g in by_vol],
                        "by_pct": [gainer(k, g) for k, g in by_pct],
                        "pct_min_base": PCT_MIN_BASE},
        "concentration": sorted(
            ({"name": c, "partners": len(members[c]),
              "top3_share_pct": round(100.0 * sum(sorted((E[k]["conns"] for k in members[c]), reverse=True)[:3])
                                      / ce[c], 1) if ce[c] else 0.0}
             for c in categories), key=lambda d: -d["top3_share_pct"]),
        "ratings": sorted(
            ({"name": name(k), "new_ratings": E[k]["ratings"] - S[k]["ratings"],
              "avg_end": round(E[k]["avg"], 2) if E[k]["avg"] else None}
             for k in both if E[k]["ratings"] > S[k]["ratings"]),
            key=lambda r: (-r["new_ratings"], r["name"])),
        "asterisk": asterisk,
    }

    # ---- leaderboard: rank 1 only, per category, three views ----
    leaderboard = {}
    gain_of = dict(gains)
    for c in categories:
        ks = members[c]
        if not ks:
            continue

        def pick(pool, metric):
            return sorted(pool, key=lambda k: (-metric(k), -gain_of.get(k, E[k]["conns"]), name(k)))[0] if pool else None

        conn_leader = pick(ks, lambda k: E[k]["conns"])
        # Growth by volume: positive change only; a company new this quarter counts its full count.
        vol_pool = [k for k in ks if gain_of.get(k, E[k]["conns"]) > 0]
        vol_leader = pick(vol_pool, lambda k: gain_of.get(k, E[k]["conns"]))
        # Growth by percentage: needs a real base at quarter start, so new companies are out.
        pct_pool = [k for k in ks if k in S and S[k]["conns"] >= PCT_MIN_BASE and gain_of[k] > 0]
        pct_leader = pick(pct_pool, lambda k: gain_of[k] / S[k]["conns"])

        leaderboard[c] = {
            "partner_count": len(ks),
            "total_connections": ce[c],
            "net_change": ce[c] - cs[c],
            "connections": {"leader": {"name": name(conn_leader), "value": E[conn_leader]["conns"]}},
            # gainer_count caps how many gated rows the widget draws, so it never promises a
            # rank that does not exist.
            "growth_volume": {"gainer_count": len(vol_pool),
                              "leader": {"name": name(vol_leader), "value": gain_of.get(vol_leader, E[vol_leader]["conns"])}
                              if vol_leader else None},
            "growth_pct": {"gainer_count": len(pct_pool),
                           "leader": {"name": name(pct_leader),
                                      "value": round(100.0 * gain_of[pct_leader] / S[pct_leader]["conns"], 1)}
                           if pct_leader else None},
        }

    checks = {
        "uncategorized_end": sum(1 for v in E.values() if not v["category"]),
        "uncategorized_start": sum(1 for v in S.values() if not v["category"]),
        "sum_categories_eq_total": sum(ce.values()) == report["summary"]["connections_end"],
        "sum_net_eq_total": sum(ce[c] - cs[c] for c in categories) == net,
        "sum_added_eq_total": sum(adds.values()) == len(added),
        "sum_departed_eq_total": sum(deps.values()) == len(departed),
    }
    return report, leaderboard, checks


# --------------------------------------------------------------------------------------
# Payload guard — if it's in the payload, it's public.
# --------------------------------------------------------------------------------------

LEADERBOARD_KEYS = {"partner_count", "total_connections", "net_change",
                    "connections", "growth_volume", "growth_pct"}


def guard(leaderboard):
    for c, v in leaderboard.items():
        if set(v) != LEADERBOARD_KEYS:
            sys.exit(f"STOP: leaderboard[{c}] has unexpected keys {set(v) ^ LEADERBOARD_KEYS}")
        for view in ("growth_volume", "growth_pct"):
            if set(v[view]) != {"gainer_count", "leader"}:
                sys.exit(f"STOP: leaderboard[{c}][{view}] carries more than rank 1")


def write(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"wrote {os.path.relpath(path, HERE)} ({os.path.getsize(path):,} bytes)")


def main():
    conn = connect(DB_PATH)
    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    index, results = [], {}

    for i, q in enumerate(QUARTERS):
        report, leaderboard, checks = build_quarter(conn, q)
        guard(leaderboard)
        prior = QUARTERS[i - 1]["id"] if i else None
        meta = {"id": q["id"], "label": q["label"], "months": q["months"],
                "start_date": q["start_date"], "end_date": q["end_date"], "prior": prior,
                "generated_at": generated_at}
        write(os.path.join(OUT_DIR, q["id"], "report.json"),
              {**meta, "blog_url": q["blog_url"], "published": q["published"], **report})
        write(os.path.join(OUT_DIR, q["id"], "leaderboard.json"),
              {**meta, "pct_min_base": PCT_MIN_BASE, "categories": leaderboard})
        index.append({"id": q["id"], "label": q["label"]})
        results[q["id"]] = (report, leaderboard, checks)

    write(os.path.join(OUT_DIR, "quarters.json"), {"quarters": index, "latest": index[-1]["id"]})
    conn.close()

    # ---- review report (printed only, never shipped) ----
    rows = [("partners_added", "Partners added"), ("partners_departed", "Partners departed"),
            ("net_new_connections", "Net new connections"), ("pct_zero_new_ratings", "% with no new ratings"),
            ("partners_end", "Partners at quarter end"), ("connections_end", "Connections at quarter end")]
    print("\n--- at a glance (company basis) ---")
    print(f"  {'':28}" + "".join(f"{q['label']:>12}" for q in QUARTERS))
    for key, label in rows:
        print(f"  {label:28}" + "".join(f"{results[q['id']][0]['summary'][key]:>12}" for q in QUARTERS))
    for q in QUARTERS:
        report, leaderboard, checks = results[q["id"]]
        print(f"\n--- {q['label']} (pulls {q['start_pull']} -> {q['end_pull']}) ---")
        if report["asterisk"]:
            print(f"  asterisk: {report['asterisk']}")
        for k, v in checks.items():
            ok = (v == 0) if k.startswith("uncategorized") else v
            print(f"  [{'ok  ' if ok else 'STOP'}] {k}: {v}")
        thin = sorted(c for c, v in leaderboard.items() if 0 < v["growth_pct"]["gainer_count"] < 10)
        print(f"  leaderboard categories: {len(leaderboard)}; percent view under 10 gainers: {', '.join(thin) or 'none'}")
        for c, v in sorted(leaderboard.items()):
            gv, gp = v["growth_volume"]["leader"], v["growth_pct"]["leader"]
            print(f"    {c:28} #1 {v['connections']['leader']['name']} ({v['connections']['leader']['value']})"
                  f" | vol {gv['name'] if gv else '-'} | pct {gp['name'] if gp else '-'}")
    if _SHORTENED:
        print(f"\n  display names shortened: {len(_SHORTENED)}")
        for raw, shown in sorted(_SHORTENED):
            print(f"      {raw[:52]:<54} -> {shown}")


if __name__ == "__main__":
    main()
