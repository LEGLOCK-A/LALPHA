#!/usr/bin/env python3
"""
LegLock live-site data refresh pipeline (v1).

Rebuilds the LEGLOCK.online data chunks (data-{nba,nfl,nhl}.js,
data-{nba,nfl,nhl}-prev.js, data-merge.js, nfl-usage.js) from free public
sources — ESPN's public site API and nflverse — in the exact schema the
site's app.js consumes, and stages them under staging/assets/ for review.
It never writes anywhere else and never pushes anywhere.

Repo mode (GitHub Actions): with LEGLOCK_REPO_ROOT=<path> (or
--repo-root <path>) the script treats <path> as a checkout of the site
repo — it reads the current chunks from <path>/assets, builds outputs in
a temp dir, and only on full success moves the changed files into
<path>/assets (the workflow then commits and pushes). On any
whole-league failure the repo's assets are left completely untouched.

Rules implemented (inferred + verified against the frozen 2026-11-12 build;
see README.md for the full list and the flagged uncertainties):
  * Fixed player pools (ids + order) taken from the current site data.
  * Log rows from ESPN v3 gamelogs, Regular Season + Postseason only,
    most recent first; previous season goes to logsPrev.
  * Props: line = floor(L10 mean) + 0.5; featured direction = higher L10
    hit rate (ties to Over); rates {L5,L10,L20:{o,u,n}} with u = 100 - o;
    streak = consecutive most-recent hits in the featured direction;
    gp = current-season games; avg over all current-season values.
  * NBA/NHL prop qualification: gp >= 4. NHL goalies get Saves only.
  * NFL prop stat sets by position group with L10-average gates
    (inferred thresholds — see NFL_GATES below and README).
  * NBA eFG% = (FGM + 0.5 * 3PM) / FGA * 100 from gamelog FG/3PT fields.
  * NHL xGF% carried forward by player id (MoneyPuck is PAUSED — never
    fetched); xgfSeason/xgfSource preserved verbatim.
  * watch: per player, the (game, stat) with the highest value/season-avg
    ratio; top 24 per league. NBA watch lines omit 3PM (as baked).
  * h2h: rebuilt from the current-season game logs (per-game team
    attribution from the gamelog payload).
  * games: ESPN scoreboards for today + tomorrow (America/Toronto),
    parsed exactly like app.js parseScoreboard (minus clockSec, which
    the baked chunks do not carry).
  * Player `lead`: from the ESPN athlete statsSummary — NBA/NFL take the
    single best-ranked stat; NHL takes Goals/Assists/Points/Wins with
    rank <= 30 (both inferred; see README).
  * NFL usage from nflverse (snap_counts, stats_player_week, play_by_play
    red-zone counts); on any failure the existing nfl-usage.js is copied
    through unchanged.
  * Static league pages (nba/, nhl/, nfl/ "hit rates today") + sitemap.xml
    rendered from the same in-memory dataset — plain HTML, no JS needed
    to read them. Staging mode writes them under staging/; repo mode
    writes them at the repo root. They follow the data's all-or-nothing
    rule: generated only when every league built, published only on
    full success. The pages apply the board's rare-event rule: an
    Under 0.5 prop on a rare-event stat (NBA steals/blocks/3PM, NHL
    goals, NFL TDs) lists only when the player's L20 average for the
    stat is >= 0.3.

Failure behaviour: a league whose ESPN pull fails wholesale (injuries /
scoreboard error, or >15% gamelog failures) aborts that league — nothing
is staged for it and the process exits non-zero. Repeated HTTP 429s abort
the run rather than hammering.
"""

import csv
import gzip
import hashlib
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from html import escape as html_escape
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
SITE_ASSETS = os.path.expanduser("~/workspace/leglock-site/assets")
STAGING = os.path.join(HERE, "staging", "assets")


# Repo mode: --repo-root <path> wins over the LEGLOCK_REPO_ROOT env var.
# CURRENT_ASSETS is where the current chunks live (read + hash-compared);
# in default mode it is exactly SITE_ASSETS, so default behaviour is
# unchanged.
def _repo_root():
    argv = sys.argv[1:]
    if "--repo-root" in argv:
        i = argv.index("--repo-root")
        if i + 1 < len(argv):
            return os.path.abspath(argv[i + 1])
    env = os.environ.get("LEGLOCK_REPO_ROOT")
    return os.path.abspath(env) if env else None


REPO_ROOT = _repo_root()
CURRENT_ASSETS = os.path.join(REPO_ROOT, "assets") if REPO_ROOT else SITE_ASSETS
API = "https://site.api.espn.com/apis"
UA = {"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"}

LEAGUES = {
    "NBA": {"sport": "basketball", "code": "nba"},
    "NFL": {"sport": "football", "code": "nfl"},
    "NHL": {"sport": "hockey", "code": "nhl"},
}

# Row key order inside a log row's `s` object, per league (baked format).
ROW_KEYS_CUR = {
    "NBA": ["minutes", "points", "totalRebounds", "assists", "threePointersMade", "steals", "blocks"],
    "NHL": ["goals", "assists", "points", "shotsTotal", "saves"],
    # NFL: statDef order, intersected with the player's gamelog stat names.
}
ROW_KEYS_PREV = {
    # The frozen logsPrev NBA rows use gamelog-names order (verified in the file).
    "NBA": ["minutes", "threePointersMade", "totalRebounds", "assists", "blocks", "steals", "points"],
    "NHL": ["goals", "assists", "points", "shotsTotal", "saves"],
}

# NFL prop gates on the L10 average (INFERRED from the frozen build's
# in/out gaps — see README). "always" stats are generated for every player
# in the group; gated stats need l10avg >= threshold.
NFL_GATES = {
    "QB": {"always": ["passingYards", "passingTouchdowns"],
           "gated": {"rushingYards": 15.0, "rushingTouchdowns": 0.3}},
    "RB": {"always": ["rushingYards", "rushingTouchdowns"],
           "gated": {"receivingYards": 22.0, "receivingTouchdowns": 0.2, "receptions": 2.25}},
    "WR": {"always": ["receivingYards", "receptions"],
           "gated": {"receivingTouchdowns": 0.2}},
    "TE": {"always": ["receivingYards", "receptions"],
           "gated": {"receivingTouchdowns": 0.2}},
}
NFL_WATCH_KEYS = ["rushingYards", "rushingTouchdowns", "receivingYards", "receivingTouchdowns"]
NHL_LEAD_STATS = {"Goals", "Assists", "Points", "Wins"}
NHL_LEAD_MAX_RANK = 30

USAGE_HEADER = """
/* NFL usage, baked once from nflverse (snap counts, weekly player stats and
   play-by-play red-zone counts) — the same one-time bake pattern as the
   xGF% values. Per player: weekly snap %, targets, target share %, carries,
   carry share % and red-zone opportunities, plus season (avg) and last-3
   (l3) averages. Players absent here simply have no usage data. */
"""


# --------------------------------------------------------------------------
# JS-compatible JSON + rounding (the frozen chunks were written by a JS
# builder: integral floats print without ".0", Math.round is half-up).
# --------------------------------------------------------------------------

def js_dumps(obj):
    if obj is None:
        return "null"
    if obj is True:
        return "true"
    if obj is False:
        return "false"
    if isinstance(obj, int):
        return str(obj)
    if isinstance(obj, float):
        if obj == int(obj) and abs(obj) < 1e15:
            return str(int(obj))
        return repr(obj)
    if isinstance(obj, str):
        return json.dumps(obj, ensure_ascii=True)
    if isinstance(obj, (list, tuple)):
        return "[" + ",".join(js_dumps(v) for v in obj) + "]"
    if isinstance(obj, dict):
        return "{" + ",".join(
            json.dumps(str(k), ensure_ascii=True) + ":" + js_dumps(v) for k, v in obj.items()
        ) + "}"
    raise TypeError(f"not serializable: {type(obj)}")


def js_round(x):
    return math.floor(x + 0.5)


def js_round1(x):
    return math.floor(x * 10 + 0.5) / 10.0


def mean(vals):
    return sum(vals) / len(vals) if vals else 0.0


# --------------------------------------------------------------------------
# HTTP with modest pacing, retries, and a hard stop on repeated 429s.
# --------------------------------------------------------------------------

class FetchError(Exception):
    pass


class Fetcher:
    def __init__(self, workers=6):
        self.workers = workers
        self.count_429 = 0
        self.lock = threading.Lock()
        self.aborted = False

    def get_json(self, url, allow_404=False):
        last_err = None
        for attempt in range(3):
            if self.aborted:
                raise FetchError("run aborted after repeated 429s")
            try:
                req = urllib.request.Request(url, headers=UA)
                with urllib.request.urlopen(req, timeout=30) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code == 404 and allow_404:
                    return None
                last_err = e
                if e.code == 429:
                    with self.lock:
                        self.count_429 += 1
                        n = self.count_429
                    if n > 8:
                        self.aborted = True
                        raise FetchError("aborted: repeated HTTP 429 from ESPN")
                    time.sleep(2.0)
                    continue
                if e.code >= 500:
                    time.sleep(0.6 * (attempt + 1))
                    continue
                raise FetchError(f"HTTP {e.code} for {url}")
            except Exception as e:  # timeouts, resets, bad JSON
                last_err = e
                time.sleep(0.6 * (attempt + 1))
        raise FetchError(f"failed after retries: {url} ({last_err})")

    def get_bytes(self, url):
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.read()

    def map(self, fn, items):
        with ThreadPoolExecutor(max_workers=self.workers) as ex:
            return list(ex.map(fn, items))


FETCH = Fetcher()


# --------------------------------------------------------------------------
# Load the current site data (fixed pools, statDefs, xGF) via node.
# --------------------------------------------------------------------------

NODE_DUMP = r"""
const fs = require('fs'); global.window = {};
const A = process.argv[1];
for (const lg of ['nba','nfl','nhl']) {
  eval(fs.readFileSync(A + 'data-' + lg + '.js', 'utf8'));
}
const out = {};
for (const LG of ['NBA','NFL','NHL']) {
  const L = window['__DL_' + LG];
  out[LG] = { players: L.players, statDefs: L.statDefs,
              xgfSeason: L.xgfSeason || null, xgfSource: L.xgfSource || null };
}
console.log(JSON.stringify(out));
"""


def load_current():
    out = subprocess.run(["node", "-e", NODE_DUMP, CURRENT_ASSETS + "/"],
                         capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise FetchError(f"node dump of current data failed: {out.stderr[:300]}")
    return json.loads(out.stdout)


# --------------------------------------------------------------------------
# ESPN gamelog -> log rows
# --------------------------------------------------------------------------

def season_years(lg, now):
    """(current, previous) ESPN `season` params for the run date."""
    y, m = now.year, now.month
    if lg == "NFL":
        cur = y if m >= 9 else y - 1  # season starts in September
        return cur, cur - 1
    cur = y + 1 if m >= 9 else y      # NBA/NHL seasons end the next spring
    return cur, cur - 1


def parse_num(raw):
    if raw is None:
        return None
    try:
        f = float(raw)
    except (TypeError, ValueError):
        return None
    return int(f) if f == int(f) else f


def build_rows(lg, payload, row_keys, use_names_order=False):
    """Return (dated, efg) — rows most-recent-first in the baked schema.

    Current-season rows use the fixed per-league key order; previous-season
    rows iterate the gamelog payload's own stat-name order (the frozen
    logsPrev chunks were built that way — NBA prev is byte-identical
    under this rule).
    """
    if not payload:
        return [], None
    names = payload.get("names") or []
    meta = payload.get("events") or {}
    stats_by_event = {}
    for st in payload.get("seasonTypes") or []:
        dn = st.get("displayName") or ""
        if "Regular Season" not in dn and "Postseason" not in dn:
            continue
        for cat in st.get("categories") or []:
            for ev in cat.get("events") or []:
                stats_by_event[ev.get("eventId")] = ev.get("stats") or []
    dated = []
    fgm = fga = tpm = 0
    have_fg = False
    for eid, stats in stats_by_event.items():
        m = meta.get(eid) or {}
        if not m.get("gameResult") or not m.get("score"):
            continue  # not a completed game
        smap = dict(zip(names, stats))
        s = {}
        if use_names_order:
            wanted = set(row_keys)
            for name in names:
                k = "threePointersMade" if name == \
                    "threePointFieldGoalsMade-threePointFieldGoalsAttempted" else name
                if k in wanted and k not in s:
                    raw = smap.get(name)
                    if k == "threePointersMade" and isinstance(raw, str) and "-" in raw:
                        raw = raw.split("-")[0]
                    v = parse_num(raw)
                    if v is not None:
                        s[k] = v
        else:
            for k in row_keys:
                if k == "threePointersMade":
                    combo = smap.get("threePointFieldGoalsMade-threePointFieldGoalsAttempted")
                    raw = combo.split("-")[0] if combo else None
                else:
                    raw = smap.get(k)
                v = parse_num(raw)
                if v is not None:
                    s[k] = v
        if lg == "NBA":
            fg = smap.get("fieldGoalsMade-fieldGoalsAttempted")
            tp = smap.get("threePointFieldGoalsMade-threePointFieldGoalsAttempted")
            if fg and tp and "-" in fg and "-" in tp:
                try:
                    m1, a1 = fg.split("-")
                    fgm += int(m1); fga += int(a1); tpm += int(tp.split("-")[0])
                    have_fg = True
                except ValueError:
                    pass
        dated.append({
            "date": m.get("gameDate") or "",
            "row": {
                "d": (m.get("gameDate") or "")[:10],
                "opp": f"{m.get('atVs') or ''} {(m.get('opponent') or {}).get('abbreviation') or ''}".strip(),
                "res": f"{m.get('gameResult')} {m.get('score')}",
                "s": s,
            },
            "team": (m.get("team") or {}).get("abbreviation") or "",
        })
    dated.sort(key=lambda x: x["date"], reverse=True)
    efg = None
    if lg == "NBA" and have_fg and fga > 0:
        efg = js_round1((fgm + 0.5 * tpm) / fga * 100.0)
    return dated, efg


# --------------------------------------------------------------------------
# Athlete info + lead stat
# --------------------------------------------------------------------------

def build_lead(lg, athlete):
    stats = ((athlete.get("statsSummary") or {}).get("statistics")) or []
    if lg == "NHL":
        lead = {}
        for s in stats:
            if s.get("displayName") in NHL_LEAD_STATS and s.get("rank") is not None \
                    and s["rank"] <= NHL_LEAD_MAX_RANK:
                lead[s["displayName"]] = s.get("displayValue", "")
        return lead
    best = None
    for s in stats:
        if s.get("rank") is None:
            continue
        if best is None or s["rank"] < best["rank"]:
            best = s
    if best is None:
        return {}
    return {best.get("displayName", ""): best.get("displayValue", "")}


def parse_athlete(lg, payload, fallback):
    if not payload or not payload.get("athlete"):
        return fallback
    a = payload["athlete"]
    team = a.get("team") or {}
    return {
        "name": a.get("displayName") or fallback["name"],
        "team": team.get("abbreviation") or fallback["team"],
        "teamName": team.get("displayName") or fallback["teamName"],
        "pos": (a.get("position") or {}).get("abbreviation") or fallback["pos"],
        "jersey": a.get("jersey") or "",
        "lead": build_lead(lg, a),
    }


# --------------------------------------------------------------------------
# Injuries + scoreboard games (mirrors app.js parseScoreboard, minus
# clockSec which the baked chunks do not carry)
# --------------------------------------------------------------------------

def build_injuries(payload):
    groups = []
    for g in (payload or {}).get("injuries") or []:
        groups.append((g.get("displayName") or "", g.get("injuries") or []))
    groups.sort(key=lambda x: x[0])
    out = []
    for team_name, entries in groups:
        for inj in entries:
            if inj.get("status") == "Active":
                continue  # news blurbs about healthy players, not designations
            ath = inj.get("athlete") or {}
            out.append({
                "team": team_name,
                "name": ath.get("displayName") or "",
                "pos": (ath.get("position") or {}).get("abbreviation") or "",
                "status": inj.get("status") or "",
                "date": (inj.get("date") or "")[:10],
                "comment": inj.get("longComment") or inj.get("shortComment") or "",
                "type": (inj.get("details") or {}).get("type") or "",
            })
    return out


def parse_scoreboard(payload):
    out = []
    for ev in (payload or {}).get("events") or []:
        comps = ev.get("competitions") or []
        comp = comps[0] if comps else {}
        teams = {}
        for c in comp.get("competitors") or []:
            t = c.get("team") or {}
            teams[c.get("homeAway")] = {
                "id": t.get("id") or "", "abbr": t.get("abbreviation") or "",
                "name": t.get("displayName") or "",
                "score": "" if c.get("score") is None else str(c.get("score")),
            }
        st = ev.get("status") or comp.get("status") or {}
        stype = st.get("type") or {}
        odds_list = comp.get("odds") or []
        odds = odds_list[0] if odds_list else {}
        leaders = []
        for ld in comp.get("leaders") or []:
            tops = ld.get("leaders") or []
            top = tops[0] if tops else {}
            ath = top.get("athlete") or {}
            leaders.append({
                "cat": ld.get("shortDisplayName") or ld.get("displayName") or "",
                "name": ath.get("displayName") or "",
                "val": top.get("displayValue") or "",
                "team": (ath.get("team") or {}).get("abbreviation") or "",
            })
        out.append({
            "id": ev.get("id"), "date": ev.get("date") or "", "name": ev.get("name") or "",
            "state": stype.get("state") or "", "detail": stype.get("detail") or "",
            "shortDetail": stype.get("shortDetail") or "",
            "clock": st.get("displayClock") or "", "period": st.get("period") or 0,
            "home": teams.get("home") or {}, "away": teams.get("away") or {},
            "spread": odds.get("details") or "",
            "total": odds.get("overUnder"),
            "leaders": leaders[:6],
        })
    return out


# --------------------------------------------------------------------------
# Props / watch / h2h
# --------------------------------------------------------------------------

def prop_keys_for(lg, player, vals_by_key):
    """Which prop stat keys a player gets (verified rules; NFL gates inferred)."""
    if lg == "NBA":
        return ["points", "totalRebounds", "assists", "threePointersMade",
                "steals", "blocks", "combo"]
    if lg == "NHL":
        return ["saves"] if player["pos"] == "G" else ["points", "goals", "assists", "shotsTotal"]
    grp = NFL_GATES.get(player["pos"]) or NFL_GATES["WR"]
    keys = list(grp["always"])
    for k, threshold in grp["gated"].items():
        vals = vals_by_key.get(k) or []
        if vals and mean(vals[:10]) >= threshold:
            keys.append(k)
    order = ["passingYards", "passingTouchdowns", "rushingYards", "rushingTouchdowns",
             "receivingYards", "receivingTouchdowns", "receptions"]
    return [k for k in order if k in keys]


def build_prop(pid, player, key, label, vals, gp):
    l10 = vals[:10]
    line = math.floor(mean(l10)) + 0.5
    rates = {}
    for n, wname in ((5, "L5"), (10, "L10"), (20, "L20")):
        seg = vals[:n]
        o = js_round(100.0 * sum(1 for v in seg if v > line) / len(seg)) if seg else 0
        rates[wname] = {"o": o, "u": 100 - o, "n": len(seg)}
    direction = "Over" if rates["L10"]["o"] >= rates["L10"]["u"] else "Under"
    streak = 0
    for v in vals:
        if (v > line) if direction == "Over" else (v < line):
            streak += 1
        else:
            break
    return {
        "pid": pid, "name": player["name"], "team": player["team"], "pos": player["pos"],
        "stat": label, "key": key, "line": line, "dir": direction, "rates": rates,
        "streak": streak, "gp": gp, "avg": js_round1(mean(vals)),
        "l10avg": js_round1(mean(l10)), "last": vals[0],
    }


def build_watch(lg, pool_order, players, logs, stat_defs):
    cand_keys = NFL_WATCH_KEYS if lg == "NFL" else [d["k"] for d in stat_defs]
    labels = {d["k"]: d["label"] for d in stat_defs}
    if lg == "NBA":
        labels["combo"] = "Pts+Reb+Ast"
    cands = []
    for pid in pool_order:
        rows = logs.get(pid) or []
        if not rows:
            continue
        best = None
        for k in cand_keys:
            series = [(r, r["s"][k]) for r in rows if k in r["s"]]
            if not series:
                continue
            avg = mean([v for _, v in series])
            if avg <= 0:
                continue
            for r, v in series:
                ratio = v / avg
                if best is None or ratio > best[0]:
                    best = (ratio, k, r, v)
        if best is not None:
            cands.append((best[0], pid, best[1], best[2], best[3]))
    cands.sort(key=lambda x: -x[0])
    out = []
    for ratio, pid, k, row, v in cands[:24]:
        p = players[pid]
        res_parts = row["res"].split(" ")
        line_keys = [d["k"] for d in stat_defs if d["k"] in row["s"]]
        if lg == "NBA":
            line_keys = [x for x in line_keys if x != "threePointersMade"]
        line = " · ".join(f"{row['s'][x]} {labels[x]}" for x in line_keys)
        out.append({
            "pid": pid, "name": p["name"], "team": p["team"], "pos": p["pos"],
            "date": row["d"], "opp": row["opp"],
            "result": res_parts[0], "score": res_parts[1] if len(res_parts) > 1 else "",
            "line": line, "big": f"{v} {labels[k]}", "ratio": js_round1(ratio),
        })
    return out


def build_h2h(pool_order, dated_rows_by_pid):
    games = {}
    for pid in pool_order:
        for item in dated_rows_by_pid.get(pid) or []:
            row, team = item["row"], item["team"]
            m = re.match(r"^(vs|@) (.+)$", row["opp"])
            sm = re.match(r"^([WLT]) (\d+)-(\d+)", row["res"])
            if not m or not sm or not team:
                continue
            home = team if m.group(1) == "vs" else m.group(2)
            away = m.group(2) if m.group(1) == "vs" else team
            first, second = int(sm.group(2)), int(sm.group(3))
            team_score = first if sm.group(1) == "W" else second
            opp_score = second if sm.group(1) == "W" else first
            hs = team_score if m.group(1) == "vs" else opp_score
            as_ = opp_score if m.group(1) == "vs" else team_score
            key = (row["d"], home, away)
            if key not in games:
                games[key] = {"d": row["d"], "home": home, "away": away, "hs": hs, "as": as_}
    h2h = {}
    for g in games.values():
        pk = "|".join(sorted([g["home"], g["away"]]))
        h2h.setdefault(pk, []).append(g)
    for pk in h2h:
        h2h[pk].sort(key=lambda x: x["d"])
    return h2h


# --------------------------------------------------------------------------
# League assembly
# --------------------------------------------------------------------------

def fetch_gamelog(args):
    lg, pid, season = args
    cfg = LEAGUES[lg]
    url = f"{API}/common/v3/sports/{cfg['sport']}/{cfg['code']}/athletes/{pid}/gamelog?season={season}"
    try:
        return pid, FETCH.get_json(url, allow_404=True), None
    except FetchError as e:
        return pid, None, str(e)


def build_league(lg, current, now_utc):
    cfg = LEAGUES[lg]
    base = f"{API}/site/v2/sports/{cfg['sport']}/{cfg['code']}"
    cur_season, prev_season = season_years(lg, now_utc)
    pool_order = list(current["players"].keys())
    stat_defs = current["statDefs"]
    labels = {d["k"]: d["label"] for d in stat_defs}
    if lg == "NBA":
        labels["combo"] = "Pts+Reb+Ast"

    # --- league-wide pulls (hard fail = league failure) ---
    injuries = build_injuries(FETCH.get_json(f"{base}/injuries"))
    et = ZoneInfo("America/Toronto")
    today_et = now_utc.astimezone(et).date()
    games = []
    seen_ids = set()
    for delta in (0, 1):
        d = today_et + timedelta(days=delta)
        payload = FETCH.get_json(f"{base}/scoreboard?dates={d.strftime('%Y%m%d')}")
        for g in parse_scoreboard(payload):
            if g["id"] not in seen_ids:
                seen_ids.add(g["id"])
                games.append(g)
    games.sort(key=lambda g: g["date"])

    # --- per-player pulls ---
    jobs = [(lg, pid, cur_season) for pid in pool_order] + \
           [(lg, pid, prev_season) for pid in pool_order]
    results = FETCH.map(fetch_gamelog, jobs)
    raw_logs, raw_prev, failures = {}, {}, 0
    for i, (pid, payload, err) in enumerate(results):
        target = raw_logs if i < len(pool_order) else raw_prev
        if err is not None:
            failures += 1
            target[pid] = None
        else:
            target[pid] = payload
    if failures > 0.15 * len(jobs):
        raise FetchError(f"{lg}: {failures}/{len(jobs)} gamelog requests failed — aborting league")

    def fetch_athlete(pid):
        url = f"{API}/common/v3/sports/{cfg['sport']}/{cfg['code']}/athletes/{pid}"
        try:
            return pid, FETCH.get_json(url, allow_404=True)
        except FetchError:
            return pid, None

    athlete_payloads = dict(FETCH.map(fetch_athlete, pool_order))

    # --- build players / logs ---
    row_keys_cur = ROW_KEYS_CUR.get(lg) or [d["k"] for d in stat_defs]
    row_keys_prev = ROW_KEYS_PREV.get(lg) or [d["k"] for d in stat_defs]
    players, logs, logs_prev, dated_cur = {}, {}, {}, {}
    empty_logs = []
    efg_count = 0
    xgf_carried = 0
    for pid in pool_order:
        old = current["players"][pid]
        fallback = {"name": old["name"], "team": old["team"], "teamName": old["teamName"],
                    "pos": old["pos"]}
        info = parse_athlete(lg, athlete_payloads.get(pid), fallback)
        player = {
            "id": pid, "name": info["name"], "team": info["team"],
            "teamName": info["teamName"], "pos": info["pos"],
            "jersey": info["jersey"], "lead": info["lead"],
            "img": f"https://a.espncdn.com/i/headshots/{cfg['code']}/players/full/{pid}.png",
        }
        dated, efg = build_rows(lg, raw_logs.get(pid), row_keys_cur)
        dated_p, _ = build_rows(lg, raw_prev.get(pid), row_keys_prev, use_names_order=True)
        dated_cur[pid] = dated
        logs[pid] = [x["row"] for x in dated]
        logs_prev[pid] = [x["row"] for x in dated_p]
        if not logs[pid]:
            empty_logs.append(info["name"])
        if lg == "NBA" and efg is not None:
            player["efg"] = efg
            efg_count += 1
        if lg == "NHL" and old.get("xgf") is not None:
            player["xgf"] = old["xgf"]
            xgf_carried += 1
        players[pid] = player

    # --- props ---
    props = []
    for pid in pool_order:
        rows = logs[pid]
        gp = len(rows)
        if lg in ("NBA", "NHL") and gp < 4:
            continue
        if gp == 0:
            continue
        vals_by_key = {}
        for d in stat_defs:
            vals_by_key[d["k"]] = [r["s"][d["k"]] for r in rows if d["k"] in r["s"]]
        if lg == "NBA":
            vals_by_key["combo"] = [
                r["s"].get("points", 0) + r["s"].get("totalRebounds", 0) + r["s"].get("assists", 0)
                for r in rows
            ]
        for key in prop_keys_for(lg, players[pid], vals_by_key):
            vals = vals_by_key.get(key) or []
            if not vals:
                continue
            props.append(build_prop(pid, players[pid], key, labels[key], vals, gp))

    watch = build_watch(lg, pool_order, players, logs, stat_defs)
    h2h = build_h2h(pool_order, dated_cur)

    league = {
        "players": players, "props": props, "watch": watch, "games": games,
        "injuries": injuries, "logs": logs, "h2h": h2h, "statDefs": stat_defs,
    }
    if lg == "NHL":
        league["xgfSeason"] = current["xgfSeason"]
        league["xgfSource"] = current["xgfSource"]
    report = {
        "players": len(players), "props": len(props),
        "logRows": sum(len(v) for v in logs.values()),
        "logPrevRows": sum(len(v) for v in logs_prev.values()),
        "injuries": len(injuries), "games": len(games), "watch": len(watch),
        "emptyLogs": empty_logs, "gamelogFailures": failures,
    }
    if lg == "NBA":
        report["efgCoverage"] = efg_count
    if lg == "NHL":
        report["xgfCarried"] = xgf_carried
    return league, logs_prev, report


# --------------------------------------------------------------------------
# NFL usage from nflverse (falls back to copying the existing file)
# --------------------------------------------------------------------------

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
TEAM_MAP = {"WSH": "WAS", "LAR": "LA", "JAC": "JAX"}  # ESPN abbr -> nflverse


def norm_name(name):
    n = name.lower().replace(".", "").replace("'", "").replace("-", " ")
    n = re.sub(r"\b(jr|sr|ii|iii|iv)\b", "", n)
    return re.sub(r"\s+", " ", n).strip()


def _csv_rows(raw_bytes, gz=False):
    if gz:
        raw_bytes = gzip.decompress(raw_bytes)
    text = io.TextIOWrapper(io.BytesIO(raw_bytes), encoding="utf-8", errors="replace")
    yield from csv.DictReader(text)


def build_usage(pool_players, nfl_season):
    """Return (usage_dict, matched_count). Raises on any hard failure.

    Mirrors the frozen nfl-usage.js: per player, weekly arrays aligned to
    `wk` (weeks the player recorded a snap count), sn = snap % , tg =
    targets, ts = target share %, ca = carries, cs = carry share % (of
    team carries that week), rz = red-zone opportunities (rush attempts +
    targets with yardline_100 <= 20), avg/l3 = mean / last-3 mean of the
    raw sn/ts/cs/rz values, rounded to 1dp (Python round, as baked).
    """
    snap_raw = FETCH.get_bytes(f"{NFLVERSE}/snap_counts/snap_counts_{nfl_season}.csv")
    stats_raw = FETCH.get_bytes(f"{NFLVERSE}/stats_player/stats_player_week_{nfl_season}.csv")
    pbp_raw = FETCH.get_bytes(f"{NFLVERSE}/pbp/play_by_play_{nfl_season}.csv.gz")

    weekly = {}        # (gsis, week) -> {tg, ca, ts(raw %), team}
    ids_by_name = {}   # normalized name -> {gsis: {teams}}
    team_carries = {}  # (team, week) -> total carries
    for r in _csv_rows(stats_raw):
        if r.get("season_type") not in (None, "", "REG"):
            continue
        try:
            wk = int(r["week"])
            tg = int(float(r.get("targets") or 0))
            ca = int(float(r.get("carries") or 0))
            ts = float(r.get("target_share") or 0) * 100.0
        except (TypeError, ValueError):
            continue
        gid = r.get("player_id")
        team = r.get("recent_team") or r.get("team") or ""
        weekly[(gid, wk)] = {"tg": tg, "ca": ca, "ts": ts, "team": team}
        ids_by_name.setdefault(norm_name(r.get("player_display_name") or ""), {}) \
            .setdefault(gid, set()).add(team)
        team_carries[(team, wk)] = team_carries.get((team, wk), 0) + ca

    snaps = {}  # normalized name -> {week: snap %}
    for r in _csv_rows(snap_raw):
        if r.get("game_type") not in (None, "", "REG"):
            continue
        try:
            wk = int(r["week"])
            pct = float(r.get("offense_pct") or 0) * 100.0
        except (TypeError, ValueError):
            continue
        nn = norm_name(r.get("player") or r.get("pfr_player_name") or "")
        snaps.setdefault(nn, {})[wk] = pct

    rz = {}  # (gsis, week) -> red-zone opportunities
    for r in _csv_rows(pbp_raw, gz=True):
        if r.get("season_type") != "REG":
            continue
        try:
            yl = float(r.get("yardline_100") or 99)
            wk = int(r["week"])
        except (TypeError, ValueError):
            continue
        if yl > 20:
            continue
        for col in ("rusher_player_id", "receiver_player_id"):
            gid = r.get(col)
            if gid:
                rz[(gid, wk)] = rz.get((gid, wk), 0) + 1

    usage = {}
    matched = 0
    for pid, p in pool_players.items():
        nn = norm_name(p["name"])
        candidates = ids_by_name.get(nn) or {}
        gid = None
        if len(candidates) == 1:
            gid = next(iter(candidates))
        elif candidates:
            want = TEAM_MAP.get(p["team"], p["team"])
            for cand, teams in candidates.items():
                if want in teams:
                    gid = cand
                    break
            if gid is None:
                gid = next(iter(candidates))
        weeks = sorted((snaps.get(nn) or {}).keys())
        if gid is None or not weeks:
            continue
        sn_raw = [snaps[nn][w] for w in weeks]
        tg, ts_raw, ca, cs_raw, rz_l = [], [], [], [], []
        for w in weeks:
            ws = weekly.get((gid, w)) or {"tg": 0, "ca": 0, "ts": 0.0, "team": ""}
            tg.append(ws["tg"])
            ts_raw.append(ws["ts"])
            ca.append(ws["ca"])
            total = team_carries.get((ws["team"], w), 0)
            cs_raw.append(ws["ca"] / total * 100.0 if total else 0.0)
            rz_l.append(rz.get((gid, w), 0))

        def avg(vals):
            return round(mean(vals), 1) if vals else 0.0

        def l3(vals):
            return round(mean(vals[-3:]), 1) if vals else 0.0

        usage[pid] = {
            "sn": [round(v, 1) for v in sn_raw],
            "tg": tg,
            "ts": [round(v, 1) for v in ts_raw],
            "ca": ca,
            "cs": [round(v, 1) for v in cs_raw],
            "rz": rz_l,
            "wk": weeks,
            "avg": {"sn": avg(sn_raw), "ts": avg(ts_raw), "cs": avg(cs_raw), "rz": avg(rz_l)},
            "l3": {"sn": l3(sn_raw), "ts": l3(ts_raw), "cs": l3(cs_raw), "rz": l3(rz_l)},
        }
        matched += 1
    return usage, matched


# --------------------------------------------------------------------------
# Static per-league pages + sitemap. Rendered from the same in-memory
# dataset as the data chunks: plain HTML tables/lists a crawler (or a
# browser with JS off) can read immediately, in the standalone guides
# pages' shell (leglock.css, brand header, site footer).
# --------------------------------------------------------------------------

SITE_ORIGIN = "https://leglock.online"
ET = ZoneInfo("America/Toronto")

PAGE_LEAGUES = {
    "NBA": {
        "slug": "nba",
        "title": "NBA Player Prop Hit Rates Today — LegLock",
        "h1": "NBA Player Prop Hit Rates Today",
        "sub": "Today's slate, ranked by L10 hit rate",
        "description": "NBA player prop hit rates today: the top 25 props ranked by L10 hit rate, with L5, L10 and L20 rates counted from game logs at research lines set from each player's own recent average.",
    },
    "NFL": {
        "slug": "nfl",
        "title": "NFL Player Prop Hit Rates Today — LegLock",
        "h1": "NFL Player Prop Hit Rates Today",
        "sub": "This week's slate (Thursday to Monday), ranked by L10 hit rate",
        "description": "NFL player prop hit rates today: the top 25 props for this week's games, ranked by L10 hit rate, with L5, L10 and L20 rates counted from game logs at research lines set from each player's own recent average.",
    },
    "NHL": {
        "slug": "nhl",
        "title": "NHL Player Prop Hit Rates Today — LegLock",
        "h1": "NHL Player Prop Hit Rates Today",
        "sub": "Today's slate, ranked by L10 hit rate",
        "description": "NHL player prop hit rates today: the top 25 props ranked by L10 hit rate, with L5, L10 and L20 rates counted from game logs at research lines set from each player's own recent average.",
    },
}

# Head snippets copied verbatim from the standalone guides pages.
GA4_SNIPPET = """<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-MJB3JWSKZB"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-MJB3JWSKZB');
</script>"""

ADS_SNIPPET = '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1221762448386445" crossorigin="anonymous"></script>'

THEME_PIN_SNIPPET = """<script>
try{var _t=window.localStorage.getItem("lm-theme");document.documentElement.setAttribute("data-theme",_t==="dark"?"dark":"light");}catch(e){document.documentElement.setAttribute("data-theme","light");}
</script>"""

PAGE_TABS = ('<nav class="tabs" aria-label="Main views">'
             '<a href="/"><span class="tab-label">Discover</span></a>'
             '<a href="/live/"><span class="tab-label">Live</span></a>'
             '<a href="/prop-watch/"><span class="tab-label">Prop Watch</span></a>'
             '<a href="/workstation/"><span class="tab-label">Workstation</span></a>'
             '<a href="/cheatsheet/"><span class="tab-label">Cheatsheet</span></a>'
             '<a href="/logs/"><span class="tab-label">Logs</span></a>'
             '<a href="/make-me-a-lay/"><span class="tab-label">Make me a Lay</span></a>'
             '<a href="/injuries/"><span class="tab-label">Injuries</span></a></nav>')

PAGE_FOOTER = ('<footer><div class="site-footer"><span class="site-footer-brand">LEGLOCK</span>'
               '<nav class="site-footer-links" aria-label="Site information">'
               '<a href="/privacy/">Privacy Policy</a><a href="/about/">About</a>'
               '<a href="/guides/">Guides</a><a href="/guides/responsible-play/">Responsible Play</a>'
               '<a href="/contact/">Contact</a><a href="/donation/">Donate</a></nav></div>'
               '<p class="site-footer-note">Questions: '
               '<a href="mailto:support@leglock.online">support@leglock.online</a></p>'
               '<p class="site-footer-note">LegLock — sports statistics &amp; information only '
               '— not gambling advice. No bets are taken here.</p></footer>')

PAGE_STYLE = """<style>
.props-table{width:100%;border-collapse:collapse;font-size:14px;margin:10px 0 4px}
.props-table th,.props-table td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
.props-table th{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}
.props-table td.num,.props-table th.num{white-space:nowrap}
.streak-list{margin:8px 0;padding-left:20px}
.streak-list li{margin:4px 0}
.props-note{font-size:12.5px;color:var(--dim)}
.site-footer-note{font-size:12.5px;color:var(--dim);margin:6px 0 0}
</style>"""


def page_logo_uri():
    """The guides pages' brand wordmark (a data URI), reused so the
    generated pages carry the same header brand block without a second
    copy of the artwork living in this script. Falls back to the app
    logo asset, then to no image (the footer keeps the text brand)."""
    site_root = os.path.dirname(CURRENT_ASSETS)
    guide = os.path.join(site_root, "guides", "how-hit-rates-work", "index.html")
    try:
        with open(guide, "r", encoding="utf-8") as f:
            m = re.search(r'class="site-logo"><img src="(data:image/[^"]+)"', f.read())
        if m:
            return m.group(1)
    except OSError:
        pass
    try:
        with open(os.path.join(CURRENT_ASSETS, "images.js"), "r", encoding="utf-8") as f:
            m = re.search(r'logo:\s*"(data:image/[^"]+)"', f.read())
        if m:
            return m.group(1)
    except OSError:
        pass
    return None


def fmt_stamp(dt_et):
    """'November 18, 2026, 7:15 PM ET' from an ET datetime."""
    hour = dt_et.hour % 12 or 12
    ampm = "AM" if dt_et.hour < 12 else "PM"
    return f"{dt_et.strftime('%B')} {dt_et.day}, {dt_et.year}, {hour}:{dt_et.minute:02d} {ampm} ET"


def featured_pct(prop, window):
    r = prop["rates"][window]
    return r["o"] if prop["dir"] == "Over" else r["u"]


def featured_counts(prop, window):
    """(hits, games) in the featured direction for a window. The rates
    store integer percentages over n games, which round-trips exactly."""
    r = prop["rates"][window]
    pct = r["o"] if prop["dir"] == "Over" else r["u"]
    return js_round(pct * r["n"] / 100.0), r["n"]


def fmt_counts(prop, window):
    hits, n = featured_counts(prop, window)
    return f"{hits}/{n}"


def fmt_line(line):
    return str(int(line)) if float(line) == int(line) else f"{line:.1f}"


def game_et_date(game):
    raw = (game.get("date") or "").replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(ET).date()


def game_teams(game):
    teams = set()
    for side in ("home", "away"):
        abbr = (game.get(side) or {}).get("abbr")
        if abbr:
            teams.add(abbr)
    return teams


def slate_teams_today(league, today_et):
    teams = set()
    for g in league["games"]:
        if game_et_date(g) == today_et:
            teams |= game_teams(g)
    return teams


def nfl_week_window(today_et):
    """(Thu, Mon) of the current NFL game week: the Thu–Mon span that
    contains today, or the upcoming one when today is Tue/Wed."""
    start = today_et - timedelta(days=(today_et.weekday() - 3) % 7)
    if today_et > start + timedelta(days=4):
        start += timedelta(days=7)
    return start, start + timedelta(days=4)


def slate_teams_nfl_week(league, today_et):
    """Teams playing in the current Thu–Mon NFL week (the board's NFL
    window). The baked games only cover today + tomorrow, so the week's
    scoreboards are pulled the same way build_league pulls them; on any
    failure the teams in the baked games are used instead."""
    start, end = nfl_week_window(today_et)
    cfg = LEAGUES["NFL"]
    base = f"{API}/site/v2/sports/{cfg['sport']}/{cfg['code']}"
    teams = set()
    try:
        d = start
        while d <= end:
            payload = FETCH.get_json(f"{base}/scoreboard?dates={d.strftime('%Y%m%d')}")
            for g in parse_scoreboard(payload):
                teams |= game_teams(g)
            d += timedelta(days=1)
    except Exception:
        teams = set()
    if not teams:
        for g in league["games"]:
            teams |= game_teams(g)
    return teams


# The board's rare-event rule, mirrored for the generated pages: an
# Under 0.5 prop on a rare-event stat lists only when the player's L20
# average for that stat is at least 0.3 — otherwise the top lists fill
# with near-automatic Unders on events that almost never happen.
RARE_EVENT_KEYS = {
    "NBA": {"steals", "blocks", "threePointersMade"},
    "NHL": {"goals"},
    "NFL": {"passingTouchdowns", "rushingTouchdowns", "receivingTouchdowns"},
}
RARE_L20_MIN = 0.3


def l20_average(league, prop):
    """Mean of the prop stat's values over the player's last 20 games —
    the same value series build_prop rates (current-season log rows,
    most recent first). Prop objects carry only the season and L10
    averages, so the L20 average is computed from the logs."""
    rows = league["logs"].get(prop["pid"]) or []
    vals = [r["s"][prop["key"]] for r in rows if prop["key"] in r["s"]][:20]
    return mean(vals) if vals else 0.0


def passes_rare_gate(lg, league, prop):
    if prop["dir"] != "Under" or prop["line"] != 0.5:
        return True
    if prop["key"] not in RARE_EVENT_KEYS.get(lg, ()):
        return True
    return l20_average(league, prop) >= RARE_L20_MIN - 1e-9


def build_league_page(lg, league, stamp, today_et, logo_uri):
    cfg = PAGE_LEAGUES[lg]
    slug = cfg["slug"]
    injured = {i["name"] for i in league["injuries"]}
    props_all = [p for p in league["props"] if p["name"] not in injured]
    props = [p for p in props_all if passes_rare_gate(lg, league, p)]

    if lg == "NFL":
        teams = slate_teams_nfl_week(league, today_et)
    else:
        teams = slate_teams_today(league, today_et)

    def top25(source):
        pool = [p for p in source if p["team"] in teams] if teams else []
        if pool:
            return sorted(pool, key=lambda p: (-featured_pct(p, "L10"), -featured_pct(p, "L20"),
                                               -featured_pct(p, "L5"), p["name"]))[:25], \
                ("week" if lg == "NFL" else "today")
        # No games in the window: the league's top 25 overall, honestly
        # labelled as the next slate rather than today's.
        return sorted(source, key=lambda p: (-featured_pct(p, "L10"), -featured_pct(p, "L20"),
                                             -featured_pct(p, "L5"), p["name"]))[:25], "fallback"

    listed, window = top25(props)
    heading = "Top props — next slate" if window == "fallback" else \
        ("Top props this week" if lg == "NFL" else "Top props today")
    pre_gate_top = top25(props_all)[0]
    gated_top = sum(1 for p in pre_gate_top if not passes_rare_gate(lg, league, p))

    # prop["streak"] is the true current streak: consecutive most-recent
    # games hitting in the featured direction (see build_prop).
    def streak_list(source):
        return sorted((p for p in source if p["streak"] >= 5),
                      key=lambda p: (-p["streak"], -featured_pct(p, "L10"), p["name"]))[:10]

    streaks = streak_list(props)
    gated_streaks = sum(1 for p in streak_list(props_all)
                        if not passes_rare_gate(lg, league, p))

    rows = []
    for p in listed:
        rows.append(
            '<tr><td>{}</td><td>{}</td><td>{}</td><td class="num">{} {}</td>'
            '<td class="num">{}</td><td class="num">{}</td><td class="num">{}</td></tr>'.format(
                html_escape(p["name"]), html_escape(p["team"]), html_escape(p["stat"]),
                p["dir"], fmt_line(p["line"]),
                fmt_counts(p, "L5"), fmt_counts(p, "L10"), fmt_counts(p, "L20")))

    streak_html = ""
    if streaks:
        items = []
        for p in streaks:
            items.append(
                "<li><strong>{}</strong> ({}) — {}, {} {} — {}-game hit streak "
                "&middot; L10 {}</li>".format(
                    html_escape(p["name"]), html_escape(p["team"]), html_escape(p["stat"]),
                    p["dir"], fmt_line(p["line"]), p["streak"], fmt_counts(p, "L10")))
        streak_html = ("<h2>On a streak</h2>\n"
                       "<p>Props whose featured side has cashed in at least five straight games:</p>\n"
                       '<ul class="streak-list">\n' + "\n".join(items) + "\n</ul>\n")

    others = [o for o in ("NBA", "NHL", "NFL") if o != lg]
    more_links = " and ".join(
        '<a href="/{}/">{} player prop hit rates today</a>'.format(PAGE_LEAGUES[o]["slug"], o)
        for o in others)
    logo_html = ('<div class="site-logo"><img src="{}" alt="LEGLOCK" /></div>'.format(logo_uri)
                 if logo_uri else
                 '<div class="site-logo"><span class="site-footer-brand">LEGLOCK</span></div>')

    page = f"""<!doctype html>
<html lang="en" data-theme="light">
<head>
{GA4_SNIPPET}

<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
{ADS_SNIPPET}
<meta name="apple-mobile-web-app-title" content="LEGLOCK" />
<meta name="theme-color" content="#0b1220" />
{THEME_PIN_SNIPPET}
<title>{cfg['title']}</title>
<meta name="description" content="{cfg['description']}" />
<link rel="canonical" href="{SITE_ORIGIN}/{slug}/" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Sofia+Sans+Condensed:wght@600;700&family=Sofia+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/assets/leglock.css" />
{PAGE_STYLE}
</head>
<body><main>{logo_html}{PAGE_TABS}<h1 class="display" style="font-size:28px;font-weight:700;margin:14px 0 2px">{cfg['h1']}</h1><p class="sub" style="margin:0 0 10px">{cfg['sub']}</p><section class="content-body">
<p class="content-byline">Updated {stamp}</p>
<p>{lg} player prop hit rates, ranked by how often each prop has cashed over the last 10 games. Every rate below is counted from actual game logs, and every line is a research line set from the player's own recent average — not a sportsbook price. This page is a static snapshot of the board; the full <a href="/">interactive prop board</a> covers every player and prop, and the <a href="/live/">live page</a> tracks games in progress.</p>
<h2>{heading}</h2>
<table class="props-table">
<thead><tr><th>Player</th><th>Team</th><th>Stat</th><th>Line</th><th>L5</th><th>L10</th><th>L20</th></tr></thead>
<tbody>
{chr(10).join(rows)}
</tbody>
</table>
<p class="props-note">Rates read as hits/games in each prop's featured direction — the side (Over or Under) with the higher L10 rate. Players on the injury report are left out, the same rule the board uses.</p>
{streak_html}<h2>More on LegLock</h2>
<p>See the {more_links}, or learn <a href="/guides/how-hit-rates-work/">how hit rates work</a> — what L5, L10 and L20 really measure, and how to read them without fooling yourself.</p>
</section>{PAGE_FOOTER}</main>
</body>
</html>
"""
    info = {"propsListed": len(listed), "streaks": len(streaks), "window": window,
            "gatedOutTop": gated_top, "gatedOutStreaks": gated_streaks,
            "gatedProps": len(props_all) - len(props)}
    return page, info


SITEMAP_FALLBACK_URLS = [
    "https://leglock.online/",
    "https://leglock.online/live/",
    "https://leglock.online/underdogs/",
    "https://leglock.online/shuffle/",
    "https://leglock.online/game-logs/",
    "https://leglock.online/injuries/",
    "https://leglock.online/donation/",
    "https://leglock.online/about/",
    "https://leglock.online/privacy/",
    "https://leglock.online/contact/",
    "https://leglock.online/guides/",
    "https://leglock.online/guides/getting-started/",
    "https://leglock.online/guides/how-hit-rates-work/",
    "https://leglock.online/guides/how-to-read-a-prop-board/",
    "https://leglock.online/guides/research-lines-vs-real-odds/",
    "https://leglock.online/guides/responsible-play/",
]


def build_sitemap(run_date):
    """The sitemap rewritten: the URLs already listed (read from the
    current file when available, else the known 16) plus the three
    league pages. lastmod is refreshed to the run date for the homepage
    and the league pages; every other entry carries over unchanged."""
    entries = []
    path = os.path.join(os.path.dirname(CURRENT_ASSETS), "sitemap.xml")
    try:
        with open(path, "r", encoding="utf-8") as f:
            for m in re.finditer(r"<loc>([^<]+)</loc><lastmod>([^<]+)</lastmod>", f.read()):
                entries.append([m.group(1), m.group(2)])
    except OSError:
        entries = []
    if not entries:
        entries = [[u, "2026-11-18"] for u in SITEMAP_FALLBACK_URLS]
    by_url = {u: e for u, e in ((e[0], e) for e in entries)}
    home = f"{SITE_ORIGIN}/"
    if home in by_url:
        by_url[home][1] = run_date
    else:
        entries.insert(0, [home, run_date])
    for lg in ("NBA", "NHL", "NFL"):
        url = f"{SITE_ORIGIN}/{PAGE_LEAGUES[lg]['slug']}/"
        if url in by_url:
            by_url[url][1] = run_date
        else:
            entries.append([url, run_date])
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for url, lastmod in entries:
        lines.append(f"  <url><loc>{url}</loc><lastmod>{lastmod}</lastmod></url>")
    lines.append("</urlset>")
    return "\n".join(lines) + "\n"


def generate_pages(league_objs, now_utc):
    """Return ({repo-relative path: content}, per-league info)."""
    now_et = now_utc.astimezone(ET)
    stamp = fmt_stamp(now_et)
    logo_uri = page_logo_uri()
    staged_root, info = {}, {}
    for lg in ("NBA", "NFL", "NHL"):
        page, pinfo = build_league_page(lg, league_objs[lg], stamp, now_et.date(), logo_uri)
        staged_root[f"{PAGE_LEAGUES[lg]['slug']}/index.html"] = page
        info[lg] = pinfo
    staged_root["sitemap.xml"] = build_sitemap(now_et.strftime("%Y-%m-%d"))
    return staged_root, info


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def sha256_file(path):
    if not os.path.exists(path):
        return None
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def main():
    now_utc = datetime.now(timezone.utc)
    fetched_at = now_utc.strftime("%Y-%m-%dT%H:%M:%S+00:00")
    if REPO_ROOT:
        out_dir = tempfile.mkdtemp(prefix="leglock-refresh-")
    else:
        out_dir = STAGING
        os.makedirs(out_dir, exist_ok=True)
    report = {"fetchedAt": fetched_at, "leagues": {}, "errors": []}

    try:
        current = load_current()
    except Exception as e:
        print(json.dumps({"fetchedAt": fetched_at, "errors": [f"cannot load current data: {e}"]}))
        return 1

    staged = {}
    league_objs = {}
    failed = False
    for lg in ("NBA", "NFL", "NHL"):
        try:
            league, logs_prev, lrep = build_league(lg, current[lg], now_utc)
        except Exception as e:
            report["errors"].append(f"{lg}: {e}")
            failed = True
            continue
        league_objs[lg] = league
        report["leagues"][lg] = lrep
        low = lg.lower()
        staged[f"data-{low}.js"] = f"window.__DL_{lg} = {js_dumps(league)};\n"
        staged[f"data-{low}-prev.js"] = f"window.__DL_{lg}_PREV = {js_dumps(logs_prev)};\n"

    # NFL usage (only meaningful if the NFL league built)
    usage_status = "skipped"
    if "NFL" in league_objs:
        try:
            nfl_season, _ = season_years("NFL", now_utc)
            usage, matched = build_usage(current["NFL"]["players"], nfl_season)
            if matched < 90:
                raise FetchError(f"only {matched}/101 pool players matched in nflverse")
            body = USAGE_HEADER + "DATA.leagues.NFL.usage = " + \
                json.dumps(usage, separators=(",", ":"), ensure_ascii=True) + ";\n"
            staged["nfl-usage.js"] = body
            usage_status = f"rebuilt ({matched}/101 players matched)"
        except Exception as e:
            src = os.path.join(CURRENT_ASSETS, "nfl-usage.js")
            with open(src, "r", encoding="utf-8") as f:
                staged["nfl-usage.js"] = f.read()
            usage_status = f"fallback: copied existing file ({e})"
    report["nflverse"] = usage_status

    if not failed:
        staged["data-merge.js"] = (
            f'var DATA = {{leagues: {{}}, fetchedAt: "{fetched_at}"}};\n'
            "DATA.leagues.NBA = window.__DL_NBA; DATA.leagues.NBA.logsPrev = window.__DL_NBA_PREV;\n"
            "DATA.leagues.NFL = window.__DL_NFL; DATA.leagues.NFL.logsPrev = window.__DL_NFL_PREV;\n"
            "DATA.leagues.NHL = window.__DL_NHL; DATA.leagues.NHL.logsPrev = window.__DL_NHL_PREV;\n"
        )

    # Static league pages + sitemap, from the same dataset. A failure
    # here is reported but never blocks the data publish — the pages
    # simply regenerate on the next successful run.
    staged_root = {}
    if not failed:
        try:
            staged_root, page_info = generate_pages(league_objs, now_utc)
            report["pages"] = page_info
        except Exception as e:
            report["errors"].append(f"pages: {e}")
            staged_root = {}

    changed, unchanged = [], []
    for name, content in sorted(staged.items()):
        path = os.path.join(out_dir, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        cur_hash = sha256_file(os.path.join(CURRENT_ASSETS, name))
        new_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        (changed if cur_hash != new_hash else unchanged).append(name)
    report["filesChanged"] = changed
    report["filesUnchanged"] = unchanged

    # Root-level outputs (league pages + sitemap) stage alongside the
    # data files: in the temp dir in repo mode, under staging/ otherwise.
    if REPO_ROOT:
        root_stage_dir, root_cur_dir = out_dir, REPO_ROOT
    else:
        root_stage_dir = os.path.join(HERE, "staging")
        root_cur_dir = os.path.dirname(CURRENT_ASSETS)
    root_changed, root_unchanged = [], []
    for rel, content in sorted(staged_root.items()):
        path = os.path.join(root_stage_dir, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        cur_hash = sha256_file(os.path.join(root_cur_dir, rel))
        new_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        (root_changed if cur_hash != new_hash else root_unchanged).append(rel)
    report["pageFilesChanged"] = root_changed
    report["pageFilesUnchanged"] = root_unchanged

    if REPO_ROOT:
        # Publish only on full success: move just the changed files into
        # the repo. On failure nothing is moved — assets stay untouched.
        if not failed:
            for name in changed:
                shutil.move(os.path.join(out_dir, name),
                            os.path.join(CURRENT_ASSETS, name))
            for rel in root_changed:
                dest = os.path.join(REPO_ROOT, rel)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                shutil.move(os.path.join(out_dir, rel), dest)
        shutil.rmtree(out_dir, ignore_errors=True)

    print(json.dumps(report, indent=1))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
