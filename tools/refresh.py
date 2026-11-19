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
    teams with a pre-game fixture in the slate window, at research
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
    if prop["dir"] != "Under" or prop["line"] != 0.5:
        return True
    if prop["key"] not in RARE_EVENT_KEYS.get(lg, ()):
        return True
    return l20_average(league, prop) >= RARE_L20_MIN - 1e-9


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
    return {"listed": listed, "window": window, "props_all": props_all,
            "props": props, "top_all": top25(props_all)[0]}


def build_league_page(lg, league, stamp, today_et, logo_uri):
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
    logo_html = ('<div class="site-logo"><a href="/" aria-label="LegLock home">'
                 '<img src="{}" alt="LEGLOCK" /></a></div>'.format(logo_uri)
                 if logo_uri else
                 '<div class="site-logo"><a href="/" aria-label="LegLock home">'
                 '<span class="site-footer-brand">LEGLOCK</span></a></div>')

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


def build_sitemap(run_date, archive_lastmod=None):
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
    archive_url = f"{SITE_ORIGIN}/archive/"
    archive_mod = archive_lastmod or run_date
    if archive_url in by_url:
        by_url[archive_url][1] = archive_mod
    else:
        entries.append([archive_url, archive_mod])
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for url, lastmod in entries:
        lines.append(f"  <url><loc>{url}</loc><lastmod>{lastmod}</lastmod></url>")
    lines.append("</urlset>")
    return "\n".join(lines) + "\n"


def generate_pages(league_objs, now_utc, archive_lastmod=None):
    """Return ({repo-relative path: content}, per-league info)."""
    now_et = now_utc.astimezone(ET)
    stamp = fmt_stamp(now_et)
    logo_uri = page_logo_uri()
    staged_root, info = {}, {}
    for lg in ("NBA", "NFL", "NHL"):
        page, pinfo = build_league_page(lg, league_objs[lg], stamp, now_et.date(), logo_uri)
        staged_root[f"{PAGE_LEAGUES[lg]['slug']}/index.html"] = page
        info[lg] = pinfo
    staged_root["sitemap.xml"] = build_sitemap(now_et.strftime("%Y-%m-%d"), archive_lastmod)
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


def snapshot_entries_for_league(lg, league, today_et):
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
    entries = []
    for p in sel["listed"]:
        gd_opp = info.get(p["team"])
        if gd_opp is None:
            continue
        gd, opp = gd_opp
        if gd < today_et:
            continue
        entries.append({
            "league": lg, "snapshotDate": today_et.isoformat(), "pid": p["pid"],
            "name": p["name"], "team": p["team"], "key": p["key"], "stat": p["stat"],
            "dir": p["dir"], "line": p["line"],
            "l5": list(featured_counts(p, "L5")), "l10": list(featured_counts(p, "L10")),
            "l20": list(featured_counts(p, "L20")), "gameDate": gd.isoformat(),
            "opp": opp,
        })
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
    logo_html = ('<div class="site-logo"><a href="/" aria-label="LegLock home">'
                 '<img src="{}" alt="LEGLOCK" /></a></div>'.format(logo_uri)
                 if logo_uri else
                 '<div class="site-logo"><a href="/" aria-label="LegLock home">'
                 '<span class="site-footer-brand">LEGLOCK</span></a></div>')
    return f"""<!doctype html>
<html lang="en" data-theme="light">
<head>
{GA4_SNIPPET}

<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
{ADS_SNIPPET}
<meta name="apple-mobile-web-app-title" content="LEGLOCK" />
<meta name="theme-color" content="#0b1220" />
{THEME_PIN_SNIPPET}
<title>{title}</title>
<meta name="description" content="{description}" />
<link rel="canonical" href="{SITE_ORIGIN}{canonical_path}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Sofia+Sans+Condensed:wght@600;700&family=Sofia+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/assets/leglock.css" />
{PAGE_STYLE}
</head>
<body><main>{logo_html}{PAGE_TABS}<h1 class="display" style="font-size:28px;font-weight:700;margin:14px 0 2px">{h1}</h1><p class="sub" style="margin:0 0 10px">{sub}</p><section class="content-body">
{body_html}</section>{PAGE_FOOTER}</main>
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
    others = " and ".join(
        '<a href="/{}/">{} player prop hit rates today</a>'.format(PAGE_LEAGUES[o]["slug"], o)
        for o in ("NBA", "NHL", "NFL"))
    parts.append(
        "<h2>More on LegLock</h2>\n"
        f"<p>See today's {others}, the <a href=\"/\">interactive prop board</a>, or learn "
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
            added += snapshot_entries_for_league(lg, league_objs[lg], today_et)
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


def team_upcoming(lg, league, today_et):
    """One entry per team with a pre-game fixture in the slate window
    (today ET for NBA/NHL, the current Thu–Mon week for the NFL):
    {team, opp, oppName, home, date (ET)}. Games already started or
    finished never produce team props."""
    if lg == "NFL":
        games = slate_games_nfl_week(league, today_et)
    else:
        games = [g for g in league["games"] if game_et_date(g) == today_et]
    out, seen = [], set()
    for g in games:
        if g.get("state") != "pre":
            continue
        d = game_et_date(g)
        home = (g.get("home") or {}).get("abbr")
        away = (g.get("away") or {}).get("abbr")
        if d is None or not home or not away:
            continue
        for team, opp, is_home in ((home, away, True), (away, home, False)):
            if team in seen:
                continue
            seen.add(team)
            opp_side = (g.get("away") if is_home else g.get("home")) or {}
            out.append({"team": team, "opp": opp,
                        "oppName": opp_side.get("name") or opp,
                        "home": is_home, "date": d.isoformat()})
    return out


def build_team_props(lg, league, team_logs, today_et):
    """Team props for the slate window. Research line =
    floor(average) + 0.5 over the team's last 10 games for the stat —
    or over the venue subset of those 10 when the team has >= 5 games
    at the upcoming venue in them (lineBasis says which). Hit counts
    are exact counts for both directions over L5/L10/L20; `venue`
    counts the team's last 10 games at the upcoming venue."""
    ranks = team_def_ranks(team_logs)
    props = []
    for up in team_upcoming(lg, league, today_et):
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
    return props


def build_teams(league_objs, now_utc):
    """({league: [team props]}, {league: info}) for data-teams.js. A
    league whose team pull fails degrades to an empty prop list for
    that league (with the error in the info) rather than failing the
    run or wiping the other leagues' team props."""
    today_et = now_utc.astimezone(ET).date()
    leagues, info = {}, {}
    for lg in ("NBA", "NFL", "NHL"):
        try:
            logs = fetch_team_logs(lg, now_utc, today_et)
            props = build_team_props(lg, league_objs[lg], logs, today_et)
            leagues[lg] = props
            info[lg] = {"teams": len(logs), "teamProps": len(props),
                        "gamesLogged": sum(len(e["rows"]) for e in logs.values())}
        except Exception as e:
            leagues[lg] = []
            info[lg] = {"teamProps": 0, "error": str(e)}
    return leagues, info


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
        team_leagues, team_info = build_teams(league_objs, now_utc)
        staged["data-teams.js"] = "window.__TEAMS_DATA = " + js_dumps(
            {"fetchedAt": fetched_at, "leagues": team_leagues}) + ";\n"
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
        except Exception as e:
            report["archiveError"] = f"archive failed: {e}"
            archive_outputs = {}

    # Static league pages + sitemap, from the same dataset. A failure
    # here is reported but never blocks the data publish — the pages
    # simply regenerate on the next successful run.
    staged_root = {}
    if not failed:
        try:
            staged_root, page_info = generate_pages(league_objs, now_utc, archive_lastmod)
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
