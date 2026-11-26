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
  * Results archive (archive/): the first run of an ET day before noon
    snapshots the board the league pages publish that morning into
    archive/pending.json (which lives in the repo tree so it persists
    across CI checkouts); later runs grade pending entries against the
    merged logs once their game date has passed and render
    archive/<date>/ pages plus an archive index. Archive work never
    fails the data publish — errors land in the report instead.
  * Team props (data-teams.js): per-team game logs rebuilt from ESPN
    dated scoreboards (final scores, per-period linescores, NBA team
    statistics) plus — for NHL shots on goal only, which scoreboards
    do not carry — the per-game summary endpoint's boxscore. Props
    (team total, opponent total, win-by margin, first-half / first-
    period total, NBA team threes, NHL team shots) are built for
    every team, framed against its next fixture — the earliest
    pre-game game involving it, found by scanning dated scoreboards
    day by day up to 14 days ahead — at research
    lines from the team's L10 average (venue L10 when the team has
    >= 5 games at the upcoming venue in its last 10), with L5/L10/L20
    hit counts for both directions and the research layers the card
    shows (opponent defensive rank, rest, top-scorer injuries).

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
import unicodedata
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
        self.count_403 = 0
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
                if e.code == 403:
                    # ESPN 403s from datacenter IPs are usually burst
                    # throttling, not a hard block: in the 2026-11-20
                    # failures, most requests in the same run succeeded.
                    # Pause and retry like a 429 instead of failing the
                    # request (and possibly the whole league) instantly;
                    # a run-wide cap still aborts early on a hard block.
                    with self.lock:
                        self.count_403 += 1
                        n403 = self.count_403
                    if n403 > 60:
                        self.aborted = True
                        raise FetchError("aborted: repeated HTTP 403 from ESPN")
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
CONSENT_DEFAULT_SNIPPET = """<!-- Consent Mode v2 defaults - must stay before the Google tag:
     analytics and ad storage start denied; assets/consent.js applies
     the visitor's stored choice (or region decision) as an update. -->
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('consent', 'default', {
    'analytics_storage': 'denied',
    'ad_storage': 'denied',
    'ad_user_data': 'denied',
    'ad_personalization': 'denied',
    'wait_for_update': 500
  });
</script>
"""

CONSENT_SCRIPT_SNIPPET = '<script src="/assets/consent.js" defer></script>'

GA4_SNIPPET = CONSENT_DEFAULT_SNIPPET + """<!-- Google tag (gtag.js) -->
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
             '<a class="tab" href="/">Props</a>'
             '<a class="tab" href="/live/">Live</a>'
             '<a class="tab" href="/underdogs/">Risers</a>'
             '<a class="tab" href="/shuffle/">Shuffle</a>'
             '<a class="tab" href="/game-logs/">Game Logs</a>'
             '<a class="tab" href="/injuries/">Injuries</a></nav>')

PAGE_FOOTER = ('<footer><div class="site-footer"><span class="site-footer-brand">LEGLOCK</span>'
               '<nav class="site-footer-links" aria-label="Site information">'
               '<a href="/privacy/">Privacy Policy</a><a href="/about/">About</a>'
               '<a href="/guides/">Guides</a><a href="/guides/responsible-play/">Responsible Play</a>'
               '<a href="/contact/">Contact</a><a href="/our-picks/">Our Picks</a><a href="/donation/">Donate</a></nav></div>'
               '<p class="site-footer-note">Questions: '
               '<a href="mailto:support@leglock.online">support@leglock.online</a></p>'
               '<p class="site-footer-note">LegLock — sports statistics &amp; information only '
               '— not gambling advice. No bets are taken here.</p></footer>')

PAGE_STYLE = """<style>
main{max-width:1180px;margin:0 auto;padding:0 14px 40px}
.display{font-family:'LegLockSans',sans-serif;font-weight:700;letter-spacing:.01em}
.sub{color:var(--ink2)}
.content-body{font-size:14.5px;line-height:1.55}
.content-body h2{font-size:19px;margin:22px 0 6px}
.content-body a{color:var(--accent-ink);font-weight:600;text-decoration:none}
.content-body a:hover{text-decoration:underline}
.content-byline{color:var(--ink3);font-size:12.5px;margin:2px 0 10px}
.props-table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch;width:100%;border-collapse:separate;border-spacing:0;font-size:14px;margin:12px 0 6px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius)}
.props-table th,.props-table td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.props-table tr:last-child td{border-bottom:0}
.props-table th{font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3);background:var(--surface2);white-space:nowrap}
.props-table td.num,.props-table th.num{white-space:nowrap}
.streak-list{margin:8px 0;padding-left:20px}
.streak-list li{margin:5px 0}
.props-note{font-size:12.5px;color:var(--ink3)}
.site-footer{margin-top:34px;padding-top:16px;border-top:1px solid var(--line);text-align:center}
.site-footer-brand{font-family:'Moderniz','LegLockSans',sans-serif;color:var(--accent);letter-spacing:.03em;font-size:15px}
.site-footer-links{display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:center;margin-top:8px}
.site-footer-links a{color:var(--ink2);text-decoration:none;font-weight:600;font-size:13.5px}
.site-footer-note{font-size:12.5px;color:var(--ink3);margin:6px 0 0;text-align:center}
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
            m = re.search(r'class="site-logo">(?:<a[^>]*>)?<img src="(data:image/[^"]+)"', f.read())
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


def slate_games_nfl_week(league, today_et):
    """Parsed games for the current Thu–Mon NFL week (the board's NFL
    window). The baked games only cover today + tomorrow, so the week's
    scoreboards are pulled the same way build_league pulls them; on any
    failure the baked games are used instead."""
    start, end = nfl_week_window(today_et)
    cfg = LEAGUES["NFL"]
    base = f"{API}/site/v2/sports/{cfg['sport']}/{cfg['code']}"
    games = []
    try:
        d = start
        while d <= end:
            payload = FETCH.get_json(f"{base}/scoreboard?dates={d.strftime('%Y%m%d')}")
            games.extend(parse_scoreboard(payload))
            d += timedelta(days=1)
    except Exception:
        games = []
    if not games:
        games = list(league["games"])
    return games


def slate_teams_nfl_week(league, today_et):
    """Teams playing in the current Thu–Mon NFL week."""
    teams = set()
    for g in slate_games_nfl_week(league, today_et):
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
    """Jay's Under rules for the published top lists (2026-11-22, his
    U2 pick). Overs always pass. An Under 0.5 lists only when the
    player's L20 average is at least RARE_L20_MIN (0.3) — any stat, any
    league; this replaced the per-stat RARE_EVENT_KEYS list, which is
    kept above for reference. Any other Under lists only when the L20
    average reaches at least half the line, so an Under 1.5 on a
    0.7-a-game stat never lists."""
    if prop["dir"] != "Under":
        return True
    avg = l20_average(league, prop)
    if prop["line"] == 0.5:
        return avg >= RARE_L20_MIN - 1e-9
    return avg >= prop["line"] / 2.0 - 1e-9


def cap_unders(ranked, limit, max_unders, dir_of):
    """Take up to `limit` items from a ranked list with at most
    `max_unders` Unders (Jay's split, approved 2026-11-22): ranked by
    featured hit rate, the top lists structurally drown in Unders
    because the research line is built from the player's own average,
    so the composition is capped and the freed slots go to the best
    Overs. If Overs run out, skipped Unders backfill in rank order so
    the list still fills. Callers re-sort the result by their rank
    key so display order stays by merit."""
    picked, skipped, unders = [], [], 0
    for p in ranked:
        if len(picked) >= limit:
            break
        if dir_of(p) == "Under" and unders >= max_unders:
            skipped.append(p)
            continue
        picked.append(p)
        unders += (dir_of(p) == "Under")
    for p in skipped:
        if len(picked) >= limit:
            break
        picked.append(p)
    return picked


def select_page_props(lg, league, today_et):
    """The selection the static league pages publish: injured players
    excluded, the rare-event gate applied, and the slate-restricted
    top 25 ranked by featured-direction L10 (tie-break L20, then L5).
    Shared by build_league_page and the results-archive snapshot, so
    the archive grades exactly what the pages showed. `window` is
    "today" (NBA/NHL), "week" (NFL) or "fallback" when the league has
    no games in its window (the pages then list the top 25 overall as
    the next slate)."""
    injured = {i["name"] for i in league["injuries"]}
    props_all = [p for p in league["props"] if p["name"] not in injured]
    props = [p for p in props_all if passes_rare_gate(lg, league, p)]

    if lg == "NFL":
        teams = slate_teams_nfl_week(league, today_et)
    else:
        teams = slate_teams_today(league, today_et)

    def rank_key(p):
        return (-featured_pct(p, "L10"), -featured_pct(p, "L20"),
                -featured_pct(p, "L5"), p["name"])

    def top25(source):
        pool = [p for p in source if p["team"] in teams] if teams else []
        if pool:
            picked = cap_unders(sorted(pool, key=rank_key), 25, 13, lambda p: p["dir"])
            picked.sort(key=rank_key)
            return picked, ("week" if lg == "NFL" else "today")
        # No games in the window: the league's top 25 overall, honestly
        # labelled as the next slate rather than today's.
        picked = cap_unders(sorted(source, key=rank_key), 25, 13, lambda p: p["dir"])
        picked.sort(key=rank_key)
        return picked, "fallback"

    listed, window = top25(props)
    return {"listed": listed, "window": window, "props_all": props_all,
            "props": props, "top_all": top25(props_all)[0]}


def build_league_page(lg, league, stamp, today_et, logo_uri, slugs=None,
                      team_links=None):
    cfg = PAGE_LEAGUES[lg]
    slug = cfg["slug"]
    sel = select_page_props(lg, league, today_et)
    props_all, props = sel["props_all"], sel["props"]
    listed, window = sel["listed"], sel["window"]
    heading = "Top props — next slate" if window == "fallback" else \
        ("Top props this week" if lg == "NFL" else "Top props today")
    gated_top = sum(1 for p in sel["top_all"] if not passes_rare_gate(lg, league, p))

    # prop["streak"] is the true current streak: consecutive most-recent
    # games hitting in the featured direction (see build_prop).
    def streak_list(source):
        skey = lambda p: (-p["streak"], -featured_pct(p, "L10"), p["name"])
        picked = cap_unders(sorted((p for p in source if p["streak"] >= 5), key=skey),
                            10, 5, lambda p: p["dir"])
        picked.sort(key=skey)
        return picked

    streaks = streak_list(props)
    gated_streaks = sum(1 for p in streak_list(props_all)
                        if not passes_rare_gate(lg, league, p))

    def name_link(p):
        nm = html_escape(p["name"])
        if slugs and p["pid"] in slugs:
            return f'<a href="/{slug}/player/{slugs[p["pid"]]}/">{nm}</a>'
        return nm

    rows = []
    for p in listed:
        rows.append(
            '<tr><td>{}</td><td>{}</td><td>{}</td><td class="num">{} {}</td>'
            '<td class="num">{}</td><td class="num">{}</td><td class="num">{}</td></tr>'.format(
                name_link(p), html_escape(p["team"]), html_escape(p["stat"]),
                p["dir"], fmt_line(p["line"]),
                fmt_counts(p, "L5"), fmt_counts(p, "L10"), fmt_counts(p, "L20")))

    streak_html = ""
    if streaks:
        items = []
        for p in streaks:
            items.append(
                "<li><strong>{}</strong> ({}) — {}, {} {} — {}-game hit streak "
                "&middot; L10 {}</li>".format(
                    name_link(p), html_escape(p["team"]), html_escape(p["stat"]),
                    p["dir"], fmt_line(p["line"]), p["streak"], fmt_counts(p, "L10")))
        streak_html = ("<h2>On a streak</h2>\n"
                       "<p>Props whose featured side has cashed in at least five straight games:</p>\n"
                       '<ul class="streak-list">\n' + "\n".join(items) + "\n</ul>\n")

    team_html = ""
    if team_links:
        tlinks = ", ".join(
            '<a href="/{}/team/{}/">{}</a>'.format(slug, ts, html_escape(tn))
            for tn, ts in team_links)
        team_html = ("<h2>Team props by team</h2>\n"
                     "<p>Every {} team's props, hit rates and recent results: "
                     "{}.</p>\n".format(lg, tlinks))

    others = [o for o in ("NBA", "NHL", "NFL") if o != lg]
    more_links = " and ".join(
        '<a href="/{}/">{} player prop hit rates today</a>'.format(PAGE_LEAGUES[o]["slug"], o)
        for o in others)
    logo_html = ('<div class="brand"><a href="/" aria-label="LegLock home">'
                 '<img src="{}" alt="LegLock" /></a>'
                 '<div class="tagline">Player-prop research &middot; NBA &middot; NFL &middot; NHL</div></div>'.format(logo_uri)
                 if logo_uri else
                 '<div class="brand"><a href="/" aria-label="LegLock home">'
                 '<span class="site-footer-brand">LEGLOCK</span></a>'
                 '<div class="tagline">Player-prop research &middot; NBA &middot; NFL &middot; NHL</div></div>')

    page = f"""<!doctype html>
<html lang="en" data-theme="light">
<head>
{GA4_SNIPPET}

<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
{ADS_SNIPPET}
<meta name="apple-mobile-web-app-title" content="LEGLOCK" />
<meta name="color-scheme" content="light dark" />
<title>{cfg['title']}</title>
<meta name="description" content="{cfg['description']}" />
<link rel="canonical" href="{SITE_ORIGIN}/{slug}/" />
<link rel="stylesheet" href="/assets/site.css?v=17" />
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
<p class="props-note">Rates read as hits/games in each prop's featured direction — the side (Over or Under) with the higher L10 rate. Players on the injury report are left out, the same rule the board uses. Unders list only when the player's recent average is within reach of the line, and each top list shows at most half Unders.</p>
{streak_html}{team_html}<h2>More on LegLock</h2>
<p>See the {more_links}, or learn <a href="/guides/how-hit-rates-work/">how hit rates work</a> — what L5, L10 and L20 really measure, and how to read them without fooling yourself.</p>
</section>{PAGE_FOOTER}</main>
{CONSENT_SCRIPT_SNIPPET}
</body>
</html>
"""
    info = {"propsListed": len(listed), "streaks": len(streaks), "window": window,
            "gatedOutTop": gated_top, "gatedOutStreaks": gated_streaks,
            "gatedProps": len(props_all) - len(props)}
    return page, info


# ---------------------------------------------------------------------------
# Player pages + Daily Highlights. One static page per pooled player under
# /<league>/player/<slug>/ — inside the league folders so the refresh
# workflow's commit step (which adds the league directories) publishes
# them with no workflow change — plus a Daily Highlights page under
# /archive/highlights/ (the archive directory is in the same commit
# step), built from the same selections the league pages publish.
# Rendered from the same in-memory dataset as everything else.
# ---------------------------------------------------------------------------

def player_slug(name, pid, taken):
    base = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    base = re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-") or f"player-{pid}"
    slug = base
    if slug in taken and taken[slug] != pid:
        slug = f"{base}-{pid}"
    taken[slug] = pid
    return slug


def player_slugs(league):
    """{pid: slug} for a league, assigned in sorted-pid order so the
    mapping is stable across runs."""
    taken, out = {}, {}
    for pid in sorted(league["players"]):
        out[pid] = player_slug(league["players"][pid]["name"], pid, taken)
    return out


def _prop_series(league, prop):
    """The prop stat's values from the player's current-season log rows,
    most recent first — the same series build_prop rates. The NBA combo
    stat is summed from its components."""
    rows = league["logs"].get(prop["pid"]) or []
    vals = []
    for r in rows:
        s = r["s"]
        if prop["key"] == "combo":
            if all(k in s for k in ("points", "totalRebounds", "assists")):
                vals.append(s["points"] + s["totalRebounds"] + s["assists"])
        elif prop["key"] in s:
            vals.append(s[prop["key"]])
    return vals


def _season_counts(league, prop):
    vals = _prop_series(league, prop)
    if not vals:
        return (0, 0)
    if prop["dir"] == "Over":
        hits = sum(1 for v in vals if v > prop["line"])
    else:
        hits = sum(1 for v in vals if v < prop["line"])
    return (hits, len(vals))


def _fmt_num(v):
    if isinstance(v, float) and v == int(v):
        return str(int(v))
    return str(v)


def _fmt_short_date(iso):
    try:
        dt = datetime.strptime(iso, "%Y-%m-%d")
    except (ValueError, TypeError):
        return iso or ""
    return f"{dt.strftime('%b')} {dt.day}"


PLAYER_PAGE_JS = """
<script>
(function(){
  var cur = "";
  function apply(){
    document.querySelectorAll("[data-statpick]").forEach(function(b){
      b.classList.toggle("on", (b.getAttribute("data-statpick") || "") === cur);
    });
    document.querySelectorAll("[data-prow]").forEach(function(r){
      r.classList.toggle("dim", !!cur && r.getAttribute("data-prow") !== cur);
    });
    document.querySelectorAll("[data-col]").forEach(function(c){
      var k = c.getAttribute("data-col");
      var hit = !!cur && (k === cur || (cur === "combo" && (k === "points" || k === "totalRebounds" || k === "assists")));
      c.classList.toggle("hl", hit);
    });
  }
  document.addEventListener("click", function(e){
    if (!e.target || !e.target.closest) return;
    var b = e.target.closest("[data-statpick]");
    if (b){
      var k = b.getAttribute("data-statpick") || "";
      cur = (k === cur) ? "" : k;
      apply();
      return;
    }
    var th = e.target.closest("th[data-col]");
    if (th){
      var k2 = th.getAttribute("data-col");
      if (document.querySelector('[data-statpick="' + k2 + '"]')){
        cur = (cur === k2) ? "" : k2;
        apply();
      }
    }
  });
  apply();
})();
</script>
"""

def build_player_page(lg, league, pid, stamp, logo_uri, slugs):
    cfg = PAGE_LEAGUES[lg]
    lslug = cfg["slug"]
    player = league["players"][pid]
    name = player["name"]
    pslug = slugs[pid]
    props = [p for p in league["props"] if p["pid"] == pid]
    rows_log = league["logs"].get(pid) or []
    inj = next((i for i in league["injuries"] if i["name"] == name), None)
    team_full = player.get("teamName") or player["team"]

    stat_names = ", ".join(p["stat"] for p in props[:3]) or "every tracked stat"
    title = f"{name} Prop Hit Rates & Game Log — {lg} | LegLock"
    description = (f"{name} ({team_full}) player prop hit rates: L5, L10, L20 and season "
                   f"rates for {stat_names} at research lines set from recent game logs, "
                   f"plus the full {lg} game log on LegLock.")

    parts = [f'<p class="content-byline">Updated {stamp}</p>']
    img = player.get("img")
    if img:
        parts.append(f'<p><img src="{html_escape(img)}" alt="{html_escape(name)}" '
                     'width="84" height="84" loading="lazy" style="border-radius:12px" /></p>')
    intro = (f"{html_escape(name)} — {html_escape(player.get('pos') or '')}, "
             f"{html_escape(team_full)} ({html_escape(player['team'])})")
    if player.get("jersey"):
        intro += f" &middot; #{html_escape(player['jersey'])}"
    parts.append(f"<p>{intro}.</p>")
    if inj:
        parts.append(f"<p><strong>On the injury report:</strong> "
                     f"{html_escape(inj.get('status') or 'Listed')}"
                     + (f" ({html_escape(inj['date'])})" if inj.get("date") else "")
                     + ". Props for injured players are held off the board until they return.</p>")
    parts.append("<p>Every rate below is counted from actual game logs, and every line is a "
                 "research line set from the player's own recent average — not a sportsbook price.</p>")

    if props:
        rows = []
        for p in props:
            sh, sn = _season_counts(league, p)
            rows.append(
                '<tr data-prow="{}"><td><button type="button" class="statpick" '
                'data-statpick="{}">{}</button></td><td class="num">{} {}</td><td class="num">{}</td>'
                '<td class="num">{}</td><td class="num">{}</td><td class="num">{}/{}</td>'
                '<td class="num">{}</td></tr>'.format(
                    html_escape(p["key"]), html_escape(p["key"]), html_escape(p["stat"]),
                    p["dir"], fmt_line(p["line"]),
                    fmt_counts(p, "L5"), fmt_counts(p, "L10"), fmt_counts(p, "L20"),
                    sh, sn, _fmt_num(p["l10avg"])))
        seen_stats = []
        for p in props:
            if p["key"] not in [k for k, _ in seen_stats]:
                seen_stats.append((p["key"], p["stat"]))
        chips = "".join(
            f'<button type="button" class="statchip" data-statpick="{html_escape(k)}">'
            f'{html_escape(lab)}</button>'
            for k, lab in seen_stats)
        parts.append(
            "<h2>Prop hit rates</h2>\n"
            '<div class="statchips" role="group" aria-label="Highlight a stat">'
            '<button type="button" class="statchip on" data-statpick="">All stats</button>'
            + chips + "</div>\n"
            '<p class="stathint">Tap a stat to highlight it in both tables — '
            "tap again to clear.</p>\n"
            '<table class="props-table">\n'
            "<thead><tr><th>Stat</th><th>Line</th><th>L5</th><th>L10</th><th>L20</th>"
            "<th>Season</th><th>L10 avg</th></tr></thead>\n<tbody>\n"
            + "\n".join(rows) + "\n</tbody>\n</table>\n"
            '<p class="props-note">Rates read as hits/games in each prop\'s featured '
            "direction — the side (Over or Under) with the higher L10 rate. Season counts "
            "every current-season game in the log.</p>")
        hot = [p for p in props if p["streak"] >= 5]
        if hot:
            items = "\n".join(
                "<li><strong>{}</strong> {} {} — {}-game hit streak &middot; L10 {}</li>".format(
                    html_escape(p["stat"]), p["dir"], fmt_line(p["line"]), p["streak"],
                    fmt_counts(p, "L10"))
                for p in hot)
            parts.append(f'<h2>On a streak</h2>\n<ul class="streak-list">\n{items}\n</ul>')

    if rows_log:
        defs = list(league["statDefs"])
        has_min = any("minutes" in r["s"] for r in rows_log)
        cols = ([{"k": "minutes", "label": "Min"}] if has_min else []) + defs
        head = "".join(f'<th data-col="{d["k"]}">{html_escape(d["label"])}</th>' for d in cols)
        body_rows = []
        for r in rows_log:
            cells = "".join(
                f'<td class="num" data-col="{d["k"]}">{_fmt_num(r["s"][d["k"]]) if d["k"] in r["s"] else "&mdash;"}</td>'
                for d in cols)
            body_rows.append(
                f'<tr><td>{_fmt_short_date(r["d"])}</td><td>{html_escape(r["opp"])}</td>'
                f'<td>{html_escape(r["res"])}</td>{cells}</tr>')
        parts.append(
            "<h2>Game log — this season</h2>\n"
            '<table class="props-table">\n'
            f"<thead><tr><th>Date</th><th>Opp</th><th>Result</th>{head}</tr></thead>\n<tbody>\n"
            + "\n".join(body_rows) + "\n</tbody>\n</table>")

    parts.append(
        "<h2>More on LegLock</h2>\n"
        f'<p>Back to <a href="/{lslug}/">{lg} player prop hit rates today</a>, the full '
        '<a href="/">interactive prop board</a>, or learn '
        '<a href="/guides/how-hit-rates-work/">how hit rates work</a>.</p>')
    crumbs = {"@context": "https://schema.org", "@type": "BreadcrumbList",
              "itemListElement": [
                  {"@type": "ListItem", "position": 1, "name": "LegLock",
                   "item": SITE_ORIGIN + "/"},
                  {"@type": "ListItem", "position": 2, "name": f"{lg} Prop Hit Rates",
                   "item": f"{SITE_ORIGIN}/{lslug}/"},
                  {"@type": "ListItem", "position": 3, "name": name,
                   "item": f"{SITE_ORIGIN}/{lslug}/player/{pslug}/"}]}
    parts.append(f'<script type="application/ld+json">{json.dumps(crumbs)}</script>')
    parts.append(PLAYER_PAGE_JS)
    return archive_page_shell(
        title, description, f"/{lslug}/player/{pslug}/", name,
        f"{team_full} &middot; {lg} prop hit rates and game log",
        "\n".join(parts), logo_uri)


def build_highlights_page(league_objs, stamp, today_et, logo_uri, graded_ctx, slugs_by_league):
    parts = [
        f'<p class="content-byline">Updated {stamp}</p>',
        "<p>The board at a glance: yesterday's published top props graded, today's highest "
        "hit-rate props, and the longest active hit streaks across the NBA, NFL and NHL. "
        "Every line is a research line set from the player's own recent average — not a "
        "sportsbook price.</p>",
    ]
    if graded_ctx:
        parts.append(
            "<h2>Yesterday's board, graded</h2>\n"
            f"<p>The top props published on {fmt_date_long(graded_ctx['date'])} finished "
            f"<strong>{_record_text(graded_ctx['hits'], graded_ctx['misses'], graded_ctx['dnp'])}</strong>. "
            f'Full grading: <a href="/archive/{graded_ctx["date"]}/">results for '
            f'{fmt_date_long(graded_ctx["date"])}</a> &middot; '
            '<a href="/archive/">results archive</a>.</p>')
    all_streaks = []
    for lg in ("NBA", "NFL", "NHL"):
        league = league_objs[lg]
        sel = select_page_props(lg, league, today_et)
        slugs = slugs_by_league[lg]
        lslug = PAGE_LEAGUES[lg]["slug"]
        top = cap_unders(sel["listed"], 5, 3, lambda p: p["dir"])
        top.sort(key=lambda p: (-featured_pct(p, "L10"), -featured_pct(p, "L20"),
                                -featured_pct(p, "L5"), p["name"]))
        if top:
            items = []
            for p in top:
                items.append(
                    '<li><strong><a href="/{}/player/{}/">{}</a></strong> ({}) — {}, {} {} '
                    "&middot; L10 {} &middot; L20 {}</li>".format(
                        lslug, slugs[p["pid"]], html_escape(p["name"]),
                        html_escape(p["team"]), html_escape(p["stat"]), p["dir"],
                        fmt_line(p["line"]), fmt_counts(p, "L10"), fmt_counts(p, "L20")))
            heading = "Top props this week" if lg == "NFL" else "Top props today"
            parts.append(f"<h2>{lg} — {heading}</h2>\n"
                         '<ul class="streak-list">\n' + "\n".join(items) + "\n</ul>")
        all_streaks.extend((lg, p) for p in sel["props"] if p["streak"] >= 5)
    all_streaks.sort(key=lambda t: (-t[1]["streak"], -featured_pct(t[1], "L10"), t[1]["name"]))
    all_streaks = cap_unders(all_streaks, 10, 5, lambda t: t[1]["dir"])
    all_streaks.sort(key=lambda t: (-t[1]["streak"], -featured_pct(t[1], "L10"), t[1]["name"]))
    if all_streaks:
        items = []
        for lg, p in all_streaks:
            lslug = PAGE_LEAGUES[lg]["slug"]
            items.append(
                '<li><strong><a href="/{}/player/{}/">{}</a></strong> ({}, {}) — {}, {} {} '
                "— {}-game hit streak &middot; L10 {}</li>".format(
                    lslug, slugs_by_league[lg][p["pid"]], html_escape(p["name"]),
                    html_escape(p["team"]), lg, html_escape(p["stat"]), p["dir"],
                    fmt_line(p["line"]), p["streak"], fmt_counts(p, "L10")))
        parts.append("<h2>Longest active streaks</h2>\n"
                     '<ul class="streak-list">\n' + "\n".join(items) + "\n</ul>")
    parts.append(
        "<h2>More on LegLock</h2>\n"
        '<p>Open the full <a href="/">interactive prop board</a>, check the '
        '<a href="/live/">live page</a>, or browse the '
        '<a href="/archive/">results archive</a>.</p>')
    return archive_page_shell(
        "Daily Highlights — LegLock",
        "LegLock daily highlights: yesterday's top props graded, today's highest player "
        "prop hit rates and the longest active hit streaks across the NBA, NFL and NHL.",
        "/archive/highlights/", "Daily Highlights",
        "Top props, streaks and yesterday's grade", "\n".join(parts), logo_uri)


SITEMAP_FALLBACK_URLS = [
    "https://leglock.online/",
    "https://leglock.online/live/",
    "https://leglock.online/underdogs/",
    "https://leglock.online/shuffle/",
    "https://leglock.online/game-logs/",
    "https://leglock.online/injuries/",
    "https://leglock.online/cheatsheet/",
    "https://leglock.online/donation/",
    "https://leglock.online/our-picks/",
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


def build_sitemap(run_date, archive_lastmod=None, player_urls=None,
                  team_urls=None):
    """The sitemap rewritten: the URLs already listed (read from the
    current file when available, else the known 16) plus the three
    league pages and the results archive index. lastmod is refreshed
    to the run date for the homepage and the league pages; the archive
    entry's lastmod is the newest graded archive date (or the run date
    when nothing has graded yet); every other entry carries over
    unchanged."""
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
    picks_url = f"{SITE_ORIGIN}/our-picks/"
    if picks_url not in by_url:
        entries.append([picks_url, run_date])
    archive_url = f"{SITE_ORIGIN}/archive/"
    archive_mod = archive_lastmod or run_date
    if archive_url in by_url:
        by_url[archive_url][1] = archive_mod
    else:
        entries.append([archive_url, archive_mod])
    hl_url = f"{SITE_ORIGIN}/archive/highlights/"
    if hl_url in by_url:
        by_url[hl_url][1] = run_date
    else:
        entries.append([hl_url, run_date])
    if player_urls is not None:
        keep = set(player_urls)
        entries = [e for e in entries if "/player/" not in e[0] or e[0] in keep]
        by_url = {e[0]: e for e in entries}
        for url in player_urls:
            if url in by_url:
                by_url[url][1] = run_date
            else:
                entry = [url, run_date]
                entries.append(entry)
                by_url[url] = entry
    if team_urls is not None:
        keep = set(team_urls)
        entries = [e for e in entries if "/team/" not in e[0] or e[0] in keep]
        by_url = {e[0]: e for e in entries}
        for url in team_urls:
            if url in by_url:
                by_url[url][1] = run_date
            else:
                entry = [url, run_date]
                entries.append(entry)
                by_url[url] = entry
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for url, lastmod in entries:
        lines.append(f"  <url><loc>{url}</loc><lastmod>{lastmod}</lastmod></url>")
    lines.append("</urlset>")
    return "\n".join(lines) + "\n"




def _team_featured(prop):
    """(dir, {window: (hits, n)}) — the featured direction exactly as
    the app computes it: the side with more L10 hits (Over wins ties),
    with each window's hits counted in that direction."""
    counts = prop.get("counts") or {}
    c10 = counts.get("L10") or {"o": 0, "u": 0, "n": 0}
    fdir = "Over" if c10.get("o", 0) >= c10.get("u", 0) else "Under"
    out = {}
    for w in ("L5", "L10", "L20"):
        c = counts.get(w) or {"o": 0, "u": 0, "n": 0}
        out[w] = (c.get("o", 0) if fdir == "Over" else c.get("u", 0), c.get("n", 0))
    return fdir, out


TEAM_LADDER_STEP = {"total": 3.0, "oppTotal": 3.0, "winBy": 2.5,
                    "firstHalf": 2.5, "firstPeriod": 0.5,
                    "teamThrees": 1.5, "teamShots": 2.5}


def _t_series(prop, rows):
    """The prop's stat value in each logged game, newest first,
    skipping games where the stat is missing."""
    vals = []
    for r in rows or []:
        v = team_stat_value(prop.get("stat"), r)
        if v is not None:
            vals.append(v)
    return vals


def _t_oc(vals, line, n=None):
    seg = vals if n is None else vals[:n]
    o = sum(1 for v in seg if v > line)
    u = sum(1 for v in seg if v < line)
    return o, u, len(seg)


def _t_median(vals):
    if not vals:
        return None
    sv = sorted(vals)
    m = len(sv) // 2
    return sv[m] if len(sv) % 2 else (sv[m - 1] + sv[m]) / 2.0


def _t_std(vals):
    if len(vals) < 2:
        return None
    mu = sum(vals) / len(vals)
    return (sum((v - mu) ** 2 for v in vals) / len(vals)) ** 0.5


def _t_streak(vals, line, fdir):
    n = 0
    for v in vals:
        if (v > line) if fdir == "Over" else (v < line):
            n += 1
        else:
            break
    return n


def _t_form_chips(rows, n=5):
    chips = []
    for r in (rows or [])[:n]:
        res = "W" if r["margin"] > 0 else ("L" if r["margin"] < 0 else "T")
        cls = "tw" if res == "W" else ("tl" if res == "L" else "")
        chips.append(
            f'<span class="tchip {cls}">{res} {r["pf"]}&ndash;{r["pa"]} '
            f'{"vs" if r["home"] else "@"} {html_escape(r["opp"])}</span>')
    return "".join(chips)


def _t_strip(vals, line, fdir, n=15):
    """Last-n values as bars, oldest to newest, coloured by whether
    each game hit the featured direction, with the line marked."""
    seg = list(reversed(vals[:n]))
    if not seg:
        return ""
    mx = max(max(seg), line)
    mn = min(min(seg), line)
    span = (mx - mn) or 1

    def hgt(v):
        return 16 + int(64 * (v - mn) / span)

    bars = []
    for v in seg:
        hit = v > line if fdir == "Over" else v < line
        diff = v - line
        bars.append(
            f'<i class="{"hit" if hit else "miss"}" style="height:{hgt(v)}%" '
            f'title="{fmt_line(v)} ({diff:+.1f} vs the line)"></i>')
    return (f'<div class="tstrip"><span class="tline" style="bottom:{hgt(line)}%">'
            f'line {fmt_line(line)}</span>' + "".join(bars) + "</div>")


TEAM_PAGE_JS = """
<script>
(function(){
  var D = null;
  try { D = JSON.parse(document.getElementById("tdata").textContent); } catch (e) {}
  if (!D) return;
  var W = {"L5": 5, "L10": 10, "L20": 20, "S": 0};
  var win = "L10";
  function rate(p, w){
    var n = W[w], seg = n ? p.vals.slice(0, n) : p.vals.slice();
    if (!seg.length) return null;
    var h = 0;
    for (var i = 0; i < seg.length; i++){
      if (p.dir === "Over" ? seg[i] > p.line : seg[i] < p.line) h++;
    }
    return {h: h, n: seg.length, r: Math.round(100 * h / seg.length)};
  }
  function paint(){
    D.props.forEach(function(p, i){
      var card = document.querySelector('.tprop[data-i="' + i + '"]');
      if (!card) return;
      var rt = rate(p, win);
      var b = card.querySelector(".trate"), s = card.querySelector(".thits");
      if (rt){ b.textContent = rt.r + "%"; s.textContent = rt.h + "/" + rt.n + " \\u00b7 " + (win === "S" ? "Season" : win); }
      card.setAttribute("data-rate", rt ? rt.r : -1);
    });
  }
  var tog = document.querySelectorAll(".twtog button");
  for (var i = 0; i < tog.length; i++){
    tog[i].addEventListener("click", function(){
      win = this.getAttribute("data-w");
      for (var j = 0; j < tog.length; j++) tog[j].classList.toggle("on", tog[j] === this);
      paint();
    });
  }
  var sel = document.getElementById("tsort");
  if (sel) sel.addEventListener("change", function(){
    var wrap = document.getElementById("tprops");
    var cards = Array.prototype.slice.call(wrap.querySelectorAll(".tprop"));
    var key = sel.value;
    cards.sort(function(a, b){
      if (key === "streak") return (+b.getAttribute("data-streak") || 0) - (+a.getAttribute("data-streak") || 0);
      if (key === "name") return a.getAttribute("data-name").localeCompare(b.getAttribute("data-name"));
      return (+b.getAttribute("data-rate") || 0) - (+a.getAttribute("data-rate") || 0);
    });
    cards.forEach(function(c){ wrap.appendChild(c); });
  });
  var COLMAP = {"total": "score", "oppTotal": "score", "winBy": "score", "firstHalf": "fh",
                "firstPeriod": "p1", "teamThrees": "threes", "teamShots": "shots"};
  var REVMAP = {"score": ["total", "oppTotal", "winBy"], "fh": ["firstHalf"],
                "p1": ["firstPeriod"], "threes": ["teamThrees"], "shots": ["teamShots"]};
  var curStat = "";
  function applyStat(){
    document.querySelectorAll("[data-statpick]").forEach(function(b){
      b.classList.toggle("on", (b.getAttribute("data-statpick") || "") === curStat);
    });
    document.querySelectorAll(".tprop").forEach(function(c){
      c.classList.toggle("dim", !!curStat && c.getAttribute("data-stat") !== curStat);
    });
    var col = curStat ? COLMAP[curStat] : null;
    document.querySelectorAll("[data-col]").forEach(function(c){
      c.classList.toggle("hl", !!col && c.getAttribute("data-col") === col);
    });
    if (curStat){
      var card = document.querySelector('.tprop[data-stat="' + curStat + '"]');
      if (card && !card.classList.contains("open")){
        var body = card.querySelector(".tprop-body"), head = card.querySelector(".tprop-head");
        card.classList.add("open");
        if (body) body.hidden = false;
        if (head) head.setAttribute("aria-expanded", "true");
      }
    }
  }
  document.addEventListener("click", function(e){
    if (!e.target || !e.target.closest) return;
    var b = e.target.closest("[data-statpick]");
    if (b){
      var k = b.getAttribute("data-statpick") || "";
      curStat = (k === curStat) ? "" : k;
      applyStat();
      return;
    }
    var th = e.target.closest("th[data-col]");
    if (th){
      var cands = REVMAP[th.getAttribute("data-col")] || [];
      for (var i = 0; i < cands.length; i++){
        if (document.querySelector('[data-statpick="' + cands[i] + '"]')){
          curStat = (curStat === cands[i]) ? "" : cands[i];
          applyStat();
          return;
        }
      }
    }
  });
  document.querySelectorAll(".tprop-head").forEach(function(h){
    h.addEventListener("click", function(){
      var card = h.parentNode, body = card.querySelector(".tprop-body");
      var open = card.classList.toggle("open");
      body.hidden = !open;
      h.setAttribute("aria-expanded", open ? "true" : "false");
    });
  });
  paint();
})();
</script>
"""


def _t_prop_card(p, rows, idx, opp_abbr, opp_name):
    fdir, _fc = _team_featured(p)
    line = p["line"]
    vals = _t_series(p, rows)
    o10, u10, n10 = _t_oc(vals, line, 10)
    hits10 = o10 if fdir == "Over" else u10
    rate10 = round(100 * hits10 / n10) if n10 else 0
    streak = _t_streak(vals, line, fdir)
    med = _t_median(vals[:20])
    std = _t_std(vals[:20])
    avg = p.get("avg")
    margin = (avg - line) if avg is not None else None
    os_, us_, ns_ = _t_oc(vals, line)
    season_hits = os_ if fdir == "Over" else us_
    season_rate = round(100 * season_hits / ns_) if ns_ else None

    def _split(seg):
        if not seg:
            return "&mdash;"
        o, u, n = _t_oc(seg, line)
        h = o if fdir == "Over" else u
        return (f"avg {_fmt_num(sum(seg) / len(seg))} &middot; {h}/{n} "
                f"{fdir.lower()}")

    hv = [v for v in (team_stat_value(p["stat"], r) for r in rows if r.get("home"))
          if v is not None]
    av = [v for v in (team_stat_value(p["stat"], r) for r in rows if not r.get("home"))
          if v is not None]
    h2h = [v for v in (team_stat_value(p["stat"], r) for r in rows
                       if r.get("opp") == opp_abbr) if v is not None]

    step = TEAM_LADDER_STEP.get(p.get("stat"), 2.5)
    lad = []
    for k in (-2, -1, 1, 2):
        ll = line + k * step
        o, u, n = _t_oc(vals, ll, 20)
        if n:
            h = o if fdir == "Over" else u
            lad.append(f'{fdir} {fmt_line(ll)}: <b>{round(100 * h / n)}%</b> ({h}/{n})')

    bits = []
    v = p.get("venue") or {}
    if v.get("n"):
        vh = v.get("o", 0) if fdir == "Over" else v.get("u", 0)
        bits.append(f"{'Home' if p.get('home') else 'Away'} L10: {vh}/{v['n']} "
                    f"{fdir.lower()}")
    if p.get("lineBasis") == "venue" and p.get("venueAvg") is not None:
        bits.append(f"venue average {_fmt_num(p['venueAvg'])}")
    if p.get("oppDefRank") is not None:
        bits.append(f"opponent defence #{p['oppDefRank']} "
                    f"({_fmt_num(p.get('oppDefAvg'))} allowed L10)")
    if p.get("b2b"):
        bits.append("on a back-to-back")
    elif p.get("shortWeek"):
        bits.append(f"short week &middot; {p.get('restDays')} days rest")
    elif p.get("restDays") is not None:
        bits.append(f"{p.get('restDays')} days rest")
    if p.get("injuryNote"):
        bits.append(html_escape(p["injuryNote"]))

    stats = [f"Median (L20) <b>{_fmt_num(med)}</b>",
             f"L10 average <b>{_fmt_num(avg)}</b>"]
    if margin is not None:
        stats.append(f"Avg margin vs line <b>{margin:+.1f}</b>")
    if std is not None:
        stats.append(f"Consistency (std dev) <b>{_fmt_num(std)}</b>")
    if season_rate is not None:
        stats.append(f"Season rate <b>{season_rate}%</b> ({season_hits}/{ns_})")

    detail = ['<div class="tstats">' + " &middot; ".join(stats) + "</div>"]
    strip = _t_strip(vals, line, fdir)
    if strip:
        detail.append(strip)
        detail.append('<p class="tstrip-lab">Last 15 games, oldest to newest &middot; '
                      'green hit the featured side of the line.</p>')
    detail.append(
        '<div class="tsplits"><div><span>Home</span>' + _split(hv) + '</div>'
        '<div><span>Away</span>' + _split(av) + '</div>'
        '<div><span>vs ' + html_escape(opp_name or opp_abbr or "opp") + '</span>'
        + ("games: " + ", ".join(fmt_line(x) for x in h2h) if h2h
           else "no meetings yet this season") + '</div></div>')
    if lad:
        detail.append('<div class="tlad"><span>Alt lines (L20)</span>'
                      + " &middot; ".join(lad) + "</div>")
    if bits:
        detail.append('<div class="tnotes">' + " &middot; ".join(bits) + "</div>")

    streak_html = (f'<span class="tstreak">{streak} straight {fdir.lower()}s</span>'
                   if streak >= 3 else "")
    return (
        f'<div class="tprop" data-i="{idx}" data-rate="{rate10}" data-stat="{html_escape(p["stat"])}" '
        f'data-streak="{streak}" data-name="{html_escape(p["statLabel"])}">'
        f'<button type="button" class="tprop-head" aria-expanded="false">'
        f'<span class="tprop-stat">{html_escape(p["statLabel"])}</span>'
        f'<span class="dir {"over" if fdir == "Over" else "under"}">{fdir} {fmt_line(line)}</span>'
        f'<span class="tprop-rate"><b class="trate">{rate10}%</b> '
        f'<small class="thits">{hits10}/{n10} &middot; L10</small></span>'
        + streak_html +
        '<span class="gf-chev" aria-hidden="true"></span></button>'
        f'<div class="tprop-body" hidden>' + "".join(detail) + "</div></div>")


def build_team_page(lg, team_props, abbr, rows_entry, stamp, logo_uri, tslug,
                    opp_entry=None):
    cfg = PAGE_LEAGUES[lg]
    lslug = cfg["slug"]
    first = team_props[0]
    team_name = first["teamName"]
    rows = (rows_entry or {}).get("rows") or []
    opp_abbr = first.get("opp")
    opp_name = first.get("oppName") or opp_abbr or ""
    stat_names = ", ".join(p["statLabel"] for p in team_props)
    title = f"{team_name} Team Props & Hit Rates — {lg} | LegLock"
    description = (f"{team_name} team prop hit rates: L5, L10 and L20 rates for "
                   f"{stat_names} at research lines set from recent team game logs, "
                   f"plus recent results and the next matchup on LegLock.")

    parts = [f'<p class="content-byline">Updated {stamp}</p>']
    intro = (f"{html_escape(team_name)} ({html_escape(abbr)}) — next game: "
             f"{'vs' if first.get('home') else 'at'} {html_escape(opp_name)} "
             f"&middot; {fmt_date_long(first.get('gameDate') or '')}")
    if first.get("b2b"):
        intro += " &middot; on a back-to-back"
    elif first.get("shortWeek"):
        intro += f" &middot; short week ({first.get('restDays')} days rest)"
    elif first.get("restDays") is not None:
        intro += f" &middot; {first.get('restDays')} days rest"
    parts.append(f"<p>{intro}.</p>")
    if rows:
        parts.append('<div class="tform"><span>Recent form</span>'
                     + _t_form_chips(rows, 5) + "</div>")
    parts.append("<p>Every rate below is counted from actual team game logs, and every line "
                 "is a research line set from the team's own recent average — not a "
                 "sportsbook price. Tap any prop for its game-by-game strip, splits "
                 "and alternate lines.</p>")

    cards = []
    payload = []
    for i, p in enumerate(team_props):
        cards.append(_t_prop_card(p, rows, i, opp_abbr, opp_name))
        fdir, _ = _team_featured(p)
        payload.append({"stat": p["statLabel"], "line": p["line"], "dir": fdir,
                        "vals": _t_series(p, rows)[:30]})
    tchips = "".join(
        f'<button type="button" class="statchip" data-statpick="{html_escape(p["stat"])}">'
        f'{html_escape(p["statLabel"])}</button>'
        for p in team_props)
    parts.append(
        "<h2>Team prop hit rates</h2>\n"
        '<div class="statchips" role="group" aria-label="Highlight a stat">'
        '<button type="button" class="statchip on" data-statpick="">All stats</button>'
        + tchips + "</div>\n"
        '<p class="stathint">Tap a stat to open its card and highlight it in the '
        "recent results — tap again to clear.</p>\n"
        '<div class="tcontrols"><div class="twtog" role="group" aria-label="Games window">'
        '<button type="button" data-w="L5">L5</button>'
        '<button type="button" data-w="L10" class="on">L10</button>'
        '<button type="button" data-w="L20">L20</button>'
        '<button type="button" data-w="S">Season</button></div>'
        '<label class="tsortlab">Sort <select id="tsort">'
        '<option value="rate">Hit rate</option>'
        '<option value="streak">Streak</option>'
        '<option value="name">Stat name</option></select></label></div>\n'
        '<div id="tprops">\n' + "\n".join(cards) + "\n</div>\n"
        '<p class="props-note">Rates are counted in each prop\'s featured '
        "direction — the side (Over or Under) with the higher L10 rate.</p>")

    orows = (opp_entry or {}).get("rows") or []
    if orows and opp_name:
        l10 = orows[:10]
        scored = sum(r["pf"] for r in l10) / len(l10)
        allowed = sum(r["pa"] for r in l10) / len(l10)
        parts.append(
            f"<h2>Opponent snapshot — {html_escape(opp_name)}</h2>\n"
            '<div class="tform"><span>Recent form</span>'
            + _t_form_chips(orows, 5) + "</div>"
            f"<p>Over their last 10, {html_escape(opp_name)} score "
            f"<b>{_fmt_num(scored)}</b> and allow <b>{_fmt_num(allowed)}</b> "
            "per game.</p>")

    rows_log = rows
    if rows_log:
        extras = {"NBA": (("1H", "fh", "num"), ("3PM", "threes", "num"), ("Reb", "reb", "num"),
                          ("Ast", "ast", "num"), ("FG%", "fgp", "pct"), ("3P%", "tpp", "pct")),
                  "NFL": (("1H", "fh", "num"), ("Tot Yds", "tyds", "num"), ("Pass Yds", "pyds", "num"),
                          ("Rush Yds", "ryds", "num"), ("TO", "tov", "num")),
                  "NHL": (("P1", "p1", "num"), ("P2", "p2", "num"), ("P3", "p3", "num"),
                          ("Shots", "shots", "num"), ("Saves", "saves", "num"), ("Save %", "svp", "frac"))}[lg]
        head = "".join(f'<th data-col="{k}">{lab}</th>' for lab, k, _ in extras)

        def _cell(r, k, kind):
            v = r.get(k)
            if v is None:
                return f'<td class="num" data-col="{k}">&mdash;</td>'
            if kind == "pct":
                txt = f"{v * 100:.1f}%" if v <= 1.5 else f"{_fmt_num(v)}%"
            elif kind == "frac":
                txt = f"{v:.3f}".lstrip("0") if 0 < v < 1 else _fmt_num(v)
            else:
                txt = _fmt_num(v)
            return f'<td class="num" data-col="{k}">{txt}</td>'

        body_rows = []
        for r in rows_log:
            cells = "".join(_cell(r, k, kind) for _, k, kind in extras)
            result = "W" if r["margin"] > 0 else ("L" if r["margin"] < 0 else "T")
            body_rows.append(
                f'<tr><td>{_fmt_short_date(r["d"])}</td>'
                f'<td>{"vs" if r["home"] else "@"} {html_escape(r["opp"])}</td>'
                f'<td class="num" data-col="score">{r["pf"]}&ndash;{r["pa"]}</td><td>{result}</td>{cells}</tr>')
        parts.append(
            "<h2>Recent results</h2>\n"
            '<table class="props-table">\n'
            f"<thead><tr><th>Date</th><th>Opp</th><th data-col=\"score\">Score</th><th>Result</th>{head}</tr></thead>\n<tbody>\n"
            + "\n".join(body_rows) + "\n</tbody>\n</table>")

    parts.append(
        "<h2>More on LegLock</h2>\n"
        f'<p>Back to <a href="/{lslug}/">{lg} player prop hit rates today</a>, the full '
        '<a href="/">interactive prop board</a> (team props included), or learn '
        '<a href="/guides/how-hit-rates-work/">how hit rates work</a>.</p>')
    crumbs = {"@context": "https://schema.org", "@type": "BreadcrumbList",
              "itemListElement": [
                  {"@type": "ListItem", "position": 1, "name": "LegLock",
                   "item": SITE_ORIGIN + "/"},
                  {"@type": "ListItem", "position": 2, "name": f"{lg} Prop Hit Rates",
                   "item": f"{SITE_ORIGIN}/{lslug}/"},
                  {"@type": "ListItem", "position": 3, "name": team_name,
                   "item": f"{SITE_ORIGIN}/{lslug}/team/{tslug}/"}]}
    parts.append(f'<script type="application/ld+json">{json.dumps(crumbs)}</script>')
    tdata = json.dumps({"props": payload}).replace("</", "<\\/")
    parts.append(f'<script type="application/json" id="tdata">{tdata}</script>')
    parts.append(TEAM_PAGE_JS)
    return archive_page_shell(
        title, description, f"/{lslug}/team/{tslug}/", team_name,
        f"{lg} team props, hit rates and recent results",
        "\n".join(parts), logo_uri)

def generate_pages(league_objs, now_utc, archive_lastmod=None, graded_ctx=None,
                   team_data=None):
    """Return ({repo-relative path: content}, per-league info)."""
    now_et = now_utc.astimezone(ET)
    stamp = fmt_stamp(now_et)
    logo_uri = page_logo_uri()
    staged_root, info = {}, {}
    slugs_by_league, player_urls = {}, []
    # Team pages pre-pass: group each league's team props by team and
    # assign slugs once, so the league pages' team links and the team
    # pages themselves always agree on URLs.
    team_by_league, team_links_by_league, team_slugs_by_league = {}, {}, {}
    team_urls = []
    if team_data:
        for _lg in ("NBA", "NFL", "NHL"):
            _by_team = {}
            for _p in (team_data.get("props") or {}).get(_lg) or []:
                _by_team.setdefault(_p["team"], []).append(_p)
            _taken, _slugs, _links = {}, {}, []
            for _ab in sorted(_by_team):
                _ts = player_slug(_by_team[_ab][0]["teamName"], _ab, _taken)
                _slugs[_ab] = _ts
                _links.append((_by_team[_ab][0]["teamName"], _ts))
            team_by_league[_lg] = _by_team
            team_slugs_by_league[_lg] = _slugs
            team_links_by_league[_lg] = _links
    for lg in ("NBA", "NFL", "NHL"):
        league = league_objs[lg]
        slugs = player_slugs(league)
        slugs_by_league[lg] = slugs
        page, pinfo = build_league_page(lg, league, stamp, now_et.date(), logo_uri, slugs,
                                        team_links_by_league.get(lg))
        staged_root[f"{PAGE_LEAGUES[lg]['slug']}/index.html"] = page
        info[lg] = pinfo
        count = 0
        for pid in sorted(league["players"]):
            if not league["logs"].get(pid) and \
                    not any(p["pid"] == pid for p in league["props"]):
                continue
            staged_root[f"{PAGE_LEAGUES[lg]['slug']}/player/{slugs[pid]}/index.html"] = \
                build_player_page(lg, league, pid, stamp, logo_uri, slugs)
            player_urls.append(
                f"{SITE_ORIGIN}/{PAGE_LEAGUES[lg]['slug']}/player/{slugs[pid]}/")
            count += 1
        info[lg]["playerPages"] = count
        tcount = 0
        tlogs = ((team_data or {}).get("logs") or {}).get(lg) or {}
        for ab, plist in sorted((team_by_league.get(lg) or {}).items()):
            ts = team_slugs_by_league[lg][ab]
            staged_root[f"{PAGE_LEAGUES[lg]['slug']}/team/{ts}/index.html"] = \
                build_team_page(lg, plist, ab, tlogs.get(ab), stamp, logo_uri, ts,
                                tlogs.get((plist[0] or {}).get("opp")))
            team_urls.append(f"{SITE_ORIGIN}/{PAGE_LEAGUES[lg]['slug']}/team/{ts}/")
            tcount += 1
        info[lg]["teamPages"] = tcount
    staged_root["archive/highlights/index.html"] = build_highlights_page(
        league_objs, stamp, now_et.date(), logo_uri, graded_ctx, slugs_by_league)
    info["highlights"] = True
    staged_root["sitemap.xml"] = build_sitemap(
        now_et.strftime("%Y-%m-%d"), archive_lastmod, player_urls,
        team_urls if team_data else None)
    return staged_root, info


# --------------------------------------------------------------------------
# Results archive. The first run of an ET day before noon snapshots the
# board the league pages publish that morning; later runs grade the
# pending entries against the merged logs once their game date has
# passed, and render archive/<gameDate>/ pages plus an index. State
# lives in archive/pending.json IN THE REPO TREE (staging/archive/ in
# staging mode) so it persists across ephemeral CI checkouts. Archive
# work never fails the data publish — main() wraps it and reports.
# --------------------------------------------------------------------------

def archive_state_default():
    return {"version": 1, "snapshots": [], "pending": [], "graded": {}}


def load_archive_state(path):
    """(state, corrupt). A missing file is a fresh state, not corrupt;
    an unreadable or misshapen one is reported as corrupt and treated
    as empty rather than crashing the run."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            state = json.load(f)
        if not isinstance(state, dict) or not isinstance(state.get("pending"), list):
            raise ValueError("unexpected pending.json shape")
        state.setdefault("version", 1)
        state.setdefault("snapshots", [])
        state.setdefault("graded", {})
        return state, False
    except FileNotFoundError:
        return archive_state_default(), False
    except (OSError, ValueError):
        return archive_state_default(), True


def team_game_info(lg, league, today_et):
    """{team abbr: (ET date, opponent abbr)} for the team's game in
    the window — today for NBA/NHL, the specific day inside the
    Thu–Mon window for NFL."""
    if lg == "NFL":
        games = slate_games_nfl_week(league, today_et)
    else:
        games = [g for g in league["games"] if game_et_date(g) == today_et]
    out = {}
    for g in games:
        d = game_et_date(g)
        if d is None:
            continue
        home = (g.get("home") or {}).get("abbr")
        away = (g.get("away") or {}).get("abbr")
        if home and away:
            out.setdefault(home, (d, away))
            out.setdefault(away, (d, home))
    return out


def _win_value(key, row):
    """A prop's value in one game, browser semantics: a stat absent
    from the row means the game does not count for that prop (the
    archive grader's prop_value_from_row deliberately differs — it
    counts a missing stat as 0, as build_prop does)."""
    sv = row.get("s") or {}
    if key == "combo":
        parts = [sv.get(k) for k in ("points", "totalRebounds", "assists")]
        if any(v is None for v in parts):
            return None
        return sum(parts)
    v = sv.get(key)
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _norm_cdf(z):
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def _blend_mean(windows):
    num = den = 0.0
    for vals, w in windows:
        if vals:
            num += w * (sum(vals) / len(vals))
            den += w
    return num / den if den else None


def model_probability(lg, league, logs_prev, p, opp_abbr, home_flag, game_date, allow_cache):
    """The archive's logged model probability for one board prop — a
    Python port of the board's probability engine (same recency blend,
    same opponent/venue/rest adjustments, same empirical blend and
    shrinkage; pace and spread factors are browser-only in v1). Logged
    at snapshot time so the archive can grade the model itself, not
    just the board's hit rates. None when there is not enough data."""
    pid, key = p["pid"], p["key"]

    def entries(rows):
        out = []
        for row in rows or []:
            v = _win_value(key, row)
            if v is None:
                continue
            sv = row.get("s") or {}
            out.append({"v": v, "mins": sv.get("minutes"),
                        "d": row.get("d") or "",
                        "home": str(row.get("opp") or "").startswith("vs")})
        return out

    cur = entries(league["logs"].get(pid))
    all_e = entries(merged_rows_for(league, logs_prev, pid))
    excl = 0
    if lg == "NBA":
        with_m = [e for e in all_e if e["mins"] is not None]
        if len(with_m) >= 6 and len(with_m) >= 0.6 * len(all_e):
            mins_sorted = sorted(e["mins"] for e in with_m)
            med = mins_sorted[len(mins_sorted) // 2] if len(mins_sorted) % 2                 else (mins_sorted[len(mins_sorted) // 2 - 1] + mins_sorted[len(mins_sorted) // 2]) / 2
            if med:
                kept = [e for e in all_e if e["mins"] is None or e["mins"] >= 0.6 * med]
                if len(kept) >= 5:
                    excl = len(all_e) - len(kept)
                    cur = [e for e in kept if e in cur]
                    all_e = kept
    all_v = [e["v"] for e in all_e]
    season_v = [e["v"] for e in cur]
    n = len(all_v)
    if n < 5:
        return None
    mu0 = None
    if lg == "NBA":
        with_m = [e for e in all_e if e["mins"]]
        if len(with_m) >= 6:
            def rate_of(seg):
                sv_ = sum(e["v"] for e in seg if e["mins"])
                sm = sum(e["mins"] for e in seg if e["mins"])
                return sv_ / sm if sm >= 30 else None
            num = den = 0.0
            for seg, w in ((cur, 0.4), (all_e[:20], 0.3), (all_e[:10], 0.2), (all_e[:5], 0.1)):
                r = rate_of(seg)
                if r is not None:
                    num += w * r
                    den += w
            proj_mins = _blend_mean([
                ([e["mins"] for e in cur if e["mins"] is not None], 0.4),
                ([e["mins"] for e in all_e[:20] if e["mins"] is not None], 0.3),
                ([e["mins"] for e in all_e[:10] if e["mins"] is not None], 0.2),
                ([e["mins"] for e in all_e[:5] if e["mins"] is not None], 0.1)])
            if den and proj_mins:
                mu0 = (num / den) * proj_mins
    if mu0 is None:
        mu0 = _blend_mean([(season_v, 0.4), (all_v[:20], 0.3), (all_v[:10], 0.2), (all_v[:5], 0.1)])
    if not mu0 and mu0 != 0:
        return None
    seg30 = all_v[:30]
    mean30 = sum(seg30) / len(seg30)
    var = sum((v - mean30) ** 2 for v in seg30) / len(seg30)
    sigma = max(math.sqrt(var), 0.22 * mu0 if mu0 > 0 else 0.6)
    if sigma <= 0:
        return None
    f = 1.0
    if opp_abbr:
        if key not in allow_cache:
            by_opp, allv = {}, []
            rows_by_pid = {}
            for pid2 in set(league["logs"]) | set(logs_prev or {}):
                rows_by_pid[pid2] = merged_rows_for(league, logs_prev, pid2)
            for rows in rows_by_pid.values():
                for row in rows:
                    v = _win_value(key, row)
                    if v is None:
                        continue
                    allv.append(v)
                    o = row_opp(row)
                    if o:
                        by_opp.setdefault(o, []).append(v)
            allow_cache[key] = (by_opp, sum(allv) / len(allv) if allv else None)
        by_opp, league_mean = allow_cache[key]
        oa = by_opp.get(opp_abbr)
        if oa and len(oa) >= 25 and league_mean:
            f *= min(1.18, max(0.85, (sum(oa) / len(oa)) / league_mean))
        split = [e["v"] for e in all_e if e["home"] == bool(home_flag)]
        om = sum(all_v) / len(all_v)
        if len(split) >= 4 and om:
            f *= min(1.08, max(0.92, (sum(split) / len(split)) / om))
        if all_e and all_e[0]["d"]:
            try:
                last = datetime.strptime(all_e[0]["d"], "%Y-%m-%d").date()
                gap = (game_date - last).days
                if gap <= 1:
                    f *= 0.97
                elif gap >= 5:
                    f *= 1.01
            except ValueError:
                pass
    mu = mu0 * f
    line, dir_ = p["line"], p["dir"]
    cc = 0.5 if float(line) == int(line) else 0.0
    if dir_ == "Over":
        pm = 1.0 - _norm_cdf((line + cc - mu) / sigma)
    else:
        pm = _norm_cdf((line - cc - mu) / sigma)
    l20 = all_v[:20]
    pr = pm
    if len(l20) >= 5:
        hits = sum(1 for v in l20 if (v > line if dir_ == "Over" else v < line))
        pr = 0.65 * pm + 0.35 * (hits / len(l20))
    ne = min(n, 30)
    pr = (pr * ne + 3.0) / (ne + 6.0)
    return round(min(0.98, max(0.02, pr)), 3)


def calibration_section(state):
    """Predicted vs actual for every graded prop that carries a
    logged model probability, plus the Brier score. Renders only once
    at least 30 model-graded props exist — below that the buckets
    would be noise dressed as measurement."""
    pairs = []
    for entries in state["graded"].values():
        for e in entries:
            pm = e.get("pModel")
            if pm is None or e.get("result") not in ("HIT", "MISS"):
                continue
            pairs.append((pm, 1 if e["result"] == "HIT" else 0))
    if len(pairs) < 30:
        return ""
    brier = sum((p_ - o) ** 2 for p_, o in pairs) / len(pairs)
    rows = []
    for lo, hi in ((0.50, 0.55), (0.55, 0.60), (0.60, 0.65), (0.65, 0.70), (0.70, 1.01)):
        seg = [(p_, o) for p_, o in pairs if lo <= p_ < hi]
        if len(seg) < 5:
            continue
        pred = sum(p_ for p_, _ in seg) / len(seg)
        act = sum(o for _, o in seg) / len(seg)
        rows.append(
            f"<li>Model {int(lo * 100)}&ndash;{int(min(hi, 1.0) * 100)}%: "
            f"predicted {pred * 100:.0f}%, actual {act * 100:.0f}% ({len(seg)} props)</li>")
    if not rows:
        return ""
    return ("<h2>Model calibration</h2>\n"
            "<p>Each morning's snapshot also logs the model probability behind every board "
            "prop — a projection adjusted for opponent, venue and rest, not the raw hit rate. "
            "This is how those probabilities have graded since: a well-calibrated 65% should "
            f"hit about 65% of the time. Brier score so far: <b>{brier:.3f}</b> over "
            f"{len(pairs)} graded props (lower is better; 0.25 is coin-flip).</p>\n"
            '<ul class="streak-list">\n' + "\n".join(rows) + "\n</ul>")


def snapshot_entries_for_league(lg, league, today_et, logs_prev=None):
    """Today's board for one league, as archive entries: exactly the
    selection the league pages publish (see select_page_props), each
    entry carrying the ET date of the player's game and the opponent.
    Empty when the league has no games in its window. Entries whose
    game is already played (an NFL Thursday game still in the window
    on Friday) are skipped — their lines would have been set after
    the game."""
    sel = select_page_props(lg, league, today_et)
    if sel["window"] == "fallback" or not sel["listed"]:
        return []
    info = team_game_info(lg, league, today_et)
    if lg == "NFL":
        _gs = slate_games_nfl_week(league, today_et)
    else:
        _gs = [g for g in league["games"] if game_et_date(g) == today_et]
    home_map = {}
    for g in _gs:
        _h = (g.get("home") or {}).get("abbr")
        _a = (g.get("away") or {}).get("abbr")
        if _h and _a:
            home_map[_h] = True
            home_map[_a] = False
    allow_cache = {}
    entries = []
    for p in sel["listed"]:
        gd_opp = info.get(p["team"])
        if gd_opp is None:
            continue
        gd, opp = gd_opp
        if gd < today_et:
            continue
        entry = {
            "league": lg, "snapshotDate": today_et.isoformat(), "pid": p["pid"],
            "name": p["name"], "team": p["team"], "key": p["key"], "stat": p["stat"],
            "dir": p["dir"], "line": p["line"],
            "l5": list(featured_counts(p, "L5")), "l10": list(featured_counts(p, "L10")),
            "l20": list(featured_counts(p, "L20")), "gameDate": gd.isoformat(),
            "opp": opp,
        }
        try:
            pm = model_probability(lg, league, logs_prev, p, opp,
                                   home_map.get(p["team"]), gd, allow_cache)
        except Exception:
            pm = None
        if pm is not None:
            entry["pModel"] = pm
        entries.append(entry)
    return entries


def merged_rows_for(league, logs_prev, pid):
    """Current-season log rows plus previous-season rows the current
    season doesn't already cover — the merged logs the site shows."""
    rows = list(league["logs"].get(pid) or [])
    seen = {r["d"] for r in rows}
    for r in (logs_prev or {}).get(pid) or []:
        if r["d"] not in seen:
            rows.append(r)
    return rows


def prop_value_from_row(key, row):
    """A prop's value in one game, from the same series build_prop
    rates: the NBA combo sums its three parts (missing parts count 0,
    as in build_prop); any other stat absent from a played game's row
    likewise counts 0."""
    s = row["s"]
    if key == "combo":
        return s.get("points", 0) + s.get("totalRebounds", 0) + s.get("assists", 0)
    return s.get(key, 0)


def row_opp(row):
    m = re.match(r"^(?:vs|@) (.+)$", row.get("opp") or "")
    return m.group(1) if m else None


def grade_pending(state, league_objs, logs_prev_objs, today_et):
    """Grade every pending entry whose gameDate is before today (ET).

    Matching a log row to the entry's game needs care: gameDate is an
    ET date (from the schedule), but log rows carry the game's UTC
    date — an evening ET game is dated the next UTC day. A game on ET
    date G therefore appears in the logs dated G or G+1, so candidates
    are the player's rows in that two-day window whose opponent
    matches the entry's; rows are consumed in gameDate order so
    back-to-backs against the same opponent resolve to the right
    game. When no candidate exists but the logs already hold a row
    dated after the window, the data has provably moved past the game
    and the player simply did not play: DNP. When the logs have not
    caught up yet, the entry stays pending and grades on a later run
    instead of taking a false DNP.

    An NFL game inside the window can be snapshotted on several days;
    when duplicates of the same (league, player, stat, gameDate)
    exist, only the freshest board (latest snapshotDate) counts — the
    earlier copies are dropped with it. Returns ({gameDate: [graded
    entries]}, n_graded). Mutates state."""
    today_iso = today_et.isoformat()
    due = [e for e in state["pending"] if e["gameDate"] < today_iso]
    if not due:
        return {}, 0
    best = {}
    for e in due:
        k = (e["league"], e["pid"], e["key"], e["gameDate"])
        if k not in best or e["snapshotDate"] > best[k]["snapshotDate"]:
            best[k] = e

    rows_cache = {}

    def rows_for(e):
        k = (e["league"], e["pid"])
        if k not in rows_cache:
            rows_cache[k] = merged_rows_for(league_objs[e["league"]],
                                            logs_prev_objs.get(e["league"]), e["pid"])
        return rows_cache[k]

    consumed = {}
    graded_by_date = {}
    for e in sorted(best.values(), key=lambda x: (x["gameDate"], x["league"], x["name"])):
        rows = rows_for(e)
        gdate = datetime.strptime(e["gameDate"], "%Y-%m-%d").date()
        window = {gdate.isoformat(), (gdate + timedelta(days=1)).isoformat()}
        # A row may serve several entries for the SAME game (a player
        # with two props in one game), but never two different games.
        used = consumed.setdefault((e["league"], e["pid"]), {})
        cand = [r for r in rows if r["d"] in window and row_opp(r) == e.get("opp")
                and used.get(id(r), e["gameDate"]) == e["gameDate"]]
        g = dict(e)
        if cand:
            row = min(cand, key=lambda r: r["d"])
            used[id(row)] = e["gameDate"]
            v = prop_value_from_row(e["key"], row)
            g["value"] = v
            if e["dir"] == "Over":
                g["result"] = "HIT" if v > e["line"] else "MISS"
            else:
                g["result"] = "HIT" if v < e["line"] else "MISS"
            graded_by_date.setdefault(e["gameDate"], []).append(g)
        elif any(r["d"] > max(window) for r in rows):
            g["value"] = None
            g["result"] = "DNP"
            graded_by_date.setdefault(e["gameDate"], []).append(g)
        # else: the logs have not caught up with this game yet — the
        # entry stays pending and grades on a later run.
    graded_keys = {(e["league"], e["pid"], e["key"], e["gameDate"])
                   for entries in graded_by_date.values() for e in entries}
    state["pending"] = [
        e for e in state["pending"]
        if e["gameDate"] >= today_iso
        or (e["league"], e["pid"], e["key"], e["gameDate"]) not in graded_keys]
    for d, entries in graded_by_date.items():
        state["graded"].setdefault(d, []).extend(entries)
    return graded_by_date, sum(len(v) for v in graded_by_date.values())


def archive_record(entries):
    """(hits, misses, dnps) — DNPs are excluded from the record and
    counted separately."""
    h = sum(1 for e in entries if e["result"] == "HIT")
    m = sum(1 for e in entries if e["result"] == "MISS")
    d = sum(1 for e in entries if e["result"] == "DNP")
    return h, m, d


def fmt_date_long(iso_date):
    dt = datetime.strptime(iso_date, "%Y-%m-%d")
    return f"{dt.strftime('%B')} {dt.day}, {dt.year}"


def archive_page_shell(title, description, canonical_path, h1, sub, body_html, logo_uri):
    """The league pages' shell (same head snippets, tabs and footer)
    for archive pages. No 'Updated' stamp: the content is a fixed
    record, and a stamp would dirty the file on every run."""
    logo_html = ('<div class="brand"><a href="/" aria-label="LegLock home">'
                 '<img src="{}" alt="LegLock" /></a>'
                 '<div class="tagline">Player-prop research &middot; NBA &middot; NFL &middot; NHL</div></div>'.format(logo_uri)
                 if logo_uri else
                 '<div class="brand"><a href="/" aria-label="LegLock home">'
                 '<span class="site-footer-brand">LEGLOCK</span></a>'
                 '<div class="tagline">Player-prop research &middot; NBA &middot; NFL &middot; NHL</div></div>')
    return f"""<!doctype html>
<html lang="en" data-theme="light">
<head>
{GA4_SNIPPET}

<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
{ADS_SNIPPET}
<meta name="apple-mobile-web-app-title" content="LEGLOCK" />
<meta name="color-scheme" content="light dark" />
<title>{title}</title>
<meta name="description" content="{description}" />
<link rel="canonical" href="{SITE_ORIGIN}{canonical_path}" />
<link rel="stylesheet" href="/assets/site.css?v=17" />
{PAGE_STYLE}
</head>
<body><main>{logo_html}{PAGE_TABS}<h1 class="display" style="font-size:28px;font-weight:700;margin:14px 0 2px">{h1}</h1><p class="sub" style="margin:0 0 10px">{sub}</p><section class="content-body">
{body_html}</section>{PAGE_FOOTER}</main>
{CONSENT_SCRIPT_SNIPPET}
</body>
</html>
"""


def _record_text(h, m, d):
    txt = f"{h} hits, {m} misses"
    if d:
        txt += f" &middot; {d} did not play"
    return txt


def render_archive_date(game_date, entries, logo_uri):
    long_date = fmt_date_long(game_date)
    oh, om, od = archive_record(entries)
    parts = [
        f"<p>These are the top props the board published on the morning of {long_date}, "
        "graded against the actual game logs once the games were played. Every line is a "
        "research line set from the player's own recent average — not a sportsbook price — "
        "and the L10 column is the hit count the prop carried when it was published.</p>",
        f"<p><strong>Overall: {_record_text(oh, om, od)}</strong></p>",
    ]
    for lg in ("NBA", "NFL", "NHL"):
        lg_entries = [e for e in entries if e["league"] == lg]
        if not lg_entries:
            continue
        h, m, d = archive_record(lg_entries)
        rows = []
        for e in lg_entries:
            actual = "&mdash;" if e["value"] is None else fmt_line(e["value"])
            rows.append(
                '<tr><td>{}</td><td>{}</td><td>{}</td><td class="num">{} {}</td>'
                '<td class="num">{}</td><td>{}</td><td class="num">{}/{}</td></tr>'.format(
                    html_escape(e["name"]), html_escape(e["team"]), html_escape(e["stat"]),
                    e["dir"], fmt_line(e["line"]), actual, e["result"],
                    e["l10"][0], e["l10"][1]))
        parts.append(
            f"<h2>{lg}</h2>\n<p>{lg} top props: {_record_text(h, m, d)}.</p>\n"
            '<table class="props-table">\n'
            "<thead><tr><th>Player</th><th>Team</th><th>Stat</th><th>Line</th>"
            "<th>Actual</th><th>Result</th><th>L10</th></tr></thead>\n<tbody>\n"
            + "\n".join(rows) + "\n</tbody>\n</table>")
    others = " and ".join(
        '<a href="/{}/">{} player prop hit rates today</a>'.format(PAGE_LEAGUES[o]["slug"], o)
        for o in ("NBA", "NHL", "NFL"))
    parts.append(
        "<h2>More on LegLock</h2>\n"
        f"<p>Browse the full <a href=\"/archive/\">results archive</a>, today's {others}, "
        "the <a href=\"/\">interactive prop board</a>, or learn "
        "<a href=\"/guides/how-hit-rates-work/\">how hit rates work</a>.</p>")
    return archive_page_shell(
        f"LegLock Results — {long_date}",
        f"LegLock top prop results for {long_date}: the morning board's top 25 props per "
        "league, graded hit or miss against the actual game logs.",
        f"/archive/{game_date}/", f"Top Prop Results — {long_date}",
        "The morning board, graded against the game logs", "\n".join(parts), logo_uri)


def render_archive_index(state, logo_uri):
    dates = sorted(state["graded"], reverse=True)
    parts = [
        "<p>Every morning the board's top props are recorded here and graded against the "
        "game logs after the games are played — hits, misses and did-not-plays, nothing "
        "removed. Lines are research lines set from each player's own recent average, not "
        "sportsbook prices; this is a record of what the board showed, kept honest.</p>"
    ]
    if dates:
        items = []
        for d in dates:
            h, m, dn = archive_record(state["graded"][d])
            items.append(
                f'<li><a href="/archive/{d}/">{fmt_date_long(d)}</a> — {_record_text(h, m, dn)}</li>')
        parts.append('<ul class="streak-list">\n' + "\n".join(items) + "\n</ul>")
    else:
        parts.append("<p>No graded slates yet — the first results land the morning after "
                     "the first recorded slate.</p>")
    cal = calibration_section(state)
    if cal:
        parts.append(cal)
    others = " and ".join(
        '<a href="/{}/">{} player prop hit rates today</a>'.format(PAGE_LEAGUES[o]["slug"], o)
        for o in ("NBA", "NHL", "NFL"))
    parts.append(
        "<h2>More on LegLock</h2>\n"
        f"<p>See today's {others}, the <a href=\"/archive/highlights/\">daily highlights</a>, "
        "the <a href=\"/\">interactive prop board</a>, or learn "
        "<a href=\"/guides/how-hit-rates-work/\">how hit rates work</a>.</p>")
    return archive_page_shell(
        "Results Archive — LegLock",
        "The LegLock results archive: every day's top props from the board, graded hit or "
        "miss against the actual game logs.",
        "/archive/", "Results Archive",
        "What the board published, graded after the games", "\n".join(parts), logo_uri)


def run_archive(league_objs, logs_prev_objs, now_utc, state):
    """Snapshot (first pre-noon ET run of the day) + grade + render.
    Returns ({repo-relative path: content}, info). Mutates state. The
    outputs always include archive/pending.json (hash comparison in
    main() dedupes an unchanged state) and, once anything has graded,
    every archive page — rendered content is deterministic, so
    unchanged pages hash identically and are not re-committed."""
    now_et = now_utc.astimezone(ET)
    today_et = now_et.date()
    info = {"archiveSnapshotted": 0, "archiveGraded": 0, "archivePagesWritten": []}

    if now_et.hour < 12 and today_et.isoformat() not in state["snapshots"]:
        added = []
        for lg in ("NBA", "NFL", "NHL"):
            added += snapshot_entries_for_league(lg, league_objs[lg], today_et,
                                                 (logs_prev_objs or {}).get(lg))
        state["pending"].extend(added)
        state["snapshots"].append(today_et.isoformat())
        info["archiveSnapshotted"] = len(added)

    _, n_graded = grade_pending(state, league_objs, logs_prev_objs, today_et)
    info["archiveGraded"] = n_graded

    outputs = {}
    if state["graded"]:
        logo_uri = page_logo_uri()
        for d in sorted(state["graded"]):
            rel = f"archive/{d}/index.html"
            outputs[rel] = render_archive_date(d, state["graded"][d], logo_uri)
            info["archivePagesWritten"].append(rel)
        outputs["archive/index.html"] = render_archive_index(state, logo_uri)
        info["archivePagesWritten"].append("archive/index.html")
    outputs["archive/pending.json"] = json.dumps(state, indent=1, ensure_ascii=False) + "\n"
    return outputs, info


# --------------------------------------------------------------------------
# Team game logs + team props (data-teams.js).
#
# Sources (all ESPN, verified against the live feeds):
#   * Dated scoreboards — GET /site/v2/sports/{sport}/{code}/scoreboard
#     ?dates=YYYYMMDD, one fetch per date from the season start (Oct 1
#     for NBA/NHL, Sep 1 for the NFL) through today ET. Competitors
#     carry the final score, per-period linescores (NBA/NFL periods
#     1+2 = first half; NHL period 1 = first period) and, for the NBA,
#     team statistics including threePointFieldGoalsMade. Events are
#     kept only when completed (status state "post") and regular
#     season / postseason (season.type 2 or 3 — the gamelog rule).
#   * NHL shots on goal are NOT in the scoreboard payload; they come
#     from the per-game summary endpoint — GET .../summary?event={id}
#     — boxscore.teams[].statistics, name "shotsTotal": one fetch per
#     completed NHL game.
# --------------------------------------------------------------------------

TEAM_STAT_DEFS = {
    "NBA": [("total", "Team Total"), ("oppTotal", "Opponent Total"),
            ("winBy", "Win By"), ("firstHalf", "First Half Total"),
            ("teamThrees", "Team Threes")],
    "NFL": [("total", "Team Total"), ("oppTotal", "Opponent Total"),
            ("winBy", "Win By"), ("firstHalf", "First Half Total")],
    "NHL": [("total", "Team Total"), ("oppTotal", "Opponent Total"),
            ("winBy", "Win By"), ("firstPeriod", "First Period Total"),
            ("teamShots", "Team Shots")],
}


def team_season_start(lg, now_utc):
    cur, _ = season_years(lg, now_utc)
    if lg == "NFL":
        return datetime(cur, 9, 1).date()
    return datetime(cur - 1, 10, 1).date()


def _scoreboard_day(base, d):
    try:
        return FETCH.get_json(f"{base}/scoreboard?dates={d.strftime('%Y%m%d')}")
    except FetchError:
        return None


def _espn_stat(holder, name):
    """A named team statistic's numeric value from a competitor or a
    summary boxscore team entry (both carry statistics as
    {name, displayValue} lists)."""
    for st in (holder or {}).get("statistics") or []:
        if st.get("name") == name:
            return parse_num(st.get("displayValue"))
    return None


def _period_points(competitor, periods):
    """Sum of the given 1-based periods from a competitor's
    linescores; None when the linescores are missing or short."""
    ls = competitor.get("linescores") or []
    if len(ls) < max(periods):
        return None
    total = 0
    for p in periods:
        v = parse_num((ls[p - 1] or {}).get("value"))
        if v is None:
            return None
        total += v
    return int(total)


def _nhl_game_shots(eid):
    cfg = LEAGUES["NHL"]
    url = f"{API}/site/v2/sports/{cfg['sport']}/{cfg['code']}/summary?event={eid}"
    try:
        payload = FETCH.get_json(url, allow_404=True)
    except FetchError:
        return eid, {}
    out = {}
    for t in ((payload or {}).get("boxscore") or {}).get("teams") or []:
        abbr = (t.get("team") or {}).get("abbreviation") or ""
        v = _espn_stat(t, "shotsTotal")
        if abbr and v is not None:
            out[abbr] = int(v)
    return eid, out


def _nfl_game_stats(eid):
    """{abbr: {tyds, pyds, ryds, tov}} from one game's summary
    boxscore — the NFL scoreboard carries no team statistics, so the
    Recent results enrichment reads them here. Display-only: a failed
    or stat-less summary just leaves the row's fields None."""
    cfg = LEAGUES["NFL"]
    url = f"{API}/site/v2/sports/{cfg['sport']}/{cfg['code']}/summary?event={eid}"
    try:
        payload = FETCH.get_json(url, allow_404=True)
    except FetchError:
        return eid, {}
    out = {}
    for t in ((payload or {}).get("boxscore") or {}).get("teams") or []:
        abbr = (t.get("team") or {}).get("abbreviation") or ""
        if not abbr:
            continue
        out[abbr] = {
            "tyds": _espn_stat(t, "totalYards"),
            "pyds": _espn_stat(t, "netPassingYards"),
            "ryds": _espn_stat(t, "rushingYards"),
            "tov": _espn_stat(t, "turnovers"),
        }
    return eid, out


def fetch_team_logs(lg, now_utc, today_et):
    """{team abbr: {"name": display name, "rows": [...]}} — rows most
    recent first: {d (ET date), opp, home, pf, pa, margin, fh
    (first-half points, NBA/NFL), p1 (first-period goals, NHL),
    threes (NBA), shots (NHL)}. Raises FetchError when the pull fails
    wholesale (>10% of the dated scoreboards, or — NHL — fewer than
    half the game summaries carrying shots)."""
    cfg = LEAGUES[lg]
    base = f"{API}/site/v2/sports/{cfg['sport']}/{cfg['code']}"
    start = team_season_start(lg, now_utc)
    days = [start + timedelta(days=i) for i in range((today_et - start).days + 1)]
    payloads = FETCH.map(lambda d: _scoreboard_day(base, d), days)
    failed_days = sum(1 for p in payloads if p is None)
    if days and failed_days > 0.1 * len(days):
        raise FetchError(f"{lg}: {failed_days}/{len(days)} team scoreboard days failed")

    games = {}
    for payload in payloads:
        for ev in (payload or {}).get("events") or []:
            if (ev.get("season") or {}).get("type") not in (2, 3):
                continue  # regular season + postseason only
            if ((ev.get("status") or {}).get("type") or {}).get("state") != "post":
                continue  # completed games only
            comps = ((ev.get("competitions") or [{}])[0]).get("competitors") or []
            if len(comps) != 2 or not ev.get("id") or ev["id"] in games:
                continue
            games[ev["id"]] = (ev, comps)

    teams = {}
    for eid, (ev, comps) in games.items():
        et_date = game_et_date({"date": ev.get("date") or ""})
        if et_date is None:
            continue
        parsed = []
        for c in comps:
            score = parse_num(c.get("score"))
            if score is None:
                break
            parsed.append((c, int(score)))
        if len(parsed) != 2:
            continue
        for i, (c, pf) in enumerate(parsed):
            t = c.get("team") or {}
            abbr = t.get("abbreviation") or ""
            if not abbr:
                continue
            row = {
                "d": et_date.isoformat(),
                "opp": (parsed[1 - i][0].get("team") or {}).get("abbreviation") or "",
                "home": c.get("homeAway") == "home",
                "pf": pf, "pa": parsed[1 - i][1], "margin": pf - parsed[1 - i][1],
                "fh": _period_points(c, (1, 2)) if lg in ("NBA", "NFL") else None,
                "p1": _period_points(c, (1,)) if lg == "NHL" else None,
                "threes": _espn_stat(c, "threePointFieldGoalsMade") if lg == "NBA" else None,
                "shots": None, "eid": eid,
                "reb": _espn_stat(c, "rebounds") if lg == "NBA" else None,
                "ast": _espn_stat(c, "assists") if lg == "NBA" else None,
                "fgp": _espn_stat(c, "fieldGoalPct") if lg == "NBA" else None,
                "tpp": _espn_stat(c, "threePointPct") if lg == "NBA" else None,
                "p2": _period_points(c, (2,)) if lg == "NHL" else None,
                "p3": _period_points(c, (3,)) if lg == "NHL" else None,
                "saves": _espn_stat(c, "saves") if lg == "NHL" else None,
                "svp": _espn_stat(c, "savePct") if lg == "NHL" else None,
                "tyds": None, "pyds": None, "ryds": None, "tov": None,
            }
            entry = teams.setdefault(abbr, {"name": t.get("displayName") or abbr, "rows": []})
            entry["rows"].append(row)
    for entry in teams.values():
        entry["rows"].sort(key=lambda r: r["d"], reverse=True)

    if lg == "NHL" and teams:
        eids = sorted({r["eid"] for e in teams.values() for r in e["rows"]})
        results = dict(FETCH.map(_nhl_game_shots, eids))
        filled = sum(1 for v in results.values() if v)
        if eids and filled < 0.5 * len(eids):
            raise FetchError(f"NHL: only {filled}/{len(eids)} game summaries carried shots")
        for abbr, entry in teams.items():
            for r in entry["rows"]:
                r["shots"] = (results.get(r["eid"]) or {}).get(abbr)

    if lg == "NFL" and teams:
        eids = sorted({r["eid"] for e in teams.values() for r in e["rows"]})
        results = dict(FETCH.map(_nfl_game_stats, eids))
        for abbr, entry in teams.items():
            for r in entry["rows"]:
                st = (results.get(r["eid"]) or {}).get(abbr)
                if st:
                    r.update(st)
    return teams


def team_stat_value(key, row):
    if key == "total":
        return row["pf"]
    if key == "oppTotal":
        return row["pa"]
    if key == "winBy":
        return row["margin"]
    if key == "firstHalf":
        return row["fh"]
    if key == "firstPeriod":
        return row["p1"]
    if key == "teamThrees":
        return row["threes"]
    if key == "teamShots":
        return row["shots"]
    return None


def team_def_ranks(team_logs):
    """{abbr: (rank, L10 points-against average)} — rank 1 = toughest
    defence (fewest points allowed over the last 10 games). Ordinal
    ranking over the sorted averages; the abbreviation breaks ties so
    the ranking is deterministic."""
    avgs = {}
    for abbr, entry in team_logs.items():
        rows = entry["rows"][:10]
        if rows:
            avgs[abbr] = mean([r["pa"] for r in rows])
    ranks = {}
    for i, abbr in enumerate(sorted(avgs, key=lambda a: (avgs[a], a))):
        ranks[abbr] = (i + 1, js_round1(avgs[abbr]))
    return ranks


def team_injury_note(lg, league, team_abbr):
    """"Name out" / "Name doubtful" for any of the team's top-3
    scorers (by L10 scoring average) listed Out or Doubtful on the
    injury report; None when none qualify. Scoring = the points stat
    for NBA/NHL; for the NFL it is total touchdowns (passing +
    rushing + receiving), the closest scoring measure in its logs."""
    scored = []
    for pid, p in league["players"].items():
        if p["team"] != team_abbr:
            continue
        rows = league["logs"].get(pid) or []
        if lg == "NFL":
            vals = [r["s"].get("passingTouchdowns", 0) + r["s"].get("rushingTouchdowns", 0)
                    + r["s"].get("receivingTouchdowns", 0) for r in rows]
        else:
            vals = [r["s"]["points"] for r in rows if "points" in r["s"]]
        if vals:
            scored.append((mean(vals[:10]), p))
    scored.sort(key=lambda x: -x[0])
    notes = []
    for _, p in scored[:3]:
        for inj in league["injuries"]:
            if inj["name"] != p["name"] or inj["status"] not in ("Out", "Doubtful"):
                continue
            if inj.get("team") and p.get("teamName") and inj["team"] != p["teamName"]:
                continue
            notes.append(f"{p['name']} {'out' if inj['status'] == 'Out' else 'doubtful'}")
            break
    return " · ".join(notes) if notes else None


# How far ahead (in ET days, today included) the team-prop fixture
# search scans for a team's next game. 14 days covers an NFL bye
# week plus the following game week, so every team is reached.
TEAM_FIXTURE_HORIZON_DAYS = 14


def team_next_fixtures(lg, today_et, want_teams):
    """{team abbr: fixture} — every team's NEXT fixture: the earliest
    pre-game game involving it, found by scanning dated scoreboards
    day by day from today (ET) through today +
    TEAM_FIXTURE_HORIZON_DAYS, fetching each day once and stopping
    early once every team in want_teams has a fixture. A fixture is
    {team, opp, oppName, home, date (ET)} — the shape build_team_props
    consumes. Games already started or finished never count, and
    neither do preseason games (season.type 2/3 only, like the team
    logs). A day whose scoreboard pull fails is skipped — its games
    are simply not seen; if NO fixture is found at all and at least
    one day failed, FetchError is raised so the league degrades
    loudly instead of publishing an empty slate."""
    cfg = LEAGUES[lg]
    base = f"{API}/site/v2/sports/{cfg['sport']}/{cfg['code']}"
    fixtures = {}
    failed_days = 0
    for offset in range(TEAM_FIXTURE_HORIZON_DAYS + 1):
        if want_teams and want_teams <= set(fixtures):
            break
        payload = _scoreboard_day(base, today_et + timedelta(days=offset))
        if payload is None:
            failed_days += 1
            continue
        for ev in (payload or {}).get("events") or []:
            if (ev.get("season") or {}).get("type") not in (2, 3):
                continue
            for g in parse_scoreboard({"events": [ev]}):
                if g.get("state") != "pre":
                    continue
                d = game_et_date(g)
                home = (g.get("home") or {}).get("abbr")
                away = (g.get("away") or {}).get("abbr")
                if d is None or not home or not away:
                    continue
                for team, opp, is_home in ((home, away, True), (away, home, False)):
                    prev = fixtures.get(team)
                    if prev and prev["date"] <= d.isoformat():
                        continue
                    opp_side = (g.get("away") if is_home else g.get("home")) or {}
                    fixtures[team] = {"team": team, "opp": opp,
                                      "oppName": opp_side.get("name") or opp,
                                      "home": is_home, "date": d.isoformat()}
    if not fixtures and failed_days:
        raise FetchError(f"{lg}: next-fixture search found no games and "
                         f"{failed_days} scoreboard days failed")
    return fixtures


def build_team_props(lg, league, team_logs, today_et):
    """Team props for every team, each framed against its next
    fixture (see team_next_fixtures). Research line =
    floor(average) + 0.5 over the team's last 10 games for the stat —
    or over the venue subset of those 10 when the team has >= 5 games
    at the upcoming venue in them (lineBasis says which). Hit counts
    are exact counts for both directions over L5/L10/L20; `venue`
    counts the team's last 10 games at the upcoming venue. Returns
    (props, fixtures) so the caller can report fixture coverage."""
    ranks = team_def_ranks(team_logs)
    fixtures = team_next_fixtures(lg, today_et, set(team_logs))
    props = []
    for up in sorted(fixtures.values(), key=lambda f: (f["date"], f["team"])):
        entry = team_logs.get(up["team"])
        if not entry or len(entry["rows"]) < 5:
            continue
        rows = entry["rows"]
        game_date = datetime.strptime(up["date"], "%Y-%m-%d").date()
        last_date = datetime.strptime(rows[0]["d"], "%Y-%m-%d").date()
        rest_days = (game_date - last_date).days
        note = team_injury_note(lg, league, up["team"])
        opp_rank, opp_avg = ranks.get(up["opp"], (None, None))
        for key, label in TEAM_STAT_DEFS[lg]:
            series = [v for v in (team_stat_value(key, r) for r in rows) if v is not None]
            if len(series) < 5:
                continue
            venue_vals = []
            for r in rows[:10]:
                if r["home"] != up["home"]:
                    continue
                v = team_stat_value(key, r)
                if v is not None:
                    venue_vals.append(v)
            avg = mean(series[:10])
            venue_avg = mean(venue_vals) if venue_vals else None
            use_venue = len(venue_vals) >= 5
            line_avg = venue_avg if use_venue else avg
            line = math.floor(line_avg) + 0.5
            counts = {}
            for n, wname in ((5, "L5"), (10, "L10"), (20, "L20")):
                seg = series[:n]
                o = sum(1 for v in seg if v > line)
                counts[wname] = {"o": o, "u": len(seg) - o, "n": len(seg)}
            vseries = []
            for r in rows:
                if r["home"] != up["home"]:
                    continue
                v = team_stat_value(key, r)
                if v is not None:
                    vseries.append(v)
                if len(vseries) >= 10:
                    break
            vo = sum(1 for v in vseries if v > line)
            props.append({
                "league": lg, "team": up["team"], "teamName": entry["name"],
                "opp": up["opp"], "oppName": up["oppName"], "gameDate": up["date"],
                "home": up["home"], "stat": key, "statLabel": label, "line": line,
                "dir": "Over" if counts["L10"]["o"] >= counts["L10"]["u"] else "Under",
                "counts": counts,
                "venue": {"venue": "home" if up["home"] else "away",
                          "o": vo, "u": len(vseries) - vo, "n": len(vseries)},
                "avg": js_round1(avg),
                "venueAvg": js_round1(venue_avg) if venue_avg is not None else None,
                "venueN": len(venue_vals),
                "lineAvg": js_round1(line_avg),
                "lineBasis": "venue" if use_venue else "all",
                "oppDefRank": opp_rank, "oppDefAvg": opp_avg,
                "restDays": rest_days,
                "b2b": bool(lg in ("NBA", "NHL") and rest_days == 1),
                "shortWeek": bool(lg == "NFL" and rest_days <= 4),
                "injuryNote": note,
            })
    return props, fixtures


_APP_LOG_FIELDS = {"NBA": ("d", "opp", "home", "pf", "pa", "fh", "threes"),
                   "NFL": ("d", "opp", "home", "pf", "pa", "fh"),
                   "NHL": ("d", "opp", "home", "pf", "pa", "p1", "shots")}


def _app_team_logs(team_logs):
    """The team logs as shipped to the app in data-teams.js: per-league
    fields only (margin is pf-pa, derivable), last 25 games per team.
    Powers the team popup's game strips, splits and window toggle."""
    out = {}
    for lg, teams in (team_logs or {}).items():
        fields = _APP_LOG_FIELDS.get(lg, ("d", "opp", "home", "pf", "pa"))
        out[lg] = {
            ab: {"name": e.get("name") or ab,
                 "rows": [{k: r.get(k) for k in fields}
                          for r in (e.get("rows") or [])[:25]]}
            for ab, e in (teams or {}).items()}
    return out


def build_teams(league_objs, now_utc):
    """({league: [team props]}, {league: info}) for data-teams.js. A
    league whose team pull fails degrades to an empty prop list for
    that league (with the error in the info) rather than failing the
    run or wiping the other leagues' team props."""
    today_et = now_utc.astimezone(ET).date()
    leagues, info, team_logs = {}, {}, {}
    for lg in ("NBA", "NFL", "NHL"):
        try:
            logs = fetch_team_logs(lg, now_utc, today_et)
            props, fixtures = build_team_props(lg, league_objs[lg], logs, today_et)
            leagues[lg] = props
            team_logs[lg] = {
                ab: {"name": e.get("name") or ab,
                     "rows": [{k: r.get(k) for k in ("d", "opp", "home", "pf", "pa",
                                                      "margin", "fh", "p1", "threes",
                                                      "shots", "reb", "ast", "fgp", "tpp",
                                                      "p2", "p3", "saves", "svp",
                                                      "tyds", "pyds", "ryds", "tov")}
                              for r in e.get("rows") or []]}
                for ab, e in logs.items()}
            info[lg] = {"teams": len(logs), "teamProps": len(props),
                        "gamesLogged": sum(len(e["rows"]) for e in logs.values()),
                        "fixtureTeams": len(fixtures),
                        "teamsWithProps": len({p["team"] for p in props}),
                        "noFixture": sorted(set(logs) - set(fixtures))}
        except Exception as e:
            leagues[lg] = []
            info[lg] = {"teamProps": 0, "error": str(e)}
    return leagues, info, team_logs


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
    report = {"fetchedAt": fetched_at, "leagues": {}, "errors": [],
              "archiveSnapshotted": 0, "archiveGraded": 0, "archivePagesWritten": []}

    try:
        current = load_current()
    except Exception as e:
        print(json.dumps({"fetchedAt": fetched_at, "errors": [f"cannot load current data: {e}"]}))
        return 1

    team_data = None
    staged = {}
    league_objs = {}
    logs_prev_objs = {}
    failed = False
    for lg in ("NBA", "NFL", "NHL"):
        try:
            league, logs_prev, lrep = build_league(lg, current[lg], now_utc)
        except Exception as e:
            report["errors"].append(f"{lg}: {e}")
            failed = True
            continue
        league_objs[lg] = league
        logs_prev_objs[lg] = logs_prev
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
            "var TEAMS_DATA = window.__TEAMS_DATA || {fetchedAt: null, leagues: {}};\n"
        )

    # Team props (data-teams.js), from the same run. build_teams
    # degrades per league, so this never fails the run; the chunk is
    # part of the same all-or-nothing publish set as the other data
    # files (staged here, moved only on full success in repo mode).
    if not failed:
        team_leagues, team_info, team_logs = build_teams(league_objs, now_utc)
        team_data = {"props": team_leagues, "logs": team_logs}
        staged["data-teams.js"] = "window.__TEAMS_DATA = " + js_dumps(
            {"fetchedAt": fetched_at, "leagues": team_leagues,
             "logs": _app_team_logs(team_logs)}) + ";\n"
        report["teams"] = team_info
        report["teamProps"] = {lg: len(team_leagues[lg]) for lg in team_leagues}
        for lg, tinfo in team_info.items():
            if tinfo.get("error"):
                report["errors"].append(f"teams {lg}: {tinfo['error']}")

    # Results archive (snapshot + grade + render), from the same
    # dataset. Wrapped separately: an archive failure is reported but
    # never blocks the data publish. Runs before the pages so the
    # sitemap can carry the newest graded date.
    archive_outputs = {}
    archive_lastmod = None
    graded_ctx = None
    if not failed:
        try:
            if REPO_ROOT:
                state_path = os.path.join(REPO_ROOT, "archive", "pending.json")
            else:
                state_path = os.path.join(HERE, "staging", "archive", "pending.json")
            astate, corrupt = load_archive_state(state_path)
            if corrupt:
                report["archiveError"] = "archive/pending.json corrupt — treated as empty"
                report["errors"].append("archive: pending.json corrupt, treated as empty")
            archive_outputs, ainfo = run_archive(league_objs, logs_prev_objs, now_utc, astate)
            report.update(ainfo)
            if astate["graded"]:
                archive_lastmod = max(astate["graded"])
                _gh, _gm, _gd = archive_record(astate["graded"][archive_lastmod])
                graded_ctx = {"date": archive_lastmod, "hits": _gh,
                              "misses": _gm, "dnp": _gd}
        except Exception as e:
            report["archiveError"] = f"archive failed: {e}"
            archive_outputs = {}

    # Static league pages + sitemap, from the same dataset. A failure
    # here is reported but never blocks the data publish — the pages
    # simply regenerate on the next successful run.
    staged_root = {}
    if not failed:
        try:
            staged_root, page_info = generate_pages(league_objs, now_utc, archive_lastmod,
                                                    graded_ctx, team_data)
            report["pages"] = page_info
        except Exception as e:
            report["errors"].append(f"pages: {e}")
            staged_root = {}
    staged_root.update(archive_outputs)

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
