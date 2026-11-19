
(function(){
"use strict";
var $ = function(s, r){ return (r||document).querySelector(s); };
var $$ = function(s, r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); };
var LEAGUES = ["NBA","NFL","NHL"];
var SITE = { NBA:"basketball/nba", NFL:"football/nfl", NHL:"hockey/nhl" };
var SEASON_LABEL = { NBA:["2026-27","2025-26"], NFL:["2026","2025"], NHL:["2026-27","2025-26"] };
var PRIMARY = { NBA:"points", NFL:"passingYards", NHL:"points" };

var state = {
  league:"NBA", view:"discover", stat:"All", minRate:0, win:10, sortXgf:false, sortEfg:false, rankMode:"signal",
  teamOpen:{},
  minGames:0, minAvg:0, randNoHalf:false, gamesFoldOpen:false, statFoldOpen:false,
  secPlayer:false, secTeam:false,
  dirs:{Over:true, Under:true}, search:"", gameSel:null,
  injStatus:"All", injTeam:"All", idxSearch:"", logStat:"", logWin:10,
  randLeagues:{NBA:true, NFL:true, NHL:true},
  randGames:{},
  randStats:null,
  randDir:"Both",
  streakDir:"Both",
  ws:{ pid:null, stat:"points", dir:"Over", line:0.5, split:"all", opp:null }
};
window.__LL = { state: state };
/* Props view section folds (Player Props / Team Props) persist their
   open/closed choice in localStorage — the app's other UI choices are
   in-session only, so the folds keep their own keys. Both sections are
   pre-collapsed by default. The player key is versioned (v2): the old
   unversioned key may hold an "open" stored under the previous open-by-
   default behaviour, and it must not override the new closed default;
   it is simply ignored from now on. */
try {
  var _secP = window.localStorage.getItem("leglock.sec.player.v2");
  if (_secP !== null) state.secPlayer = _secP === "1";
  var _secT = window.localStorage.getItem("leglock.sec.team");
  if (_secT !== null) state.secTeam = _secT === "1";
} catch (e) {}

/* ----- iOS-safe background scroll lock, shared by every popup -----
   Reference-counted: the first popup to open saves the scroll position and
   pins the body (position:fixed at top:-scrollY — a plain overflow:hidden
   does NOT stop background scrolling on iOS Safari). The lock releases only
   when the LAST open popup closes, and the page then jumps back to exactly
   where the user was. Popup sheets are their own scroll containers, so
   their internal scrolling keeps working normally. Used by the game-log
   popup, Players to Watch and the team head-to-head panel. The Filters
   panel deliberately does NOT use this lock: it is an inline panel with
   no backdrop, so the board behind it must stay scrollable/touchable
   while it is open (adjust a filter, then scroll the board to check the
   live re-render). Because the lock is reference-counted and Filters
   never takes a count, a locked popup opened while Filters is up locks
   normally and closing it returns to the unlocked, Filters-open state. */
var scrollLocks = 0, scrollLockY = 0;
function lockScroll(){
  scrollLocks++;
  if (scrollLocks > 1) return;
  scrollLockY = window.scrollY || window.pageYOffset || 0;
  var b = document.body;
  b.style.position = "fixed";
  b.style.top = "-" + scrollLockY + "px";
  b.style.left = "0";
  b.style.right = "0";
  b.style.width = "100%";
  b.style.overflow = "hidden";
}
function unlockScroll(){
  if (scrollLocks <= 0){ scrollLocks = 0; return; }
  scrollLocks--;
  if (scrollLocks > 0) return;
  var b = document.body;
  b.style.position = "";
  b.style.top = "";
  b.style.left = "";
  b.style.right = "";
  b.style.width = "";
  b.style.overflow = "";
  window.scrollTo(0, scrollLockY);
}
window.__LL.lockScroll = lockScroll;
window.__LL.unlockScroll = unlockScroll;

/* live state: games start from the loaded data, then polls replace them */
var LG = {}, BOX = {};
LEAGUES.forEach(function(l){ LG[l] = (DATA.leagues[l].games || []).map(normalizeGame); });
window.__LL.LG = LG; window.__LL.BOX = BOX;
function normalizeGame(g){ g = JSON.parse(JSON.stringify(g)); g.clockSec = parseClock(g.clock); return g; }
function parseClock(c){
  if (!c) return 0;
  var m = String(c).match(/(\d+):(\d+)/);
  if (m) return parseInt(m[1],10)*60 + parseInt(m[2],10);
  var f = parseFloat(c); return isNaN(f) ? 0 : Math.round(f);
}
function fmtClock(sec){ sec = Math.max(0, Math.round(sec)); return Math.floor(sec/60) + ":" + ("0" + (sec%60)).slice(-2); }

/* ---------- helpers ---------- */
function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function fmtD(iso){ if(!iso) return ""; var d = new Date(iso.length <= 10 ? iso + "T12:00:00" : iso); return d.toLocaleDateString(undefined,{month:"short", day:"numeric"}); }
function fmtDT(iso){ if(!iso) return ""; var d = new Date(iso); return d.toLocaleString(undefined,{month:"short", day:"numeric"}) + " · " + d.toLocaleTimeString(undefined,{hour:"numeric", minute:"2-digit"}); }
function fmtTime(d){ return d.toLocaleTimeString(undefined,{hour:"numeric", minute:"2-digit", second:"2-digit"}); }
function fmtVal(v){ return (v == null || isNaN(v)) ? "—" : (Math.round(v*10)/10).toString().replace(/\.0$/,""); }
function L(){ return DATA.leagues[state.league]; }
function playerOf(lg, pid){ return (DATA.leagues[lg].players || {})[pid] || {}; }
function xgfOf(lg, pid){ if (lg !== "NHL") return null; var p = playerOf(lg, pid); return (p && p.xgf != null && !isNaN(p.xgf)) ? +p.xgf : null; }
function efgOf(lg, pid){ if (lg !== "NBA") return null; var p = playerOf(lg, pid); return (p && p.efg != null && !isNaN(p.efg)) ? +p.efg : null; }
function avatarHtml(lg, pid, name){
  var p = playerOf(lg, pid);
  if (p.img) return '<div class="avatar"><img src="' + esc(p.img) + '" alt="" loading="lazy" onerror="this.parentNode.textContent=\'' + esc((name||"P").charAt(0)) + '\'"></div>';
  return '<div class="avatar" aria-hidden="true">' + esc((name||"P").charAt(0)) + '</div>';
}
function dirRate(p, w){
  var r = (p.rates || {})[w]; if (!r) return null;
  return p.dir === "Over" ? r.o : r.u;
}
function barClass(v){ return v >= 70 ? "hi" : (v >= 50 ? "mid" : ""); }
function rateCell(p, w){
  var v = dirRate(p, w), r = (p.rates || {})[w];
  if (v == null) return '<div class="rate"><div class="lab"><span>' + w + '</span><b>—</b></div><div class="bar"><i style="width:0%"></i></div></div>';
  return '<div class="rate"><div class="lab"><span>' + w + ' · ' + r.n + 'g</span><b>' + v + '%</b></div><div class="bar"><i class="' + barClass(v) + '" style="width:' + v + '%"></i></div></div>';
}
function searchMatch(txt){ return !state.search || txt.toLowerCase().indexOf(state.search) >= 0; }

/* ---------- injured players: hidden from prop surfaces, never deleted ----------
   The exclusion is a display filter recomputed from the injury list the
   page currently holds (the same data behind the Injuries tab), so
   it re-evaluates on every render against the current data: while a
   player is on the injury report their props stay off the prop surfaces,
   and the moment a refresh's list no longer names them, every prop comes
   back on its own — nothing here deletes or edits prop/player data.
   Matching is by player identity: exact name, preferring the tracked
   player whose team name matches the injury entry's team. Any listed
   status counts (Out, Doubtful, Questionable, Day-to-Day, ...). */
var _injMemo = {};
function injuredInfo(lg){
  var league = DATA.leagues[lg] || {};
  var inj = league.injuries || [];
  var memo = _injMemo[lg];
  if (memo && memo.src === inj) return memo.info;
  var players = league.players || {};
  var byName = {};
  Object.keys(players).forEach(function(pid){
    var p = players[pid];
    if (p && p.name) (byName[p.name] = byName[p.name] || []).push(pid);
  });
  var pids = {}, names = {};
  inj.forEach(function(i){
    if (!i || !i.name) return;
    names[i.name] = 1;
    var cands = byName[i.name] || [], pick = null;
    cands.forEach(function(pid){ if (i.team && players[pid].teamName === i.team) pick = pid; });
    if (pick) pids[pick] = 1;
    else if (cands.length === 1) pids[cands[0]] = 1;
    else cands.forEach(function(pid){ pids[pid] = 1; });
  });
  var info = { pids: pids, names: names };
  _injMemo[lg] = { src: inj, info: info };
  return info;
}
function isInjured(lg, p){
  if (!p) return false;
  var info = injuredInfo(lg);
  if (p.pid && info.pids[p.pid]) return true;
  /* fallback for a prop whose player id is not in the tracked pool:
     an exact name match against the injury list still hides it */
  var players = (DATA.leagues[lg] || {}).players || {};
  if ((!p.pid || !players[p.pid]) && p.name && info.names[p.name]) return true;
  return false;
}

/* ---------- Games window: headline hit rate + average ----------
   Last 10 is the board's canonical window, so it reads the prop's own
   L10 rate and average exactly as before. The other windows (5 / 15 / 50)
   are computed from the merged game logs — this season first, then last
   season, the same rows the game-log popup windows use — over however
   many of the player's most recent games exist. The research line never
   changes: it stays set from the L10 average. Results are cached per
   prop + window for the life of the page's data. */
var WIN_OPTS = [5, 10, 15, 50];
function winVal(row, key){
  var s = row.s || {};
  if (key === "combo"){
    if (s.points == null || s.totalRebounds == null || s.assists == null) return null;
    return s.points + s.totalRebounds + s.assists;
  }
  var v = s[key];
  return (v == null || isNaN(v)) ? null : v;
}
function winStat(lg, p){
  var w = state.win || 10;
  if (p._wc && p._wc.w === w) return p._wc.v;
  var out = null;
  if (w === 10){
    var r = dirRate(p, "L10");
    if (r != null){
      var rr = (p.rates || {})["L10"] || {};
      var nn = rr.n || p.gp || 0;
      out = { rate: r, avg: p.l10avg, n: nn, hits: Math.round(r * nn / 100) };
    }
  } else {
    var lgData = DATA.leagues[lg] || {};
    var rows = ((lgData.logs || {})[p.pid] || []).concat((lgData.logsPrev || {})[p.pid] || []);
    var vals = [];
    rows.forEach(function(row){ var v = winVal(row, p.key); if (v != null) vals.push(v); });
    vals = vals.slice(0, w);
    if (vals.length){
      var hits = 0, sum = 0;
      vals.forEach(function(v){ sum += v; if (p.dir === "Over" ? v > p.line : v < p.line) hits++; });
      out = { rate: Math.round(100 * hits / vals.length), avg: sum / vals.length, n: vals.length, hits: hits };
    }
  }
  p._wc = { w: w, v: out };
  return out;
}
/* A prop's hit rate at its board line over the player's whole current
   season — the Shuffle pool's qualifying test. Same conventions as
   winStat's log-computed windows (winVal values, so combos need all
   three parts; a game counts only when the stat was recorded in it;
   the featured direction p.dir against the board line p.line), but the
   rows are this season's logs only — never logsPrev — with no slice:
   every game the player has logged this season counts, however few.
   No values at all returns null, and the pool treats null as not
   qualifying, exactly like a window with no games. Cached per prop. */
function seasonRate(lg, p){
  if (p._sr !== undefined) return p._sr;
  var lgData = DATA.leagues[lg] || {};
  var rows = (lgData.logs || {})[p.pid] || [];
  var vals = [];
  rows.forEach(function(row){ var v = winVal(row, p.key); if (v != null) vals.push(v); });
  var out = null;
  if (vals.length){
    var hits = 0;
    vals.forEach(function(v){ if (p.dir === "Over" ? v > p.line : v < p.line) hits++; });
    out = Math.round(100 * hits / vals.length);
  }
  p._sr = out;
  return out;
}
window.__LL.seasonRate = seasonRate;

/* ---------- window values: median / margin / spread ----------
   The actual stat values behind a prop's selected-window numbers,
   taken from the same merged logs (this season first, then last)
   the non-L10 windows already use, sliced to the selected Games
   window. Cached per prop + window, like winStat. The median sits
   next to the average so one huge game cannot silently carry the
   number; margin and standard deviation live in the game-log popup. */
function winVals(lg, p){
  var w = state.win || 10;
  if (p._wv && p._wv.w === w) return p._wv.v;
  var lgData = DATA.leagues[lg] || {};
  var rows = ((lgData.logs || {})[p.pid] || []).concat((lgData.logsPrev || {})[p.pid] || []);
  var vals = [];
  rows.forEach(function(row){ var v = winVal(row, p.key); if (v != null) vals.push(v); });
  vals = vals.slice(0, w);
  p._wv = { w: w, v: vals };
  return vals;
}
function medianOf(vals){
  if (!vals.length) return null;
  var s = vals.slice().sort(function(a, b){ return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/* population standard deviation: how far the player's games
   typically land from his own average over the same values */
function sdOf(vals, avg){
  if (vals.length < 2) return null;
  var a = (avg == null) ? avgOf(vals) : avg;
  var acc = 0;
  vals.forEach(function(v){ acc += (v - a) * (v - a); });
  return Math.sqrt(acc / vals.length);
}

/* ---------- opponent context (card face) ----------
   One compact line on the prop card: the upcoming opponent and what
   they allow in this stat, the player's home/away averages for the
   stat this season, and a B2B flag when the team played yesterday.
   Defensive averages aggregate every tracked player's current-season
   log rows by the opponent named in the row — the board's own logs —
   ranked across every opponent appearing in them (rank 1 allows the
   least). The fixture (opponent, home/away, back-to-back) comes from
   the team-props data, which frames every team's next game; if that
   is unavailable, the slate in DATA supplies the opponent only.
   Pace is deliberately absent: the team data carries points for and
   against, not the possession inputs (attempts, free throws,
   turnovers) a real pace number needs. */
var _defMemo = {};
function defTable(lg, key){
  var lgData = DATA.leagues[lg] || {};
  var logs = lgData.logs || {};
  var memo = _defMemo[lg + "|" + key];
  if (memo && memo.src === logs) return memo.tab;
  var agg = {};
  Object.keys(logs).forEach(function(pid){
    (logs[pid] || []).forEach(function(row){
      var v = winVal(row, key);
      if (v == null) return;
      var opp = String(row.opp || "").split(" ").pop();
      if (!opp) return;
      var a = agg[opp] || (agg[opp] = { sum: 0, n: 0 });
      a.sum += v; a.n++;
    });
  });
  var tab = {};
  Object.keys(agg).forEach(function(opp){ tab[opp] = { avg: agg[opp].sum / agg[opp].n, n: agg[opp].n }; });
  Object.keys(tab).sort(function(a, b){ return tab[a].avg - tab[b].avg; })
    .forEach(function(opp, i){ tab[opp].rank = i + 1; });
  _defMemo[lg + "|" + key] = { src: logs, tab: tab };
  return tab;
}
function ordinal(n){
  var v = n % 100;
  if (v >= 11 && v <= 13) return n + "th";
  switch (n % 10){ case 1: return n + "st"; case 2: return n + "nd"; case 3: return n + "rd"; default: return n + "th"; }
}
function nextFixture(lg, team){
  var td = window.TEAMS_DATA;
  var list = (td && td.leagues && td.leagues[lg]) || [];
  for (var i = 0; i < list.length; i++){
    if (list[i].team === team) return { opp: list[i].opp, home: !!list[i].home, b2b: !!list[i].b2b, date: list[i].gameDate || "" };
  }
  var games = (DATA.leagues[lg] || {}).games || {};
  var mine = Object.keys(games).map(function(k){ return games[k]; })
    .filter(function(g){ return g && g.home && g.away && (g.home.abbr === team || g.away.abbr === team) && g.state !== "post"; })
    .sort(function(a, b){ return String(a.date || "").localeCompare(String(b.date || "")); });
  if (!mine.length) return null;
  var g = mine[0], home = g.home.abbr === team;
  return { opp: home ? g.away.abbr : g.home.abbr, home: home, b2b: false, date: g.date || "" };
}
function oppCtxHtml(p, lg){
  var parts = [];
  var fx = nextFixture(lg, p.team);
  if (fx && fx.opp){
    var head = (fx.home ? "vs " : "@ ") + fx.opp;
    var dt = defTable(lg, p.key)[fx.opp];
    if (dt) head += " · allows " + fmtVal(dt.avg) + " (" + ordinal(dt.rank) + ")";
    parts.push(head);
  }
  var rows = ((DATA.leagues[lg] || {}).logs || {})[p.pid] || [];
  var hS = 0, hN = 0, aS = 0, aN = 0;
  rows.forEach(function(row){
    var v = winVal(row, p.key);
    if (v == null) return;
    if (String(row.opp || "").indexOf("vs") === 0){ hS += v; hN++; } else { aS += v; aN++; }
  });
  var splits = [];
  if (hN) splits.push("Home " + fmtVal(hS / hN));
  if (aN) splits.push("Away " + fmtVal(aS / aN));
  if (splits.length) parts.push(splits.join(" · "));
  if (fx && fx.b2b) parts.push("B2B");
  if (!parts.length) return "";
  return '<div class="oppctx">' + esc(parts.join(" · ")) + '</div>';
}

/* ---------- Signal Score (Signal ranking mode) ----------
   SignalScore = HitRateScore × VolumeScore × SampleScore × MeaningScore,
   computed per prop for its listed direction over the SELECTED Games
   window (the window's hit rate, the window's stat average, the games
   played in that window; the research line as-is). Signal mode changes
   ORDER ONLY — every filter and display rule still decides what appears,
   and every card keeps displaying the RAW window hit rate.

   The hit rate fed into HitRateScore is first shrunk toward its group
   with an Empirical-Bayes Beta-Binomial prior (the beta-binomial form of
   the shrinkage idea — James–Stein is the normal-means cousin of the same
   principle and is not implemented separately):
     shrunken = (α + k) / (α + β + n)
   with k = hits in the window and n = games in the window. The prior is
   estimated per group (league + stat + direction) by method of moments
   across that group's FULL listing pool in the current window — before
   any user filter is applied — with the prior strength (α + β) clamped
   to 2–40. A group with fewer than 10 listings falls back to the
   league + direction prior; a moment estimate with no positive
   between-listing variance falls back to the group mean at strength 5.
   Priors are cached per league + window, so they recompute exactly when
   the window or league changes. Classic mode never touches any of this. */
var _priorCache = {};
function momPrior(recs){
  var m = recs.length, sn = 0, sh = 0;
  recs.forEach(function(r){ sn += r.n; sh += r.hits; });
  if (!sn || !m) return null;
  var mu = sh / sn;
  var s2 = 0;
  recs.forEach(function(r){ var d = r.rate - mu; s2 += r.n * d * d; });
  s2 /= sn;
  /* between-listing variance, net of the average sampling variance */
  var tau2 = s2 - mu * (1 - mu) * m / sn;
  var muc = Math.min(0.98, Math.max(0.02, mu));
  var nu = tau2 > 0 ? (mu * (1 - mu) / tau2 - 1) : 5;
  nu = Math.min(40, Math.max(2, nu));
  return { a: muc * nu, b: (1 - muc) * nu, mu: mu, count: m };
}
function ebPriors(lg){
  var w = state.win || 10, ck = lg + "|" + w;
  if (_priorCache[ck]) return _priorCache[ck];
  var groups = {}, byDir = {};
  (DATA.leagues[lg].props || []).forEach(function(p){
    var ws = winStat(lg, p);
    if (!ws || !ws.n) return;
    var rec = { rate: ws.rate / 100, n: ws.n, hits: ws.hits != null ? ws.hits : Math.round(ws.rate * ws.n / 100) };
    var gk = p.key + "|" + p.dir;
    (groups[gk] = groups[gk] || []).push(rec);
    (byDir[p.dir] = byDir[p.dir] || []).push(rec);
  });
  var out = { groups: {}, byDir: {} };
  Object.keys(groups).forEach(function(k){ out.groups[k] = momPrior(groups[k]); });
  Object.keys(byDir).forEach(function(k){ out.byDir[k] = momPrior(byDir[k]); });
  _priorCache[ck] = out;
  return out;
}
function ebShrunkRate(lg, p, ws){
  var pr = ebPriors(lg);
  var g = pr.groups[p.key + "|" + p.dir];
  var prior = (g && g.count >= 10) ? g : pr.byDir[p.dir];
  if (!prior) return ws.rate / 100;
  var k = ws.hits != null ? ws.hits : Math.round(ws.rate * ws.n / 100);
  return (prior.a + k) / (prior.a + prior.b + ws.n);
}
function signalScore(lg, p){
  var ws = winStat(lg, p);
  if (!ws) return null;
  var shrunk = ebShrunkRate(lg, p, ws);
  var hit = 100 * (1 - Math.pow(1 - shrunk, 1.3));
  var avg = ws.avg, line = p.line, vol;
  if (avg < 0.15) vol = 0.15;
  else if (avg < 0.4) vol = 0.35 + avg * 0.8;
  else vol = Math.min(1.0, 0.55 + avg * 0.35);
  if ((p.dir === "Under" && avg < line) || (p.dir === "Over" && avg > line)) vol = Math.min(1.0, vol * 1.15);
  var sample;
  if (ws.n >= 10) sample = 1.0;
  else if (ws.n >= 8) sample = 0.92;
  else if (ws.n >= 6) sample = 0.78;
  else if (ws.n >= 4) sample = 0.60;
  else sample = 0.40;
  var meaning;
  if (line === 0.5 && avg < 0.3) meaning = 0.55;
  else if (line === 0.5 && avg < 0.6) meaning = 0.75;
  else meaning = 1.0;
  if (line >= 1.5) meaning = Math.min(1.0, meaning + 0.1);
  return { score: hit * vol * sample * meaning, hit: hit, vol: vol, sample: sample, meaning: meaning,
           rate: ws.rate, avg: avg, n: ws.n, shrunk: shrunk };
}
/* Signal ordering: score desc, ties on the RAW window hit rate, then the
   window average. Null scores (no window data) sink to the bottom. */
function cmpSignal(a, b){
  var sa = a ? a.score : -1, sb = b ? b.score : -1;
  if (sb !== sa) return sb - sa;
  var ra = a ? a.rate : -1, rb = b ? b.rate : -1;
  if (rb !== ra) return rb - ra;
  var aa = a ? a.avg : -1, ab = b ? b.avg : -1;
  return ab - aa;
}
function winRowHtml(p, lg){
  var ws = winStat(lg, p);
  if (!ws) return "";
  /* Sample honesty, all leagues: a headline window built on fewer than 8
     games is labelled, not hidden — the rate stays, the reader sees the
     thin base. Regression risk: the headline window looks extreme next to
     the longer L20 view — either the window rate is 90%+ while the L20
     rate sits at least 25 points lower, or the player is riding an 8+
     game streak in this direction while his L20 rate in that direction
     is under 60%. Informational only — the prop stays listed. */
  var tags = "";
  if (ws.n < 8) tags += '<span class="smallsample">Small sample</span>';
  var l20 = dirRate(p, "L20");
  if (l20 != null && ((ws.rate >= 90 && ws.rate - l20 >= 25) || (p.streak >= 8 && l20 < 60)))
    tags += '<span class="regtag" data-regtag="1" data-no-log role="button" tabindex="0" aria-haspopup="true" aria-expanded="false" aria-controls="regPop" aria-label="Regression risk — show definition">Regression risk</span>';
  var med = medianOf(winVals(lg, p));
  return '<div class="winrow"><span>Last ' + ws.n + ' games</span><b>' + ws.rate + '%</b><span>hit · avg <b>' + fmtVal(ws.avg) + '</b>' + (med != null ? ' · med <b>' + fmtVal(med) + '</b>' : '') + '</span>' + tags + '</div>';
}

/* ---------- tabs ---------- */
function showView(name){
  state.view = name;
  $$(".tab").forEach(function(t){ t.setAttribute("aria-selected", t.getAttribute("data-view") === name ? "true" : "false"); });
  $$(".view").forEach(function(v){ v.classList.toggle("active", v.id === "view-" + name); });
  window.scrollTo({top:0, behavior:"smooth"});
}
$$(".tab").forEach(function(t){ t.addEventListener("click", function(){ showView(t.getAttribute("data-view")); }); });

/* ---------- info pages (Privacy / About / Guides / Responsible Play / Contact) ----------
   The pages are static .view sections in the markup. Opening one swaps the
   board view for the page; Back restores the exact board tab and scroll
   position the user left, with league/filters/search state untouched. */
var pageReturn = null;
function openPage(name){
  if (!document.getElementById("view-" + name)) return;
  if (!pageReturn) pageReturn = { view: state.view, y: window.scrollY || 0 };
  $$(".tab").forEach(function(t){ t.setAttribute("aria-selected", "false"); });
  $$(".view").forEach(function(v){ v.classList.toggle("active", v.id === "view-" + name); });
  window.scrollTo(0, 0);
}
function closePage(){
  var back = pageReturn ? pageReturn.view : "discover";
  var y = pageReturn ? pageReturn.y : 0;
  pageReturn = null;
  state.view = back;
  $$(".tab").forEach(function(t){ t.setAttribute("aria-selected", t.getAttribute("data-view") === back ? "true" : "false"); });
  $$(".view").forEach(function(v){ v.classList.toggle("active", v.id === "view-" + back); });
  window.scrollTo(0, y);
}
document.addEventListener("click", function(e){
  if (!e.target.closest) return;
  var p = e.target.closest("[data-page]");
  if (p){ openPage(p.getAttribute("data-page")); return; }
  if (e.target.closest("[data-back]")) closePage();
});
window.__LL.openPage = openPage;
window.__LL.closePage = closePage;

/* ---------- league switching ---------- */
function setLeague(lg){
  state.league = lg; state.stat = "All"; state.gameSel = null; state.injStatus = "All"; state.injTeam = "All";
  state.sortXgf = false; state.sortEfg = false;
  state.ws.pid = null; state.ws.opp = null;
  $$(".leagues .pill").forEach(function(b){ b.setAttribute("aria-pressed", b.getAttribute("data-league") === lg ? "true" : "false"); });
  renderAll();
}
$$(".leagues .pill").forEach(function(b){ b.addEventListener("click", function(){ setLeague(b.getAttribute("data-league")); }); });
  window.__LL.setLeague = setLeague;

/* ---------- games strip + team head-to-head ---------- */
function gameStatusText(g){
  if (g.state === "in") return String(g.detail || "").replace(/^\s*\d{1,2}:\d{2}\s*[-–—·]\s*/, "").replace(/\s*[-–—·]\s*\d{1,2}:\d{2}\s*$/, "") + (g.clockSec > 0 ? " · " + fmtClock(g.clockSec) : "");
  if (g.state === "post") return "Final";
  return fmtDT(g.date);
}
function shortTeamName(name, abbr){
  if (!name) return "";
  var parts = String(name).trim().split(/\s+/);
  var last = parts[parts.length - 1];
  return (last && last !== abbr) ? last : "";
}
  function fmtGameWhen(iso){
    if (!iso) return "";
    var d = new Date(iso), now = new Date();
    var day = function(x){ return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((day(d) - day(now)) / 86400000);
    var tm = d.toLocaleTimeString(undefined,{hour:"numeric", minute:"2-digit"});
    if (diff === 0) return "Today \u00B7 " + tm;
    if (diff === 1) return "Tomorrow \u00B7 " + tm;
    if (diff === -1) return "Yesterday \u00B7 " + tm;
    return d.toLocaleDateString(undefined,{weekday:"short"}) + ", " + d.toLocaleDateString(undefined,{month:"short", day:"numeric"}) + " \u00B7 " + tm;
  }
  /* the feed's status detail already embeds the game clock ("5:43 - 2nd
     Quarter"); strip it at render so the only clock on a live card is the
     appended one — in gameStatusHtml that is the span the 1-second ticker
     keeps live — instead of the time showing twice on every live box */
  function detailNoClock(g){
    return String(g.detail || "")
      .replace(/^\s*(?:\d{1,2}:\d{2}|\d{1,2}\.\d{1,2})\s*[-–—·]\s*/, "")
      .replace(/\s*[-–—·]\s*(?:\d{1,2}:\d{2}|\d{1,2}\.\d{1,2})\s*$/, "")
      .trim();
  }
  function gameStatusLine(g){
    if (g.state === "in") return detailNoClock(g) + (g.clockSec > 0 ? " \u00B7 " + fmtClock(g.clockSec) : "");
    if (g.state === "post") return "Final";
    return fmtGameWhen(g.date);
  }
  function gameStatusHtml(g){
    if (g.state === "in" && g.clockSec > 0) return esc(detailNoClock(g)) + ' \u00B7 <span data-clock="' + esc(g.id) + '">' + fmtClock(g.clockSec) + '</span>';
    return esc(gameStatusLine(g));
  }
  function gameBoxHtml(g, lg){
    var aWin = g.state !== "pre" && (+g.away.score > +g.home.score), hWin = g.state !== "pre" && (+g.home.score > +g.away.score);
    var label = (g.away.name || g.away.abbr) + ' at ' + (g.home.name || g.home.abbr) + ', ' + gameStatusLine(g)
      + (g.state === "pre" ? '' : ', score ' + (g.away.score || "0") + ' to ' + (g.home.score || "0")) + '. Tap for players to watch.';
    return '<button class="game' + (g.state === "in" ? " is-live" : "") + '" data-gid="' + esc(g.id) + '" data-lg="' + esc(lg) + '" aria-label="' + esc(label) + '">'
      + '<span class="gteamrow' + (aWin ? " win" : "") + '"><span class="gabbr">' + esc(g.away.abbr) + '</span><span class="gsc" data-score="away">' + (g.state === "pre" ? "" : esc(g.away.score || "0")) + '</span></span>'
      + '<span class="gteamrow' + (hWin ? " win" : "") + '"><span class="gabbr">' + esc(g.home.abbr) + '</span><span class="gsc" data-score="home">' + (g.state === "pre" ? "" : esc(g.home.score || "0")) + '</span></span>'
      + '<span class="time">' + gameStatusHtml(g) + '</span>'
      + '<span class="gwatch">Players to watch <span aria-hidden="true">\u203A</span></span></button>';
  }
  window.__LL.gameBoxHtml = gameBoxHtml;
  window.__LL.gameStatusLine = gameStatusLine;
  window.__LL.gameStatusHtml = gameStatusHtml;
  /* strip order: games in progress first (red), then upcoming games that
     haven't started, then finals last — chronological inside each group,
     applied across the merged today + next-day list */
  function stripGames(games){
    var rank = { "in":0, "pre":1, "post":2 };
    return (games || []).slice().sort(function(a, b){
      var ra = rank[a.state] != null ? rank[a.state] : 3, rb = rank[b.state] != null ? rank[b.state] : 3;
      if (ra !== rb) return ra - rb;
      return String(a.date || "").localeCompare(String(b.date || ""));
    });
  }
  function updateGamesArrows(){
    var el = $("#gamesStrip"), prev = $("#gamesPrev"), next = $("#gamesNext");
    if (!el || !next) return;
    var max = el.scrollWidth - el.clientWidth, x = el.scrollLeft;
    if (prev) prev.hidden = !(max > 4 && x > 4);
    next.hidden = !(max > 4 && x < max - 4);
  }
  window.__LL.updateGamesArrows = updateGamesArrows;
  function renderGamesStrip(){
    var el = $("#gamesStrip");
    var sx = el ? el.scrollLeft : 0;
    var games = stripGames(LG[state.league] || []);
    el.innerHTML = games.length ? games.map(function(g){ return gameBoxHtml(g, state.league); }).join("")
      : '<span style="color:var(--ink3);font-size:13px">No games on the schedule for ' + state.league + ' right now.</span>';
    $$("#gamesStrip .game").forEach(function(b){
      b.addEventListener("click", function(){
        if (window.__LL.openPlayersToWatch) window.__LL.openPlayersToWatch(state.league, b.getAttribute("data-gid"));
      });
    });
    if (el) el.scrollLeft = sx;
    updateGamesArrows();
  }
  window.__LL.renderGamesStrip = renderGamesStrip;
  window.__LL.stripGames = stripGames;
  (function(){
    var el = $("#gamesStrip"), prev = $("#gamesPrev"), next = $("#gamesNext");
    if (next) next.addEventListener("click", function(){ if (el) el.scrollBy({ left: Math.max(120, Math.round(el.clientWidth * 0.8)), behavior:"smooth" }); });
    if (prev) prev.addEventListener("click", function(){ if (el) el.scrollBy({ left: -Math.max(120, Math.round(el.clientWidth * 0.8)), behavior:"smooth" }); });
    if (el) el.addEventListener("scroll", updateGamesArrows, { passive:true });
    window.addEventListener("resize", updateGamesArrows);
  })();
function pairKey(a, b){ return [a, b].sort().join("|"); }
function renderTeamH2hPanel(){
  var panel = $("#teamH2hPanel");
  if (!state.gameSel){ panel.className = "h2hpanel"; panel.innerHTML = ""; return; }
  var g = (LG[state.league] || []).filter(function(x){ return x.id === state.gameSel; })[0];
  if (!g){ panel.className = "h2hpanel"; panel.innerHTML = ""; return; }
  var meetings = (L().h2h || {})[pairKey(g.away.abbr, g.home.abbr)] || [];
  var head = '<h3>' + esc(g.away.name) + ' vs ' + esc(g.home.name) + ' — head-to-head</h3>';
  if (!meetings.length){
    panel.innerHTML = head + '<div class="sub">No meeting history between these two teams in the schedule data for this season or last — nothing to show yet.</div>';
    panel.className = "h2hpanel open"; return;
  }
  function teamAgg(abbr){
    var scored = 0, allowed = 0, wins = 0;
    meetings.forEach(function(m){
      var mine = (m.home === abbr) ? +m.hs : +m.as, theirs = (m.home === abbr) ? +m.as : +m.hs;
      scored += mine; allowed += theirs; if (mine > theirs) wins++;
    });
    return { avg:(scored/meetings.length), allow:(allowed/meetings.length), wins:wins };
  }
  var A = teamAgg(g.away.abbr), H = teamAgg(g.home.abbr);
  function aggHtml(abbr, nm, ag){
    return '<div class="h2hteam"><b>' + esc(abbr) + '</b> ' + esc(nm) + '<div><span>Wins in meetings</span><b>' + ag.wins + ' / ' + meetings.length + '</b></div>'
      + '<div><span>Avg scored</span><b>' + fmtVal(ag.avg) + '</b></div><div><span>Avg allowed</span><b>' + fmtVal(ag.allow) + '</b></div></div>';
  }
  var rows = meetings.map(function(m){
    var wAbbr = (+m.hs > +m.as) ? m.home : m.away;
    return '<div class="meet"><span class="md">' + fmtD(m.d) + '</span><span>' + esc(m.away) + ' @ ' + esc(m.home) + '</span><span class="mw">' + esc(m.as) + ' – ' + esc(m.hs) + ' · ' + esc(wAbbr) + '</span></div>';
  }).join("");
  panel.innerHTML = head + '<div class="sub">Recent meetings from team schedules (this season and last). Team totals and totals allowed are from those meetings.</div>'
    + '<div class="h2hgrid">' + aggHtml(g.away.abbr, g.away.name, A) + aggHtml(g.home.abbr, g.home.name, H) + '</div>' + rows;
  panel.className = "h2hpanel open";
}
/* the open team head-to-head panel holds one scroll lock while it is shown */
var h2hLockHeld = false;
function renderTeamH2h(){
  renderTeamH2hPanel();
  var open = $("#teamH2hPanel").classList.contains("open");
  if (open && !h2hLockHeld){ h2hLockHeld = true; lockScroll(); }
  else if (!open && h2hLockHeld){ h2hLockHeld = false; unlockScroll(); }
}

/* ---------- Discover ---------- */
function statDefs(lg){ return DATA.leagues[lg].statDefs; }
function allStatLabels(lg){
  var labels = statDefs(lg).map(function(s){ return s.label; });
  if (lg === "NBA") labels.push("Pts+Reb+Ast");
  return labels;
}
function renderStatChips(){
  var labels = ["All"].concat(allStatLabels(state.league));
  var html = labels.map(function(s){
    return '<button class="chip" data-stat="' + esc(s) + '" aria-pressed="' + (state.stat === s ? "true" : "false") + '">' + esc(s) + '</button>';
  }).join("");
  $("#statChips").innerHTML = html;
  /* NBA only: the eFG% sort toggle lives in the stat row as a chip,
     immediately after Pts+Reb+Ast. It is the page's only eFG% control —
     tapping sorts the visible cards by eFG% highest first (players with
     no eFG% value at the bottom, cards stay visible), tapping again
     turns the sort off. It is not a stat filter: it carries no data-stat
     and never changes state.stat, and it is kept out of the Filters
     panel's mirrored stat chips below. */
  if (state.league === "NBA"){
    var efgBtn = document.createElement("button");
    efgBtn.className = "chip sortbtn sortEfgBtn";
    efgBtn.type = "button";
    efgBtn.textContent = "eFG%";
    efgBtn.setAttribute("aria-pressed", state.sortEfg ? "true" : "false");
    efgBtn.setAttribute("aria-label", "Sort board by eFG%, highest first");
    efgBtn.addEventListener("click", function(){ state.sortEfg = !state.sortEfg; syncEfgUI(); renderDiscover(); });
    var pra = null;
    $$("#statChips .chip").forEach(function(c){ if (c.getAttribute("data-stat") === "Pts+Reb+Ast") pra = c; });
    if (pra && pra.nextSibling) $("#statChips").insertBefore(efgBtn, pra.nextSibling);
    else $("#statChips").appendChild(efgBtn);
  }
  $$("#statChips .chip[data-stat]").forEach(function(c){ c.addEventListener("click", function(){ state.stat = c.getAttribute("data-stat"); renderStatChips(); renderDiscover(); }); });
  $("#filterStatChips").innerHTML = html;
  $$("#filterStatChips .chip").forEach(function(c){ c.addEventListener("click", function(){ state.stat = c.getAttribute("data-stat"); renderStatChips(); renderDiscover(); }); });
  /* the collapsed Stats fold header names the active stat */
  if (typeof syncStatFoldSum === "function") syncStatFoldSum();
}
function propCard(p, lg){
  var l10 = dirRate(p, "L10");
  /* Signal mode only: the Why? breakdown rides on the card as data
     attributes, computed by the same signalScore() that ordered the
     board, so the popover always matches the ranking. Classic mode
     renders no Why? target at all. */
  var sig = state.rankMode === "signal" ? signalScore(lg, p) : null;
  var xv = xgfOf(lg, p.pid); var ev = efgOf(lg, p.pid);
  return '<article class="card" data-open-logs="' + esc(p.pid) + '" data-stat-key="' + esc(p.key) + '" data-lg="' + esc(lg) + '" role="button" tabindex="0" aria-label="Open game log for ' + esc(p.name) + ' \u2014 ' + esc(p.stat) + '">'
    + '<div class="cardtop">' + avatarHtml(lg, p.pid, p.name)
    + '<div class="who"><div class="nm">' + esc(p.name) + '</div><div class="tm">' + esc(p.team) + (p.pos ? ' · ' + esc(p.pos) : '') + ' · ' + esc(lg) + '</div>' + (xv != null ? '<div class="tm">xGF% ' + xv.toFixed(1) + ' · MoneyPuck</div>' : '') + (ev != null ? '<div class="tm">eFG% ' + ev.toFixed(1) + '</div>' : '') + nflCardMetaHtml(p, lg) + '</div>'
    + '<div class="streak' + (p.streak >= 5 ? " hot" : "") + '"><b>' + p.streak + '</b><span>' + (p.dir === "Over" ? "Over" : "Under") + ' streak</span></div></div>'
    + '<div class="linebox"><span class="dir ' + (p.dir === "Over" ? "over" : "under") + '">' + p.dir + ' ' + fmtVal(p.line) + '</span>'
    + '<span class="stat">' + esc(p.stat) + '</span>'
    + '<span class="avg">Avg <b>' + fmtVal(p.avg) + '</b><br>L10 avg <b>' + fmtVal(p.l10avg) + '</b> · Last <b>' + fmtVal(p.last) + '</b></span></div>'
    + winRowHtml(p, lg)
    + oppCtxHtml(p, lg)
    + '<div class="rates">' + rateCell(p, "L5") + rateCell(p, "L10") + rateCell(p, "L20") + '</div>'
    + '<div class="cardfoot"><span class="note">' + p.gp + ' games logged · hit rates vs this line</span>'
    + (sig ? '<button class="whybtn" data-why="1" data-no-log data-sig="' + Math.round(sig.score) + '" data-hit="' + Math.round(sig.hit) + '" data-raw="' + Math.round(sig.rate) + '" data-shrunk="' + Math.round(sig.shrunk * 100) + '" data-vol="' + sig.vol.toFixed(2) + '" data-sample="' + sig.sample.toFixed(2) + '" data-meaning="' + sig.meaning.toFixed(2) + '" aria-haspopup="true" aria-expanded="false" aria-controls="sigPop" aria-label="Why is this ranked here? Signal Score breakdown">Why?</button>' : '')
    + '<button class="openbtn" data-open-logs="' + esc(p.pid) + '" data-stat-key="' + esc(p.key) + '" data-lg="' + esc(lg) + '">Game log</button></div>'
    + '</article>';
}
function effSortCmp(x, y){
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  return y - x;
}
function filteredProps(lg){
  var list = (DATA.leagues[lg].props || []).filter(function(p){
    if (isInjured(lg, p)) return false;
    if (lg === "NFL" && nflTdGimme(p)) return false;
    if (rareUnderHidden(lg, p)) return false;
    if (state.stat !== "All" && p.stat !== state.stat) return false;
    if (!state.dirs[p.dir]) return false;
    var ws = winStat(lg, p);
    if (!ws || ws.rate < state.minRate) return false;
    /* Min games / Min average: the prop's game count and stat average
       over the selected Games window must clear the floors */
    if (state.minGames && ws.n < state.minGames) return false;
    if (state.minAvg > 0 && ws.avg < state.minAvg) return false;
    return searchMatch(p.name + " " + p.team + " " + p.stat);
  });
  /* Optional efficiency sort: highest eFG% (NBA) / xGF% (NHL) first.
     It only reorders the cards that pass the other filters — players
     with no value keep their cards and sort to the bottom. */
  if (lg === "NBA" && state.sortEfg) list.sort(function(a, b){ return effSortCmp(efgOf(lg, a.pid), efgOf(lg, b.pid)); });
  if (lg === "NHL" && state.sortXgf) list.sort(function(a, b){ return effSortCmp(xgfOf(lg, a.pid), xgfOf(lg, b.pid)); });
  /* Signal ranking mode: order by Signal Score (EB-shrunken hit rate ×
     volume × sample × meaning) over the selected window. ORDER ONLY —
     the filters above already decided what appears. The efficiency sort,
     when the user has switched it on, still takes over as it always has. */
  if (!((lg === "NBA" && state.sortEfg) || (lg === "NHL" && state.sortXgf)) && state.rankMode === "signal"){
    var scored = list.map(function(p){ return { p: p, s: signalScore(lg, p) }; });
    scored.sort(function(x, y){ return cmpSignal(x.s, y.s); });
    return scored.map(function(x){ return x.p; });
  }
  /* Classic mode is exactly the pre-Signal behaviour: a non-default Games
     window re-sorts the board by that window's hit rate (the pipeline
     order is already the L10 order at the default). */
  if (!((lg === "NBA" && state.sortEfg) || (lg === "NHL" && state.sortXgf)) && (state.win || 10) !== 10){
    list.sort(function(a, b){
      var wa = winStat(lg, a), wb = winStat(lg, b);
      return ((wb ? wb.rate : -1) - (wa ? wa.rate : -1));
    });
  }
  return list;
}
state.dseg = "props";
function renderDSeg(){
  ["props", "streaks", "watch"].forEach(function(k){
    var pane = $("#dseg-" + k);
    if (pane) pane.hidden = state.dseg !== k;
  });
  $$("#dsegChips .chip").forEach(function(c){ c.setAttribute("aria-pressed", c.getAttribute("data-dseg") === state.dseg ? "true" : "false"); });
}
$$("#dsegChips .chip").forEach(function(c){ c.addEventListener("click", function(){ state.dseg = c.getAttribute("data-dseg"); renderDSeg(); }); });
var _boardList = null; /* the board's last computed list — the collapsed Player Props preview reads the same array */
var _teamList = null; /* renderTeamProps' last ranked list — the collapsed Team Props preview reads the same array */
function renderDiscover(){
  var list = filteredProps(state.league);
  _boardList = list;
  $("#propCount").textContent = list.length + " props · " + state.league + (state.rankMode === "signal"
    ? " · sorted by Signal Score at the research line"
    : " · sorted by L" + (state.win || 10) + " hit rate at the research line");
  $("#propGrid").innerHTML = list.length ? list.slice(0, 90).map(function(p){ return propCard(p, state.league); }).join("")
    : '<div class="emptybox" style="grid-column:1/-1">No props match those filters. Loosen the minimum hit rate or pick another stat.</div>';
  renderSecPreview();
}
/* One delegated handler for EVERY player surface: any element carrying
   data-open-logs (prop cards, watchlist / riser cards, cheatsheet rows,
   injury rows, ranked Game Logs rows, Players to Watch heads + prop rows)
   opens that player's game-log popup, with data-stat-key preselected when
   the surface has a stat and the league's primary stat otherwise. Because
   it is delegated, live re-renders and popup re-renders keep working. */
function openLogFromEl(b){
  if (!b) return;
  var lg = b.getAttribute("data-lg");
  if (lg && lg !== state.league) setLeague(lg);
  window.__LL.openWorkstation(b.getAttribute("data-open-logs"), b.getAttribute("data-stat-key") || "");
}
document.addEventListener("click", function(e){
  if (!e.target.closest) return;
  var b = e.target.closest("[data-open-logs]");
  if (!b) return;
  /* an inner control with its own action (a stepper, toggle, link or select
     sitting between the tap and the clickable player element) must not
     accidentally open the log — unless that control is itself the log opener */
  var inner = e.target.closest("button, a, input, select, textarea, [data-no-log]");
  if (inner && inner !== b && b.contains(inner) && !inner.hasAttribute("data-open-logs")) return;
  openLogFromEl(b);
});
document.addEventListener("keydown", function(e){
  if (e.key !== "Enter" && e.key !== " ") return;
  var el = e.target;
  if (!el || !el.hasAttribute || !el.hasAttribute("data-open-logs")) return;
  if (el.tagName === "BUTTON") return; /* native buttons already fire click */
  e.preventDefault();
  openLogFromEl(el);
});

/* ---------- Regression risk definition popover ----------
   One shared tooltip (#regPop) serves every .regtag — the tag is rendered
   by winRowHtml, so this covers the Props board and any other card surface
   that renders it, wrapped onto its own line or not. Tapping the tag
   toggles the popover anchored at the tag; the tap must never reach the
   game-log opener above, so the tag carries data-no-log (that handler
   ignores it) AND this capture-phase handler consumes tag taps outright.
   The box is position:fixed — it floats over the board and never pushes
   a card around — and is centred on the tag, clamped inside the viewport
   horizontally and flipped above the tag when there is no room below.
   Tapping the tag again, tapping anywhere else, scrolling, resizing or
   pressing Escape closes it; only one can be open at a time. */
var regPop = document.getElementById("regPop");
var regAnchor = null;
function closeRegPop(){
  if (regAnchor) regAnchor.setAttribute("aria-expanded", "false");
  regAnchor = null;
  if (regPop) regPop.hidden = true;
}
function placeRegPop(tag){
  var r = tag.getBoundingClientRect();
  var vw = window.innerWidth, vh = window.innerHeight, M = 8, GAP = 6;
  regPop.style.left = "0px"; regPop.style.top = "0px";
  var w = regPop.offsetWidth, h = regPop.offsetHeight;
  var left = r.left + r.width / 2 - w / 2;
  left = Math.max(M, Math.min(left, vw - w - M));
  var top = r.bottom + GAP;
  if (top + h > vh - M) top = r.top - GAP - h;      /* no room below: flip above */
  if (top < M) top = Math.min(vh - h - M, r.bottom + GAP);
  if (top < M) top = M;
  regPop.style.left = Math.round(left) + "px";
  regPop.style.top = Math.round(top) + "px";
}
function toggleRegPop(tag){
  if (!regPop) return;
  if (regAnchor === tag && !regPop.hidden){ closeRegPop(); return; }
  closeRegPop();
  closeRankPop();
  regAnchor = tag;
  regPop.hidden = false;
  tag.setAttribute("aria-expanded", "true");
  placeRegPop(tag);
}
document.addEventListener("click", function(e){
  if (!e.target.closest) return;
  var tag = e.target.closest("[data-regtag]");
  if (tag){ e.stopPropagation(); toggleRegPop(tag); return; }
  if (regPop && !regPop.hidden && !e.target.closest("#regPop")) closeRegPop();
}, true);
document.addEventListener("keydown", function(e){
  if (e.key === "Escape"){ closeRegPop(); return; }
  if ((e.key === "Enter" || e.key === " ") && e.target && e.target.closest){
    var tag = e.target.closest("[data-regtag]");
    if (tag){ e.preventDefault(); toggleRegPop(tag); }
  }
});
window.addEventListener("scroll", closeRegPop, { passive:true, capture:true });
window.addEventListener("resize", closeRegPop);
if (window.MutationObserver){
  /* a board re-render replaces the anchor card — never leave the popover
     floating over a tag that no longer exists */
  new MutationObserver(function(){
    if (regAnchor && !document.contains(regAnchor)) closeRegPop();
  }).observe(document.body, { childList:true, subtree:true });
}

/* ---------- Signal Score "Why?" breakdown popover ----------
   Same pattern as the Regression risk popover above: one shared tooltip
   (#sigPop, a .regpop box) serves every .whybtn, floated position:fixed,
   centred on the button, clamped inside the viewport and flipped above
   when there is no room below. The button carries data-no-log AND this
   capture-phase handler consumes its taps outright, so a Why? tap never
   opens the game-log popup. Tapping the button again, tapping anywhere
   else, scrolling, resizing or pressing Escape closes it. The numbers
   come from the button's data attributes — written by propCard from the
   same signalScore() that ordered the board — so the components shown
   always multiply out to the displayed score: Hit rate is the score
   component (0–100) computed from the EB-shrunken rate, shown with the
   raw window rate and the shrunken rate it became; Volume / Sample /
   Meaning are shown to 2 decimals; the final score is whole. */
var sigPop = document.getElementById("sigPop");
var sigAnchor = null;
function fmtComp(v){
  var s = (+v).toFixed(2);
  return s.slice(-1) === "0" ? s.slice(0, -1) : s;
}
function closeSigPop(){
  if (sigAnchor) sigAnchor.setAttribute("aria-expanded", "false");
  sigAnchor = null;
  if (sigPop) sigPop.hidden = true;
}
function placeSigPop(btn){
  var r = btn.getBoundingClientRect();
  var vw = window.innerWidth, vh = window.innerHeight, M = 8, GAP = 6;
  sigPop.style.left = "0px"; sigPop.style.top = "0px";
  var w = sigPop.offsetWidth, h = sigPop.offsetHeight;
  var left = r.left + r.width / 2 - w / 2;
  left = Math.max(M, Math.min(left, vw - w - M));
  var top = r.bottom + GAP;
  if (top + h > vh - M) top = r.top - GAP - h;      /* no room below: flip above */
  if (top < M) top = Math.min(vh - h - M, r.bottom + GAP);
  if (top < M) top = M;
  sigPop.style.left = Math.round(left) + "px";
  sigPop.style.top = Math.round(top) + "px";
}
function toggleSigPop(btn){
  if (!sigPop) return;
  if (sigAnchor === btn && !sigPop.hidden){ closeSigPop(); return; }
  closeSigPop();
  closeRegPop();
  closeRankPop();
  sigAnchor = btn;
  sigPop.innerHTML = '<b>Signal ' + esc(btn.getAttribute("data-sig")) + '</b> — Hit rate ' + esc(btn.getAttribute("data-hit"))
    + ' (' + esc(btn.getAttribute("data-raw")) + '% &rarr; shrunk ' + esc(btn.getAttribute("data-shrunk")) + '%)'
    + ' &middot; Volume ' + esc(fmtComp(btn.getAttribute("data-vol")))
    + ' &middot; Sample ' + esc(fmtComp(btn.getAttribute("data-sample")))
    + ' &middot; Meaning ' + esc(fmtComp(btn.getAttribute("data-meaning")));
  sigPop.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  placeSigPop(btn);
}
document.addEventListener("click", function(e){
  if (!e.target.closest) return;
  var btn = e.target.closest("[data-why]");
  if (btn){ e.stopPropagation(); toggleSigPop(btn); return; }
  if (sigPop && !sigPop.hidden && !e.target.closest("#sigPop")) closeSigPop();
}, true);
document.addEventListener("keydown", function(e){
  if (e.key === "Escape") closeSigPop();
});
window.addEventListener("scroll", closeSigPop, { passive:true, capture:true });
window.addEventListener("resize", closeSigPop);
if (window.MutationObserver){
  new MutationObserver(function(){
    if (sigAnchor && !document.contains(sigAnchor)) closeSigPop();
  }).observe(document.body, { childList:true, subtree:true });
}

/* ---------- Signal / Classic definition popover ----------
   Same pattern as the Regression risk and Why? popovers: one shared
   tooltip (#rankPop, a .regpop box whose two definitions are static
   markup) serves the info button beside the Signal/Classic switch on
   the Props board AND the matching info button in the Watchlist pane —
   the Watchlist follows the same rankMode, so it gets the same
   explanation. Tapping the info button toggles the popover anchored at
   it; on hover-capable devices, hovering the switch itself or the info
   button also opens it (anchored at the switch), and moving the mouse
   away closes a hover-opened popover. A tap-opened popover dismisses
   the usual ways: tapping the button again, tapping anywhere else,
   scrolling, resizing or pressing Escape. Only one of the three
   definition popovers is ever open at a time. */
var rankPop = document.getElementById("rankPop");
var rankAnchor = null;
var rankHoverOpen = false;
function closeRankPop(){
  if (rankAnchor && rankAnchor.hasAttribute && rankAnchor.hasAttribute("data-rankinfo")) rankAnchor.setAttribute("aria-expanded", "false");
  rankAnchor = null;
  rankHoverOpen = false;
  if (rankPop) rankPop.hidden = true;
}
function placeRankPop(anchor){
  var r = anchor.getBoundingClientRect();
  var vw = window.innerWidth, vh = window.innerHeight, M = 8, GAP = 6;
  rankPop.style.left = "0px"; rankPop.style.top = "0px";
  var w = rankPop.offsetWidth, h = rankPop.offsetHeight;
  var left = r.left + r.width / 2 - w / 2;
  left = Math.max(M, Math.min(left, vw - w - M));
  var top = r.bottom + GAP;
  if (top + h > vh - M) top = r.top - GAP - h;      /* no room below: flip above */
  if (top < M) top = Math.min(vh - h - M, r.bottom + GAP);
  if (top < M) top = M;
  rankPop.style.left = Math.round(left) + "px";
  rankPop.style.top = Math.round(top) + "px";
}
function openRankPop(anchor, fromHover){
  if (!rankPop) return;
  closeRegPop();
  closeSigPop();
  if (rankAnchor && rankAnchor !== anchor && rankAnchor.hasAttribute && rankAnchor.hasAttribute("data-rankinfo")) rankAnchor.setAttribute("aria-expanded", "false");
  rankAnchor = anchor;
  rankHoverOpen = !!fromHover;
  rankPop.hidden = false;
  if (anchor.hasAttribute && anchor.hasAttribute("data-rankinfo")) anchor.setAttribute("aria-expanded", "true");
  placeRankPop(anchor);
}
function toggleRankPop(btn){
  if (!rankPop) return;
  if (rankAnchor === btn && !rankPop.hidden){ closeRankPop(); return; }
  openRankPop(btn, false);
}
document.addEventListener("click", function(e){
  if (!e.target.closest) return;
  var btn = e.target.closest("[data-rankinfo]");
  if (btn){ e.stopPropagation(); toggleRankPop(btn); return; }
  if (rankPop && !rankPop.hidden && !e.target.closest("#rankPop")) closeRankPop();
}, true);
document.addEventListener("keydown", function(e){
  if (e.key === "Escape"){ closeRankPop(); return; }
  if ((e.key === "Enter" || e.key === " ") && e.target && e.target.closest){
    var btn = e.target.closest("[data-rankinfo]");
    if (btn){ e.preventDefault(); toggleRankPop(btn); }
  }
});
window.addEventListener("scroll", closeRankPop, { passive:true, capture:true });
window.addEventListener("resize", closeRankPop);
if (window.MutationObserver){
  new MutationObserver(function(){
    if (rankAnchor && !document.contains(rankAnchor)) closeRankPop();
  }).observe(document.body, { childList:true, subtree:true });
}
if (window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches){
  /* desktop hover: the switch and its info buttons are hover targets;
     a hover-opened popover closes when the mouse leaves the target,
     while a tap-opened one stays until dismissed */
  var rankSegEl = document.getElementById("rankSeg");
  if (rankSegEl){
    rankSegEl.addEventListener("mouseenter", function(){ openRankPop(rankSegEl, true); });
    rankSegEl.addEventListener("mouseleave", function(){ if (rankHoverOpen && rankAnchor === rankSegEl) closeRankPop(); });
  }
  $$("[data-rankinfo]").forEach(function(btn){
    btn.addEventListener("mouseenter", function(){ openRankPop(btn, true); });
    btn.addEventListener("mouseleave", function(){ if (rankHoverOpen && rankAnchor === btn) closeRankPop(); });
  });
}

/* ---------- Ranking mode switch (Signal / Classic) ----------
   In-session only, like every other board control: state.rankMode drives
   filteredProps ordering, the count-line wording, the Watchlist order
   and whether prop cards render their Why? target. Switching re-renders
   the two affected segments; Streaks, Risers and Shuffle never read
   rankMode and keep their own ordering in both modes. */
$$("#rankSeg button").forEach(function(b){
  b.addEventListener("click", function(){
    state.rankMode = b.getAttribute("data-rank");
    $$("#rankSeg button").forEach(function(x){ x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    closeSigPop();
    closeRankPop();
    renderDiscover(); renderWatchlist();
  });
});

/* ---------- Watchlist ---------- */
/* The watch stat's window numbers (games + average over the selected
   Games window) for the Min games / Min average floors: the board prop's
   own window stat when the board carries one for that player + stat,
   otherwise computed straight from the merged logs over the window. */
function watchQual(lg, w){
  var key = watchKeyOf(w);
  var bp = (DATA.leagues[lg].props || []).filter(function(x){ return x.pid === w.pid && x.key === key; })[0];
  if (bp) return winStat(lg, bp);
  var vals = [];
  udMergedRows(lg, w.pid).forEach(function(r){ var v = winVal(r, key); if (v != null) vals.push(v); });
  vals = vals.slice(0, state.win || 10);
  if (!vals.length) return null;
  return { n: vals.length, avg: avgOf(vals), rate: null };
}
function watchKeyOf(w){
  var bigLabel = String(w.big || "").replace(/^[\d.]+\s*/, ""), key = "";
  (L().statDefs || []).forEach(function(d){ if (d.label === bigLabel) key = d.k; });
  if (!key && bigLabel === "Pts+Reb+Ast") key = "combo";
  return key;
}
function renderWatchlist(){
  var list = (L().watch || []).filter(function(w){
    if (!searchMatch(w.name + " " + w.team)) return false;
    /* the shared Min hit rate floor applies here too, at the watch stat's
       board line over the selected Games window */
    if (state.minRate > 0){
      var r = boardRate(state.league, w.pid, watchKeyOf(w));
      if (r == null || r < state.minRate) return false;
    }
    /* Min games / Min average floors apply here too, tested on the watch
       stat over the selected Games window */
    if (state.minGames || state.minAvg > 0){
      var wq = watchQual(state.league, w);
      if (!wq) return false;
      if (state.minGames && wq.n < state.minGames) return false;
      if (state.minAvg > 0 && wq.avg < state.minAvg) return false;
    }
    /* Hidden gimmes stay off the Watchlist too: when the watch stat's
       board prop is one of the props the board hides — an NFL Under 1.5
       TD gimme, or a rare-event Under 0.5 whose L20 average is under
       0.3 — the entry goes with it */
    var bp = (L().props || []).filter(function(x){ return x.pid === w.pid && x.key === watchKeyOf(w); })[0];
    if (bp && nflTdGimme(bp)) return false;
    if (bp && rareUnderHidden(state.league, bp)) return false;
    return true;
  });
  /* Signal ranking mode: the Watchlist follows the same Signal Score
     order as Top Props, scored on each entry's board prop (same player +
     stat). Entries with no board prop keep their relative order at the
     bottom. Classic mode leaves the list exactly as it has always been. */
  if (state.rankMode === "signal"){
    var wscored = list.map(function(w){
      var bp2 = (L().props || []).filter(function(x){ return x.pid === w.pid && x.key === watchKeyOf(w); })[0];
      return { w: w, s: bp2 ? signalScore(state.league, bp2) : null };
    });
    wscored.sort(function(x, y){ return cmpSignal(x.s, y.s); });
    list = wscored.map(function(x){ return x.w; });
  }
  $("#watchCount").textContent = list.length + " players to keep an eye on · " + state.league;
  $("#watchGrid").innerHTML = list.length ? list.map(function(w){
    var wkey = watchKeyOf(w);
    return '<div class="wcard" data-open-logs="' + esc(w.pid) + '" data-stat-key="' + esc(wkey) + '" data-lg="' + state.league + '" role="button" tabindex="0" aria-label="Open game log for ' + esc(w.name) + '"><div class="cardtop">' + avatarHtml(state.league, w.pid, w.name)
      + '<div class="who"><div class="nm">' + esc(w.name) + '</div><div class="tm">' + esc(w.team) + (w.pos ? ' · ' + esc(w.pos) : '') + '</div></div>'
      + '<span class="ratiochip">' + esc(w.big) + ' · ' + w.ratio + '× avg</span></div>'
      + '<div class="bigline">' + esc(w.big) + '</div><div class="fulline">' + esc(w.line) + '</div>'
      + '<div class="when">' + fmtD(w.date) + ' · ' + esc(w.opp) + ' · ' + esc(w.result) + ' ' + esc(w.score) + '</div>'
      + '<div class="cardfoot" style="margin-top:10px"><span class="note">Season-best type of night — check the log before trusting it twice.</span>'
      + '<button class="openbtn" data-open-logs="' + esc(w.pid) + '" data-stat-key="' + esc(wkey) + '" data-lg="' + state.league + '">Game log</button></div></div>';
  }).join("") : '<div class="emptybox">No recent top stat lines for ' + state.league + ' in the current data.</div>';
}

  /* ---------- Risers ---------- */
/* Hard rule, no vibes: baseline = last-20 average for the stat, and it must sit in the
   bottom half of the tracked pool for that league + stat. Surging = last-5 average at
   least 50% above baseline AND the absolute jump clears the per-stat minimum below. */
var UD_MIN = {
  NBA: { points:4.0, totalRebounds:1.5, assists:1.5, steals:0.8, blocks:0.8, threePointersMade:0.8, combo:5.0 },
  NHL: { points:0.6, assists:0.4, goals:0.4, shotsTotal:1.0 },
  NFL: { passingYards:40, rushingYards:15, receivingYards:15, receptions:1.5 }
};
function udStatVal(row, key){
  if (key === "combo"){
    var s = row.s || {};
    if (s.points == null || s.totalRebounds == null || s.assists == null) return null;
    return s.points + s.totalRebounds + s.assists;
  }
  var v = (row.s || {})[key];
  return (v == null || isNaN(v)) ? null : v;
}
function udStatLabel(lg, key){
  if (key === "combo") return "Pts+Reb+Ast";
  var defs = statDefs(lg);
  for (var i = 0; i < defs.length; i++) if (defs[i].k === key) return defs[i].label;
  return key;
}
function avgOf(vals){ return vals.length ? vals.reduce(function(a, b){ return a + b; }, 0) / vals.length : null; }
/* The Risers grid is recomputed on every live check, but its inputs
   are the baked game logs (static between checks) plus the schedule —
   so on most checks the HTML comes out byte-identical. When it does,
   the DOM is left completely untouched: assigning the same innerHTML
   would still recreate every card's headshot and flash them all. */
var _udGridHtml = null;
function renderUnderdogs(){
  var lg = state.league;
  /* NBA and NFL use the ranked Riser Score (see renderUdScored below);
     the NHL keeps this hard bar exactly as it has always been. */
  if (lg !== "NHL"){ renderUdScored(lg); return; }
  var mins = UD_MIN[lg] || {};
  var logs = DATA.leagues[lg].logs || {}, players = DATA.leagues[lg].players || {};
  var out = [], near = [];
  Object.keys(mins).forEach(function(key){
    var entries = [], shorts = [];
    Object.keys(logs).forEach(function(pid){
      if (!players[pid]) return;
      if (injuredInfo(lg).pids[pid]) return;
      var vals = (logs[pid] || []).map(function(r){ return udStatVal(r, key); }).filter(function(v){ return v != null; });
      if (vals.length >= 10) entries.push({ pid: pid, vals: vals, base: avgOf(vals.slice(0, 20)), recent: avgOf(vals.slice(0, 5)) });
      else if (vals.length >= 5) shorts.push({ pid: pid, vals: vals, base: avgOf(vals.slice(0, 20)), recent: avgOf(vals.slice(0, 5)) });
    });
    if (!entries.length) return;
    var bases = entries.map(function(e){ return e.base; }).sort(function(a, b){ return a - b; });
    var median = bases[Math.floor(bases.length / 2)];
    function udEntry(e, reason){
      var jump = e.recent - e.base;
      var streak = 0;
      for (var i = 0; i < e.vals.length; i++){ if (e.vals[i] > e.base) streak++; else break; }
      var last10 = e.vals.slice(0, 10);
      return {
        pid: e.pid, key: key, base: e.base, recent: e.recent,
        pct: Math.round(100 * jump / e.base), jump: jump,
        l5: e.vals.slice(0, 5), streak: streak,
        beat: last10.filter(function(v){ return v > e.base; }).length, n10: last10.length,
        reason: reason || null
      };
    }
    function rateFail(e){
      if (state.minRate <= 0) return null;
      var r = boardRate(lg, e.pid, key);
      return (r == null || r < state.minRate) ? "Hit rate " + (r == null ? "—" : r + "%") + " at the board line — below the " + state.minRate + "% floor" : null;
    }
    entries.forEach(function(e){
      /* the hard bar, test by test — the list itself is unchanged: an
         entry still needs every test to list. Failing exactly one test
         makes it a near miss (below), never a list member. */
      var fails = [];
      if (!(e.base > 0) || e.base > median) fails.push("Baseline not in the bottom half for " + udStatLabel(lg, key) + " — L20 avg " + fmtVal(e.base));
      var jump = e.recent - e.base;
      if (e.recent < e.base * 1.5) fails.push("Jump +" + (e.base > 0 ? Math.round(100 * jump / e.base) : 0) + "% — below the surge bar (last 5 at least 50% above baseline)");
      else if (jump < mins[key]) fails.push("Jump of " + fmtVal(jump) + " a game — below the " + fmtVal(mins[key]) + " minimum for " + udStatLabel(lg, key));
      var rf = rateFail(e);
      if (rf) fails.push(rf);
      if (!fails.length) out.push(udEntry(e, null));
      else if (fails.length === 1) near.push(udEntry(e, fails[0]));
    });
    /* too few games to judge (5–9 logged) but otherwise over the bar */
    shorts.forEach(function(e){
      if (!(e.base > 0) || e.base > median) return;
      var jump = e.recent - e.base;
      if (e.recent < e.base * 1.5 || jump < mins[key]) return;
      if (rateFail(e)) return;
      near.push(udEntry(e, "Only " + e.vals.length + " games logged — needs 10"));
    });
  });
  out.sort(function(a, b){ return (b.pct - a.pct) || (b.jump - a.jump); });
  out = out.slice(0, 30);
  /* Near misses: only when the list itself comes up short of 10 — the
     next-best entries that failed exactly one test, labelled as such.
     They never count toward the list and never enter another surface. */
  var nearShown = [];
  if (out.length < 10){
    near.sort(function(a, b){ return (b.pct - a.pct) || (b.jump - a.jump); });
    nearShown = near.slice(0, 3);
  }
  var shown = out.filter(function(u){ var p = players[u.pid] || {}; return searchMatch((p.name || "") + " " + (p.team || "")); });
  var nmShown = nearShown.filter(function(u){ var p = players[u.pid] || {}; return searchMatch((p.name || "") + " " + (p.team || "")); });
  $("#udCount").textContent = (out.length
    ? out.length + " surging riser stat lines · " + lg + " · bottom-half baseline, last-5 at least 50% above it" + (state.minRate > 0 ? " · min hit rate " + state.minRate + "% (last " + (state.win || 10) + ")" : "")
    : "No risers qualify in " + lg + " right now")
    + (nearShown.length ? " · " + nearShown.length + " near miss" + (nearShown.length > 1 ? "es" : "") : "");
  function nhlCard(u){
    var p = players[u.pid] || {};
    var vals = u.l5.map(function(v){ return '<span class="uval' + (v > u.base ? ' above' : '') + '">' + fmtVal(v) + '</span>'; }).join("");
    return '<div class="wcard ucard" data-open-logs="' + esc(u.pid) + '" data-stat-key="' + esc(u.key) + '" data-lg="' + lg + '" role="button" tabindex="0" aria-label="Open game log for ' + esc(p.name || "") + '">'
      + '<div class="cardtop">' + avatarHtml(lg, u.pid, p.name)
      + '<div class="who"><div class="nm">' + esc(p.name) + '</div><div class="tm">' + esc(p.team) + (p.pos ? ' · ' + esc(p.pos) : '') + ' · ' + lg + '</div></div>'
      + (u.reason ? '<span class="nmflag">Near miss</span>' : '<span class="upct">+' + u.pct + '%</span>') + '</div>'
      + '<div class="bigline">' + esc(udStatLabel(lg, u.key)) + '</div>'
      + '<div class="ucmp"><span>Baseline (L20) <b>' + fmtVal(u.base) + '</b></span><span class="arrow">→</span><span>Last 5 <b>' + fmtVal(u.recent) + '</b></span></div>'
      + '<div class="uvals"><span class="lab">Last 5</span>' + vals + '</div>'
      + '<div class="umeta">'
      + (u.streak >= 3 ? '<span class="ustreak">' + u.streak + '-game streak above own baseline</span>' : '')
      + '<span class="ubeat">Beat own baseline in ' + u.beat + ' of last ' + u.n10 + '</span></div>'
      + (u.reason ? '<div class="nmreason">Missed: ' + esc(u.reason) + '</div>' : '')
      + '<div class="cardfoot" style="margin-top:10px"><span class="note">Tap for the full game log — up to 82 games merged.</span>'
      + '<button class="openbtn" data-open-logs="' + esc(u.pid) + '" data-stat-key="' + esc(u.key) + '" data-lg="' + lg + '">Game log</button></div></div>';
  }
  var gridHtml = out.length ? shown.map(nhlCard).join("") : '<div class="emptybox">Nobody in ' + lg + ' clears the riser bar in the current data — bottom-half baseline, last-5 at least 50% above it, and the minimum jump for the stat. The bar stays where it is; check back after more games.</div>';
  if (nmShown.length) gridHtml += '<div class="nmwrap"><div class="nmhead">Near misses</div><div class="nmsub">Close, but each missed one test — they are not on the list.</div><div class="wlist">' + nmShown.map(nhlCard).join("") + '</div></div>';
  if (out.length && !shown.length && !nmShown.length) gridHtml = '<div class="emptybox">No risers match your search in ' + lg + '.</div>';
  if (gridHtml !== _udGridHtml){ _udGridHtml = gridHtml; $("#udGrid").innerHTML = gridHtml; }
}
window.__LL.renderUnderdogs = renderUnderdogs;

/* ---------- Risers, scored (NBA + NFL) ----------
   Same pool as ever: the player's last-20 baseline for the stat sits in the
   bottom half of the league pool for that stat, and injured players stay
   hidden. What changed is the bar: instead of pass/fail, every qualifier
   gets a Riser Score built to estimate whether the surge is likely to
   CONTINUE, not how big the spike looks:
     consistency — games above baseline in the last 5 (6 pts each) and the
       last 10 (2 pts each): the heaviest weight, and the reason one blowup
       game cannot top the list on its own;
     streak — current run of games above baseline, 3 pts each, capped at 5;
     jump — last-5 average vs baseline %, capped at +100%, worth at most 15:
       the noisiest signal, so the smallest weight;
     NBA only — opportunity: a minutes trend up 20%+ adds 5–10, and a
       higher-minutes teammate on the injury report adds 4.
     NFL only — opportunity from baked usage data: a snap-share jump of
       10+ points or a role-share jump of 25%+ (last 3 weeks vs the weeks
       before) adds 5–10, and a higher-usage same-position teammate on
       the injury report adds 4. NFL cards also carry an opponent
       adjustment: defenses are ranked from the page's own game logs by
       yards allowed per game to the stat's position group — a bottom-8
       matchup adds 3, a top-8 matchup subtracts 3, and above-baseline
       games against top-10 defenses add up to 3 more.
   The total is then shrunk by the evidence behind it (games in the merged
   log for that stat ÷ 20, capped at 1), so a surge built on 8 games ranks
   below the identical surge built on 20+. Listing floor: at least 8 games
   in the merged log, last-5 average above baseline, at least 2 of the
   last 5 above baseline, and the player's next game today or tomorrow
   (Eastern) — for the NFL, a next game inside the current Thursday–Monday
   game week. Top 10 by score, dealt across the stat categories that
   qualified (best of each first, at most 2 slots per player) — the list
   is never padded. */
var UD_KEYS = {
  NBA: ["points", "totalRebounds", "assists", "steals", "blocks", "threePointersMade", "combo"],
  NFL: ["passingYards", "rushingYards", "receivingYards", "receptions"]
};
function udMergedRows(lg, pid){
  var L = DATA.leagues[lg] || {};
  return ((L.logs || {})[pid] || []).concat((L.logsPrev || {})[pid] || []);
}
/* A player + stat's hit rate at its board line over the selected Games
   window — the number the shared Min hit rate floor is tested against.
   Falls back to the research line (last-10 average, nearest half, Over
   side) when the board carries no prop for that player + stat. */
function boardRate(lg, pid, key){
  var props = DATA.leagues[lg].props || [];
  for (var i = 0; i < props.length; i++){
    if (props[i].pid === pid && props[i].key === key){
      var ws = winStat(lg, props[i]);
      return ws ? ws.rate : null;
    }
  }
  var vals = udMergedRows(lg, pid).map(function(r){ return udStatVal(r, key); }).filter(function(v){ return v != null; });
  if (!vals.length) return null;
  var l10 = avgOf(vals.slice(0, 10));
  if (l10 == null) return null;
  var line = Math.round(l10 * 2) / 2, win = vals.slice(0, state.win || 10), hits = 0;
  win.forEach(function(v){ if (v > line) hits++; });
  return win.length ? Math.round(100 * hits / win.length) : null;
}
function udEtDay(iso){
  try { return etYMD(iso); } catch(e){ return ""; }
}
/* The team's next game from the page's schedule data (the same games the
   Discover strip and Live tab show), kept only when it falls today or
   tomorrow in Eastern time. */
function udNextGame(lg, team){
  var games = LG[lg] || [];
  if (!team || !games.length) return null;
  var today = udEtDay(new Date().toISOString());
  if (!today) return null;
  var p = today.split("-");
  var tomorrow = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + 1)).toISOString().slice(0, 10);
  var best = null;
  games.forEach(function(g){
    if (!g || !g.home || !g.away || g.state === "post") return;
    if (g.home.abbr !== team && g.away.abbr !== team) return;
    var day = udEtDay(g.date);
    if (!day || day < today) return;
    if (!best || String(g.date || "") < String(best.g.date || "")) best = { g: g, day: day };
  });
  if (!best || (best.day !== today && best.day !== tomorrow)) return null;
  var home = best.g.home.abbr === team;
  return { opp: home ? best.g.away.abbr : best.g.home.abbr, home: home, when: best.day === today ? "Today" : "Tomorrow", day: best.day };
}
function udDayLabel(day){
  var d = new Date(day + "T12:00:00");
  return isNaN(d) ? day : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
/* NFL only: the team's next game inside the current game-week window —
   Thursday through Monday (Eastern). On Tuesday/Wednesday the window is
   the coming Thursday–Monday. The chip label is the actual weekday. */
function udNextGameWeek(team){
  var games = LG.NFL || [];
  if (!team || !games.length) return null;
  var today = udEtDay(new Date().toISOString());
  if (!today) return null;
  var p = today.split("-");
  var base = Date.UTC(+p[0], +p[1] - 1, +p[2]);
  var dow = new Date(base).getUTCDay();
  var startOff = (dow === 2 || dow === 3) ? ((4 - dow + 7) % 7) : -((dow + 3) % 7);
  var start = new Date(base + startOff * 864e5).toISOString().slice(0, 10);
  var end = new Date(base + (startOff + 4) * 864e5).toISOString().slice(0, 10);
  var best = null;
  games.forEach(function(g){
    if (!g || !g.home || !g.away || g.state === "post") return;
    if (g.home.abbr !== team && g.away.abbr !== team) return;
    var day = udEtDay(g.date);
    if (!day || day < today || day < start || day > end) return;
    if (!best || String(g.date || "") < String(best.g.date || "")) best = { g: g, day: day };
  });
  if (!best) return null;
  var home = best.g.home.abbr === team;
  var wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(best.day + "T12:00:00Z").getUTCDay()];
  return { opp: home ? best.g.away.abbr : best.g.home.abbr, home: home, when: wd, day: best.day };
}
/* ---------- NFL usage (baked nflverse data) ---------- */
function nflUsageOf(pid){
  var u = ((DATA.leagues.NFL || {}).usage || {})[pid];
  return u || null;
}
function seriesOf(arr){ return (arr || []).filter(function(v){ return v != null && !isNaN(v); }); }
function l3Of(arr){ var s = seriesOf(arr); return s.length ? avgOf(s.slice(-3)) : null; }
function prevOf(arr){ var s = seriesOf(arr); return s.length > 3 ? avgOf(s.slice(0, s.length - 3)) : null; }
/* Usage trend for one NFL player: last-3-weeks average vs the average of
   the weeks before them, for snap share and for role share (target share
   for WR/TE, carry share for RB, both for pass-catching RBs). Rising =
   snaps up 10+ points OR role share up 25%+ relative; falling mirrors it.
   Returns null when the player has no baked usage data. */
function nflUsageTrend(pid){
  var u = nflUsageOf(pid); if (!u) return null;
  var p = playerOf("NFL", pid);
  var out = { snapL3: l3Of(u.sn), snapPrev: prevOf(u.sn), snapUp: false, snapDown: false,
              roleUp: false, roleDown: false, roleUpInfo: null, rising: false, falling: false };
  if (out.snapL3 != null && out.snapPrev != null){
    var d = out.snapL3 - out.snapPrev;
    if (d >= 10) out.snapUp = true;
    if (d <= -10) out.snapDown = true;
  }
  var kinds = [];
  if (p.pos === "WR" || p.pos === "TE") kinds = ["ts"];
  else if (p.pos === "RB"){
    kinds = ["cs"];
    var tgAvg = avgOf(seriesOf(u.tg));
    if (tgAvg != null && tgAvg >= 3) kinds.push("ts");
  }
  kinds.forEach(function(k){
    var l3 = l3Of(u[k]), pv = prevOf(u[k]);
    if (l3 == null || pv == null || !(pv > 0)) return;
    var rel = (l3 - pv) / pv;
    if (rel >= 0.25 && !out.roleUpInfo){ out.roleUp = true; out.roleUpInfo = { kind: k, l3: l3, prev: pv }; }
    if (rel <= -0.25) out.roleDown = true;
  });
  out.rising = out.snapUp || out.roleUp;
  out.falling = out.snapDown || out.roleDown;
  return out;
}
/* Recent red-zone opportunities (last-3-weeks average) and the per-position
   medians across the tracked pool — the backing test for NFL TD props. */
function nflRzRecent(pid){
  var u = nflUsageOf(pid); if (!u) return null;
  var s = seriesOf(u.rz);
  return s.length ? avgOf(s.slice(-3)) : null;
}
var _rzMed = null;
function nflRzMedians(){
  if (_rzMed) return _rzMed;
  var byPos = {};
  Object.keys(DATA.leagues.NFL.players || {}).forEach(function(pid){
    var p = playerOf("NFL", pid);
    var r = nflRzRecent(pid);
    if (r == null || !p.pos) return;
    (byPos[p.pos] = byPos[p.pos] || []).push(r);
  });
  var med = {};
  Object.keys(byPos).forEach(function(pos){
    var a = byPos[pos].slice().sort(function(x, y){ return x - y; });
    med[pos] = a[Math.floor(a.length / 2)];
  });
  _rzMed = med; return med;
}
var NFL_TD_KEYS = { passingTouchdowns: 1, rushingTouchdowns: 1, receivingTouchdowns: 1 };
function nflTdBacked(pid){
  var p = playerOf("NFL", pid);
  var r = nflRzRecent(pid);
  if (r == null) return false;
  var med = nflRzMedians()[p.pos];
  return med != null && r >= med;
}
/* ---------- NFL role line, volatility tag and the Under 1.5 TD rule ----------
   Role at a glance, from the baked usage data: snap % (last-3 average) and
   the player's role share — target share for WR/TE, carry share for RB,
   plus target share for pass-catching RBs (3+ targets a game); QBs show
   snaps only. An arrow follows a metric when its last-3 average differs
   from the player's season average by 5+ points. Role volatile: the snap
   share swung 40+ points across the last 5 games, or the last-3 snap
   average sits 25+ points away from the games before them — the role
   itself is unstable, which is exactly when hit rates mislead. */
function nflRoleInfo(pid){
  var u = nflUsageOf(pid); if (!u) return null;
  var p = playerOf("NFL", pid);
  var shares = [];
  if (p.pos === "WR" || p.pos === "TE") shares.push({ label: "Target share", l3: u.l3.ts, avg: u.avg.ts });
  else if (p.pos === "RB"){
    shares.push({ label: "Carry share", l3: u.l3.cs, avg: u.avg.cs });
    var tgAvg = avgOf(seriesOf(u.tg));
    if (tgAvg != null && tgAvg >= 3) shares.push({ label: "Target share", l3: u.l3.ts, avg: u.avg.ts });
  }
  var sn = seriesOf(u.sn), volatile = false;
  if (sn.length >= 2){
    var last5 = sn.slice(-5);
    if (Math.max.apply(null, last5) - Math.min.apply(null, last5) >= 40) volatile = true;
    if (sn.length > 3){
      var l3m = avgOf(sn.slice(-3)), prior = avgOf(sn.slice(0, sn.length - 3));
      if (l3m != null && prior != null && Math.abs(l3m - prior) >= 25) volatile = true;
    }
  }
  return { snapL3: u.l3.sn, snapAvg: u.avg.sn, shares: shares, volatile: volatile };
}
function nflRoleText(pid){
  var info = nflRoleInfo(pid); if (!info) return "";
  function metric(label, l3, avg){
    var s = label + " " + fmtVal(l3) + "%";
    if (avg != null && Math.abs(l3 - avg) >= 5) s += (l3 > avg ? " ↑" : " ↓");
    return s;
  }
  var parts = [metric("Snaps", info.snapL3, info.snapAvg)];
  info.shares.forEach(function(sh){ parts.push(metric(sh.label, sh.l3, sh.avg)); });
  return parts.join(" · ");
}
function nflCardMetaHtml(p, lg){
  if (lg !== "NFL") return "";
  var info = nflRoleInfo(p.pid); if (!info) return "";
  return '<div class="tm roleline"><span>' + esc(nflRoleText(p.pid)) + '</span>' + (info.volatile ? '<span class="voltag">Role volatile</span>' : '') + '</div>';
}
window.__LL.nflRoleInfo = nflRoleInfo;
window.__LL.nflRoleText = nflRoleText;
/* Under 1.5 TD clutter rule (NFL only): a touchdown prop listed Under 1.5
   is a gimme when the player almost never beats the line — it stays on the
   board only if he scored 2+ TDs in that category in at least 2 of his
   last 20 merged-log games (current season, then last season), or in at
   least 10% of them when he has fewer than 20 logged. Like the injured
   filter this is a display rule computed from the logs on every render:
   the prop data is never edited, and the prop returns on its own when
   the log evidence changes. Only the 1.5 line is in scope — 0.5 TD lines
   and every other stat are untouched, and Risers (surge-based) does
   not use this filter. */
function nflTdGimme(p){
  if (!p || p.dir !== "Under" || p.line !== 1.5 || !NFL_TD_KEYS[p.key]) return false;
  var lgData = DATA.leagues.NFL || {};
  var rows = ((lgData.logs || {})[p.pid] || []).concat((lgData.logsPrev || {})[p.pid] || []);
  var vals = [];
  rows.forEach(function(r){ var v = winVal(r, p.key); if (v != null) vals.push(v); });
  vals = vals.slice(0, 20);
  if (!vals.length) return true;
  var beat = 0;
  vals.forEach(function(v){ if (v >= 2) beat++; });
  if (vals.length >= 20) return beat < 2;
  return (beat / vals.length) < 0.10;
}
/* Rare-event Under rule (all leagues): an Under at a 0.5 line is a
   near-certain gimme when the player almost never clears the line at
   all — the classic Under 0.5 blocks / steals / 3PM / goals / TD flood
   that crowds the board at 90–100%. The prop is displayed only when the
   player genuinely threatens to clear it: his average for the stat over
   his last 20 merged-log games (or all available games, if fewer) is at
   least 0.3. Below that the Under is hidden. Like the injured filter and
   the NFL Under 1.5 TD rule this is a display rule computed from the
   logs on every render — the prop data is never edited, and the prop
   returns on its own when the log evidence changes. Over 0.5 props and
   Unders at any other line are untouched. */
function rareAvg20(lg, p){
  if (p._ra && p._ra.k === p.key) return p._ra.v;
  var lgData = DATA.leagues[lg] || {};
  var rows = ((lgData.logs || {})[p.pid] || []).concat((lgData.logsPrev || {})[p.pid] || []);
  var vals = [];
  rows.forEach(function(r){ var v = winVal(r, p.key); if (v != null) vals.push(v); });
  vals = vals.slice(0, 20);
  var v = vals.length ? vals.reduce(function(a, b){ return a + b; }, 0) / vals.length : null;
  p._ra = { k: p.key, v: v };
  return v;
}
function rareUnderHidden(lg, p){
  if (!p || p.dir !== "Under" || p.line !== 0.5) return false;
  var a = rareAvg20(lg, p);
  return a == null || a < 0.3;
}
window.__LL.rareUnderHidden = rareUnderHidden;
window.__LL.rareAvg20 = rareAvg20;
/* Defensive ranks from the page's own NFL game logs (this season): yards
   allowed per game to each position group, summed per game so teammates
   facing the same defense on the same day count as one game. Rank 1 =
   toughest (fewest yards allowed). Defenses with fewer than 3 such games
   in the logs are left unranked rather than guessed at. */
var _defRanks = null;
function nflDefRanks(){
  if (_defRanks) return _defRanks;
  var L = DATA.leagues.NFL || {}, players = L.players || {};
  var groups = { pass: {}, run: {}, rec: {} };
  Object.keys(L.logs || {}).forEach(function(pid){
    var p = players[pid]; if (!p) return;
    (L.logs[pid] || []).forEach(function(r){
      var opp = (r.opp || "").split(" ").pop(); if (!opp) return;
      var s = r.s || {}, g = null, v = null;
      if (p.pos === "QB"){ g = "pass"; v = s.passingYards; }
      else if (p.pos === "RB"){ g = "run"; v = s.rushingYards; }
      else if (p.pos === "WR" || p.pos === "TE"){ g = "rec"; v = s.receivingYards; }
      if (!g || v == null || isNaN(v)) return;
      var G = groups[g]; G[opp] = G[opp] || {};
      var k = opp + "|" + r.d;
      G[opp][k] = (G[opp][k] || 0) + v;
    });
  });
  var ranks = {};
  Object.keys(groups).forEach(function(g){
    var arr = Object.keys(groups[g]).map(function(def){
      var gm = groups[g][def], ks = Object.keys(gm), tot = 0;
      ks.forEach(function(k){ tot += gm[k]; });
      return { def: def, avg: tot / ks.length, n: ks.length };
    }).filter(function(x){ return x.n >= 3; });
    arr.sort(function(a, b){ return a.avg - b.avg; });
    var m = {};
    arr.forEach(function(x, i){ m[x.def] = { rank: i + 1, of: arr.length, avg: x.avg }; });
    ranks[g] = m;
  });
  _defRanks = ranks; return ranks;
}
function nflStatGroup(key){
  if (key === "passingYards") return "pass";
  if (key === "rushingYards") return "run";
  return "rec";
}
function udMinutes(rows){
  var mins = [];
  rows.forEach(function(r){ var v = (r.s || {}).minutes; if (v != null && !isNaN(v)) mins.push(+v); });
  if (mins.length < 8) return null;
  var l5 = avgOf(mins.slice(0, 5)), base = avgOf(mins.slice(0, 20));
  if (!(base > 0) || l5 == null) return null;
  return { l5: l5, base: base, pct: Math.round(100 * (l5 - base) / base) };
}
function udVsOpp(rows, key, opp){
  var vals = [];
  rows.forEach(function(r){
    if ((r.opp || "").split(" ").pop() !== opp) return;
    var v = udStatVal(r, key);
    if (v != null) vals.push(v);
  });
  return vals.length ? { avg: avgOf(vals), n: vals.length } : null;
}
function renderUdScored(lg){
  var players = DATA.leagues[lg].players || {};
  var inj = injuredInfo(lg).pids;
  var isNba = lg === "NBA";
  var isNfl = lg === "NFL";
  var defRanks = isNfl ? nflDefRanks() : null;
  /* NBA opportunity inputs, computed once per render: minutes trend for
     every tracked player (L5 vs L20 average minutes from the merged log) */
  var minInfo = {};
  if (isNba) Object.keys(players).forEach(function(pid){ minInfo[pid] = udMinutes(udMergedRows(lg, pid)); });
  var out = [], near = [];
  (UD_KEYS[lg] || []).forEach(function(key){
    var entries = [], shorts = [];
    Object.keys(players).forEach(function(pid){
      if (inj[pid]) return;
      var rows = udMergedRows(lg, pid);
      var vals = rows.map(function(r){ return udStatVal(r, key); }).filter(function(v){ return v != null; });
      if (vals.length >= 8) entries.push({ pid: pid, rows: rows, vals: vals, base: avgOf(vals.slice(0, 20)), recent: avgOf(vals.slice(0, 5)) });
      else if (vals.length >= 5) shorts.push({ pid: pid, rows: rows, vals: vals, base: avgOf(vals.slice(0, 20)), recent: avgOf(vals.slice(0, 5)) });
    });
    if (!entries.length) return;
    var bases = entries.map(function(e){ return e.base; }).sort(function(a, b){ return a - b; });
    var median = bases[Math.floor(bases.length / 2)];
    /* Scoring is shared by qualifiers and near misses: an entry that
       fails exactly one qualification test is scored exactly the same
       way and kept aside as a near miss — labelled, never listed. The
       Top 10 itself is built only from entries that clear every test,
       exactly as before. */
    function scoreEntry(e, nx, reason){
      var l5 = e.vals.slice(0, 5), l10 = e.vals.slice(0, 10);
      var beat5 = l5.filter(function(v){ return v > e.base; }).length;
      var p = players[e.pid] || {};
      var beat10 = l10.filter(function(v){ return v > e.base; }).length;
      var streak = 0;
      for (var i = 0; i < e.vals.length; i++){ if (e.vals[i] > e.base) streak++; else break; }
      var pct = Math.round(100 * (e.recent - e.base) / e.base);
      var raw = beat5 * 6 + beat10 * 2 + Math.min(streak, 5) * 3 + Math.min(Math.max(pct, 0), 100) / 100 * 15;
      var minChip = null, teamChip = null, useChips = [], muChip = null;
      if (isNba){
        var mi = minInfo[e.pid];
        if (mi && mi.pct >= 20){
          raw += 5 + Math.min(5, Math.floor((mi.pct - 20) / 10));
          minChip = "Minutes " + fmtVal(mi.l5) + " vs " + fmtVal(mi.base) + " · +" + mi.pct + "%";
        }
        if (mi){
          var bestMate = null;
          Object.keys(players).forEach(function(pid2){
            if (pid2 === e.pid || !inj[pid2]) return;
            if ((players[pid2] || {}).team !== p.team) return;
            var m2 = minInfo[pid2];
            if (m2 && m2.base > mi.base && (!bestMate || m2.base > bestMate.base)) bestMate = { name: players[pid2].name, base: m2.base };
          });
          if (bestMate){ raw += 4; teamChip = "Teammate out: " + bestMate.name; }
        }
      }
      if (isNfl){
        var tr = nflUsageTrend(e.pid);
        if (tr){
          var ob = 0;
          if (tr.snapUp){
            ob = Math.max(ob, 5 + Math.min(5, Math.floor((tr.snapL3 - tr.snapPrev - 10) / 5)));
            useChips.push("Snaps " + Math.round(tr.snapPrev) + "% → " + Math.round(tr.snapL3) + "%");
          }
          if (tr.roleUp && tr.roleUpInfo){
            var relPct = Math.round(100 * (tr.roleUpInfo.l3 - tr.roleUpInfo.prev) / tr.roleUpInfo.prev);
            ob = Math.max(ob, 5 + Math.min(5, Math.floor((relPct - 25) / 15)));
            useChips.push((tr.roleUpInfo.kind === "ts" ? "Target share " : "Carry share ") + fmtVal(tr.roleUpInfo.prev) + "% → " + fmtVal(tr.roleUpInfo.l3) + "%");
          }
          if (tr.snapUp && tr.roleUp) ob += 2;
          raw += ob;
          var myU = nflUsageOf(e.pid);
          if (myU){
            var myBase = avgOf(seriesOf(myU.sn)), bestMate2 = null;
            Object.keys(players).forEach(function(pid2){
              if (pid2 === e.pid || !inj[pid2]) return;
              var p2 = players[pid2] || {};
              if (p2.team !== p.team || p2.pos !== p.pos) return;
              var u2 = nflUsageOf(pid2); if (!u2) return;
              var b2 = avgOf(seriesOf(u2.sn));
              if (b2 != null && (myBase == null || b2 > myBase) && (!bestMate2 || b2 > bestMate2.base)) bestMate2 = { name: p2.name, base: b2 };
            });
            if (bestMate2){ raw += 4; teamChip = "Teammate out: " + bestMate2.name; }
          }
        }
        /* Opponent adjustment from the page's own logs: the upcoming
           defense's rank for this stat's group — bottom-8 (soft) adds a
           small boost, top-8 (tough) a small penalty, and above-baseline
           games this season against top-10 defenses earn slight credit. */
        var grp = nflStatGroup(key);
        var dr = (defRanks && nx && defRanks[grp]) ? defRanks[grp][nx.opp] : null;
        if (dr){
          muChip = "vs #" + dr.rank + " " + grp + " D";
          if (dr.rank > dr.of - 8) raw += 3;
          else if (dr.rank <= 8) raw -= 3;
          var curLen = ((DATA.leagues.NFL.logs || {})[e.pid] || []).length;
          var tough = 0;
          e.rows.slice(0, Math.min(10, curLen)).forEach(function(r){
            var v = udStatVal(r, key);
            if (v == null || !(v > e.base)) return;
            var o2 = (r.opp || "").split(" ").pop();
            var d2 = defRanks[grp][o2];
            if (d2 && d2.rank <= 10) tough++;
          });
          raw += Math.min(3, tough);
        }
      }
      return {
        pid: e.pid, key: key, base: e.base, recent: e.recent, pct: pct, l5: l5,
        beat5: beat5, beat10: beat10, n10: l10.length, streak: streak, n: e.vals.length,
        score: Math.round(raw * Math.min(1, e.vals.length / 20)),
        nx: nx, minChip: minChip, teamChip: teamChip, useChips: useChips, muChip: muChip,
        vs: nx ? udVsOpp(e.rows, key, nx.opp) : null, reason: reason || null
      };
    }
    entries.forEach(function(e){
      var l5 = e.vals.slice(0, 5);
      var beat5 = l5.filter(function(v){ return v > e.base; }).length;
      var p = players[e.pid] || {};
      var nx = isNfl ? udNextGameWeek(p.team) : udNextGame(lg, p.team);
      var fails = [];
      if (!(e.base > 0) || e.base > median) fails.push("Baseline not in the bottom half for " + udStatLabel(lg, key) + " — L20 avg " + fmtVal(e.base));
      if (!(e.recent > e.base)) fails.push("Last 5 not above baseline — " + fmtVal(e.recent) + " vs baseline " + fmtVal(e.base));
      if (beat5 < 2) fails.push(beat5 + " of last 5 above baseline — needs 2");
      if (!nx) fails.push(isNfl ? "No game in the Thu–Mon game week" : "No game today or tomorrow");
      if (state.minRate > 0){
        var br = boardRate(lg, e.pid, key);
        if (br == null || br < state.minRate) fails.push("Hit rate " + (br == null ? "—" : br + "%") + " at the board line — below the " + state.minRate + "% floor");
      }
      if (!fails.length) out.push(scoreEntry(e, nx, null));
      else if (fails.length === 1) near.push(scoreEntry(e, nx, fails[0]));
    });
    /* too few games to judge (5–7 logged) but otherwise over every bar */
    shorts.forEach(function(e){
      var l5 = e.vals.slice(0, 5);
      var beat5 = l5.filter(function(v){ return v > e.base; }).length;
      if (!(e.base > 0) || e.base > median) return;
      if (!(e.recent > e.base)) return;
      if (beat5 < 2) return;
      var p = players[e.pid] || {};
      var nx = isNfl ? udNextGameWeek(p.team) : udNextGame(lg, p.team);
      if (!nx) return;
      if (state.minRate > 0){
        var br = boardRate(lg, e.pid, key);
        if (br == null || br < state.minRate) return;
      }
      near.push(scoreEntry(e, nx, "Only " + e.vals.length + " games logged — needs 8"));
    });
  });
  out.sort(function(a, b){ return (b.score - a.score) || (b.beat5 - a.beat5) || (b.pct - a.pct); });
  /* Variety pass: a straight top 10 by score let one stat category take
     most of the list — receptions are a low-baseline counting stat, so
     their consistency and jump numbers outscore rushing yards almost
     every time (the Nov 14 list ran 5 receptions / 3 passing / 2
     receiving / 0 rushing from a qualifier pool that held 6 / 6 / 6 / 3)
     — and one player could hold several slots with what is really the
     same signal. The list is still built ONLY from entries that cleared
     every floor above — nothing is padded — but when more than one stat
     category qualified it is dealt round-robin across those categories,
     best entry of each category first, with at most 2 slots per player.
     When only one category qualified, the ranked list stands as-is and
     the count line says so. */
  var poolCats = {};
  out.forEach(function(u){ poolCats[u.key] = 1; });
  var catCount = Object.keys(poolCats).length;
  var spread = catCount > 1;
  if (spread){
    var byCat = {}, catOrder = [];
    out.forEach(function(u){
      if (!byCat[u.key]){ byCat[u.key] = []; catOrder.push(u.key); }
      byCat[u.key].push(u);
    });
    var picked = [], perPlayer = {}, ptr = {};
    catOrder.forEach(function(k){ ptr[k] = 0; });
    while (picked.length < 10){
      var progressed = false;
      for (var ci = 0; ci < catOrder.length && picked.length < 10; ci++){
        var ck = catOrder[ci];
        while (ptr[ck] < byCat[ck].length && (perPlayer[byCat[ck][ptr[ck]].pid] || 0) >= 2) ptr[ck]++;
        if (ptr[ck] < byCat[ck].length){
          var ent = byCat[ck][ptr[ck]++];
          perPlayer[ent.pid] = (perPlayer[ent.pid] || 0) + 1;
          picked.push(ent); progressed = true;
        }
      }
      if (!progressed) break;
    }
    out = picked;
  } else {
    var capped = [], ppN = {};
    out.forEach(function(u){
      if ((ppN[u.pid] || 0) >= 2) return;
      ppN[u.pid] = (ppN[u.pid] || 0) + 1;
      capped.push(u);
    });
    out = capped.slice(0, 10);
  }
  /* Near misses: only when the Top 10 comes up short — the next-best
     scored entries that failed exactly one qualification test, up to 3,
     at most 2 slots per player like the list itself. They never count
     toward the Top 10 and never enter any other surface. */
  var nearShown = [];
  if (out.length < 10){
    near.sort(function(a, b){ return (b.score - a.score) || (b.beat5 - a.beat5) || (b.pct - a.pct); });
    var ppNm = {};
    near.forEach(function(u){
      if (nearShown.length >= 3) return;
      if ((ppNm[u.pid] || 0) >= 2) return;
      ppNm[u.pid] = (ppNm[u.pid] || 0) + 1;
      nearShown.push(u);
    });
  }
  var shown = out.filter(function(u){ var p = players[u.pid] || {}; return searchMatch((p.name || "") + " " + (p.team || "")); });
  var nmShown = nearShown.filter(function(u){ var p = players[u.pid] || {}; return searchMatch((p.name || "") + " " + (p.team || "")); });
  $("#udCount").textContent = (out.length
    ? "Top " + out.length + " surging risers · " + lg + " · ranked by Riser Score · " + (isNfl ? "next game in the Thu–Mon game week" : "next game today or tomorrow") + (state.minRate > 0 ? " · min hit rate " + state.minRate + "% (last " + (state.win || 10) + ")" : "") + (spread ? " · spread across stat categories, best of each first" : (catCount === 1 ? " · all " + udStatLabel(lg, out[0].key) + " — the only stat category that qualified" : ""))
    : "No surging risers with a game " + (isNfl ? "in the Thu–Mon game week" : "today or tomorrow") + " · " + lg)
    + (nearShown.length ? " · " + nearShown.length + " near miss" + (nearShown.length > 1 ? "es" : "") : "");
  function udCard(u){
    var p = players[u.pid] || {};
    var vals = u.l5.map(function(v){ return '<span class="uval' + (v > u.base ? ' above' : '') + '">' + fmtVal(v) + '</span>'; }).join("");
    return '<div class="wcard ucard" data-open-logs="' + esc(u.pid) + '" data-stat-key="' + esc(u.key) + '" data-lg="' + lg + '" role="button" tabindex="0" aria-label="Open game log for ' + esc(p.name || "") + '">'
      + '<div class="cardtop">' + avatarHtml(lg, u.pid, p.name)
      + '<div class="who"><div class="nm">' + esc(p.name) + '</div><div class="tm">' + esc(p.team) + (p.pos ? ' · ' + esc(p.pos) : '') + ' · ' + lg + '</div></div>'
      + (u.reason ? '<span class="nmflag">Near miss</span>' : '<div class="uscore"><b>' + u.score + '</b><span>Score</span></div>') + '</div>'
      + '<div class="bigline">' + esc(udStatLabel(lg, u.key)) + '</div>'
      + '<div class="ucmp"><span>Baseline (L20) <b>' + fmtVal(u.base) + '</b></span><span class="arrow">→</span><span>Last 5 <b>' + fmtVal(u.recent) + '</b></span><span class="upct">+' + u.pct + '%</span></div>'
      + '<div class="uvals"><span class="lab">Last 5</span>' + vals + '</div>'
      + '<div class="umeta">'
      + (u.nx ? '<span class="unext">' + u.nx.when + (u.nx.home ? ' vs ' : ' @ ') + esc(u.nx.opp) + ' · ' + esc(udDayLabel(u.nx.day)) + '</span>' : '')
      + '<span class="ubeat">+' + u.pct + '% vs normal</span>'
      + '<span class="ubeat">' + u.beat5 + ' of last 5 above</span>'
      + '<span class="ubeat">' + u.beat10 + ' of last ' + u.n10 + ' above</span>'
      + (u.streak >= 2 ? '<span class="ustreak">Streak ' + u.streak + '</span>' : '')
      + (u.minChip ? '<span class="uopp">' + esc(u.minChip) + '</span>' : '')
      + (u.teamChip ? '<span class="uopp">' + esc(u.teamChip) + '</span>' : '')
      + (u.useChips || []).map(function(c){ return '<span class="uopp">' + esc(c) + '</span>'; }).join("")
      + (u.muChip ? '<span class="ubeat">' + esc(u.muChip) + '</span>' : '')
      + (u.vs ? '<span class="ubeat">Avg ' + fmtVal(u.vs.avg) + ' vs ' + esc(u.nx.opp) + ' · ' + u.vs.n + ' meeting' + (u.vs.n > 1 ? 's' : '') + '</span>' : '')
      + '</div>'
      + (u.reason ? '<div class="nmreason">Missed: ' + esc(u.reason) + '</div>' : '')
      + '<div class="cardfoot" style="margin-top:10px"><span class="note">Score from ' + u.n + ' logged games · tap for the full game log.</span>'
      + '<button class="openbtn" data-open-logs="' + esc(u.pid) + '" data-stat-key="' + esc(u.key) + '" data-lg="' + lg + '">Game log</button></div></div>';
  }
  var gridHtml = out.length ? shown.map(udCard).join("") : '<div class="emptybox">' + (isNfl
    ? 'No surging risers with a game in the Thu–Mon game week in NFL. The list only shows bottom-half players whose last-5 form is above their baseline, with their next game in the current game week (Thursday–Monday, Eastern) — it never reaches further ahead to fill the spots.'
    : 'No surging risers with a game today or tomorrow in ' + lg + '. The list only shows bottom-half players whose last-5 form is above their baseline, with their next game today or tomorrow (Eastern) — it never reaches further ahead to fill the spots.') + '</div>';
  if (nmShown.length) gridHtml += '<div class="nmwrap"><div class="nmhead">Near misses</div><div class="nmsub">Close, but each missed one test — they are not in the Top 10.</div><div class="wlist">' + nmShown.map(udCard).join("") + '</div></div>';
  if (out.length && !shown.length && !nmShown.length) gridHtml = '<div class="emptybox">No risers match your search in ' + lg + '.</div>';
  if (gridHtml !== _udGridHtml){ _udGridHtml = gridHtml; $("#udGrid").innerHTML = gridHtml; }
}


/* ---------- Randomizer ---------- */
/* Stat options come from the props actually on the board for the selected
   leagues (statDefs order first, then any extra prop stats such as the NBA
   Pts+Reb+Ast combo), keyed per league so NBA Points and NHL Points stay
   separate picks. Selection lives in state.randStats as "LG:key" flags. */
function randStatOptions(){
  var out = [], seen = {};
  LEAGUES.forEach(function(lg){
    if (!state.randLeagues[lg]) return;
    (DATA.leagues[lg].statDefs || []).forEach(function(d){
      var id = lg + ":" + d.k;
      if (!seen[id]){ seen[id] = 1; out.push({ lg:lg, key:d.k, label:d.label, id:id }); }
    });
    (DATA.leagues[lg].props || []).forEach(function(p){
      var id = lg + ":" + p.key;
      if (!seen[id]){ seen[id] = 1; out.push({ lg:lg, key:p.key, label:p.stat, id:id }); }
    });
  });
  return out;
}
function syncRandStats(){
  var opts = randStatOptions(), valid = {};
  opts.forEach(function(o){ valid[o.id] = 1; });
  if (!state.randStats){
    state.randStats = {};
    opts.forEach(function(o){ state.randStats[o.id] = true; });
    return;
  }
  /* Stats of a deselected league drop out of the selection. An empty
     selection is a real state (the user can clear everything via the
     All stats toggle) — it is NOT auto-refilled here. */
  Object.keys(state.randStats).forEach(function(id){ if (!valid[id]) delete state.randStats[id]; });
}
function randSelectedCount(){
  var n = 0;
  randStatOptions().forEach(function(o){ if (state.randStats && state.randStats[o.id]) n++; });
  return n;
}
function renderRandStats(){
  syncRandStats();
  var opts = randStatOptions();
  var labelCount = {};
  opts.forEach(function(o){ labelCount[o.label] = (labelCount[o.label] || 0) + 1; });
  var allOn = opts.length > 0 && opts.every(function(o){ return state.randStats[o.id]; });
  var html = '<button class="chip" data-rand-all="1" aria-pressed="' + (allOn ? "true" : "false") + '">All stats</button>';
  html += opts.map(function(o){
    var lab = labelCount[o.label] > 1 ? o.lg + " · " + o.label : o.label;
    return '<button class="chip" data-rs="' + esc(o.id) + '" aria-pressed="' + (state.randStats[o.id] ? "true" : "false") + '">' + esc(lab) + '</button>';
  }).join("");
  $("#randStats").innerHTML = html;
  $$("#randStats .chip").forEach(function(c){
    c.addEventListener("click", function(){
      if (c.getAttribute("data-rand-all")){
        /* All stats is a true toggle: filled (every stat on) -> clicking
           empties the selection; anything else -> clicking fills it. */
        var optsNow = randStatOptions();
        var filledNow = optsNow.length > 0 && optsNow.every(function(o){ return state.randStats[o.id]; });
        optsNow.forEach(function(o){ state.randStats[o.id] = !filledNow; });
        renderRandStats(); renderPoolNote(null);
        return;
      }
      var id = c.getAttribute("data-rs"), on = c.getAttribute("aria-pressed") === "true";
      /* No minimum-one guard: individual stats can be tapped down to zero. */
      state.randStats[id] = !on;
      renderRandStats(); renderPoolNote(null);
    });
  });
}
function randStatsSummary(){
  var opts = randStatOptions();
  var sel = opts.filter(function(o){ return state.randStats[o.id]; });
  if (opts.length && !sel.length) return "no stats";
  if (!opts.length || sel.length === opts.length) return "all stats";
  var seen = {}, labs = [];
  sel.forEach(function(o){ if (!seen[o.label]){ seen[o.label] = 1; labs.push(o.label); } });
  if (labs.length > 5) return labs.slice(0, 5).join(", ") + " +" + (labs.length - 5) + " more";
  return labs.join(", ");
}
/* ---------- Shuffle games filter ----------
   A "Games" row at the top of the Shuffle view: a "Today's games"
   toggle chip plus one tappable chip per game on the slate,
   multi-select. The slate is today's games (ET) for NBA/NHL and the
   current Thu–Mon week for the NFL — the same windows the board and
   the pipeline use — read from LG (the live-merged game lists),
   falling back to the baked chunk games. "Today's games" selects the
   whole slate; tapping it again (or Clear, which appears whenever a
   selection exists) empties the selection, and its pressed state
   simply reflects "the whole slate is selected". The selection lives
   in state.randGames keyed by game id; every chip re-render prunes
   ids whose games left the slate or whose league was switched off in
   the Shuffle league row, so fresh games data after a poll refreshes
   the chips without wiping a live selection. While any game is
   selected, the deal pool keeps only props whose player is on one of
   the selected games' two teams; every other Shuffle rule (injuries,
   hit-rate floor, No 0.5 lines, stat picks, direction, NFL usage
   weighting, weighted draw, short-pool honesty) applies on top,
   unchanged. */
function etYMD(iso){
  var parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  var y = "", m = "", d = "";
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].type === "year") y = parts[i].value;
    else if (parts[i].type === "month") m = parts[i].value;
    else if (parts[i].type === "day") d = parts[i].value;
  }
  if (!y) throw new Error("bad date");
  return y + "-" + m + "-" + d;
}
function etDayStr(iso){
  try { return etYMD(iso); } catch (e) { return ""; }
}
function nflWeekDayStrs(){
  var d = new Date(etDayStr(new Date().toISOString()) + "T12:00:00Z");
  var dow = (d.getUTCDay() + 6) % 7;               /* Mon=0 ... Sun=6 */
  var start = new Date(d.getTime());
  start.setUTCDate(start.getUTCDate() - ((dow - 3 + 7) % 7));   /* back to Thursday */
  if (d.getTime() > start.getTime() + 4 * 864e5) start.setUTCDate(start.getUTCDate() + 7);
  var days = [];
  for (var i = 0; i < 5; i++){
    var x = new Date(start.getTime());
    x.setUTCDate(x.getUTCDate() + i);
    days.push(x.toISOString().slice(0, 10));
  }
  return days;
}
function etDayStrPlus(n){
  return etDayStr(new Date(Date.now() + n * 864e5).toISOString());
}
function randSlateGames(lg){
  /* Merge the baked slate with the live one by id instead of picking one:
     the baked chunks span today + tomorrow, the live list is fresher for
     states and scores. Live wins on conflict, so a game that has tipped
     off (or finished) since the bake drops out of the pre filter. */
  var byId = {}, all = [];
  ((DATA.leagues[lg] && DATA.leagues[lg].games) || []).forEach(function(g){ if (g && g.id) byId[g.id] = g; });
  (((window.__LL.LG || {})[lg]) || []).forEach(function(g){ if (g && g.id) byId[g.id] = g; });
  Object.keys(byId).forEach(function(k){ all.push(byId[k]); });
  var days = lg === "NFL" ? nflWeekDayStrs() : [etDayStr(new Date().toISOString()), etDayStrPlus(1)];
  var inDays = {};
  days.forEach(function(x){ inDays[x] = 1; });
  return stripGames(all.filter(function(g){ return g.state === "pre" && inDays[etDayStr(g.date)]; }));
}
function randSelectedGames(){
  var out = [];
  LEAGUES.forEach(function(lg){
    if (!state.randLeagues[lg]) return;
    randSlateGames(lg).forEach(function(g){ if (state.randGames[g.id]) out.push({ lg: lg, g: g }); });
  });
  return out;
}
function randGameTeamSet(){
  var set = {};
  randSelectedGames().forEach(function(x){
    set[x.lg + "|" + x.g.away.abbr] = 1;
    set[x.lg + "|" + x.g.home.abbr] = 1;
  });
  return Object.keys(set).length ? set : null;
}
function renderRandGames(){
  var wrap = $("#randGames");
  if (!wrap) return;
  var valid = {};
  LEAGUES.forEach(function(lg){
    if (!state.randLeagues[lg]) return;
    randSlateGames(lg).forEach(function(g){ valid[g.id] = 1; });
  });
  Object.keys(state.randGames).forEach(function(id){ if (!valid[id]) delete state.randGames[id]; });
  var html = "", selCount = 0;
  var todayStr = etDayStr(new Date().toISOString()), tomorrowStr = etDayStrPlus(1);
  var tCount = 0, tSel = 0, tmCount = 0, tmSel = 0;
  LEAGUES.forEach(function(lg){
    if (!state.randLeagues[lg]) return;
    randSlateGames(lg).forEach(function(g){
      var on = !!state.randGames[g.id];
      if (on) selCount++;
      var gd = etDayStr(g.date);
      if (gd === todayStr){ tCount++; if (on) tSel++; }
      else if (gd === tomorrowStr){ tmCount++; if (on) tmSel++; }
      html += '<button class="chip" data-rg="' + esc(g.id) + '" aria-pressed="' + (on ? "true" : "false") + '">'
        + esc(g.away.abbr) + ' @ ' + esc(g.home.abbr) + ' · ' + esc(gameStatusLine(g)) + '</button>';
    });
  });
  wrap.innerHTML = html || '<span style="color:var(--ink3);font-size:12px">No upcoming games on the slate for the selected leagues.</span>';
  $$("#randGames .chip").forEach(function(c){
    c.addEventListener("click", function(){
      var id = c.getAttribute("data-rg");
      if (state.randGames[id]) delete state.randGames[id]; else state.randGames[id] = 1;
      renderRandGames();
      renderPoolNote(null);
    });
  });
  var todayBtn = $("#randToday");
  if (todayBtn) todayBtn.setAttribute("aria-pressed", tCount > 0 && tSel === tCount ? "true" : "false");
  var tomorrowBtn = $("#randTomorrow");
  if (tomorrowBtn) tomorrowBtn.setAttribute("aria-pressed", tmCount > 0 && tmSel === tmCount ? "true" : "false");
  var clearBtn = $("#randGamesClear");
  if (clearBtn) clearBtn.hidden = selCount === 0;
}
window.__LL.renderRandGames = renderRandGames;

function randPool(){
  syncRandStats();
  var min = +$("#randMin").value, pool = [];
  var gameSet = randGameTeamSet();
  LEAGUES.forEach(function(lg){
    if (!state.randLeagues[lg]) return;
    (DATA.leagues[lg].props || []).forEach(function(p){
      /* games filter: with games selected, only the two teams in
         those games deal */
      if (gameSet && !gameSet[lg + "|" + p.team]) return;
      if (isInjured(lg, p)) return;
      if (lg === "NFL" && nflTdGimme(p)) return;
      if (rareUnderHidden(lg, p)) return;
      /* "No 0.5 lines" toggle: every 0.5-line prop, either direction,
         stays out of the pool while it is on */
      if (state.randNoHalf && p.line === 0.5) return;
      if (!state.randStats[lg + ":" + p.key]) return;
      /* NFL only: a touchdown prop deals only when the player's recent
         red-zone opportunities back it (at or above his position group's
         median in the pool). Unsupported TD props stay on the Props board;
         they are simply never dealt here. */
      if (lg === "NFL" && NFL_TD_KEYS[p.key] && !nflTdBacked(p.pid)) return;
      /* Direction filter: p.dir is the prop's recommended side (the one with
         the higher L10 hit rate). "Both" deals either; Over/Under deal only
         that side — the pool never pads with the other direction. */
      if (state.randDir && state.randDir !== "Both" && p.dir !== state.randDir) return;
      /* Qualifying test: the prop's SEASON hit rate at the board line
         (seasonRate — this season's logs only, every game counting).
         The entry's r stays the L20 rate: it only feeds the draw weight
         and the combined-rate note, neither of which changed. */
      var sr = seasonRate(lg, p);
      if (sr != null && sr >= min){
        /* NFL usage tier for deal weighting: 0 = usage rising, 1 = steady
           or no usage data, 2 = usage falling. Other leagues stay tier 1
           (neutral weight). */
        var r = dirRate(p, "L20");
        var tier = 1;
        if (lg === "NFL"){ var tr = nflUsageTrend(p.pid); tier = !tr ? 1 : (tr.rising ? 0 : (tr.falling ? 2 : 1)); }
        pool.push({ p:p, lg:lg, r: (r != null ? r : sr), tier:tier });
      }
    });
  });
  return pool;
}
window.__LL.randPool = randPool;
function renderPoolNote(dealt, picks){
  if (randStatOptions().length && randSelectedCount() === 0){
    $("#poolNote").innerHTML = '<b>0</b> props in the pool — no stats selected. Tap <b>All stats</b> or pick stats to fill it.';
    return;
  }
  var pool = randPool(), want = +$("#randCount").value;
  var dirTxt = state.randDir === "Over" ? "Overs only" : (state.randDir === "Under" ? "Unders only" : "both directions");
  var txt = '<b>' + pool.length + '</b> props at ' + $("#randMin").value + '%+ (Season) across ' + LEAGUES.filter(function(l){ return state.randLeagues[l]; }).join(", ") + ' · ' + dirTxt + ' · stats: ' + esc(randStatsSummary()) + '.';
  if (state.randNoHalf) txt += ' 0.5 lines are excluded from the pool.';
  var selGames = randSelectedGames();
  if (selGames.length) txt += ' Games filter on: ' + selGames.length + ' game' + (selGames.length > 1 ? 's' : '') + ' selected — the pool only deals players from those matchups.';
  /* a control change makes any dealt set's correlation warning stale */
  if (dealt == null){ var dw0 = $("#dealWarn"); if (dw0) dw0.hidden = true; }
  if (state.randLeagues.NFL) txt += ' NFL props are usage-weighted: rising-usage players are drawn more often, and TD props need red-zone usage behind them.';
  if (dealt != null){
    txt += ' Dealt ' + dealt + ' of ' + want + ' requested.';
    if (picks && picks.length){
      var comb = 1;
      picks.forEach(function(x){ comb *= (x.r || 0) / 100; });
      var cpct = comb * 100;
      txt += ' Combined L10 hit rate for the set: <b>' + (cpct >= 10 ? Math.round(cpct) : Math.round(cpct * 10) / 10) + '%</b>.';
    }
    if (dealt < want) txt += ' The pool is smaller than the pick count at this threshold, so you got everything available — the rate floor was not lowered to fill the set.';
  }
  $("#poolNote").innerHTML = txt;
}
function dealCard(x){
  var p = x.p, lg = x.lg;
  return '<article class="card dealcard" data-open-logs="' + esc(p.pid) + '" data-stat-key="' + esc(p.key) + '" data-lg="' + esc(lg) + '" role="button" tabindex="0" aria-label="Open game log for ' + esc(p.name) + ' — ' + esc(p.stat) + '">'
    + '<div class="cardtop">' + avatarHtml(lg, p.pid, p.name)
    + '<div class="who"><div class="nm">' + esc(p.name) + '</div><div class="tm">' + esc(p.team) + (p.pos ? ' · ' + esc(p.pos) : '') + ' · ' + esc(lg) + '</div>' + nflCardMetaHtml(p, lg) + '</div>'
    + '<div class="streak' + (p.streak >= 5 ? " hot" : "") + '"><b>' + p.streak + '</b><span>' + (p.dir === "Over" ? "Over" : "Under") + ' streak</span></div></div>'
    + '<div class="linebox"><span class="dir ' + (p.dir === "Over" ? "over" : "under") + '">' + p.dir + ' ' + fmtVal(p.line) + '</span>'
    + '<span class="stat">' + esc(p.stat) + '</span>'
    + '<span class="avg">Avg <b>' + fmtVal(p.avg) + '</b><br>L10 avg <b>' + fmtVal(p.l10avg) + '</b> · Last <b>' + fmtVal(p.last) + '</b></span></div>'
    + '<div class="rates">' + rateCell(p, "L5") + rateCell(p, "L10") + rateCell(p, "L20") + '</div>'
    + '<div class="cardfoot"><span class="note">' + p.gp + ' games logged · hit rates vs this line</span>'
    + '<button class="openbtn" data-open-logs="' + esc(p.pid) + '" data-stat-key="' + esc(p.key) + '" data-lg="' + esc(lg) + '">Game log</button></div>'
    + '</article>';
}
function deal(){
  if (randStatOptions().length && randSelectedCount() === 0){
    $("#dealGrid").innerHTML = '<div class="emptybox" style="grid-column:1/-1">No stats selected — tap All stats or pick stats.</div>';
    renderPoolNote(0, []);
    return;
  }
  var pool = randPool(), want = +$("#randCount").value;
  /* Weighted draw, without replacement. Every press samples the whole
     qualified pool instead of re-dealing its front: a prop's weight rises
     with its L10 hit rate, NFL props get a usage multiplier (rising usage
     ×2, falling ×0.5 — the previous hard tier sort pinned the same
     rising-usage props to the front of every deal in the same order, so
     at the default 80% floor, where the whole qualified NFL pool is two
     rushing-TD props, every NFL deal came out identical), and a leg
     whose league + stat already appears twice in this deal — or whose
     player is already in it — is drawn far less readily, so a deal
     spreads across stat types and names. A capped category sits a draw
     out only while an uncapped alternative remains, so a small pool
     still deals everything it has. No player + stat can repeat — pool entries are unique props
     and each pick leaves the draw. */
  var picks = [], rest = pool.slice();
  while (picks.length < want && rest.length){
    var catN = {}, plN = {};
    picks.forEach(function(x){
      var ck2 = x.lg + ":" + x.p.key;
      catN[ck2] = (catN[ck2] || 0) + 1;
      plN[x.p.pid] = (plN[x.p.pid] || 0) + 1;
    });
    var hasAlt = rest.some(function(x){ return (catN[x.lg + ":" + x.p.key] || 0) < 2; });
    var total = 0, ws = rest.map(function(x){
      var w = Math.max(1, (x.r || 50) - 40);
      if (x.lg === "NFL") w *= x.tier === 0 ? 2 : (x.tier === 2 ? 0.5 : 1);
      if ((catN[x.lg + ":" + x.p.key] || 0) >= 2) w *= hasAlt ? 0 : 0.04;
      if (plN[x.p.pid]) w *= 0.3;
      total += w;
      return w;
    });
    var roll = Math.random() * total, idx = 0;
    while (idx < rest.length - 1 && roll > ws[idx]){ roll -= ws[idx]; idx++; }
    picks.push(rest.splice(idx, 1)[0]);
  }
  $("#dealGrid").innerHTML = picks.length ? picks.map(function(x){ return dealCard(x); }).join("")
    : '<div class="emptybox" style="grid-column:1/-1">No props clear that hit-rate floor for the selected leagues, stats and direction. Try 70% or 50%, add more stats, or switch direction to Both.</div>';
  renderPoolNote(picks.length, picks);
  renderDealWarnings(picks);
}
/* Correlation warning: a dealt set that stacks 3+ legs from one game
   (same matchup, via each team's next game) or one team gets a short
   warning line under the deal. Warning only — the deal itself is never
   changed or re-dealt. */
function renderDealWarnings(picks){
  var dw = $("#dealWarn");
  if (!dw) return;
  var warns = [];
  var byTeam = {};
  picks.forEach(function(x){ var k = x.lg + "|" + x.p.team; (byTeam[k] = byTeam[k] || []).push(x); });
  Object.keys(byTeam).forEach(function(k){
    if (byTeam[k].length < 3) return;
    var x = byTeam[k][0], pl = playerOf(x.lg, x.p.pid) || {};
    var nm = pl.teamName ? (shortTeamName(pl.teamName, x.p.team) || pl.teamName) : x.p.team;
    warns.push("Same team: " + byTeam[k].length + " legs from the " + nm);
  });
  var byGame = {};
  picks.forEach(function(x){
    var nx = x.lg === "NFL" ? udNextGameWeek(x.p.team) : udNextGame(x.lg, x.p.team);
    if (!nx) return;
    var away = nx.home ? nx.opp : x.p.team, home = nx.home ? x.p.team : nx.opp;
    var k = x.lg + "|" + away + "@" + home;
    if (!byGame[k]) byGame[k] = { n: 0, label: away + " @ " + home };
    byGame[k].n++;
  });
  Object.keys(byGame).forEach(function(k){
    if (byGame[k].n >= 3) warns.push("Same-game stack: " + byGame[k].n + " legs from " + byGame[k].label);
  });
  if (warns.length){ dw.innerHTML = warns.map(esc).join("<br>"); dw.hidden = false; }
  else dw.hidden = true;
}
$("#dealBtn").addEventListener("click", deal);
(function(){
  var db = $("#dealBtn");
  if (!db) return;
  var dbT = null, dbDown = 0;
  function dbPress(){
    dbDown = Date.now();
    if (dbT){ clearTimeout(dbT); dbT = null; }
    db.classList.add("deal-pressed");
  }
  function dbRelease(){
    if (!db.classList.contains("deal-pressed")) return;
    var wait = Math.max(0, 350 - (Date.now() - dbDown));
    if (dbT) clearTimeout(dbT);
    dbT = setTimeout(function(){ db.classList.remove("deal-pressed"); dbT = null; }, wait);
  }
  db.addEventListener("pointerdown", dbPress);
  db.addEventListener("pointerup", dbRelease);
  db.addEventListener("pointercancel", dbRelease);
  db.addEventListener("pointerleave", dbRelease);
  db.addEventListener("click", function(){
    if (!db.classList.contains("deal-pressed") && !dbT){ dbPress(); dbRelease(); }
  });
})();
$("#randNoHalf").addEventListener("click", function(){
  state.randNoHalf = !state.randNoHalf;
  this.setAttribute("aria-pressed", state.randNoHalf ? "true" : "false");
  renderPoolNote(null);
});
$$("#randDir button").forEach(function(b){
  b.addEventListener("click", function(){
    state.randDir = b.getAttribute("data-rd");
    $$("#randDir button").forEach(function(x){ x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    renderPoolNote(null);
  });
});
$("#randMin").addEventListener("input", function(){ var v = $("#randMinVal"); if (v) v.textContent = $("#randMin").value + "%"; renderPoolNote(null); });
$("#randMin").addEventListener("change", function(){ renderPoolNote(null); });
$("#randCount").addEventListener("change", function(){ renderPoolNote(null); });
function randToggleDay(dayStr){
  var ids = [];
  LEAGUES.forEach(function(lg){
    if (!state.randLeagues[lg]) return;
    randSlateGames(lg).forEach(function(g){ if (etDayStr(g.date) === dayStr) ids.push(g.id); });
  });
  var allOn = ids.length > 0 && ids.every(function(id){ return state.randGames[id]; });
  if (allOn) ids.forEach(function(id){ delete state.randGames[id]; });
  else ids.forEach(function(id){ state.randGames[id] = 1; });
  renderRandGames();
  renderPoolNote(null);
}
$("#randToday").addEventListener("click", function(){ randToggleDay(etDayStr(new Date().toISOString())); });
$("#randTomorrow").addEventListener("click", function(){ randToggleDay(etDayStrPlus(1)); });
$("#randGamesClear").addEventListener("click", function(){
  state.randGames = {};
  renderRandGames();
  renderPoolNote(null);
});
$$("#randLeagues .chip").forEach(function(c){
  c.addEventListener("click", function(){
    var lg = c.getAttribute("data-rl");
    var on = c.getAttribute("aria-pressed") === "true";
    if (on && LEAGUES.filter(function(l){ return state.randLeagues[l]; }).length === 1) return;
    state.randLeagues[lg] = !on;
    c.setAttribute("aria-pressed", !on ? "true" : "false");
    if (!on){
      /* A league switched back on brings its stats back into the selection. */
      if (!state.randStats) state.randStats = {};
      randStatOptions().forEach(function(o){ if (o.lg === lg) state.randStats[o.id] = true; });
    }
    renderRandStats();
    renderRandGames();
    renderPoolNote(null);
  });
});
renderRandStats();
renderRandGames();
renderPoolNote(null);

/* ---------- Cheatsheets ---------- */
function renderSheets(){
  var byStat = {};
  (L().props || []).forEach(function(p){
    if (isInjured(state.league, p)) return;
    if (state.league === "NFL" && nflTdGimme(p)) return;
    if (rareUnderHidden(state.league, p)) return;
    /* the shared Min hit rate floor applies here too, over the selected
       Games window — groups it empties simply never render */
    if (state.minRate > 0){ var ws = winStat(state.league, p); if (!ws || ws.rate < state.minRate) return; }
    /* Min games / Min average floors apply here too, over the window */
    if (state.minGames || state.minAvg > 0){ var wq = winStat(state.league, p); if (!wq) return; if (state.minGames && wq.n < state.minGames) return; if (state.minAvg > 0 && wq.avg < state.minAvg) return; }
    /* Streaks direction filter: Both (the default) shows every streak;
       Over / Under keep only entries whose streak runs on that side of
       the line — p.dir is the direction this prop's streak was computed
       for, the same direction the row displays */
    if (state.streakDir && state.streakDir !== "Both" && p.dir !== state.streakDir) return;
    var r = dirRate(p, "L10");
    if (r == null) return;
    if (r >= 90 || p.streak >= 5) (byStat[p.stat] = byStat[p.stat] || []).push(p);
  });
  var order = allStatLabels(state.league);
  var html = "";
  order.forEach(function(stat){
    var rows = (byStat[stat] || []).sort(function(a, b){ return (b.streak - a.streak) || (dirRate(b, "L10") - dirRate(a, "L10")); }).slice(0, 8);
    if (!rows.length) return;
    html += '<div class="ssheet"><h3>' + esc(stat) + ' <span class="tag">90%+ L10 or 5+ streak</span></h3>';
    rows.forEach(function(p){
      var r = dirRate(p, "L10");
      html += '<div class="srow" data-open-logs="' + esc(p.pid) + '" data-stat-key="' + esc(p.key) + '" data-lg="' + state.league + '" role="button" tabindex="0" aria-label="Open game log for ' + esc(p.name) + ' \u2014 ' + esc(p.stat) + '">' + avatarHtml(state.league, p.pid, p.name)
        + '<div class="who"><div class="nm">' + esc(p.name) + '</div><div class="tm">' + esc(p.team) + (p.pos ? ' · ' + esc(p.pos) : '') + '</div></div>'
        + '<div class="barwrap"><div class="lab" style="display:flex;justify-content:space-between;font-size:11px;font-weight:700;color:var(--ink3);margin-bottom:4px"><span>L10</span><b>' + r + '%</b></div><div class="bar"><i class="' + barClass(r) + '" style="width:' + r + '%"></i></div></div>'
        + '<span class="line">' + p.dir + ' ' + fmtVal(p.line) + ' ' + esc(p.stat) + '</span>'
        + '<div class="streak' + (p.streak >= 5 ? " hot" : "") + '"><b>' + p.streak + '</b><span>Streak</span></div>'
        + '<button class="openbtn" data-open-logs="' + esc(p.pid) + '" data-stat-key="' + esc(p.key) + '" data-lg="' + state.league + '">Log</button></div>';
    });
    html += '</div>';
  });
  $("#sheets").innerHTML = html || '<div class="emptybox">No 90%+ streaks for ' + state.league + ' right now.</div>';
}
/* Streaks direction switch: same pattern as Shuffle's — the choice lives
   in state.streakDir, so leaving for Top Props / Watchlist and coming
   back keeps it for the session */
$$("#streakDir button").forEach(function(b){
  b.addEventListener("click", function(){
    state.streakDir = b.getAttribute("data-sd");
    $$("#streakDir button").forEach(function(x){ x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    renderSheets();
  });
});

/* ---------- Injuries ---------- */
function renderInjuries(){
  var all = L().injuries || [];
  var statuses = ["All"].concat(Array.from(new Set(all.map(function(i){ return i.status || "Unknown"; }))).sort());
  if (statuses.indexOf(state.injStatus) < 0) state.injStatus = "All";
  $("#injChips").innerHTML = statuses.map(function(s){
    return '<button class="chip" data-inj="' + esc(s) + '" aria-pressed="' + (state.injStatus === s ? "true" : "false") + '">' + esc(s) + '</button>';
  }).join("");
  $$("#injChips .chip").forEach(function(c){ c.addEventListener("click", function(){ state.injStatus = c.getAttribute("data-inj"); renderInjuries(); }); });
  /* Team dropdown: 'All teams' plus every team on this league's injury
     list, each with its injured-player count. Built from the full league
     list (not the status/search-filtered list) so the options and counts
     stay stable while the other filters change. League switches reset
     state.injTeam to 'All' in setLeague; a stale pick also falls back. */
  var teamCounts = {};
  all.forEach(function(i){ var t = i.team || "Unknown"; teamCounts[t] = (teamCounts[t] || 0) + 1; });
  var teams = Object.keys(teamCounts).sort(function(a, b){ return a.localeCompare(b); });
  if (state.injTeam !== "All" && !teamCounts[state.injTeam]) state.injTeam = "All";
  var teamSel = $("#injTeamSel");
  if (teamSel){
    teamSel.innerHTML = '<option value="All"' + (state.injTeam === "All" ? " selected" : "") + '>All teams</option>'
      + teams.map(function(t){
        return '<option value="' + esc(t) + '"' + (state.injTeam === t ? " selected" : "") + '>' + esc(t) + ' (' + teamCounts[t] + ')</option>';
      }).join("");
    teamSel.value = state.injTeam;
    teamSel.onchange = function(){ state.injTeam = teamSel.value; renderInjuries(); };
  }
  var list = all.filter(function(i){
    if (state.injStatus !== "All" && (i.status || "Unknown") !== state.injStatus) return false;
    if (state.injTeam !== "All" && (i.team || "Unknown") !== state.injTeam) return false;
    return searchMatch(i.name + " " + i.team + " " + (i.type || ""));
  });
  $("#injCount").textContent = list.length + " entries · " + state.league + " · injury report";
  var playersByName = {};
  Object.keys(L().players || {}).forEach(function(pid){ var pp = L().players[pid]; if (pp && pp.name) playersByName[pp.name] = pid; });
  $("#injList").innerHTML = list.length ? list.slice(0, 120).map(function(i){
    var cls = i.status === "Out" ? "out" : (/question|doubt/i.test(i.status || "") ? "ques" : "other");
    var ipid = playersByName[i.name] || "";
    return '<div class="irow"' + (ipid ? ' data-open-logs="' + esc(ipid) + '" data-stat-key="" data-lg="' + state.league + '" role="button" tabindex="0" aria-label="Open game log for ' + esc(i.name) + '"' : '') + '><div class="who"><div class="nm" style="font-weight:700;font-size:15.5px">' + esc(i.name)
      + ' <span style="color:var(--ink3);font-weight:300;font-size:13px">' + esc(i.team) + (i.pos ? ' · ' + esc(i.pos) : '') + (i.type ? ' · ' + esc(i.type) : '') + '</span></div>'
      + (i.comment ? '<div class="comment">' + esc(i.comment) + '</div>' : '') + '</div>'
      + '<span class="idate">' + fmtD(i.date) + '</span><span class="status ' + cls + '">' + esc(i.status || "Unknown") + '</span></div>';
  }).join("") : '<div class="emptybox">No injuries match that filter.</div>';
}


  /* ---------- Game Logs tab: players ranked by stat category + window (log opens as a popup) ---------- */
  function logStatKeys(lg){
    var keys = (DATA.leagues[lg].statDefs || []).map(function(s){ return s.k; });
    if (lg === "NBA"){ if (keys.indexOf("threePointersMade") < 0) keys.push("threePointersMade"); keys.push("combo"); }
    return keys;
  }
  function logStatLabel(lg, key){
    if (key === "combo") return "Pts+Reb+Ast";
    if (key === "threePointersMade") return "3-Pointers";
    var defs = DATA.leagues[lg].statDefs || [];
    for (var i = 0; i < defs.length; i++) if (defs[i].k === key) return defs[i].label;
    return key;
  }
  function logStatVal(row, key){
    var s = row.s || {};
    if (key === "combo"){
      if (s.points == null || s.totalRebounds == null || s.assists == null) return null;
      return s.points + s.totalRebounds + s.assists;
    }
    var v = s[key];
    return (v == null || isNaN(v)) ? null : v;
  }
  var LOG_WINS = [5, 10, 25, 50];
  function renderPlayerIndex(){
    var lg = state.league;
    var players = DATA.leagues[lg].players || {}, logs = DATA.leagues[lg].logs || {}, logsPrev = DATA.leagues[lg].logsPrev || {};
    var keys = logStatKeys(lg);
    if (!state.logStat || keys.indexOf(state.logStat) < 0) state.logStat = keys[0];
    var key = state.logStat, label = logStatLabel(lg, key);
    if (LOG_WINS.indexOf(state.logWin) < 0) state.logWin = 10;
    var win = state.logWin;
    var chipsEl = $("#logStatChips");
    if (chipsEl){
      chipsEl.innerHTML = keys.map(function(k){
        return '<button class="chip" data-logstat="' + esc(k) + '" aria-pressed="' + (k === key ? "true" : "false") + '">' + esc(logStatLabel(lg, k)) + '</button>';
      }).join("");
      $$("#logStatChips .chip").forEach(function(c){ c.addEventListener("click", function(){ state.logStat = c.getAttribute("data-logstat"); renderPlayerIndex(); }); });
    }
    var winEl = $("#logWinChips");
    if (winEl){
      winEl.innerHTML = LOG_WINS.map(function(w){
        return '<button class="chip" data-logwin="' + w + '" aria-pressed="' + (w === win ? "true" : "false") + '">Last ' + w + '</button>';
      }).join("");
      $$("#logWinChips .chip").forEach(function(c){ c.addEventListener("click", function(){ state.logWin = +c.getAttribute("data-logwin"); renderPlayerIndex(); }); });
    }
    var ranked = [];
    Object.keys(logs).forEach(function(id){
      if (!players[id]) return;
      /* merged log: this season first, then last season fills the bigger windows */
      var vals = [];
      (logs[id] || []).concat(logsPrev[id] || []).forEach(function(r){ var v = logStatVal(r, key); if (v != null) vals.push(v); });
      var w = vals.slice(0, win);
      if (w.length < 3) return;
      var sum = 0; w.forEach(function(v){ sum += v; });
      ranked.push({ id:id, avg: sum / w.length, n: w.length, l5: vals.slice(0, 5), allAvail: vals.length < win });
    });
    ranked.sort(function(a, b){ return (b.avg - a.avg) || (b.n - a.n) || players[a.id].name.localeCompare(players[b.id].name); });
    ranked.forEach(function(r, i){ r.rank = i + 1; });
    var q = (state.idxSearch || state.search || "").toLowerCase();
    var shown = q ? ranked.filter(function(r){ var pp = players[r.id]; return (pp.name + " " + pp.team + " " + (pp.pos || "")).toLowerCase().indexOf(q) >= 0; }) : ranked.slice(0, 25);
    var cnt = $("#playerIndexCount");
    if (cnt) cnt.textContent = q
      ? shown.length + " matching players \u00B7 " + label + " \u00B7 " + lg + " \u00B7 ranked by last-" + win + " average \u00B7 tap a player for the game-log popup"
      : "Top " + shown.length + " \u00B7 " + label + " \u00B7 " + lg + " \u00B7 ranked by last-" + win + " average (3+ games in the window" + (win > 10 ? "; this season first, last-season games fill the rest" : "") + ") \u00B7 tap a player for the game-log popup";
    var el = $("#playerIndex");
    if (!el) return;
    el.innerHTML = shown.length ? shown.slice(0, 200).map(function(r){
      var pp = players[r.id];
      return '<button class="prowbtn" data-open-logs="' + esc(r.id) + '" data-stat-key="' + esc(key) + '" data-lg="' + lg + '">'
        + '<span class="lrank' + (r.rank <= 3 ? " top" : "") + '">' + r.rank + '</span>'
        + avatarHtml(lg, r.id, pp.name)
        + '<span class="who"><span class="nm">' + esc(pp.name) + '</span>'
        + '<span class="tm">' + esc(pp.team) + (pp.pos ? ' \u00B7 ' + esc(pp.pos) : '') + '</span>'
        + '<span class="l5"><b>L5</b>' + r.l5.map(function(v){ return fmtVal(v); }).join(" \u00B7 ") + '</span></span>'
        + '<span class="lavg"><b>' + fmtVal(r.avg) + '</b><span>L' + win + ' avg \u00B7 ' + r.n + ' gms' + (r.allAvail ? ' \u00B7 all avail' : '') + '</span></span></button>';
    }).join("") : '<div class="emptybox" style="grid-column:1/-1">' + (q ? 'No players match that search in ' + lg + '.' : 'No ' + lg + ' players have 3+ games logged for ' + esc(label) + ' yet.') + '</div>';
  }
  window.__LL.renderPlayerIndex = renderPlayerIndex;
  var pixEl = $("#playerIndexSearch");
  if (pixEl) pixEl.addEventListener("input", function(){ state.idxSearch = this.value.trim().toLowerCase(); renderPlayerIndex(); });

/* ---------- filters / search wiring ---------- */
var fBtn = $("#filterBtn"), fPanel = $("#filtersPanel");
fBtn.addEventListener("click", function(){
  var open = fPanel.classList.toggle("open");
  fBtn.setAttribute("aria-expanded", open ? "true" : "false");
  $$(".filters-dup").forEach(function(b){ b.setAttribute("aria-expanded", open ? "true" : "false"); });
  /* No scroll lock here on purpose (see the lockScroll note above):
     Filters stays open over a fully scrollable page, filter changes
     already re-render the board live, and the Filters button itself
     remains the open/close control. Other popups opened on top take
     and release their own lock counts without disturbing this panel. */
});
/* Duplicate Filters buttons beside each view's heading — a second, more
   reachable copy Jay asked for; the top-right original stays. Each dup
   clicks the original button, so the panel toggle and aria state can
   never drift apart. */
$$("#view-discover .sechead, #view-live .sechead, #view-underdogs .sechead, #view-randomizer .sechead, #view-logs .sechead, #view-injuries .sechead").forEach(function(head){
  if (!head || head.querySelector(".filters-dup")) return;
  var dup = document.createElement("button");
  dup.type = "button";
  dup.className = "toolbtn filters-dup";
  dup.setAttribute("aria-expanded", "false");
  dup.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg> Filters';
  dup.addEventListener("click", function(){ fBtn.click(); });
  head.appendChild(dup);
});
$$(".sortXgfBtn").forEach(function(b){ b.addEventListener("click", function(){ state.sortXgf = !state.sortXgf; syncXgfUI(); renderDiscover(); }); });
/* the eFG% toggle is the stat-row chip built by renderStatChips, which
   attaches its own click handler — no static .sortEfgBtn exists to bind */
var range = $("#minRate");
range.addEventListener("input", function(){
  state.minRate = +range.value;
  $("#minRateVal").textContent = range.value + "%";
  /* one shared floor: Props, Streaks, Watchlist and Risers all follow it */
  renderDiscover(); renderSheets(); renderWatchlist(); renderUnderdogs();
});
$$("#filterDirChips .chip").forEach(function(c){
  c.addEventListener("click", function(){
    var d = c.getAttribute("data-dir"), on = c.getAttribute("aria-pressed") === "true";
    if (on && (state.dirs.Over !== state.dirs.Under)) return; /* keep at least one direction on */
    state.dirs[d] = !on;
    c.setAttribute("aria-pressed", !on ? "true" : "false");
    renderDiscover();
  });
});
var searchTimer = null;
$("#searchInput").addEventListener("input", function(){
  var el = this;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function(){
    state.search = el.value.trim().toLowerCase();
    renderDiscover(); renderWatchlist(); renderUnderdogs(); renderInjuries(); renderPlayerIndex();
  }, 160);
});

/* ---------- Games window chips (Filters panel + board bar, kept in sync) ---------- */
function renderWinChips(){
  var html = WIN_OPTS.map(function(w){
    return '<button class="chip" data-win="' + w + '" aria-pressed="' + ((state.win || 10) === w ? "true" : "false") + '">Last ' + w + '</button>';
  }).join("");
  ["#winChipsPanel", "#winChipsBoard"].forEach(function(sel){
    var el = $(sel);
    if (!el) return;
    el.innerHTML = html;
    $$(".chip", el).forEach(function(c){
      c.addEventListener("click", function(){
        state.win = +c.getAttribute("data-win");
        var lab = $("#minRateWinLab");
        if (lab) lab.textContent = "Last " + state.win;
        renderWinChips();
        /* hit rates everywhere are evaluated over this window */
        renderDiscover(); renderSheets(); renderWatchlist(); renderUnderdogs();
      });
    });
  });
  syncGamesFoldSum();
}
renderWinChips();

/* ---------- Collapsible Games section (Filters panel) ----------
   Groups the Games window + Min games controls in one section that
   starts collapsed. The header always shows the active values (e.g.
   "Games · Last 10 · Min 8+", or "Games · Last 10" with no Min games
   floor) so the state reads without opening it. Open state is kept
   in-session on state.gamesFoldOpen, like the other filter controls. */
function syncGamesFoldSum(){
  var el = $("#gamesFoldSum");
  if (!el) return;
  el.textContent = "· Last " + (state.win || 10) + (state.minGames ? " · Min " + state.minGames + "+" : "");
}
function syncGamesFold(){
  var fold = $("#gamesFold"), body = $("#gamesFoldBody"), head = $("#gamesFoldHead");
  if (!fold || !body || !head) return;
  var open = !!state.gamesFoldOpen;
  fold.classList.toggle("open", open);
  body.hidden = !open;
  head.setAttribute("aria-expanded", open ? "true" : "false");
  syncGamesFoldSum();
}
var gamesFoldHead = $("#gamesFoldHead");
if (gamesFoldHead) gamesFoldHead.addEventListener("click", function(){ state.gamesFoldOpen = !state.gamesFoldOpen; syncGamesFold(); });
syncGamesFold();

/* ---------- Collapsible Stats section (Props board stat chips) ----------
   The board's stat chips row sits in a fold in its exact original spot,
   above the Games bar. It starts collapsed (same declutter pattern as
   the Games fold above); the header always shows the active stat —
   "Stats · Points", or "Stats · All" — plus "· eFG% sort" while the
   NBA eFG% sort toggle is on, so the state reads without opening it.
   Picking a chip never collapses the fold, and the open/closed state is
   kept in-session on state.statFoldOpen across league switches (a
   league switch resets the stat to All, which the header then shows). */
function syncStatFoldSum(){
  var el = $("#statFoldSum");
  if (!el) return;
  el.textContent = "· " + (state.stat || "All") + ((state.league === "NBA" && state.sortEfg) ? " · eFG% sort" : "");
}
function syncStatFold(){
  var fold = $("#statFold"), body = $("#statFoldBody"), head = $("#statFoldHead");
  if (!fold || !body || !head) return;
  var open = !!state.statFoldOpen;
  fold.classList.toggle("open", open);
  body.hidden = !open;
  head.setAttribute("aria-expanded", open ? "true" : "false");
  syncStatFoldSum();
}
var statFoldHead = $("#statFoldHead");
if (statFoldHead) statFoldHead.addEventListener("click", function(){ state.statFoldOpen = !state.statFoldOpen; syncStatFold(); });
syncStatFold();

/* ---------- Props view section folds + Team Props ----------
   The Props view is two collapsible sections: Player Props (the
   board as it always was) and Team Props (team totals, opponent
   totals, win-by margins, first-half / first-period totals, NBA team
   threes, NHL team shots — built by the refresh pipeline into
   data-teams.js, exposed as TEAMS_DATA by data-merge.js). The folds
   follow the stat-fold idiom (head button, chevron, aria-expanded,
   hidden body) and persist per section in localStorage. Team cards
   mirror the player cards: line box, L5/L10/L20 rates in the
   featured direction (higher L10 rate, ties to Over), and one
   research sub-line carrying the venue split, the opponent's
   defensive rank, a rest flag and any top-scorer injury note. */
/* "Show More / Show Less" label beside each section head's chevron:
   injected from JS (the pages' markup is untouched), seated on the
   header's right side as part of the same tap target, and worded
   from the section's open state on every syncSec — so the persisted
   state on load and every header tap keep it correct. The head's
   aria-expanded already carries the state for assistive tech, so
   the label itself is aria-hidden. */
function ensureSecLabel(which){
  var cap = which === "player" ? "Player" : "Team";
  var head = $("#sec" + cap + "Head");
  if (!head) return null;
  var el = head.querySelector(".sec-more");
  if (!el){
    el = document.createElement("span");
    el.className = "sec-more";
    el.setAttribute("aria-hidden", "true");
    var chev = head.querySelector(".gf-chev");
    if (chev) head.insertBefore(el, chev); else head.appendChild(el);
  }
  return el;
}
function syncSecLabel(which, open){
  var el = ensureSecLabel(which);
  if (el) el.textContent = open ? "Show Less" : "Show More";
}
function syncSec(which){
  var cap = which === "player" ? "Player" : "Team";
  var sec = $("#sec" + cap), body = $("#sec" + cap + "Body"), head = $("#sec" + cap + "Head");
  if (!sec || !body || !head) return;
  var open = which === "player" ? !!state.secPlayer : !!state.secTeam;
  sec.classList.toggle("open", open);
  body.hidden = !open;
  head.setAttribute("aria-expanded", open ? "true" : "false");
  syncSecLabel(which, open);
  if (which === "player") renderSecPreview();
  else renderTeamSecPreview();
}
function bindSec(which, key){
  var cap = which === "player" ? "Player" : "Team";
  var head = $("#sec" + cap + "Head");
  if (!head) return;
  head.addEventListener("click", function(){
    if (which === "player") state.secPlayer = !state.secPlayer; else state.secTeam = !state.secTeam;
    try { window.localStorage.setItem(key, (which === "player" ? state.secPlayer : state.secTeam) ? "1" : "0"); } catch (e) {}
    syncSec(which);
  });
}
bindSec("player", "leglock.sec.player.v2");
bindSec("team", "leglock.sec.team");
syncSec("player");
syncSec("team");

/* ---------- Player Props collapsed preview ----------
   While the Player Props section is collapsed, a preview of the
   board's top 2 props sits between the section header and the
   hidden body, so the page still leads with the day's best lines.
   It renders the first two entries of the SAME list renderDiscover()
   computed (stashed in _boardList, already filtered and ranked for
   the current league) through the same propCard() renderer — no
   forked logic, so league switches, filters and Signal/Classic
   ranking all match the board exactly, and renderDiscover() calls
   this on every board rebuild. The markup carries no element ids
   and both card interactions (the game-log tap and the Why?
   popover) are document-delegated, so preview cards behave exactly
   like their board twins. Expanding the section hides the preview —
   the board itself starts with the same two cards. An empty board
   (or a board not computed yet) shows no preview at all. */
function ensureSecPreview(){
  var head = $("#secPlayerHead");
  if (!head) return null;
  var el = document.getElementById("secPlayerPreview");
  if (!el){
    el = document.createElement("div");
    el.id = "secPlayerPreview";
    el.className = "grid secpreview";
    el.setAttribute("aria-label", "Top 2 props preview");
    head.insertAdjacentElement("afterend", el);
  }
  return el;
}
function renderSecPreview(){
  var el = ensureSecPreview();
  if (!el) return;
  if (state.secPlayer || !_boardList || !_boardList.length){
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.innerHTML = _boardList.slice(0, 2).map(function(p){ return propCard(p, state.league); }).join("");
  el.hidden = false;
}

/* ---------- Team Props collapsed preview ----------
   The Team Props section gets the identical treatment: while it is
   collapsed, a preview of its top 2 team props sits between the
   section header and the hidden body. It renders the first two
   entries of the SAME ranked list renderTeamProps() computed
   (stashed in _teamList, already sorted by featured-direction L10
   rate for the current league) through the same teamPropCard()
   renderer the grid uses — no forked card markup — and
   renderTeamProps() calls this on every team rebuild, so league
   switches match the grid exactly. Expanding the section hides the
   preview; an empty slate shows no preview at all. */
function ensureTeamSecPreview(){
  var head = $("#secTeamHead");
  if (!head) return null;
  var el = document.getElementById("secTeamPreview");
  if (!el){
    el = document.createElement("div");
    el.id = "secTeamPreview";
    el.className = "grid secpreview";
    el.setAttribute("aria-label", "Top 2 team props preview");
    head.insertAdjacentElement("afterend", el);
  }
  return el;
}
function renderTeamSecPreview(){
  var el = ensureTeamSecPreview();
  if (!el) return;
  if (state.secTeam || !_teamList || !_teamList.length){
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.innerHTML = _teamList.slice(0, 2).map(teamPropCard).join("");
  el.hidden = false;
}

function teamFeatured(p){
  var c = (p.counts || {}).L10 || { o:0, u:0, n:0 };
  if (c.o >= c.u) return { dir:"Over", hits:c.o, n:c.n, rate: c.n ? Math.round(100 * c.o / c.n) : 0 };
  return { dir:"Under", hits:c.u, n:c.n, rate: c.n ? Math.round(100 * c.u / c.n) : 0 };
}
function teamRateCell(p, w){
  var c = (p.counts || {})[w];
  if (!c || !c.n) return '<div class="rate"><div class="lab"><span>' + w + '</span><b>—</b></div><div class="bar"><i style="width:0%"></i></div></div>';
  var hits = teamFeatured(p).dir === "Over" ? c.o : c.u;
  var v = Math.round(100 * hits / c.n);
  return '<div class="rate"><div class="lab"><span>' + w + ' · ' + c.n + 'g</span><b>' + v + '%</b></div><div class="bar"><i class="' + barClass(v) + '" style="width:' + v + '%"></i></div></div>';
}
function teamPropCard(p){
  var f = teamFeatured(p);
  var meta = [];
  if (p.venue && p.venue.n) {
    var vh = f.dir === "Over" ? p.venue.o : p.venue.u;
    meta.push('<span>' + (p.home ? "Home" : "Away") + ' L10: <b>' + vh + '/' + p.venue.n + '</b> ' + f.dir.toLowerCase() + '</span>');
  }
  if (p.oppDefRank != null) meta.push('<span>Opp defence <b>#' + p.oppDefRank + '</b> (' + fmtVal(p.oppDefAvg) + ' allowed L10)</span>');
  if (p.b2b) meta.push('<span><b>On a back-to-back</b></span>');
  else if (p.shortWeek) meta.push('<span><b>Short week</b> · ' + p.restDays + ' days rest</span>');
  if (p.injuryNote) meta.push('<span><b>' + esc(p.injuryNote) + '</b></span>');
  return '<article class="card teamcard tcard">'
    + '<div class="cardtop"><div class="who"><div class="nm">' + esc(p.teamName) + '</div>'
    + '<div class="tm">' + (p.home ? "vs " : "at ") + esc(p.oppName) + ' · ' + esc(fmtD(p.gameDate)) + ' · ' + esc(p.league) + '</div></div></div>'
    + '<div class="linebox"><span class="dir ' + (f.dir === "Over" ? "over" : "under") + '">' + f.dir + ' ' + fmtVal(p.line) + '</span>'
    + '<span class="stat">' + esc(p.statLabel) + '</span>'
    + '<span class="avg">L10 avg <b>' + fmtVal(p.avg) + '</b>' + (p.lineBasis === "venue" && p.venueAvg != null ? '<br>Venue avg <b>' + fmtVal(p.venueAvg) + '</b>' : '') + '</span></div>'
    + '<div class="rates">' + teamRateCell(p, "L5") + teamRateCell(p, "L10") + teamRateCell(p, "L20") + '</div>'
    + (meta.length ? '<div class="tmeta">' + meta.join(' · ') + '</div>' : '')
    + '<div class="cardfoot"><span class="note">Research line from the team&rsquo;s last-10 average · hit rates vs this line</span></div>'
    + '</article>';
}
/* Expanded Team Props grid only: the SAME ranked list, grouped
   by team so the grid reads team by team instead of one long
   mixed run. Groups appear in first-appearance order (the order
   each team's highest-ranked prop appears in the ranking); cards
   inside a group keep their ranked order. Which props qualify
   and the ranking are untouched — and the collapsed preview
   keeps the overall top 2, ungrouped. */
function teamGroupsHtml(shown){
  var order = [], byTeam = {};
  shown.forEach(function(p){
    if (!byTeam[p.team]){ byTeam[p.team] = []; order.push(p.team); }
    byTeam[p.team].push(p);
  });
  return order.map(function(t){
    var props = byTeam[t], first = props[0];
    var label = first.teamName ? first.teamName + " (" + t + ")" : t;
    /* every group starts closed; the open set lives on state (in
       memory only — a fresh page load starts all closed) so a team
       the reader opened stays open across re-renders */
    var key = state.league + ":" + t;
    var open = !!state.teamOpen[key];
    return '<div class="teamgroup' + (open ? " open" : "") + '">'
      + '<button type="button" class="teamgroup-head" data-tgroup="' + esc(key) + '" aria-expanded="' + (open ? "true" : "false") + '">'
      + '<span>' + esc(label) + ' · ' + props.length + '</span><span class="gf-chev" aria-hidden="true"></span></button>'
      + '<div class="grid tgroup-body"' + (open ? "" : " hidden") + '>' + props.map(teamPropCard).join("") + '</div></div>';
  }).join("");
}
function renderTeamProps(){
  var grid = $("#teamPropGrid"), count = $("#teamPropCount");
  if (!grid || !count) return;
  var td = window.TEAMS_DATA;
  var list = (td && td.leagues && td.leagues[state.league]) || [];
  var sorted = list.slice().sort(function(a, b){ return teamFeatured(b).rate - teamFeatured(a).rate; });
  _teamList = sorted;
  count.textContent = sorted.length
    ? sorted.length + " team props · " + state.league + " · sorted by L10 hit rate at the research line"
    : "";
  /* No display cap: the grouped grid shows every team's props
     (the data itself is bounded by teams x stats per league).
     The 500 slice is only a pathological-data safety bound. */
  grid.innerHTML = sorted.length
    ? teamGroupsHtml(sorted.slice(0, 500))
    : '<div class="emptybox" style="grid-column:1/-1">No team props for the current slate.</div>';
  renderTeamSecPreview();
}
window.__LL.renderTeamProps = renderTeamProps;
/* Team group toggles: one delegated listener on the grid container
   (which itself is never re-rendered — only its innerHTML is), so it
   survives every renderTeamProps pass. Toggling flips the in-memory
   open set and the DOM in place — no grid re-render. */
(function(){
  var grid = $("#teamPropGrid");
  if (!grid) return;
  grid.addEventListener("click", function(e){
    var b = e.target && e.target.closest ? e.target.closest("[data-tgroup]") : null;
    if (!b) return;
    var key = b.getAttribute("data-tgroup");
    state.teamOpen[key] = !state.teamOpen[key];
    var open = !!state.teamOpen[key];
    b.setAttribute("aria-expanded", open ? "true" : "false");
    var wrap = b.parentNode;
    if (wrap) wrap.classList.toggle("open", open);
    var body = wrap ? wrap.querySelector(".tgroup-body") : null;
    if (body) body.hidden = !open;
  });
})();

/* ---------- Min games / Min average ----------
   Min games lives only in the Filters panel's collapsible Games
   section: the prop's game count in the selected Games window must
   meet the pick (Any / 5+ / 8+ / 10+ / 15+). Min average keeps its
   Filters panel + board bar steppers (kept in sync): a 0.5-step
   stepper (Off at 0) the prop's stat average over the same window must
   meet. Both compose with every other filter and apply across Top
   Props, Streaks and Watchlist, like the shared hit-rate floor. */
var MIN_GAMES_OPTS = [0, 5, 8, 10, 15];
function renderQualControls(){
  var ghtml = MIN_GAMES_OPTS.map(function(n){
    return '<button class="chip" data-mg="' + n + '" aria-pressed="' + (state.minGames === n ? "true" : "false") + '">' + (n === 0 ? "Any" : n + "+") + '</button>';
  }).join("");
  ["#minGamesPanel"].forEach(function(sel){
    var el = $(sel);
    if (!el) return;
    el.innerHTML = ghtml;
    $$(".chip", el).forEach(function(c){
      c.addEventListener("click", function(){
        state.minGames = +c.getAttribute("data-mg");
        renderQualControls();
        renderDiscover(); renderSheets(); renderWatchlist();
      });
    });
  });
  var ahtml = '<button type="button" data-ma="-1" aria-label="Lower minimum average">&minus;</button>'
    + '<span class="v' + (state.minAvg > 0 ? "" : " off") + '">' + (state.minAvg > 0 ? fmtVal(state.minAvg) : "Off") + '</span>'
    + '<button type="button" data-ma="1" aria-label="Raise minimum average">+</button>';
  ["#minAvgPanel", "#minAvgBoard"].forEach(function(sel){
    var el = $(sel);
    if (!el) return;
    el.innerHTML = ahtml;
    $$("button", el).forEach(function(b){
      b.addEventListener("click", function(){
        state.minAvg = Math.max(0, Math.round((state.minAvg + 0.5 * (+b.getAttribute("data-ma"))) * 2) / 2);
        renderQualControls();
        renderDiscover(); renderSheets(); renderWatchlist();
      });
    });
  });
  syncGamesFoldSum();
}
renderQualControls();

/* ---------- render everything for the current league ---------- */
function syncXgfUI(){
  var isNhl = state.league === "NHL";
  var g = $("#xgfFilterGroup"); if (g) g.hidden = !isNhl;
  var b = $("#xgfBoardBar"); if (b) b.hidden = !isNhl;
  $$(".sortXgfBtn").forEach(function(btn){ btn.setAttribute("aria-pressed", state.sortXgf ? "true" : "false"); });
}
window.__LL.syncXgfUI = syncXgfUI;
function syncEfgUI(){
  /* the only eFG% control is the stat-row chip (NBA only, built by
     renderStatChips); syncing is just its pressed state */
  $$(".sortEfgBtn").forEach(function(btn){ btn.setAttribute("aria-pressed", state.sortEfg ? "true" : "false"); });
  /* the Stats fold header notes the sort while it is on */
  syncStatFoldSum();
}
window.__LL.syncEfgUI = syncEfgUI;
function renderAll(){
  syncXgfUI();
  syncEfgUI();
  renderStatChips(); renderDiscover(); renderTeamProps(); renderWatchlist(); renderUnderdogs(); renderSheets(); renderInjuries(); renderPlayerIndex(); renderDSeg();
  renderGamesStrip(); renderTeamH2h();
  if (window.__LL.renderWorkstation) window.__LL.renderWorkstation();
  if (window.__LL.renderLive) window.__LL.renderLive();
}
window.__LL.renderAll = renderAll;
$("#snapStamp").textContent = "Data updated " + new Date(DATA.fetchedAt).toLocaleString("en-US",{ timeZone:"America/New_York", weekday:"short", month:"short", day:"numeric", hour:"numeric", minute:"2-digit" }) + " ET · Live scores + stats keep refreshing while the page is open.";
})();


(function(){
"use strict";
/* ================= Workstation / game logs ================= */
var $ = function(s, r){ return (r||document).querySelector(s); };
var $$ = function(s, r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); };
var LEAGUES = ["NBA","NFL","NHL"];
var SEASON_LABEL = { NBA:["2026-27","2025-26"], NFL:["2026","2025"], NHL:["2026-27","2025-26"] };
function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function fmtD(iso){ if(!iso) return ""; var d = new Date(iso.length <= 10 ? iso + "T12:00:00" : iso); return d.toLocaleDateString(undefined,{month:"short", day:"numeric", year:"numeric"}); }
function fmtVal(v){ return (v == null || isNaN(v)) ? "—" : (Math.round(v*10)/10).toString().replace(/\.0$/,""); }

/* state is shared with the first script block via window.__LL */
var S = window.__LL.state;

function statVal(row, key){
  if (key === "combo"){
    var s = row.s || {};
    if (s.points == null || s.totalRebounds == null || s.assists == null) return null;
    return s.points + s.totalRebounds + s.assists;
  }
  var v = (row.s || {})[key];
  return (v == null || isNaN(v)) ? null : v;
}
/* median + population standard deviation over a value list — the
   popup's window companions to its Window avg cell */
function wsMedian(vals){
  if (!vals.length) return null;
  var s = vals.slice().sort(function(a, b){ return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function wsSd(vals, avg){
  if (vals.length < 2) return null;
  var a = (avg == null) ? vals.reduce(function(x, y){ return x + y; }, 0) / vals.length : avg;
  var acc = 0;
  vals.forEach(function(v){ acc += (v - a) * (v - a); });
  return Math.sqrt(acc / vals.length);
}
function wsAvg(vals){ return vals.length ? vals.reduce(function(x, y){ return x + y; }, 0) / vals.length : null; }
/* ---------- alt-line ladder ----------
   Hit rates for the featured stat at the board line and the four
   neighbouring lines (steps of 1.0, never below 0.5), in the prop's
   featured direction, over the board's selected Games window and
   over the last 20 — so a reader can see how much of the headline
   rate is the line itself. The board line rung is highlighted.
   When the selected window IS the last 20, one row serves both. */
function ladderHtml(){
  var lg = S.league, ws = S.ws;
  var bp = (DATA.leagues[lg].props || []).filter(function(x){ return x.pid === ws.pid && x.key === ws.stat; })[0];
  var line = bp ? bp.line : ws.line, dir = bp ? bp.dir : ws.dir;
  var rows = allRows();
  var allVals = [];
  rows.forEach(function(r){ var v = statVal(r, ws.stat); if (v != null) allVals.push(v); });
  if (!allVals.length) return "";
  var wN = S.win || 10;
  var vWin = allVals.slice(0, wN), v20 = allVals.slice(0, 20);
  var rungs = [];
  [-2, -1, 0, 1, 2].forEach(function(d){
    var L = Math.round((line + d) * 10) / 10;
    if (L >= 0.5 && rungs.indexOf(L) < 0) rungs.push(L);
  });
  function rowHtml(label, vals){
    return '<div class="ladrow"><span class="ladlab">' + label + '</span>' + rungs.map(function(L){
      var h = 0;
      vals.forEach(function(v){ if (dir === "Over" ? v > L : v < L) h++; });
      return '<span class="rung' + (L === line ? ' base' : '') + '"><b>' + fmtVal(L) + '</b> ' + (vals.length ? Math.round(100 * h / vals.length) + '%' : '—') + '</span>';
    }).join("") + '</div>';
  }
  var body = rowHtml("Last " + vWin.length, vWin);
  if (v20.length !== vWin.length) body += rowHtml(v20.length === 20 ? "L20" : "Last " + v20.length, v20);
  return '<div class="ladder"><div class="ladtitle">Alt lines · ' + esc(dir) + ' hit rate at each line</div>' + body + '</div>';
}
/* ---------- injury impact ----------
   When a teammate is on the injury report, the popup shows what the
   player has actually done without him this season: his featured-
   stat average in games the teammate also played vs games he did
   not (a game counts as "with" when the teammate has a log row for
   the same date + opponent). The teammate used is the highest-
   minutes one on the report (games played breaks the tie where a
   league's logs carry no minutes). Shown only with at least 3
   without-games and at least 1 with-game — otherwise the split
   would be noise, so the line is omitted entirely. */
function injuryImpactHtml(){
  var lg = S.league, ws = S.ws;
  var players = DATA.leagues[lg].players || {};
  var me = players[ws.pid];
  if (!me) return "";
  var inj = DATA.leagues[lg].injuries || [];
  if (!inj.length) return "";
  var injByName = {};
  inj.forEach(function(i){ if (i && i.name) injByName[i.name] = i; });
  var cands = [];
  Object.keys(players).forEach(function(pid){
    if (pid === ws.pid) return;
    var pl = players[pid];
    if (!pl || !injByName[pl.name]) return;
    if (me.teamName ? pl.teamName !== me.teamName : pl.team !== me.team) return;
    cands.push(pid);
  });
  if (!cands.length) return "";
  var logs = DATA.leagues[lg].logs || {};
  function mateRank(pid){
    var rows = logs[pid] || [], mins = 0, mn = 0;
    rows.forEach(function(r){ var m = (r.s || {}).minutes; if (m != null && !isNaN(m)){ mins += m; mn++; } });
    return { avgMin: mn ? mins / mn : null, gp: rows.length };
  }
  cands.sort(function(a, b){
    var ra = mateRank(a), rb = mateRank(b);
    if (ra.avgMin != null && rb.avgMin != null) return rb.avgMin - ra.avgMin;
    if (ra.avgMin != null) return -1;
    if (rb.avgMin != null) return 1;
    return rb.gp - ra.gp;
  });
  var matePid = cands[0], mate = players[matePid], entry = injByName[mate.name];
  var mateKeys = {};
  (logs[matePid] || []).forEach(function(r){ mateKeys[r.d + "|" + r.opp] = 1; });
  var withV = [], withoutV = [];
  curRows().forEach(function(r){
    var v = statVal(r, ws.stat);
    if (v == null) return;
    if (mateKeys[r.d + "|" + r.opp]) withV.push(v); else withoutV.push(v);
  });
  if (withoutV.length < 3 || !withV.length) return "";
  var nm = String(mate.name || "").split(" ");
  var short = nm.length > 1 ? nm[0].charAt(0) + ". " + nm[nm.length - 1] : mate.name;
  return '<div class="injimpact">Without ' + esc(short) + ' (' + esc(entry.status || "Out") + '): <b>' + fmtVal(wsAvg(withoutV)) + ' ' + esc(statLabel(ws.stat)) + '</b> in ' + withoutV.length + ' games · With: <b>' + fmtVal(wsAvg(withV)) + '</b> in ' + withV.length + '</div>';
}
function tagRows(rows, season){
  return (rows || []).map(function(r){
    var abbr = (r.opp || "").split(" ").pop();
    return { d:r.d, opp:r.opp, res:r.res, s:r.s, season:season, abbr:abbr, home:(r.opp || "").indexOf("vs") === 0 };
  });
}
function curRows(){ return tagRows(DATA.leagues[S.league].logs[S.ws.pid], SEASON_LABEL[S.league][0]); }
function allRows(){
  return curRows().concat(tagRows((DATA.leagues[S.league].logsPrev || {})[S.ws.pid], SEASON_LABEL[S.league][1]));
}
var WINN = { l25:25, l50:50, l82:82 };
function splitRows(){
  var ws = S.ws;
  /* Extended windows: current season first, then last season fills the rest (up to 82). */
  if (WINN[ws.split]) return allRows().slice(0, WINN[ws.split]);
  var rows = curRows();
  if (ws.split === "l5") return rows.slice(0, 5);
  if (ws.split === "l10") return rows.slice(0, 10);
  if (ws.split === "home") return rows.filter(function(r){ return r.home; });
  if (ws.split === "away") return rows.filter(function(r){ return !r.home; });
  if (ws.split === "h2h") return allRows().filter(function(r){ return r.abbr === ws.opp; });
  return rows;
}
function windowInfo(rows){
  var cur = SEASON_LABEL[S.league][0], nCur = 0;
  rows.forEach(function(r){ if (r.season === cur) nCur++; });
  return { n: rows.length, cur: nCur, prev: rows.length - nCur };
}
function splitTitle(rows){
  var ws = S.ws, info = windowInfo(rows), labels = SEASON_LABEL[S.league];
  if (WINN[ws.split]){
    var t = "Last " + info.n + (info.n < WINN[ws.split] ? " — all available" : "");
    t += " · " + info.cur + " this season (" + labels[0] + ")";
    if (info.prev) t += " + " + info.prev + " last season (" + labels[1] + ")";
    return t;
  }
  if (ws.split === "all") return "All games this season · " + info.n + " games (" + labels[0] + ")";
  if (ws.split === "l5" || ws.split === "l10") return "Last " + info.n + " · this season (" + labels[0] + ")";
  if (ws.split === "h2h") return "Head-to-head · " + info.n + " meetings across both seasons";
  if (ws.split === "home") return "Home · " + info.n + " games this season";
  if (ws.split === "away") return "Away · " + info.n + " games this season";
  return info.n + " games";
}
function hitOf(v, line, dir){ if (v == null) return null; return dir === "Over" ? v > line : v < line; }
function rateOf(rows, key, line, dir){
  var vals = rows.map(function(r){ return statVal(r, key); }).filter(function(v){ return v != null; });
  if (!vals.length) return null;
  var hits = vals.filter(function(v){ return hitOf(v, line, dir); }).length;
  return { pct: Math.round(100 * hits / vals.length), n: vals.length, hits: hits };
}
function statLabel(key){
  if (key === "combo") return "Pts+Reb+Ast";
  var defs = DATA.leagues[S.league].statDefs;
  for (var i = 0; i < defs.length; i++) if (defs[i].k === key) return defs[i].label;
  return key;
}
function wsStatKeys(){
  var keys = DATA.leagues[S.league].statDefs.map(function(s){ return s.k; });
  if (S.league === "NBA") keys.push("combo");
  return keys;
}
function buildPlayerSelect(){
  var players = DATA.leagues[S.league].players || {}, logs = DATA.leagues[S.league].logs || {};
  var ids = Object.keys(logs).filter(function(id){ return players[id]; })
    .sort(function(a, b){ return players[a].name.localeCompare(players[b].name); });
  if (!S.ws.pid || ids.indexOf(S.ws.pid) < 0) S.ws.pid = ids[0];
  $("#playerSel").innerHTML = ids.map(function(id){
    var p = players[id];
    return '<option value="' + esc(id) + '"' + (id === S.ws.pid ? " selected" : "") + '>' + esc(p.name) + ' — ' + esc(p.team) + (p.pos ? " · " + esc(p.pos) : "") + '</option>';
  }).join("");
}
function buildOppSelect(){
  var rows = allRows(), seen = {}, order = [];
  rows.forEach(function(r){ if (!seen[r.abbr]){ seen[r.abbr] = true; order.push(r.abbr); } });
  if (!S.ws.opp || order.indexOf(S.ws.opp) < 0) S.ws.opp = order[0] || null;
  $("#oppSel").innerHTML = order.map(function(a){
    return '<option value="' + esc(a) + '"' + (a === S.ws.opp ? " selected" : "") + '>' + esc(a) + '</option>';
  }).join("");
}
var WS_PRIMARY = { NBA:"points", NFL:"passingYards", NHL:"points" };
function setupWs(pid, statKey){
  if (pid) S.ws.pid = pid;
  if (statKey) S.ws.stat = statKey;
  else S.ws.stat = WS_PRIMARY[S.league] || wsStatKeys()[0];
  var props = (DATA.leagues[S.league].props || []).filter(function(p){ return p.pid === S.ws.pid && p.key === S.ws.stat; });
  var rows = curRows();
  var vals = rows.map(function(r){ return statVal(r, S.ws.stat); }).filter(function(v){ return v != null; });
  if (props.length){ S.ws.line = props[0].line; S.ws.dir = props[0].dir; }
  else if (vals.length){ var avg = vals.slice(0, 10).reduce(function(a, b){ return a + b; }, 0) / Math.min(10, vals.length); S.ws.line = Math.floor(avg) + 0.5; S.ws.dir = "Over"; }
  S.ws.split = "all"; S.ws.opp = null;
  renderWorkstation();
}
/* ----- game-log popup: z-index 1000, always above the Players to Watch popup (900) ----- */
function anyModalOpen(){ return $("#logModal").classList.contains("open") || ($("#pwModal") && $("#pwModal").classList.contains("open")); }
function openLogModal(){
  var m = $("#logModal");
  var wasOpen = m.classList.contains("open");
  if (!wasOpen){
    /* fresh open: game-log section expanded, the other two sections closed */
    var ld = $("#wsLogDet"); if (ld) ld.open = true;
    var md = $("#wsMoreDet"); if (md) md.open = false;
    var fd = $("#wsFullDet"); if (fd) fd.open = false;
  }
  m.classList.add("open");
  document.body.classList.add("modal-open");
  if (!wasOpen && window.__LL.lockScroll) window.__LL.lockScroll();
  var s = m.querySelector(".sheet"); if (s) s.scrollTop = 0;
  var c = $("#logClose"); if (c) c.focus();
}
function closeLogModal(){
  var m = $("#logModal");
  var wasOpen = m.classList.contains("open");
  m.classList.remove("open");
  if (!anyModalOpen()) document.body.classList.remove("modal-open");
  if (wasOpen && window.__LL.unlockScroll) window.__LL.unlockScroll();
}
window.__LL.openLogModal = openLogModal;
window.__LL.closeLogModal = closeLogModal;
window.__LL.openWorkstation = function(pid, statKey){ setupWs(pid, statKey); openLogModal(); };
window.__LL.initWorkstation = setupWs;
$("#logClose").addEventListener("click", closeLogModal);
$("#logModal .backdrop").addEventListener("click", closeLogModal);
document.addEventListener("keydown", function(e){
  if (e.key !== "Escape") return;
  if ($("#logModal").classList.contains("open")){ closeLogModal(); return; }
  if (window.__LL.closePlayersToWatch) window.__LL.closePlayersToWatch();
});
function fmtDS(iso){ if(!iso) return ""; var d = new Date(iso.length <= 10 ? iso + "T12:00:00" : iso); return d.toLocaleDateString(undefined,{month:"short", day:"numeric"}); }
function nextGameFor(p){
  var LG = (window.__LL && window.__LL.LG) || {};
  var games = LG[S.league] || [], team = (p && p.team) || "";
  if (!team || !games.length) return null;
  var mine = games.filter(function(g){ return g && g.home && g.away && (g.home.abbr === team || g.away.abbr === team) && g.state !== "post"; });
  mine.sort(function(a, b){ return String(a.date || "").localeCompare(String(b.date || "")); });
  if (!mine.length) return null;
  var g = mine[0], home = g.home.abbr === team;
  return { opp: home ? g.away.abbr : g.home.abbr, home: home, date: g.date || "", state: g.state || "" };
}
function renderWorkstation(){
  var ws = S.ws, lg = S.league;
  if (wsStatKeys().indexOf(ws.stat) < 0) ws.stat = wsStatKeys()[0];
  buildPlayerSelect(); buildOppSelect();
  var p = (DATA.leagues[lg].players || {})[ws.pid] || {};
  /* stat chips */
  $("#wsStatChips").innerHTML = wsStatKeys().map(function(k){
    return '<button class="chip" data-wsstat="' + esc(k) + '" aria-pressed="' + (ws.stat === k ? "true" : "false") + '">' + esc(statLabel(k)) + '</button>';
  }).join("");
  $$("#wsStatChips .chip").forEach(function(c){ c.addEventListener("click", function(){
    ws.stat = c.getAttribute("data-wsstat");
    var props = (DATA.leagues[lg].props || []).filter(function(x){ return x.pid === ws.pid && x.key === ws.stat; });
    if (props.length){ ws.line = props[0].line; ws.dir = props[0].dir; }
    renderWorkstation();
  }); });
  /* splits */
  $$("#logModal [data-split]").forEach(function(c){ c.setAttribute("aria-pressed", c.getAttribute("data-split") === ws.split ? "true" : "false"); });
  var rows = splitRows();
  var rate = rateOf(rows, ws.stat, ws.line, ws.dir);
  var wVals = rows.map(function(r){ return statVal(r, ws.stat); }).filter(function(v){ return v != null; });
  var wAvg = wVals.length ? wVals.reduce(function(a, b){ return a + b; }, 0) / wVals.length : null;
  var wOver = wVals.filter(function(v){ return v > ws.line; }).length, wUnder = wVals.filter(function(v){ return v < ws.line; }).length;
  /* compact header: headshot, name, team · next game */
  var nx = nextGameFor(p);
  var av = $("#logAvatar");
  if (av){
    if (p.img) av.innerHTML = '<img src="' + esc(p.img) + '" alt="" onerror="this.parentNode.textContent=\'' + esc((p.name || "P").charAt(0)) + '\'">';
    else av.textContent = (p.name || "P").charAt(0);
  }
  var lt = $("#logTitle"); if (lt) lt.textContent = p.name || "Game Log";
  var sub = esc(p.team || "") + (p.pos ? ' · ' + esc(p.pos) : '') + (p.jersey ? ' · #' + esc(p.jersey) : '') + ' · ' + lg;
  if (lg === "NHL" && p.xgf != null && !isNaN(p.xgf)) sub += ' · xGF% ' + (+p.xgf).toFixed(1) + ' · MoneyPuck';
  if (lg === "NBA" && p.efg != null && !isNaN(p.efg)) sub += ' · eFG% ' + (+p.efg).toFixed(1);
  if (lg === "NFL" && window.__LL.nflRoleText){
    var rt = window.__LL.nflRoleText(ws.pid);
    if (rt) sub += ' · ' + esc(rt);
    var ri = window.__LL.nflRoleInfo ? window.__LL.nflRoleInfo(ws.pid) : null;
    if (ri && ri.volatile) sub += ' · Role volatile';
  }
  if (nx){
    var when = "";
    if (nx.date){ var nd = new Date(nx.date); when = nd.toLocaleDateString(undefined,{weekday:"short", month:"short", day:"numeric"}) + ' · ' + nd.toLocaleTimeString(undefined,{hour:"numeric", minute:"2-digit"}); }
    sub += ' · Next: ' + (nx.home ? 'vs ' : '@ ') + esc(nx.opp) + (nx.state === "in" ? ' · live now' : (when ? ' · ' + esc(when) : ''));
  }
  var ls = $("#logSub"); if (ls) ls.innerHTML = sub;
  /* summary strip: line + Over/Under, L5/L10/L20 hit rates at the line, the selected
     window's average + over/under record + hit %, current streak, H2H avg vs next opponent */
  var sRows = curRows();
  function wRate(n){ var r = rateOf(sRows.slice(0, n), ws.stat, ws.line, ws.dir); return r ? r.pct + '%' : '—'; }
  var streak = 0;
  for (var si = 0; si < sRows.length; si++){ if (hitOf(statVal(sRows[si], ws.stat), ws.line, ws.dir)) streak++; else break; }
  var h2hOpp = nx ? nx.opp : ws.opp;
  var h2hVals = h2hOpp ? allRows().filter(function(r){ return r.abbr === h2hOpp; }).map(function(r){ return statVal(r, ws.stat); }).filter(function(v){ return v != null; }) : [];
  var h2hAvg = h2hVals.length ? h2hVals.reduce(function(a, b){ return a + b; }, 0) / h2hVals.length : null;
  var xgfCell = (lg === "NHL" && p.xgf != null && !isNaN(p.xgf)) ? '<div class="sumcell"><span>xGF% · MoneyPuck</span><b>' + (+p.xgf).toFixed(1) + '</b></div>' : '';
  var efgCell = (lg === "NBA" && p.efg != null && !isNaN(p.efg)) ? '<div class="sumcell"><span>eFG%</span><b>' + (+p.efg).toFixed(1) + '</b></div>' : '';
  $("#wsPanel").innerHTML =
    '<div class="sumtop">'
    + '<div class="seg" role="group" aria-label="Over or under"><button data-wsdir="Over" aria-pressed="' + (ws.dir === "Over") + '">Over</button><button data-wsdir="Under" aria-pressed="' + (ws.dir === "Under") + '">Under</button></div>'
    + '<div class="stepper sm"><button id="stepDown" aria-label="Lower the line">−</button><div class="val"><span id="stepVal">' + fmtVal(ws.line) + '</span><small>Line · ' + esc(statLabel(ws.stat)) + '</small></div><button id="stepUp" aria-label="Raise the line">+</button></div>'
    + '</div>'
    + '<div class="ratechips">'
    + '<div class="rchip"><span>L5</span><b>' + wRate(5) + '</b></div>'
    + '<div class="rchip"><span>L10</span><b>' + wRate(10) + '</b></div>'
    + '<div class="rchip"><span>L20</span><b>' + wRate(20) + '</b></div>'
    + '</div>'
    + '<div class="sumgrid">'
    + '<div class="sumcell"><span>Window avg</span><b>' + fmtVal(wAvg) + '</b></div>'
    + '<div class="sumcell"><span>Over–Under at line</span><b>' + (wVals.length ? wOver + '–' + wUnder : '—') + '</b></div>'
    + '<div class="sumcell"><span>Hit % · window</span><b>' + (rate ? rate.pct + '% (' + rate.hits + '/' + rate.n + ')' : '—') + '</b></div>'
    + '<div class="sumcell"><span>Streak · ' + (ws.dir === "Over" ? "overs" : "unders") + '</span><b>' + (streak ? streak + ' straight' : '0') + '</b></div>'
    + '<div class="sumcell"><span>' + (nx ? 'Avg vs ' + esc(nx.opp) + ' · next' : 'H2H avg' + (h2hOpp ? ' vs ' + esc(h2hOpp) : '')) + '</span><b>' + (h2hAvg != null ? fmtVal(h2hAvg) : 'no meetings') + '</b></div>'
    + '<div class="sumcell"><span>Median · window</span><b>' + fmtVal(wsMedian(wVals)) + '</b></div>'
    + '<div class="sumcell"><span>Avg margin vs line</span><b>' + (wAvg == null ? '—' : ((wAvg - ws.line) >= 0 ? '+' : '') + fmtVal(wAvg - ws.line)) + '</b></div>'
    + '<div class="sumcell"><span>Std dev · window</span><b>' + fmtVal(wsSd(wVals, wAvg)) + '</b></div>'
    + xgfCell + efgCell
    + '</div>'
    + '<div class="sumnote">' + esc(splitTitle(rows)) + ' · Last 25 / 50 / 82 fill from last season and count in the averages and hit %.</div>'
    + ladderHtml()
    + injuryImpactHtml();
  $$("#wsPanel [data-wsdir]").forEach(function(b){ b.addEventListener("click", function(){ ws.dir = b.getAttribute("data-wsdir"); renderWorkstation(); }); });
  $("#stepUp").addEventListener("click", function(){ ws.line = Math.round((ws.line + 0.5) * 10) / 10; renderWorkstation(); });
  $("#stepDown").addEventListener("click", function(){ if (ws.line > 0.5) ws.line = Math.round((ws.line - 0.5) * 10) / 10; renderWorkstation(); });
  renderGraph(rows);
  renderCompactLog(rows);
  renderFullTable(rows);
  renderH2hBlock();
}
function h2hRows(){ return allRows().filter(function(r){ return r.abbr === S.ws.opp; }); }
function h2hSummary(){
  var rows = h2hRows(); if (!rows.length) return "no meetings";
  var rate = rateOf(rows, S.ws.stat, S.ws.line, S.ws.dir);
  return rows.length + " meetings · " + (rate ? rate.pct + "% at line" : "—");
}
function renderGraph(rows){
  var ws = S.ws;
  var data = rows.slice(0, 20).slice().reverse();
  var vals = data.map(function(r){ return statVal(r, ws.stat); });
  var max = Math.max.apply(null, vals.concat([ws.line]).filter(function(v){ return v != null; }).concat([1])) * 1.15;
  var W = 560, base = 104, bw = Math.min(30, (W - 50) / Math.max(1, data.length) - 14);
  var bars = "";
  data.forEach(function(r, i){
    var v = statVal(r, ws.stat); if (v == null) return;
    var h = Math.max(3, (v / max) * (base - 18));
    var x = 38 + i * ((W - 60) / Math.max(1, data.length));
    var hit = hitOf(v, ws.line, ws.dir);
    bars += '<rect x="' + x.toFixed(1) + '" y="' + (base - h).toFixed(1) + '" width="' + bw + '" height="' + h.toFixed(1) + '" rx="4" fill="' + (hit ? "var(--accent)" : "var(--skel2)") + '"><title>' + esc(fmtD(r.d)) + ' ' + esc(r.opp) + ': ' + fmtVal(v) + '</title></rect>';
  });
  var ly = base - (ws.line / max) * (base - 18);
  $("#wsGraph").innerHTML = '<div class="ghead"><b>' + esc(statLabel(ws.stat)) + ' by game</b><span>last ' + data.length + ' in window · line ' + fmtVal(ws.line) + ' · green = ' + ws.dir.toLowerCase() + ' hit</span></div>'
    + '<svg viewBox="0 0 ' + W + ' 122" width="100%" height="106" role="img" aria-label="Bar chart of game by game ' + esc(statLabel(ws.stat)) + ' against the line">'
    + '<line x1="30" y1="16" x2="30" y2="' + base + '" stroke="var(--line2)"/><line x1="30" y1="' + base + '" x2="545" y2="' + base + '" stroke="var(--line2)"/>'
    + '<line x1="30" y1="' + ly.toFixed(1) + '" x2="545" y2="' + ly.toFixed(1) + '" stroke="var(--amber)" stroke-width="1.5" stroke-dasharray="6 5"/>' + bars + '</svg>';
}
function renderCompactLog(rows){
  var ws = S.ws;
  var body = rows.map(function(r){
    var v = statVal(r, ws.stat), hit = hitOf(v, ws.line, ws.dir);
    var stag = (r.season && r.season !== SEASON_LABEL[S.league][0]) ? ' <span class="seasontag">Last season</span>' : '';
    var min = (r.s || {}).minutes;
    var mark = v == null ? '<span style="color:var(--ink3)">—</span>' : (hit ? '<span class="hit">' + ws.dir + '</span>' : '<span class="miss">' + (ws.dir === "Over" ? "Under" : "Over") + '</span>');
    return '<div class="gamerow"><span class="gd">' + esc(fmtDS(r.d)) + '</span><span class="go">' + esc(r.opp) + stag + '</span>'
      + (min != null ? '<span class="gm">' + fmtVal(min) + ' min</span>' : '')
      + '<span class="gv">' + fmtVal(v) + ' <small>' + esc(statLabel(ws.stat)) + '</small></span>'
      + '<span class="gmark">' + mark + '</span></div>';
  }).join("");
  $("#wsLogWrap").innerHTML = rows.length ? body : '<div class="emptybox" style="border:0">No games in this split.</div>';
  var sum = $("#wsLogSummary");
  if (sum){
    var winName = { all:"All games", l5:"Last 5", l10:"Last 10", l25:"Last 25", l50:"Last 50", l82:"Last 82", h2h:"Head-to-Head", home:"Home", away:"Away" }[ws.split] || "";
    sum.textContent = "Game log · " + statLabel(ws.stat) + (winName ? " · " + winName : "") + " · " + rows.length + (rows.length === 1 ? " game" : " games");
  }
}
/* Full stat lines as compact per-game boxes (live game-box style) instead
   of the old wide all-stats table: one box per game — the same games, in
   the same order, with every value the table showed. The header line
   carries date · opponent · result · the at-line outcome · minutes (NBA);
   the stat grid carries every statDef value (— where a game has none,
   exactly as the table rendered it) plus the NBA PRA column. The grid
   wraps inside the box, so at phone width nothing scrolls sideways and
   nothing clips. The analysed stat's cell is highlighted (.sel), as the
   table highlighted its column. */
var FULL_ABBR = { points:"PTS", totalRebounds:"REB", assists:"AST", threePointersMade:"3PM", steals:"STL", blocks:"BLK", combo:"PRA",
  passingYards:"PASS YDS", passingTouchdowns:"PASS TD", rushingYards:"RUSH YDS", rushingTouchdowns:"RUSH TD",
  receivingYards:"REC YDS", receivingTouchdowns:"REC TD", receptions:"REC",
  goals:"GOALS", shotsTotal:"SHOTS", saves:"SAVES" };
function renderFullTable(rows){
  var ws = S.ws, defs = DATA.leagues[S.league].statDefs;
  var body = rows.map(function(r){
    var v = statVal(r, ws.stat), hit = hitOf(v, ws.line, ws.dir);
    var stag = (r.season && r.season !== SEASON_LABEL[S.league][0]) ? ' <span class="seasontag">Last season · ' + esc(r.season) + '</span>' : '';
    var min = (r.s || {}).minutes;
    var pill = hit == null ? '<span style="color:var(--ink3)">—</span>' : (hit ? '<span class="hit">' + (ws.dir === "Over" ? "OVER" : "UNDER") + '</span>' : '<span class="miss">' + (ws.dir === "Over" ? "UNDER" : "OVER") + '</span>');
    var cells = defs.map(function(d){
      return '<div class="fcell' + (d.k === ws.stat ? ' sel' : '') + '"><span class="fl">' + esc(FULL_ABBR[d.k] || d.label) + '</span><span class="fv">' + fmtVal((r.s || {})[d.k]) + '</span></div>';
    }).join("");
    if (S.league === "NBA") cells += '<div class="fcell' + (ws.stat === "combo" ? ' sel' : '') + '"><span class="fl">PRA</span><span class="fv">' + fmtVal(statVal(r, "combo")) + '</span></div>';
    return '<div class="fbox"><div class="fbox-head"><span class="fd">' + esc(fmtDS(r.d)) + '</span><span class="fo">' + esc(r.opp) + '</span>'
      + (r.res ? '<span class="fr">' + esc(r.res) + '</span>' : '') + stag
      + '<span class="fpill">' + pill + '</span>'
      + (min != null ? '<span class="fm">' + fmtVal(min) + ' min</span>' : '')
      + '</div><div class="fgrid">' + cells + '</div></div>';
  }).join("");
  $("#wsFullTable").innerHTML = rows.length
    ? '<div class="logtitle">' + esc(splitTitle(rows)) + '</div><div class="fullboxes">' + body + '</div>'
    : '<div class="emptybox" style="border:0">No games in this split.</div>';
}
function renderH2hBlock(){
  var ws = S.ws, rows = h2hRows();
  var title = '<h4>Head-to-head — vs ' + esc(ws.opp || "—") + ' · ' + esc(statLabel(ws.stat)) + '</h4>';
  if (!rows.length){
    $("#wsH2h").innerHTML = title + '<p style="margin:4px 0 0;color:var(--ink3);font-size:13.5px">No meetings yet vs ' + esc(ws.opp || "this opponent") + ' in this season&rsquo;s or last season&rsquo;s game log for ' + esc((DATA.leagues[S.league].players[ws.pid] || {}).name || "this player") + '.</p>';
    return;
  }
  var vals = rows.map(function(r){ return statVal(r, ws.stat); }).filter(function(v){ return v != null; });
  var avg = vals.length ? vals.reduce(function(a, b){ return a + b; }, 0) / vals.length : null;
  var rate = rateOf(rows, ws.stat, ws.line, ws.dir);
  var seasons = Array.from(new Set(rows.map(function(r){ return r.season; })));
  var spanNote = seasons.length > 1
    ? 'Meetings span the ' + seasons[1] + ' and ' + seasons[0] + ' seasons (from game logs).'
    : (seasons[0] === SEASON_LABEL[S.league][0] ? 'This season only (' + seasons[0] + ') — no meetings found in last season&rsquo;s log.' : 'Last season only (' + seasons[0] + ') — no meetings yet this season.');
  var list = rows.map(function(r){
    var v = statVal(r, ws.stat), hit = hitOf(v, ws.line, ws.dir);
    return '<div class="meet"><span class="md">' + fmtD(r.d) + '</span><span>' + esc(r.opp) + ' · ' + esc(r.res) + ' <span style="color:var(--ink3)">(' + esc(r.season) + ')</span></span><span class="mw">' + fmtVal(v) + ' ' + esc(statLabel(ws.stat)) + ' · ' + (hit == null ? '—' : (hit ? '<span class="hit">HIT</span>' : '<span class="miss">MISS</span>')) + '</span></div>';
  }).join("");
  $("#wsH2h").innerHTML = title
    + '<div class="h2hstats"><div class="h2hstat"><b>' + rows.length + '</b><span>Meetings</span></div>'
    + '<div class="h2hstat"><b>' + fmtVal(avg) + '</b><span>H2H average</span></div>'
    + '<div class="h2hstat"><b>' + (rate ? rate.pct + '%' : '—') + '</b><span>' + ws.dir + ' ' + fmtVal(ws.line) + ' hit rate</span></div></div>'
    + '<div style="font-size:12.5px;color:var(--ink3)">' + spanNote + ' Recomputes when the stat or line changes.</div>' + list;
}
$$("#logModal [data-split]").forEach(function(c){ c.addEventListener("click", function(){ S.ws.split = c.getAttribute("data-split"); renderWorkstation(); }); });
/* popup sections accordion: game log / more splits / full stat lines —
   opening one section closes whichever other section is open; tapping the
   open section's header closes it (native details toggle), leaving all
   three closed, which is allowed */
var LOG_DETS = ["wsLogDet", "wsMoreDet", "wsFullDet"];
LOG_DETS.forEach(function(id){
  var d = document.getElementById(id);
  if (!d) return;
  d.addEventListener("toggle", function(){
    if (!d.open) return;
    LOG_DETS.forEach(function(o){
      if (o === id) return;
      var el = document.getElementById(o);
      if (el && el.open) el.open = false;
    });
  });
});
$("#oppSel").addEventListener("change", function(){ S.ws.opp = this.value; if (S.ws.split !== "h2h") S.ws.split = "h2h"; renderWorkstation(); });
$("#playerSel").addEventListener("change", function(){
  S.ws.pid = this.value; S.ws.opp = null; S.ws.split = "all";
  var props = (DATA.leagues[S.league].props || []).filter(function(x){ return x.pid === S.ws.pid && x.key === S.ws.stat; });
  if (props.length){ S.ws.line = props[0].line; S.ws.dir = props[0].dir; }
  renderWorkstation();
});
window.__LL.renderWorkstation = renderWorkstation;
})();


(function(){
"use strict";
/* ================= Live engine: scoreboard + box scores, in place ================= */
var $ = function(s, r){ return (r||document).querySelector(s); };
var $$ = function(s, r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); };
var LEAGUES = ["NBA","NFL","NHL"];
var SITE = { NBA:"basketball/nba", NFL:"football/nfl", NHL:"hockey/nhl" };
var PRIMARY = { NBA:"points", NFL:"passingYards", NHL:"points" };
var S = window.__LL.state, LG = window.__LL.LG, BOX = window.__LL.BOX;
function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function fmtDT(iso){ if(!iso) return ""; var d = new Date(iso); return d.toLocaleString(undefined,{month:"short", day:"numeric"}) + " · " + d.toLocaleTimeString(undefined,{hour:"numeric", minute:"2-digit"}); }
function fmtD(iso){ if(!iso) return ""; var d = new Date(iso.length <= 10 ? iso + "T12:00:00" : iso); return d.toLocaleDateString(undefined,{month:"short", day:"numeric"}); }
function fmtTime(d){ return d.toLocaleTimeString(undefined,{hour:"numeric", minute:"2-digit", second:"2-digit"}); }
function fmtVal(v){ return (v == null || isNaN(v)) ? "—" : (Math.round(v*10)/10).toString().replace(/\.0$/,""); }
function fmtClock(sec){ sec = Math.max(0, Math.round(sec)); return Math.floor(sec/60) + ":" + ("0" + (sec%60)).slice(-2); }
function parseClock(c){
  if (!c) return 0;
  var m = String(c).match(/(\d+):(\d+)/);
  if (m) return parseInt(m[1],10)*60 + parseInt(m[2],10);
  var f = parseFloat(c); return isNaN(f) ? 0 : Math.round(f);
}
function pairKey(a, b){ return [a, b].sort().join("|"); }

function parseScoreboard(json){
  var out = [];
  (json.events || []).forEach(function(ev){
    var comp = (ev.competitions || [])[0] || {};
    var teams = {};
    (comp.competitors || []).forEach(function(c){
      var t = c.team || {};
      teams[c.homeAway] = { id:t.id || "", abbr:t.abbreviation || "", name:t.displayName || "", score:(c.score == null ? "" : String(c.score)) };
    });
    var st = ev.status || comp.status || {};
    var odds = (comp.odds || [])[0] || {};
    var leaders = [];
    (comp.leaders || []).forEach(function(ld){
      var top = (ld.leaders || [])[0] || {};
      var ath = top.athlete || {};
      leaders.push({ cat: ld.shortDisplayName || ld.displayName || "", name: ath.displayName || "", val: top.displayValue || "",
                     team: (ath.team && ath.team.abbreviation) || "" });
    });
    out.push({ id: ev.id, date: ev.date || "", name: ev.name || "",
      state: (st.type || {}).state || "", detail: (st.type || {}).detail || "", shortDetail: (st.type || {}).shortDetail || "",
      clock: st.displayClock || "", period: st.period || 0, clockSec: parseClock(st.displayClock),
      home: teams.home || {}, away: teams.away || {},
      spread: odds.details || "", total: (odds.overUnder == null ? null : odds.overUnder), leaders: leaders.slice(0, 6) });
  });
  return out;
}
var LABELMAP = {
  NBA: { "PTS":"points", "REB":"totalRebounds", "AST":"assists", "STL":"steals", "BLK":"blocks", "3PT":"threePointersMade" },
  NHL: { "G":"goals", "A":"assists", "PTS":"points", "SOG":"shotsTotal", "SV":"saves" }
};
var NFLMAP = {
  passing: { "YDS":"passingYards", "TD":"passingTouchdowns" },
  rushing: { "YDS":"rushingYards", "TD":"rushingTouchdowns" },
  receiving: { "REC":"receptions", "YDS":"receivingYards", "TD":"receivingTouchdowns" }
};
function parseSummary(json, lg){
  var athletes = {};
  var players = (((json || {}).boxscore || {}).players) || [];
  players.forEach(function(teamEntry){
    var teamAbbr = ((teamEntry.team || {}).abbreviation) || "";
    (teamEntry.statistics || []).forEach(function(grp){
      var labels = grp.labels || grp.names || [];
      (grp.athletes || []).forEach(function(a){
        var ath = a.athlete || {};
        var id = ath.id; if (!id) return;
        var rec = athletes[id] || (athletes[id] = { name: ath.displayName || "", team: teamAbbr, stats: {} });
        labels.forEach(function(lab, i){
          var key = null;
          if (lg === "NFL"){ var gm = NFLMAP[grp.name || ""]; key = gm ? gm[lab] : null; }
          else key = LABELMAP[lg][lab];
          if (!key) return;
          var raw = (a.stats || [])[i];
          var v = parseFloat(String(raw == null ? "" : raw).split("-")[0]);
          if (!isNaN(v)) rec.stats[key] = v;
        });
      });
    });
  });
  return { athletes: athletes };
}
function anyLive(){
  return LEAGUES.some(function(lg){ return (LG[lg] || []).some(function(g){ return g.state === "in"; }); });
}
function liveCount(){
  var n = 0;
  LEAGUES.forEach(function(lg){ (LG[lg] || []).forEach(function(g){ if (g.state === "in") n++; }); });
  return n;
}
function statSummary(lg, stats){
  var parts = [];
  (DATA.leagues[lg].statDefs || []).forEach(function(d){
    if (stats[d.k] != null) parts.push(fmtVal(stats[d.k]) + " " + d.label.replace("Yds", "yds").replace("Touchdowns", "TD"));
  });
  return parts.slice(0, 5).join(" · ");
}
function gameCard(lg, g){
  var aWin = g.state !== "pre" && (+g.away.score > +g.home.score), hWin = g.state !== "pre" && (+g.home.score > +g.away.score);
  var status = window.__LL.gameStatusHtml ? window.__LL.gameStatusHtml(g) : esc(g.detail || "");
  var label = (g.away.name || g.away.abbr) + " at " + (g.home.name || g.home.abbr) + ". Tap for players to watch.";
  return '<div class="game lgame' + (g.state === "in" ? " is-live" : "") + '" data-pw-lg="' + esc(lg) + '" data-pw-gid="' + esc(g.id) + '" role="button" tabindex="0" aria-label="' + esc(label) + '">'
    + '<span class="gteamrow' + (aWin ? " win" : "") + '"><span class="gabbr">' + esc(g.away.abbr) + '</span><span class="gsc" data-score="away">' + (g.state === "pre" ? "" : esc(g.away.score || "0")) + '</span></span>'
    + '<span class="gteamrow' + (hWin ? " win" : "") + '"><span class="gabbr">' + esc(g.home.abbr) + '</span><span class="gsc" data-score="home">' + (g.state === "pre" ? "" : esc(g.home.score || "0")) + '</span></span>'
    + '<span class="time">' + status + '</span>'
    + '<span class="gwatch">Players to watch <span aria-hidden="true">\u203A</span></span></div>';
}
/* per-sport open state for the Live dropdowns: defaults follow whether the
   sport has games in progress; once the user taps a header, their choice is
   stored here and renderLive never overrides it on the ~20s re-renders */
var liveOpen = {}, liveOpenTouched = {};

/* ---------- Live props tracker (inside the game popup) ----------
   A sportsbook-style tracker added at the bottom of the Players to
   Watch popup for a game in progress: one row per tracked prop whose
   player appears in that game's live box score, ranked by the prop's
   featured-direction L10 hit rate (50% floor, max 10 per game, never
   padded with weaker props). It sits below everything the popup
   already shows — header, team sections and their prop rows are
   untouched. Values, player matching and outcomes reuse the Players
   to Watch machinery (pwStatVal / pwOutcome), so the tracker can
   never disagree with the popup's own prop rows above it. The Live
   page itself carries no tracker section. A game with no qualifying
   props (or no box score yet) gets no block. Lines are the board's
   research lines, as everywhere else on the site. */
function lptRate(p){
  var r = (p.rates || {}).L10;
  if (!r) return null;
  var v = p.dir === "Over" ? r.o : r.u;
  return (v == null || isNaN(v)) ? null : +v;
}
function lptDisc(oc){
  if (oc.cls === "hi") return '<span class="lpt-disc hi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5l5 5L19.5 7"/></svg></span>';
  if (oc.cls === "lo") return '<span class="lpt-disc lo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></span>';
  return '<span class="lpt-disc mid"><span class="lpt-dot"></span></span>';
}
function lptFillCls(p, v, oc){
  if (oc.cls === "lo") return "lo";
  if (oc.cls === "hi") return "hi";
  /* live and undecided: an Over fills green; an Under stays green while
     safely under and turns amber inside the last ~20% before the line */
  if (p.dir === "Under" && p.line > 0 && v >= 0.8 * p.line) return "mid";
  return "hi";
}
function lptRowHtml(lg, p, v, oc){
  /* the line tick sits at ~82% of the bar: the scale's full value is
     line / 0.82 — except a 0.5 line, where line + 1 is the reference so
     the bar does not saturate on the first make */
  var ref = p.line <= 0.5 ? p.line + 1 : p.line / 0.82;
  var tickPct = Math.min(100, Math.round(1000 * p.line / ref) / 10);
  var fillPct = Math.max(0, Math.min(100, Math.round(1000 * v / ref) / 10));
  var pillPct = Math.max(5, fillPct);
  var fillCls = lptFillCls(p, v, oc);
  var pinfo = (DATA.leagues[lg].players || {})[p.pid] || {};
  var name = p.name || pinfo.name || "";
  var avatar = pinfo.img ? '<div class="avatar"><img src="' + esc(pinfo.img) + '" alt="" loading="lazy" onerror="this.parentNode.textContent=\'' + esc((name || "P").charAt(0)) + '\'"></div>'
                         : '<div class="avatar">' + esc((name || "P").charAt(0)) + '</div>';
  return '<div class="lpt-row" data-lptk="' + esc(p.pid + "|" + p.key) + '">'
    + lptDisc(oc)
    + avatar
    + '<div class="lpt-main">'
    +   '<div class="lpt-top"><span class="lpt-name">' + esc(name) + ' <b>' + p.dir + ' ' + fmtVal(p.line) + '</b></span>' + (oc.badge ? ' ' + oc.badge : '') + '</div>'
    +   '<div class="lpt-sub">' + esc(p.stat) + '</div>'
    +   '<div class="lpt-barzone"><div class="lpt-track">'
    +     '<i class="lpt-fill ' + fillCls + '" style="width:' + fillPct + '%"></i>'
    +     '<span class="lpt-tick" style="left:' + tickPct + '%"></span>'
    +     '<span class="lpt-pill ' + fillCls + '" style="left:' + pillPct + '%">' + fmtVal(v) + '</span>'
    +     '<span class="lpt-lineval" style="left:' + tickPct + '%">' + fmtVal(p.line) + '</span>'
    +   '</div></div>'
    + '</div></div>';
}
/* The tracker's candidate model, shared by the block builder and the
   in-place updater: the qualifying props for this game, in display
   order, each with its live value and outcome. */
function lptModel(lg, g){
  var box = BOX[g.id];
  if (!box) return [];
  var seen = {}, cands = [];
  (DATA.leagues[lg].props || []).forEach(function(p){
    var a = box.athletes[p.pid];
    if (!a) return;
    var dedupe = p.pid + "|" + p.key;
    if (seen[dedupe]) return;
    var v = pwStatVal(a.stats, p.key);
    if (v == null) return;
    var rate = lptRate(p);
    if (rate == null || rate < 50) return;
    seen[dedupe] = 1;
    cands.push({ p: p, v: v, rate: rate });
  });
  if (!cands.length) return [];
  /* rank by featured-direction L10 rate, then cap — no padding */
  cands.sort(function(a, b){ return b.rate - a.rate; });
  cands = cands.slice(0, 10);
  /* display order: cashed first, then live rows by progress toward the
     line (highest value/line ratio first), then busted or missed */
  cands.forEach(function(c){
    c.oc = pwOutcome(c.p, c.v, g.state === "post");
    c.grp = c.oc.cls === "hi" ? 0 : (c.oc.cls === "lo" ? 2 : 1);
    c.ratio = c.p.line > 0 ? c.v / c.p.line : 0;
  });
  cands.sort(function(a, b){
    if (a.grp !== b.grp) return a.grp - b.grp;
    if (a.grp === 1 && a.ratio !== b.ratio) return b.ratio - a.ratio;
    return 0;
  });
  return cands;
}
function lptPopupHtml(lg, g){
  var cands = lptModel(lg, g);
  if (!cands.length) return "";
  return '<div class="lpt"><div class="lpt-title">Live props</div>' + cands.map(function(c){ return lptRowHtml(lg, c.p, c.v, c.oc); }).join("") + '</div>';
}
/* In-place update for one tracker row: the status disc, the outcome
   badge, the bar fill and the value pill are rewritten in the existing
   row — its headshot node is never touched. */
function updLptRow(lg, row, c){
  var p = c.p, v = c.v, oc = c.oc;
  var ref = p.line <= 0.5 ? p.line + 1 : p.line / 0.82;
  var fillPct = Math.max(0, Math.min(100, Math.round(1000 * v / ref) / 10));
  var pillPct = Math.max(5, fillPct);
  var fillCls = lptFillCls(p, v, oc);
  var disc = row.querySelector(".lpt-disc");
  if (disc){
    var tmp = document.createElement("div");
    tmp.innerHTML = lptDisc(oc);
    if (tmp.firstChild) row.replaceChild(tmp.firstChild, disc);
  }
  var top = row.querySelector(".lpt-top");
  if (top){
    var pinfo = (DATA.leagues[lg].players || {})[p.pid] || {};
    var name = p.name || pinfo.name || "";
    top.innerHTML = '<span class="lpt-name">' + esc(name) + ' <b>' + p.dir + ' ' + fmtVal(p.line) + '</b></span>' + (oc.badge ? ' ' + oc.badge : '');
  }
  var fill = row.querySelector(".lpt-fill");
  if (fill){ fill.className = "lpt-fill " + fillCls; fill.style.width = fillPct + "%"; }
  var pill = row.querySelector(".lpt-pill");
  if (pill){ pill.className = "lpt-pill " + fillCls; pill.style.left = pillPct + "%"; pill.textContent = fmtVal(v); }
}
/* In-place update for one Live-view game card: the shared box update
   (scores, live marker, status line) plus the leader bolding and the
   accessible label, all written into the existing card node. */
function updLiveCard(card, g){
  updGameBox(card, g);
  var rows = $$(".gteamrow", card);
  var aWin = g.state !== "pre" && (+g.away.score > +g.home.score), hWin = g.state !== "pre" && (+g.home.score > +g.away.score);
  if (rows[0]) rows[0].classList.toggle("win", aWin);
  if (rows[1]) rows[1].classList.toggle("win", hWin);
  card.setAttribute("aria-label", (g.away.name || g.away.abbr) + " at " + (g.home.name || g.home.abbr) + ". Tap for players to watch.");
}
function renderLive(){
  var totalLive = 0, model = [];
  LEAGUES.forEach(function(lg){
    /* same order as the games slider, inside each sport section: games in
       progress first, then upcoming, then finals — chronological within
       each group (stripGames is the slider's own sorter) */
    var games = window.__LL.stripGames ? window.__LL.stripGames(LG[lg] || []) : (LG[lg] || []);
    var live = games.filter(function(g){ return g.state === "in"; }).length;
    totalLive += live;
    model.push({ lg: lg, games: games, live: live });
  });
  /* Keyed in-place path: when the sections and cards already in the DOM
     are exactly the games the new data describes (same leagues, same
     game ids per section — renderGamesStripLive keeps them ordered),
     update scores, status lines and win markers in the existing nodes
     instead of rebuilding #liveWrap. Rebuilding recreates every card on
     every check; the in-place path leaves the DOM — and anything in it
     still loading — alone. A structure change (a game appears or
     disappears, a section gains or loses its last game) takes the full
     build below, exactly as before. */
  var wrap = $("#liveWrap");
  var secs = wrap ? $$(".livesec", wrap) : [];
  var canPatch = secs.length === model.length;
  if (canPatch){
    model.forEach(function(m, i){
      if (!canPatch) return;
      var sec = secs[i];
      if (sec.getAttribute("data-livesec") !== m.lg){ canPatch = false; return; }
      m._sec = sec;
      var grid = sec.querySelector(".lgrid");
      if (!m.games.length){ if (grid) canPatch = false; return; }
      if (!grid){ canPatch = false; return; }
      var cards = $$(".game", grid);
      if (cards.length !== m.games.length){ canPatch = false; return; }
      var byId = {};
      cards.forEach(function(c){ byId[c.getAttribute("data-pw-gid")] = c; });
      m.games.forEach(function(g){ if (!byId[String(g.id)]) canPatch = false; });
      m._byId = byId;
    });
  }
  if (canPatch){
    model.forEach(function(m){
      m.games.forEach(function(g){ updLiveCard(m._byId[String(g.id)], g); });
      var cnt = m._sec.querySelector(".ls-count");
      if (cnt) cnt.textContent = m.live + " live / " + m.games.length + " total";
      if (!liveOpenTouched[m.lg]){
        var open = m.live > 0;
        m._sec.classList.toggle("closed", !open);
        var head = m._sec.querySelector(".livesec-head");
        if (head) head.setAttribute("aria-expanded", open ? "true" : "false");
      }
    });
  } else {
    var html = "";
    model.forEach(function(m){
      var open = liveOpenTouched[m.lg] ? !!liveOpen[m.lg] : m.live > 0;
      html += '<div class="livesec' + (open ? "" : " closed") + '" data-livesec="' + m.lg + '">'
        + '<button type="button" class="livesec-head" data-live-toggle="' + m.lg + '" aria-expanded="' + (open ? "true" : "false") + '">'
        + '<span class="ls-name">' + m.lg + '</span>'
        + '<span class="ls-count">' + m.live + ' live / ' + m.games.length + ' total</span>'
        + '<span class="ls-chev" aria-hidden="true"></span></button>'
        + '<div class="livesec-body">'
        + (m.games.length ? '<div class="lgrid">' + m.games.map(function(g){ return gameCard(m.lg, g); }).join("") + '</div>'
                          : '<div class="emptybox">No games today.</div>')
        + '</div></div>';
    });
    if (wrap) wrap.innerHTML = html;
  }
  var meta = totalLive
    ? totalLive + ' game' + (totalLive > 1 ? "s" : "") + ' in progress — scores and player stats update in place about every 20 seconds.'
    : 'Nothing in progress right now — the page still checks about every minute for games starting.';
  if (lastCheckedAt) meta += ' Last checked ' + fmtTime(lastCheckedAt) + '.';
  if (liveUpdatedAt) meta += ' Live updated ' + fmtTime(liveUpdatedAt) + '.';
  $("#liveMeta").textContent = meta;
  var badge = $("#liveTabCount");
  badge.style.display = totalLive ? "" : "none";
  badge.textContent = totalLive;
}
window.__LL.renderLive = renderLive;
/* Live dropdown toggle: flips the section in place and records the choice so
   the ~20s re-renders keep it. Game cards stay in the DOM while collapsed, so
   in-place score/clock updates and the Players to Watch popup keep working. */
document.addEventListener("click", function(e){
  var b = e.target.closest ? e.target.closest("[data-live-toggle]") : null;
  if (!b) return;
  var lg = b.getAttribute("data-live-toggle");
  var sec = b.closest ? b.closest(".livesec") : null;
  if (!sec) return;
  var closed = sec.classList.toggle("closed");
  liveOpen[lg] = !closed;
  liveOpenTouched[lg] = true;
  b.setAttribute("aria-expanded", closed ? "false" : "true");
});

/* ---------- stamps ---------- */
var lastCheckedAt = null, liveUpdatedAt = null, checking = false, pollTimer = null;
function updateStamp(){
  var dot = $("#liveDot"), el = $("#liveStamp");
  if (!dot || !el) return;
  var live = anyLive();
  dot.className = "livedot" + (live ? " on" : "");
  if (live) el.textContent = 'Live — updated ' + (liveUpdatedAt ? fmtTime(liveUpdatedAt) : "—") + ' · checked ' + (lastCheckedAt ? fmtTime(lastCheckedAt) : "—") + ' · auto-checks ~20s';
  else el.textContent = 'No games live — checked ' + (lastCheckedAt ? fmtTime(lastCheckedAt) : "—") + ' · rechecks ~1 min';
}
function scheduleNext(){
  clearTimeout(pollTimer);
  if (document.hidden) return;
  pollTimer = setTimeout(function(){ runCheck(false); }, anyLive() ? 10000 : 60000);
}
function fetchJson(url){
  return fetch(url, { cache: "no-store" }).then(function(r){ if (!r.ok) throw new Error(r.status); return r.json(); });
}
/* next-day schedule: the default scoreboard is today's slate; one extra dated
   fetch for the following day is merged in by game id, so today's games
   (live, finals and upcoming) never drop out when next-day games are added */
function etDayOf(iso){
  /* Self-contained on purpose: etYMD lives in another IIFE and is NOT in
     scope here — calling it threw, the catch swallowed it, and every
     caller downstream silently got "" (which killed the dated fetches). */
  try {
    var parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
    var y = "", m = "", d = "";
    for (var i = 0; i < parts.length; i++){
      if (parts[i].type === "year") y = parts[i].value;
      else if (parts[i].type === "month") m = parts[i].value;
      else if (parts[i].type === "day") d = parts[i].value;
    }
    return (y && m && d) ? (y + "-" + m + "-" + d) : "";
  } catch(e){ return ""; }
}
function nextDayParam(games){
  var base = "";
  (games || []).forEach(function(g){ var d = etDayOf(g.date); if (d > base) base = d; });
  if (!base) base = etDayOf(new Date().toISOString());
  var p = (base || "").split("-");
  if (p.length !== 3) return "";
  var dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + 1));
  return dt.toISOString().slice(0, 10).replace(/-/g, "");
}
function mergeGameLists(a, b){
  var seen = {}, out = [];
  a.concat(b).forEach(function(g){ if (g && g.id && !seen[g.id]){ seen[g.id] = 1; out.push(g); } });
  out.sort(function(x, y){ return String(x.date || "").localeCompare(String(y.date || "")); });
  return out;
}
function runCheck(manual){
  if (checking) return;
  checking = true;
  var btn = $("#refreshBtn");
  if (btn){ btn.disabled = true; }
  var sbDone = LEAGUES.map(function(lg){
    var url = "https://site.api.espn.com/apis/site/v2/sports/" + SITE[lg] + "/scoreboard";
    /* Default slate + explicit today/tomorrow (ET) dated slates, merged by
       id. The old chain derived the dated fetch from the default slate's
       latest game, so when the default slate lagged a day behind (ESPN
       serves yesterday's finals well past midnight ET) the fetch landed on
       the wrong day and the merged list lost every upcoming game. Any
       source may fail on its own; LG is only replaced when the merge
       produced games, so a bad check never wipes the baked slate. */
    var dayParam = function(iso){ var d = etDayOf(iso); return d ? d.replace(/-/g, "") : ""; };
    var pToday = dayParam(new Date().toISOString());
    var pTomorrow = dayParam(new Date(Date.now() + 864e5).toISOString());
    var urls = [url];
    if (pToday) urls.push(url + "?dates=" + pToday);
    if (pTomorrow && pTomorrow !== pToday) urls.push(url + "?dates=" + pTomorrow);
    return Promise.all(urls.map(function(u){
      return fetchJson(u).then(function(json){ return parseScoreboard(json); }).catch(function(){ return null; });
    })).then(function(lists){
      var merged = [];
      lists.forEach(function(l){ if (l) merged = mergeGameLists(merged, l); });
      if (merged.length) LG[lg] = merged;
      return merged.length > 0;
    });
  });
  Promise.all(sbDone).then(function(){
    var liveGames = [];
    LEAGUES.forEach(function(lg){ (LG[lg] || []).forEach(function(g){ if (g.state === "in") liveGames.push({ lg: lg, g: g }); }); });
    var sumDone = liveGames.map(function(x){
      return fetchJson("https://site.api.espn.com/apis/site/v2/sports/" + SITE[x.lg] + "/summary?event=" + x.g.id)
        .then(function(json){ var parsed = parseSummary(json, x.lg); if (Object.keys(parsed.athletes).length) BOX[x.g.id] = parsed; return true; })
        .catch(function(){ return false; });
    });
    return Promise.all(sumDone);
  }).then(function(){
    checking = false;
    if (btn){ btn.disabled = false; }
    lastCheckedAt = new Date();
    if (anyLive()) liveUpdatedAt = lastCheckedAt;
    updateStamp();
    if (window.__LL.renderGamesStrip) window.__LL.renderGamesStrip();
    window.__LL.renderGamesStripLive();
    renderLive();
    if (window.__LL.renderUnderdogs) window.__LL.renderUnderdogs();
    if (window.__LL.renderPlayersToWatch) window.__LL.renderPlayersToWatch();
    if (window.__LL.renderRandGames) window.__LL.renderRandGames();
    scheduleNext();
  });
}
$("#refreshBtn").addEventListener("click", function(){ runCheck(true); });
document.addEventListener("visibilitychange", function(){
  if (document.hidden){ clearTimeout(pollTimer); }
  else { runCheck(false); }
});
/* ticking clock: counts down locally between checks, re-anchored on every check */
setInterval(function(){
  if (document.hidden) return;
  var changed = false, zeroed = false;
  LEAGUES.forEach(function(lg){
    (LG[lg] || []).forEach(function(g){
      if (g.state !== "in" || !(g.clockSec > 0)) return;
      if (/half|intermission|end of|break/i.test(g.detail || "")) return;
      g.clockSec -= 1; changed = true;
      if (g.clockSec <= 0){ g.clockSec = 0; zeroed = true; }
      $$("[data-clock='" + g.id + "']").forEach(function(el){ el.textContent = fmtClock(g.clockSec); });
    });
  });
  if (changed) window.__LL.renderGamesStripLive();
  if (zeroed && !checking) runCheck(false);
}, 1000);

/* ---------- games strip: in-place text updates for scores/clocks ---------- */
/* One in-place game-box update shared by the strip, the Live view and
   the clock ticker: scores, the live marker and the status line are
   written into the existing nodes — the box itself is never recreated,
   so nothing in it can flash or reload. */
function updGameBox(box, g){
  if (!box || !g) return;
  var aS = box.querySelector('[data-score="away"]'), hS = box.querySelector('[data-score="home"]');
  if (g.state !== "pre"){
    if (aS) aS.textContent = g.away.score || "0";
    if (hS) hS.textContent = g.home.score || "0";
  }
  box.classList.toggle("is-live", g.state === "in");
  var tm = box.querySelector(".time");
  if (tm && window.__LL.gameStatusLine) tm.textContent = window.__LL.gameStatusLine(g);
}
window.__LL.renderGamesStripLive = function(){
  var updBox = updGameBox;
  $$("#gamesStrip .game").forEach(function(chip){
    var id = chip.getAttribute("data-gid");
    updBox(chip, (LG[S.league] || []).filter(function(x){ return x.id === id; })[0]);
  });
  /* keep the strip grouped live -> upcoming -> final on in-place updates too:
     a game that tips off or goes final moves to its group without a rebuild,
     and the user's scroll position is preserved */
  var stripEl = $("#gamesStrip");
  if (stripEl && window.__LL.stripGames){
    var wantOrder = window.__LL.stripGames(LG[S.league] || []);
    var chipsNow = $$("#gamesStrip .game");
    var ordered = chipsNow.length === wantOrder.length && chipsNow.every(function(chip, i){ return chip.getAttribute("data-gid") === String(wantOrder[i].id); });
    if (!ordered){
      var chipById = {};
      chipsNow.forEach(function(chip){ chipById[chip.getAttribute("data-gid")] = chip; });
      var stripX = stripEl.scrollLeft;
      wantOrder.forEach(function(g){ var chip = chipById[String(g.id)]; if (chip) stripEl.appendChild(chip); });
      stripEl.scrollLeft = stripX;
      if (window.__LL.updateGamesArrows) window.__LL.updateGamesArrows();
    }
  }
  $$("#liveWrap .game").forEach(function(card){
    var lg = card.getAttribute("data-pw-lg"), id = card.getAttribute("data-pw-gid");
    updBox(card, (LG[lg] || []).filter(function(x){ return x.id === id; })[0]);
  });
  /* keep each Live section grouped live -> upcoming -> final on in-place
     updates too: a game that tips off or goes final moves to its group
     inside its own section by re-appending the existing cards — no
     rebuild, so the section's open/closed state and the cards' live
     text updates are untouched */
  if (window.__LL.stripGames){
    $$("#liveWrap .livesec").forEach(function(sec){
      var grid = sec.querySelector(".lgrid");
      if (!grid) return;
      var want = window.__LL.stripGames(LG[sec.getAttribute("data-livesec")] || []);
      var cards = $$(".game", grid);
      var ordered = cards.length === want.length && cards.every(function(card, i){ return card.getAttribute("data-pw-gid") === String(want[i].id); });
      if (!ordered){
        var byId = {};
        cards.forEach(function(card){ byId[card.getAttribute("data-pw-gid")] = card; });
        want.forEach(function(g){ var card = byId[String(g.id)]; if (card) grid.appendChild(card); });
      }
    });
  }
};

/* ================= Players to Watch popup (z-index 900 — game log opens above it) ================= */
var pwCtx = null;
/* Structure signatures for the popup's in-place live updates: the teams
   body's shape last built, and the tracker block's row keys. A matching
   signature means a re-check may only touch values, never rebuild. */
var pwBuiltSig = null, pwLptKeys = null;
function pwStatVal(stats, key){
  if (!stats) return null;
  if (key === "combo"){
    if (stats.points == null || stats.totalRebounds == null || stats.assists == null) return null;
    return stats.points + stats.totalRebounds + stats.assists;
  }
  var v = stats[key];
  return (v == null || isNaN(v)) ? null : v;
}
function pwTopPlayers(lg, abbr){
  var byPid = {};
  (DATA.leagues[lg].props || []).forEach(function(pr){ if (pr.team === abbr) (byPid[pr.pid] = byPid[pr.pid] || []).push(pr); });
  var prim = PRIMARY[lg];
  var arr = Object.keys(byPid).map(function(pid){
    var ps = byPid[pid];
    var pp = ps.filter(function(x){ return x.key === prim; })[0];
    var score = pp ? (pp.l10avg || 0) : Math.max.apply(null, ps.map(function(x){ return x.l10avg || 0; }));
    return { pid: pid, props: ps, score: score, name: ps[0].name };
  });
  arr.sort(function(a, b){ return b.score - a.score; });
  return arr.slice(0, 5);
}
/* ONE direction-aware outcome for a started game's prop row: it drives BOTH
   the progress-bar colour and the badge, so the two can never disagree.
   Lines are always .5, so there are no pushes.
   - Over, value above the line (live or final): HIT — green, "Already over"
   - Over, final, value at/below the line: MISSED — red, "Missed"
   - Over, live, not yet above: still alive — amber in-progress fill, no badge
   - Under, value above the line (live or final): BUSTED, can never come
     back — red, "Busted"
   - Under, final, value below the line: HIT — green, "Hit"
   - Under, live, still below: still alive — amber in-progress fill, no badge
   Amber is only ever an in-progress colour, never a final-state colour. */
function pwOutcome(p, v, final){
  var crossed = v > p.line;
  if (p.dir === "Under"){
    if (crossed) return { cls: "lo", badge: '<span class="overmark bad">Busted</span>' };
    if (final) return { cls: "hi", badge: '<span class="overmark">Hit</span>' };
    return { cls: "mid", badge: "" };
  }
  if (crossed) return { cls: "hi", badge: '<span class="overmark">Already over</span>' };
  if (final) return { cls: "lo", badge: '<span class="overmark bad">Missed</span>' };
  return { cls: "mid", badge: "" };
}
function pwPropRow(p, box, gstate, lg){
  var started = gstate !== "pre";
  var final = gstate === "post";
  if (started){
    var a = box ? box.athletes[p.pid] : null;
    var v = a ? pwStatVal(a.stats, p.key) : null;
    if (v == null) return '<button type="button" class="pwprow pwprowbtn" data-open-logs="' + esc(p.pid) + '" data-stat-key="' + esc(p.key) + '" data-lg="' + esc(lg || "") + '"><span>' + p.dir + ' ' + fmtVal(p.line) + ' ' + esc(p.stat) + '</span><span class="pwval">\u2014</span></button>';
    var pct = p.line > 0 ? Math.min(100, Math.round(100 * v / p.line)) : 100;
    var oc = pwOutcome(p, v, final);
    return '<button type="button" class="pwprow pwprowbtn" data-open-logs="' + esc(p.pid) + '" data-stat-key="' + esc(p.key) + '" data-lg="' + esc(lg || "") + '"><span>' + p.dir + ' ' + fmtVal(p.line) + ' ' + esc(p.stat) + '</span><span class="pwval">' + fmtVal(v) + (oc.badge ? ' ' + oc.badge : '') + '</span></button>'
      + '<div class="bar pwbar"><i class="' + oc.cls + '" style="width:' + pct + '%"></i></div>';
  }
  function rr(r){ if (!r) return "\u2014"; return (p.dir === "Over" ? r.o : r.u) + "%"; }
  return '<button type="button" class="pwprow pwprowbtn" data-open-logs="' + esc(p.pid) + '" data-stat-key="' + esc(p.key) + '" data-lg="' + esc(lg || "") + '"><span>' + p.dir + ' ' + fmtVal(p.line) + ' ' + esc(p.stat) + '</span><span class="pwval">L5 ' + rr((p.rates || {}).L5) + ' \u00B7 L10 ' + rr((p.rates || {}).L10) + '</span></button>';
}
function renderPw(){
  if (!pwCtx) return;
  var lg = pwCtx.lg;
  var g = (LG[lg] || []).filter(function(x){ return x.id === pwCtx.gid; })[0];
  if (!g){ closePw(); return; }
  var started = g.state !== "pre";
  $("#pwTitle").textContent = (g.away.name || g.away.abbr) + " at " + (g.home.name || g.home.abbr);
  var sub = window.__LL.gameStatusLine ? window.__LL.gameStatusLine(g) : "";
  if (g.state !== "pre") sub += " \u00B7 " + (g.away.score || "0") + " \u2013 " + (g.home.score || "0");
  if (g.spread || g.total) sub += " \u00B7 " + (g.spread || "") + (g.total ? " O/U " + g.total : "");
  $("#pwSub").textContent = sub.trim();
  var box = BOX[g.id];
  /* The popup body is built from a small model: the two team sections,
     their top players and each player's prop rows, every row carrying
     the live value data an in-place update needs. The signature
     captures structure only (game, state, box-score presence, teams,
     players, prop keys) — never values. When the signature matches
     what is already in the DOM, a live re-check updates team scores,
     row values, badges and bars in the existing nodes; rebuilding the
     body would recreate every headshot in it and flash them all on
     every check. A structure change (the state flips, the box score
     first arrives, another game opens) takes the full build below. */
  var teams = [], rows = [], sigParts = [pwCtx.gid, g.state, box ? "box" : "nobox"];
  [g.away, g.home].forEach(function(tm){
    var tops = pwTopPlayers(lg, tm.abbr);
    sigParts.push(tm.abbr);
    var tmodel = { tm: tm, tops: [] };
    tops.forEach(function(tp){
      var prows = tp.props.slice(0, 4);
      /* NBA: the 3PM prop always gets a row too, so live progress toward the
         3-pointers line shows like every other tracked stat */
      if (lg === "NBA"){
        var p3 = null;
        tp.props.forEach(function(x){ if (x.key === "threePointersMade") p3 = x; });
        if (p3 && prows.indexOf(p3) < 0) prows.push(p3);
      }
      sigParts.push(tp.pid);
      var prowModels = prows.map(function(pr){
        sigParts.push(pr.key);
        var m = { p: pr, v: null, oc: null, pct: null };
        if (started && box){
          var a = box.athletes[pr.pid];
          var v = a ? pwStatVal(a.stats, pr.key) : null;
          if (v != null){
            m.v = v;
            m.pct = pr.line > 0 ? Math.min(100, Math.round(100 * v / pr.line)) : 100;
            m.oc = pwOutcome(pr, v, g.state === "post");
          }
        }
        rows.push(m);
        return m;
      });
      tmodel.tops.push({ tp: tp, prows: prowModels });
    });
    teams.push(tmodel);
  });
  var sig = sigParts.join("|");
  var bodyEl = $("#pwBody");
  var patched = false;
  if (bodyEl && sig === pwBuiltSig){
    var secEls = $$("#pwBody .pwteam");
    var btns = $$("#pwBody .pwprow");
    if (secEls.length === 2 && btns.length === rows.length){
      teams.forEach(function(tmodel, ti){
        var span = secEls[ti] ? secEls[ti].querySelector("h4 span") : null;
        if (span) span.textContent = (tmodel.tm.name || "") + (g.state === "pre" ? "" : " \u00B7 " + (tmodel.tm.score || "0"));
      });
      if (started && box){
        rows.forEach(function(m, i){
          var btn = btns[i]; if (!btn) return;
          var valEl = btn.querySelector(".pwval");
          var bar = btn.nextElementSibling;
          if (!bar || !bar.classList.contains("pwbar")) bar = null;
          if (m.v == null){
            if (valEl) valEl.textContent = "\u2014";
            if (bar) bar.parentNode.removeChild(bar);
          } else {
            if (valEl) valEl.innerHTML = fmtVal(m.v) + (m.oc.badge ? " " + m.oc.badge : "");
            if (!bar){
              bar = document.createElement("div");
              bar.className = "bar pwbar";
              bar.innerHTML = "<i></i>";
              btn.parentNode.insertBefore(bar, btn.nextSibling);
            }
            var fill = bar.querySelector("i");
            if (fill){ fill.className = m.oc.cls; fill.style.width = m.pct + "%"; }
          }
        });
      }
      patched = true;
    }
  }
  if (!patched && bodyEl){
    var body = "";
    teams.forEach(function(tmodel){
      var tm = tmodel.tm;
      body += '<div class="pwteam"><h4>' + esc(tm.abbr) + ' <span>' + esc(tm.name || "") + (g.state === "pre" ? "" : " \u00B7 " + esc(tm.score || "0")) + '</span></h4>';
      if (!tmodel.tops.length){ body += '<div class="emptybox">No tracked players for ' + esc(tm.abbr) + ' in the ' + lg + ' pool.</div></div>'; return; }
      tmodel.tops.forEach(function(tw){
        var tp = tw.tp;
        var pinfo = (DATA.leagues[lg].players || {})[tp.pid] || {};
        var img = pinfo.img ? '<div class="avatar"><img src="' + esc(pinfo.img) + '" alt="" loading="lazy" onerror="this.parentNode.textContent=\'' + esc((tp.name || "P").charAt(0)) + '\'"></div>'
                            : '<div class="avatar">' + esc((tp.name || "P").charAt(0)) + '</div>';
        body += '<div class="pwplayer"><button class="pwhead" data-open-logs="' + esc(tp.pid) + '" data-stat-key="' + esc(PRIMARY[lg]) + '" data-lg="' + esc(lg) + '">' + img
          + '<span class="who"><span class="nm">' + esc(tp.name) + '</span><span class="tm">' + esc(tm.abbr) + (pinfo.pos ? ' \u00B7 ' + esc(pinfo.pos) : '') + ' \u00B7 tap for game log</span></span><span class="golog">Log \u203A</span></button>'
          + tw.prows.map(function(m){ return pwPropRow(m.p, box, g.state, lg); }).join("") + '</div>';
      });
      body += '</div>';
    });
    if (started && !box) body += '<div style="color:var(--ink3);font-size:12.5px;margin-top:10px">Loading player stats for this game\u2026</div>';
    bodyEl.innerHTML = body;
    pwBuiltSig = sig;
    pwLptKeys = null;   /* a rebuilt body takes any tracker block with it */
  }
  /* In-progress games only: the bar-style Live props tracker goes at the
     very bottom of the popup, below everything the popup already shows —
     nothing above it changes. No qualifying props (or no box score yet)
     means no block at all, never an empty heading. renderPw re-runs on
     every live check while the popup is open (and once the on-open box
     score fetch lands), so the block stays current on the same cycle as
     the rest of the popup — no separate timer. While the tracked set is
     unchanged, its rows update in place (re-appended into display order
     when the ranking moves); the block is rebuilt only when the set
     itself changes, e.g. a player records a tracked stat for the first
     time. */
  if (g.state === "in" && bodyEl){
    var cands = lptModel(lg, g);
    var keys = cands.map(function(c){ return c.p.pid + "|" + c.p.key; });
    var lptEl = bodyEl.querySelector(".lpt");
    var sameSet = false;
    if (lptEl && pwLptKeys && pwLptKeys.length === keys.length){
      var keySet = {};
      pwLptKeys.forEach(function(k){ keySet[k] = 1; });
      sameSet = keys.every(function(k){ return keySet[k]; });
    }
    if (sameSet){
      var rowByKey = {};
      $$(".lpt-row", lptEl).forEach(function(r){ rowByKey[r.getAttribute("data-lptk")] = r; });
      cands.forEach(function(c){
        var row = rowByKey[c.p.pid + "|" + c.p.key];
        if (!row) return;
        lptEl.appendChild(row);
        updLptRow(lg, row, c);
      });
      pwLptKeys = keys;
    } else {
      if (lptEl) lptEl.parentNode.removeChild(lptEl);
      if (cands.length){
        var tmp = document.createElement("div");
        tmp.innerHTML = lptPopupHtml(lg, g);
        if (tmp.firstChild) bodyEl.appendChild(tmp.firstChild);
      }
      pwLptKeys = cands.length ? keys : null;
    }
  }
  /* player heads + prop rows carry data-open-logs: the shared delegated
     handler opens the log popup on top, so live re-renders need no rebinding */
}

function openPw(lg, gid){
  pwCtx = { lg: lg, gid: gid };
  pwBuiltSig = null; pwLptKeys = null;
  var hp = $("#pwH2hPanel"); hp.className = "h2hpanel"; hp.innerHTML = "";
  $("#pwH2hBtn").setAttribute("aria-expanded", "false");
  var pwWasOpen = $("#pwModal").classList.contains("open");
  $("#pwModal").classList.add("open");
  document.body.classList.add("modal-open");
  if (!pwWasOpen && window.__LL.lockScroll) window.__LL.lockScroll();
  var sh = $("#pwModal .sheet"); if (sh) sh.scrollTop = 0;
  renderPw();
  var g = (LG[lg] || []).filter(function(x){ return x.id === gid; })[0];
  if (g && g.state !== "pre" && !BOX[gid]){
    fetchJson("https://site.api.espn.com/apis/site/v2/sports/" + SITE[lg] + "/summary?event=" + gid)
      .then(function(json){ var parsed = parseSummary(json, lg); if (Object.keys(parsed.athletes).length) BOX[gid] = parsed; if (pwCtx && pwCtx.gid === gid) renderPw(); })
      .catch(function(){});
  }
}
function closePw(){
  var m = $("#pwModal"); if (!m) return;
  var wasOpen = m.classList.contains("open");
  m.classList.remove("open");
  pwCtx = null;
  pwBuiltSig = null; pwLptKeys = null;
  if (!$("#logModal").classList.contains("open")) document.body.classList.remove("modal-open");
  if (wasOpen && window.__LL.unlockScroll) window.__LL.unlockScroll();
}
window.__LL.openPlayersToWatch = openPw;
window.__LL.closePlayersToWatch = closePw;
window.__LL.renderPlayersToWatch = function(){ if (pwCtx && $("#pwModal").classList.contains("open")) renderPw(); };
$("#pwClose").addEventListener("click", closePw);
$("#pwModal .backdrop").addEventListener("click", closePw);
$("#pwH2hBtn").addEventListener("click", function(){
  var panel = $("#pwH2hPanel");
  if (panel.classList.contains("open")){ panel.className = "h2hpanel"; panel.innerHTML = ""; this.setAttribute("aria-expanded", "false"); return; }
  if (!pwCtx) return;
  var lg = pwCtx.lg;
  var g = (LG[lg] || []).filter(function(x){ return x.id === pwCtx.gid; })[0];
  if (!g) return;
  var meetings = (DATA.leagues[lg].h2h || {})[pairKey(g.away.abbr, g.home.abbr)] || [];
  var head = '<h3>' + esc(g.away.name) + ' vs ' + esc(g.home.name) + ' \u2014 head-to-head</h3>';
  if (!meetings.length){
    panel.innerHTML = head + '<div class="sub">No meeting history between these two teams in the schedule data for this season or last.</div>';
  } else {
    panel.innerHTML = head + '<div class="sub">Recent meetings from team schedules (this season and last).</div>' + meetings.map(function(mt){
      var wAbbr = (+mt.hs > +mt.as) ? mt.home : mt.away;
      return '<div class="meet"><span class="md">' + fmtD(mt.d) + '</span><span>' + esc(mt.away) + ' @ ' + esc(mt.home) + '</span><span class="mw">' + esc(mt.as) + ' \u2013 ' + esc(mt.hs) + ' \u00B7 ' + esc(wAbbr) + '</span></div>';
    }).join("");
  }
  panel.className = "h2hpanel open";
  this.setAttribute("aria-expanded", "true");
});
document.addEventListener("click", function(e){
  var c = e.target.closest ? e.target.closest("[data-pw-gid]") : null;
  if (c) openPw(c.getAttribute("data-pw-lg"), c.getAttribute("data-pw-gid"));
});
document.addEventListener("keydown", function(e){
  if ((e.key === "Enter" || e.key === " ") && e.target && e.target.matches && e.target.matches("[data-pw-gid]")){
    e.preventDefault();
    openPw(e.target.getAttribute("data-pw-lg"), e.target.getAttribute("data-pw-gid"));
  }
});

/* ---------- init ---------- */
/* Seed LG from the baked chunks before the first paint. The strip
   renders from LG, and if LG is empty at init (or an early fetch
   replaced it with an empty list) the strip paints "No games on the
   schedule" until a manual refresh forces a good fetch — the baked
   per-league games are already in strip shape, so paint from them;
   runCheck keeps overwriting LG with fresh data exactly as before.
   Baked in-progress games also get clockSec parsed from their M:SS
   clock string so the ticking clock works from first paint. */
LEAGUES.forEach(function(lg){
  var baked = (DATA.leagues[lg] && DATA.leagues[lg].games) || [];
  if (baked.length && !(LG[lg] || []).length) LG[lg] = baked.slice();
  (LG[lg] || []).forEach(function(g){
    if (g.state === "in" && g.clock && g.clockSec == null){
      var m = String(g.clock).match(/(\d+):(\d+)/);
      if (m) g.clockSec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }
  });
});
window.__LL.renderAll();
var top = (DATA.leagues.NBA.props || [])[0];
if (top) window.__LL.initWorkstation(top.pid, top.key);
runCheck(false);
})();


/* ---------- Swipe-down-to-dismiss for the popup sheets (iPhone sheet style) ----------
   Attached to every bottom-sheet modal on the page (game log + Players to Watch),
   so the gesture works the same way everywhere.
   - Dragging down from the sheet header (or the grab handle) always drags the sheet.
   - Dragging down from the content drags the sheet only while the content is
     scrolled to its very top; if a gesture scrolls the content back to the top
     and keeps pulling down, the sheet takes over from there — re-based at the
     takeover point, so the sheet follows the finger with no jump.
   - Release past ~110px of drag, or a fast downward flick, closes through the
     popup's own close function (background scroll lock release, page scroll
     restore and stacked popups behave exactly like the × button: only the top
     sheet closes). Below the threshold the sheet springs back into place.
   - Content scrolling, horizontal gestures, taps, steppers and chart touches
     are untouched: the drag engages only on a deliberate downward pull, and
     taps never call preventDefault. */
(function(){
  "use strict";
  var THRESH = 110;    /* px of drag that dismisses on release */
  var FLICK_V = 0.5;   /* px/ms downward velocity that counts as a flick */
  var FLICK_MIN = 30;  /* a flick still needs this much travel */
  var SLOP = 6;        /* px of movement before the gesture is classified */
  function attach(modalId, closeFn){
    var modal = document.getElementById(modalId);
    if (!modal) return;
    var sheet = modal.querySelector(".sheet");
    var backdrop = modal.querySelector(".backdrop");
    if (!sheet) return;
    var st = null, dismissing = false;
    function clearStyles(){
      sheet.style.transform = "";
      sheet.style.transition = "";
      if (backdrop){ backdrop.style.opacity = ""; backdrop.style.transition = ""; }
    }
    function setY(y){
      sheet.style.transform = "translateY(" + y + "px)";
      if (backdrop) backdrop.style.opacity = String(Math.max(0.3, 1 - y / 750));
    }
    function startDrag(base){
      st.mode = "drag";
      st.dragBase = base;
      st.cur = 0;
      sheet.style.transition = "none";
    }
    function findTouch(e){
      for (var i = 0; i < e.changedTouches.length; i++)
        if (e.changedTouches[i].identifier === st.id) return e.changedTouches[i];
      return null;
    }
    sheet.addEventListener("touchstart", function(e){
      if (dismissing || !modal.classList.contains("open")){ st = null; return; }
      if (e.touches.length !== 1){ st = null; return; }
      var t = e.touches[0];
      var head = (e.target && e.target.closest) ? e.target.closest(".sheethead, .sheetgrab") : null;
      st = { id: t.identifier, x0: t.clientX, y0: t.clientY, lastY: t.clientY,
             lastT: Date.now(), vy: 0, header: !!head, mode: "pending", dragBase: 0, cur: 0 };
    }, { passive: true });
    sheet.addEventListener("touchmove", function(e){
      if (!st) return;
      var t = findTouch(e); if (!t) return;
      var now = Date.now();
      var dx = t.clientX - st.x0, dy = t.clientY - st.y0;
      var step = t.clientY - st.lastY, dt = now - st.lastT;
      if (dt > 0) st.vy = 0.65 * st.vy + 0.35 * (step / dt);
      st.lastY = t.clientY; st.lastT = now;
      if (st.mode === "ignore") return;
      if (st.mode === "scroll"){
        /* content is scrolling: hand the gesture to the sheet only once the
           content reaches the top and the finger keeps pulling down */
        if (sheet.scrollTop <= 0 && step > 0) startDrag(t.clientY);
        else return;
      } else if (st.mode === "pending"){
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)){ st.mode = "ignore"; return; }
        if (dy < -SLOP){ st.mode = "scroll"; return; }
        if (dy > SLOP){
          /* engage from the gesture's start (past the slop) so the sheet's
             travel tracks the finger's total pull, flick distance included */
          if (st.header || sheet.scrollTop <= 0) startDrag(st.y0 + SLOP);
          else { st.mode = "scroll"; return; }
        } else return;
      }
      /* mode === "drag": the sheet follows the finger, content scroll held off */
      if (e.cancelable) e.preventDefault();
      var y = t.clientY - st.dragBase;
      st.cur = y > 0 ? y : 0;
      setY(st.cur);
    }, { passive: false });
    function finish(){
      if (!st) return;
      var was = st.mode, cur = st.cur || 0, vy = st.vy || 0;
      if (Date.now() - st.lastT > 80) vy = 0; /* finger paused before release: not a flick */
      st = null;
      if (was !== "drag") return;
      if (cur > THRESH || (vy > FLICK_V && cur > FLICK_MIN)){
        dismissing = true;
        var h = sheet.offsetHeight || 640;
        sheet.style.transition = "transform .22s ease-in";
        if (backdrop) backdrop.style.transition = "opacity .22s ease-in";
        setY(h);
        setTimeout(function(){
          try { closeFn(); } catch (err) {}
          dismissing = false;
          clearStyles();
        }, 210);
      } else {
        sheet.style.transition = "transform .3s cubic-bezier(.32,.72,.35,1)";
        if (backdrop) backdrop.style.transition = "opacity .3s ease";
        sheet.style.transform = "translateY(0px)";
        if (backdrop) backdrop.style.opacity = "";
        setTimeout(clearStyles, 320);
      }
    }
    sheet.addEventListener("touchend", finish);
    sheet.addEventListener("touchcancel", finish);
  }
  attach("logModal", function(){ if (window.__LL && window.__LL.closeLogModal) window.__LL.closeLogModal(); });
  attach("pwModal", function(){ if (window.__LL && window.__LL.closePlayersToWatch) window.__LL.closePlayersToWatch(); });
})();
