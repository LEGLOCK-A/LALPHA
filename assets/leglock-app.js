
"use strict";
/* ---------- app mode (LEGLOCK iOS shell) ----------
   The native shell injects window.LEGLOCK_APP_MODE = true via a
   WKUserScript at document start, before any page script runs. In
   every other context (this file opened in Safari, the public link)
   the flag is absent and autoLater runs its callback immediately, so
   browser behaviour is exactly as before. In app mode the board
   paints first from its baked snapshot and the automatic game-log
   work is deferred by ~1.2s so the first screen is instant; the
   refresh itself, once started, is unchanged. Manual Refresh is
   never routed through autoLater — it always fires immediately. */
var APP_MODE = !!window.LEGLOCK_APP_MODE;
function autoLater(fn){ if(APP_MODE){ setTimeout(fn, 1200); } else { fn(); } }
/* ---------- helpers ---------- */
var LEAGUES = ["NBA","NFL","NHL","MLB"];
var STAT_FROM = {
  points:["points"], totalRebounds:["totalRebounds"], assists:["assists"],
  pra:["points","totalRebounds","assists"], pr:["points","totalRebounds"], pa:["points","assists"],
  threePointersMade:["threePointFieldGoalsMade-threePointFieldGoalsAttempted"],
  steals:["steals"], blocks:["blocks"],
  passingYards:["passingYards"], passingTouchdowns:["passingTouchdowns"],
  passRushYards:["passingYards","rushingYards"], rushingYards:["rushingYards"],
  receivingYards:["receivingYards"], receptions:["receptions"], rushingAttempts:["rushingAttempts"],
  goals:["goals"], shotsTotal:["shotsTotal"],
  hits:["hits"], totalBases:["__totalBases"], homeRuns:["homeRuns"], RBIs:["RBIs"],
  runs:["runs"], stolenBases:["stolenBases"], pitcherStrikeouts:["strikeouts"]
};
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function pct(h,n){return n?Math.round(h/n*100):0;}
function fmtLine(l){return Number.isInteger(l)?String(l):Number(l).toFixed(1);}
function hitsFor(values,line,n,over){var s=values.slice(0,n);var h=0;for(var i=0;i<s.length;i++){if(over?s[i]>line:s[i]<line)h++;}return {h:h,n:s.length};}
function windowsFor(values,line,over){return {l5:hitsFor(values,line,5,over),l10:hitsFor(values,line,10,over),l20:hitsFor(values,line,20,over)};}
function fmtGameTime(iso){
  var d=new Date(iso); if(isNaN(d.getTime()))return "";
  var today=new Date(); var same=d.toDateString()===today.toDateString();
  var tom=new Date(today.getTime()+86400000).toDateString()===d.toDateString();
  var time=new Intl.DateTimeFormat(undefined,{hour:"numeric",minute:"2-digit"}).format(d);
  if(same)return "Today · "+time; if(tom)return "Tomorrow · "+time;
  return new Intl.DateTimeFormat(undefined,{weekday:"short",month:"short",day:"numeric"}).format(d)+" · "+time;
}
function initials(name){return name.split(" ").map(function(p){return p[0];}).filter(Boolean).slice(0,2).join("").toUpperCase();}
/* Player headshots come from ESPN's CDN (remote on purpose — embedding 400
   photos would balloon this file). Per-league pattern verified live:
   .png returns a real image for all four leagues, while .jpg 404s for
   NBA/MLB and some NFL players. The initials stay rendered underneath the
   <img>; if the photo is missing, blocked or the file is offline, the
   img's onerror removes it and the initials avatar shows — no broken-image
   icon, no layout shift (fixed-size circular container). */
function headshotUrl(lg,id){
  if(id==null||!/^\d+$/.test(String(id)))return "";
  return "https://a.espncdn.com/i/headshots/"+String(lg||"").toLowerCase()+"/players/full/"+id+".png";
}
function playerAvatar(name,id,lg,extra){
  var ini=esc(initials(name||""));
  var url=headshotUrl(lg,id);
  if(!url)return '<div class="avatar'+(extra?" "+extra:"")+'" aria-hidden="true">'+ini+'</div>';
  return '<div class="avatar'+(extra?" "+extra:"")+'" aria-hidden="true">'+ini+'<img src="'+url+'" alt="" loading="lazy" decoding="async" onerror="this.remove()"></div>';
}
function toast(msg){
  var t=document.getElementById("toast"); t.textContent=msg; t.classList.add("show");
  clearTimeout(toast._h); toast._h=setTimeout(function(){t.classList.remove("show");},2600);
}
function saveBlob(blob,filename){
  var url=URL.createObjectURL(blob);
  var a=document.createElement("a"); a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){URL.revokeObjectURL(url);},4000);
}
function csvCell(v){var s=String(v==null?"":v); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}

/* ---------- state (this tab only — nothing is stored) ---------- */
var state={
  league:"NBA", tab:(window.LEGLOCK_PAGE==="lay"?"makelay":(window.LEGLOCK_PAGE||"discover")),
  lineOverrides:{},
  ws:{search:"",stat:"all",min:0,sort:"l10",shown:60},
  cs:{win:"l10",minPct:70},
  detail:null, teamDetail:null, liveGameId:null, watchGameId:null, livePwKey:null, livePwHad:false, livePwPrev:null, refreshing:false, liveRefreshing:false, refreshed:{}, boardStamp:{},
  pwOpen:{},
  pwFresh:{}, gl:{stat:null},
  lay:{legs:4,minPct:50,selected:null,pickerOpen:false,generated:null,genCount:0,genMeta:null},
  inj:{status:"idle",teams:null,asOf:"",q:""}
};
function board(){return DATA[state.league];}
var WS_PAGE=60;
var lineRev=0;
function lineFor(p){var k=state.league+":"+p.id; return state.lineOverrides[k]!=null?state.lineOverrides[k]:p.line;}
function setLine(p,l){state.lineOverrides[state.league+":"+p.id]=l;lineRev++;}
function lineForLg(lg,p){var k=lg+":"+p.id; return state.lineOverrides[k]!=null?state.lineOverrides[k]:p.line;}
/* ---------- team props (Discover section; data baked in as TEAM_DATA) ---------- */
function teamBoard(){return (typeof TEAM_DATA!=="undefined"&&TEAM_DATA[state.league])?TEAM_DATA[state.league]:{teams:[],props:[]};}
function teamLineFor(p){var k=state.league+":"+p.id; return state.lineOverrides[k]!=null?state.lineOverrides[k]:p.line;}
function findTeamProp(pid){var f=null; teamBoard().props.forEach(function(x){if(x.id===pid)f=x;}); return f;}
function tstatValue(g,statKey){var v=g.stats[statKey]; return v==null?null:v;}

/* ---------- shared fragments ---------- */
function winRow(label,w,values,line,over){
  var slice=values.slice(0,w.n); var cells="";
  for(var i=0;i<slice.length;i++){var hit=over?slice[i]>line:slice[i]<line;cells+='<span class="cell'+(hit?" hit":"")+'"></span>';}
  if(!slice.length)cells='<span class="sub">No games yet</span>';
  return '<div class="winrow"><span class="lab">'+label+'</span><span class="cells">'+cells+'</span><span class="val tnum">'+w.h+'/'+w.n+' · '+pct(w.h,w.n)+'%</span></div>';
}
function stepper(p){
  var line=lineFor(p);
  return '<div class="stepper"><button type="button" data-step="-0.5" data-pid="'+esc(p.id)+'" aria-label="Lower line for '+esc(p.playerName)+'">−</button><span class="lv tnum">'+fmtLine(line)+'</span><button type="button" data-step="0.5" data-pid="'+esc(p.id)+'" aria-label="Raise line for '+esc(p.playerName)+'">+</button></div>';
}
function propCard(p,hero,compact){
  var line=lineFor(p), custom=line!==p.line;
  var w=custom?windowsFor(p.values,line,true):p.over;
  var badges=p.badges.map(function(b){var hot=b.indexOf("HOT")===0||b.indexOf("STREAK")===0;return '<span class="badge'+(hot?" hot":"")+'">'+esc(b)+'</span>';}).join("");
  var nameFs=compact?(hero?15:13):(hero?22:19);
  var lineFs=compact?12:15;
  var mt1=compact?6:12, mt2=compact?4:8, mt3=compact?7:14;
  var labFs=compact?9:11;
  return '<article class="card prop'+(compact?" compact":"")+'">'
    +'<div style="display:flex;gap:'+(compact?7:12)+'px;align-items:flex-start">'+playerAvatar(p.playerName,p.playerId,state.league,hero?"lg":"")
    +'<div style="flex:1;min-width:0"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">'
    +'<h3 class="display" style="margin:0;font-size:'+nameFs+'px;font-weight:700">'+esc(p.playerName)+'</h3>'
    +'<div class="rate display tnum">'+pct(w.l10.h,w.l10.n)+'%<small>L10 HIT RATE</small></div></div>'
    +'<p class="sub" style="margin:2px 0 0">'+esc(p.teamAbbr)+(p.position?" · "+esc(p.position):"")+(p.nextGame?' · '+(p.nextGame.home?"vs ":"@ ")+esc(p.nextGame.oppAbbr)+' · '+esc(fmtGameTime(p.nextGame.date)):" · No upcoming game on the slate")+'</p></div></div>'
    +'<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:8px;margin-top:'+mt1+'px"><p style="margin:0;font-size:'+lineFs+'px"><b>Over '+fmtLine(line)+'</b> <span style="color:var(--dim)">'+esc(p.statLabel)+'</span></p>'
    +'<p class="sub tnum" style="margin:0">Avg L10 <b style="color:var(--text)">'+p.avgL10+'</b> · Season <b style="color:var(--text)">'+p.avgAll+'</b></p></div>'
    +(custom?'<p style="margin:4px 0 0;font-size:12px;font-weight:700;color:var(--accent-ink)">Your line — rates recomputed from the game log</p>':"")
    +'<div style="margin-top:'+mt2+'px">'+winRow("L5",w.l5,p.values,line,true)+winRow("L10",w.l10,p.values,line,true)+winRow("L20",w.l20,p.values,line,true)+'</div>'
    +(w.l10.n<10?'<p class="note" style="margin-top:6px">Early sample — based on '+w.l20.n+' games in the log so far.</p>':"")
    +(badges?'<div class="badges">'+badges+'</div>':"")
    +'<div style="display:flex;gap:'+(compact?6:8)+'px;margin-top:'+mt3+'px"><button type="button" class="btn" style="flex:1" data-detail="'+esc(p.playerId)+'">Game log</button></div>'
    +'<div style="display:flex;justify-content:space-between;align-items:center;margin-top:'+mt1+'px"><span class="sub" style="font-weight:800;letter-spacing:.05em;font-size:'+labFs+'px">RESEARCH LINE</span>'+stepper(p)+'</div>'
    +'</article>';
}

function teamStepper(p){
  var line=teamLineFor(p);
  return '<div class="stepper"><button type="button" data-tstep="-0.5" data-tpid="'+esc(p.id)+'" aria-label="Lower line for '+esc(p.playerName)+' '+esc(p.statLabel)+'">−</button><span class="lv tnum">'+fmtLine(line)+'</span><button type="button" data-tstep="0.5" data-tpid="'+esc(p.id)+'" aria-label="Raise line for '+esc(p.playerName)+' '+esc(p.statLabel)+'">+</button></div>';
}
function teamPropCard(p){
  var line=teamLineFor(p), custom=line!==p.line;
  var w=custom?windowsFor(p.values,line,true):p.over;
  var badges=p.badges.map(function(b){var hot=b.indexOf("HOT")===0||b.indexOf("STREAK")===0;return '<span class="badge'+(hot?" hot":"")+'">'+esc(b)+'</span>';}).join("");
  return '<article class="card prop compact">'
    +'<div style="display:flex;gap:7px;align-items:flex-start"><div class="avatar" aria-hidden="true" style="font-size:10px;letter-spacing:-.02em">'+esc(p.teamAbbr)+'</div>'
    +'<div style="flex:1;min-width:0"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">'
    +'<h3 class="display" style="margin:0;font-size:13px;font-weight:700">'+esc(p.playerName)+'</h3>'
    +'<div class="rate display tnum">'+pct(w.l10.h,w.l10.n)+'%<small>L10 HIT RATE</small></div></div>'
    +'<p class="sub" style="margin:2px 0 0">'+esc(p.teamAbbr)+' · Team prop'+(p.nextGame?' · '+(p.nextGame.home?"vs ":"@ ")+esc(p.nextGame.oppAbbr)+' · '+esc(fmtGameTime(p.nextGame.date)):" · No upcoming game on the slate")+'</p></div></div>'
    +'<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:8px;margin-top:6px"><p style="margin:0;font-size:12px"><b>Over '+fmtLine(line)+'</b> <span style="color:var(--dim)">'+esc(p.statLabel)+'</span></p>'
    +'<p class="sub tnum" style="margin:0">Avg L10 <b style="color:var(--text)">'+p.avgL10+'</b> · Season <b style="color:var(--text)">'+p.avgAll+'</b></p></div>'
    +(custom?'<p style="margin:4px 0 0;font-size:12px;font-weight:700;color:var(--accent-ink)">Your line — rates recomputed from the game log</p>':"")
    +'<div style="margin-top:4px">'+winRow("L5",w.l5,p.values,line,true)+winRow("L10",w.l10,p.values,line,true)+winRow("L20",w.l20,p.values,line,true)+'</div>'
    +(w.l10.n<10?'<p class="note" style="margin-top:6px">Early sample — based on '+w.l20.n+' games in the log so far.</p>':"")
    +(badges?'<div class="badges">'+badges+'</div>':"")
    +'<div style="display:flex;gap:6px;margin-top:7px"><button type="button" class="btn" style="flex:1" data-tdetail="'+esc(p.id)+'">Game log</button></div>'
    +'<div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px"><span class="sub" style="font-weight:800;letter-spacing:.05em;font-size:9px">RESEARCH LINE</span>'+teamStepper(p)+'</div>'
    +'</article>';
}
function bindTeamCards(scope){
  scope.querySelectorAll("[data-tstep]").forEach(function(btn){
    btn.addEventListener("click",function(){
      var p=findTeamProp(btn.getAttribute("data-tpid")); if(!p)return;
      var nl=Math.round((teamLineFor(p)+parseFloat(btn.getAttribute("data-tstep")))*2)/2; if(nl<0.5)nl=0.5;
      state.lineOverrides[state.league+":"+p.id]=nl; lineRev++;
      if(state.teamDetail)renderTeamModal(); else render();
    });
  });
  scope.querySelectorAll("[data-tdetail]").forEach(function(btn){
    btn.addEventListener("click",function(){openTeamDetail(btn.getAttribute("data-tdetail"));});
  });
}

/* ---------- views ---------- */
function liveGameFor(bg){
  if(!bg||bg.id==null)return null;
  var lb=liveBoard();
  var games=lb.games||[];
  for(var i=0;i<games.length;i++){if(String(games[i].id)===String(bg.id))return games[i];}
  return null;
}
function liveScoreFor(lg,abbr){
  if(!lg||!lg.teams)return null;
  for(var i=0;i<lg.teams.length;i++){if(lg.teams[i].abbr===abbr)return lg.teams[i].score;}
  return null;
}
function gamesStrip(games){
  if(!games.length)return "";
  var stripProvider=null;
  var out='<div class="games">';
  games.slice(0,20).forEach(function(g){
    var lg=liveGameFor(g);
    var isLive=g.state==="in"||(lg&&lg.state==="in");
    var awayScore=g.awayScore, homeScore=g.homeScore;
    var when=g.state==="pre"?fmtGameTime(g.date):(g.detail||"");
    if(lg&&lg.state==="in"){
      var as=liveScoreFor(lg,g.awayAbbr), hs=liveScoreFor(lg,g.homeAbbr);
      if(as!=null)awayScore=as;
      if(hs!=null)homeScore=hs;
      if(lg.detail)when=lg.detail;
    }
    var inner='<div class="t"><span>'+esc(g.awayAbbr)+'</span><span class="tnum" data-score-for="'+esc(g.id)+':'+esc(g.awayAbbr)+'" style="color:var(--dim)">'+esc(awayScore==null?"":awayScore)+'</span></div>'
      +'<div class="t" style="margin-top:1px"><span>'+esc(g.homeAbbr)+'</span><span class="tnum" data-score-for="'+esc(g.id)+':'+esc(g.homeAbbr)+'" style="color:var(--dim)">'+esc(homeScore==null?"":homeScore)+'</span></div>';
    var whenHtml=isLive
      ? '<p class="when"><span class="livedot" aria-hidden="true"></span><span data-clock-for="'+esc(g.id)+'">'+esc(when||"Live")+'</span></p>'
      : '<p class="when">'+esc(when)+'</p>';
    var effState=(lg&&lg.state)?lg.state:g.state;
    var effOdds=(lg&&lg.odds)||g.odds||null;
    var oddsHtml=(effState==="pre"&&effOdds)?oddsCompactHtml(effOdds,g.awayAbbr,g.homeAbbr):"";
    if(effState==="pre"&&effOdds&&effOdds.provider&&!stripProvider)stripProvider=effOdds.provider;
    out+='<button type="button" class="card game'+(isLive?" game-live":"")+'" data-watch-game="'+esc(g.id)+'" aria-label="Open players to watch for '+esc(g.awayAbbr)+' at '+esc(g.homeAbbr)+'">'
      +inner+whenHtml+oddsHtml+'<p class="game-tap">Players to watch ›</p></button>';
  });
  return out+'</div>'+(stripProvider?oddsNoteHtml(stripProvider):"");
}
function etDayKey(iso){
  var d=new Date(iso); if(isNaN(d.getTime()))return "";
  try{
    var parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(d);
    var y="",mo="",da="";
    parts.forEach(function(p){if(p.type==="year")y=p.value;else if(p.type==="month")mo=p.value;else if(p.type==="day")da=p.value;});
    return y+"-"+mo+"-"+da;
  }catch(e){return d.toDateString();}
}
function fmtEtTime(iso){
  var d=new Date(iso); if(isNaN(d.getTime()))return "";
  try{
    var t=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"numeric",minute:"2-digit",hour12:true}).format(d);
    var tz="";
    new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",timeZoneName:"short"}).formatToParts(d).forEach(function(p){if(p.type==="timeZoneName")tz=p.value;});
    return t.toUpperCase()+(tz?" "+tz:" ET");
  }catch(e){return fmtGameTime(iso);}
}
function todaysGames(){
  var todayKey=etDayKey(new Date().toISOString());
  var liveById={};
  (liveBoard().games||[]).forEach(function(g){liveById[String(g.id)]=g;});
  var out=[], seen={};
  function add(bg,lg){
    var id=String(lg&&lg.id!=null?lg.id:(bg?bg.id:""));
    var state=lg?lg.state:(bg?bg.state:"pre");
    var awayAbbr="",homeAbbr="",awayScore=null,homeScore=null;
    if(bg){awayAbbr=bg.awayAbbr||"";homeAbbr=bg.homeAbbr||"";awayScore=bg.awayScore;homeScore=bg.homeScore;}
    if(lg){(lg.teams||[]).forEach(function(t){if(t.home){homeAbbr=t.abbr||homeAbbr;homeScore=t.score;}else{awayAbbr=t.abbr||awayAbbr;awayScore=t.score;}});}
    if(state==="pre"){awayScore=null;homeScore=null;}
    out.push({id:id,date:(lg&&lg.date)||(bg&&bg.date)||"",state:state,awayAbbr:awayAbbr,homeAbbr:homeAbbr,
      awayScore:awayScore,homeScore:homeScore,detail:(lg&&lg.detail)||(bg&&bg.detail)||""});
    seen[id]=1;
  }
  board().games.forEach(function(g){if(etDayKey(g.date)===todayKey)add(g,liveById[String(g.id)]||null);});
  (liveBoard().games||[]).forEach(function(g){if(!seen[String(g.id)]&&etDayKey(g.date)===todayKey)add(null,g);});
  out.sort(function(a,c){
    var la=a.state==="in"?0:1, lc=c.state==="in"?0:1;
    if(la!==lc)return la-lc;
    return new Date(a.date)-new Date(c.date);
  });
  return out;
}
function discoverProps(){
  var per={},out=[];
  board().props.forEach(function(p){var c=per[p.playerId]||0; if(c>=2)return; per[p.playerId]=c+1; out.push(p);});
  return out.slice(0,30);
}
function viewDiscover(){
  var b=board(), props=discoverProps();
  var h=gamesStrip(b.games);
  var liveN=0;
  b.games.slice(0,20).forEach(function(g){var lg=liveGameFor(g); if(g.state==="in"||(lg&&lg.state==="in"))liveN++;});
  if(b.games.length)h+='<p class="note" style="margin:8px 2px 0">'+(liveN?'<span class="livedot" aria-hidden="true"></span> <b style="color:var(--text)">'+liveN+' game'+(liveN===1?"":"s")+' live</b> — ':"")+'Tap a game above for players to watch.</p>';
  if(props[0]){h+='<h2 class="section-h">Today\u2019s top play</h2>'+propCard(props[0],true,true);}
  h+='<h2 class="section-h">Top hit-rate plays · '+state.league+'</h2>';
  props.slice(1).forEach(function(p){h+=propCard(p,false,true);});
  var tb=teamBoard();
  if(tb.props.length){
    h+='<h2 class="section-h">Team Props · '+state.league+' · '+tb.props.length+'</h2>';
    h+='<p class="note" style="margin:2px 2px 0">Team lines are research lines set from each team\u2019s own last-10 average — same rules as the player props above. Ranked by L10 hit rate'+(tb.props.length>20?', top 20 shown':'')+' · from ESPN team game logs'+(typeof TEAM_AS_OF!=="undefined"?' · baked '+esc(TEAM_AS_OF):'')+'.</p>';
    tb.props.slice(0,20).forEach(function(p){h+=teamPropCard(p);});
  }
  h+='<p class="note" style="margin-top:14px">'+esc(b.poolNote||"")+'</p>';
  return h;
}
var wsCache={key:"",rows:null};
function filteredWs(){
  var ws=state.ws;
  var ck=state.league+"|"+ws.stat+"|"+ws.search+"|"+ws.min+"|"+ws.sort+"|"+(state.boardStamp[state.league]||"")+"|"+board().props.length+"|"+lineRev;
  if(wsCache.key===ck&&wsCache.rows)return wsCache.rows;
  var rows=board().props.filter(function(p){
    var line=lineFor(p); var w=line!==p.line?windowsFor(p.values,line,true):p.over;
    if(ws.stat!=="all"&&p.statKey!==ws.stat)return false;
    if(ws.search&&p.playerName.toLowerCase().indexOf(ws.search.toLowerCase())<0)return false;
    if(pct(w.l10.h,w.l10.n)<ws.min)return false;
    return true;
  });
  function key(p){var line=lineFor(p);var w=line!==p.line?windowsFor(p.values,line,true):p.over;
    if(ws.sort==="l5")return pct(w.l5.h,w.l5.n); if(ws.sort==="avg")return p.avgL10;
    if(ws.sort==="edge")return p.avgL10-line; return pct(w.l10.h,w.l10.n);}
  rows.sort(function(a,b){return key(b)-key(a);});
  wsCache={key:ck,rows:rows};
  return rows;
}
function wsMinLabel(v){return v? v+"%+" : "Any";}
function bindWsMore(scope){
  var more=(scope||document).querySelector("#wsMore"); if(!more)return;
  more.addEventListener("click",function(){
    state.ws.shown=(state.ws.shown||WS_PAGE)+WS_PAGE;
    var res=document.getElementById("wsResults");
    if(res){res.innerHTML=wsResultsHtml(filteredWs()); bindPropCards(res); bindWsMore(res);}
  });
}
function wsResultsHtml(rows){
  var h='<p class="note" style="margin-top:10px">'+rows.length+' prop'+(rows.length===1?"":"s")+' · adjust any line and the bars recompute from the real game log.</p>';
  if(!rows.length)h+='<div class="card" style="padding:18px;margin-top:10px"><p class="note" style="margin:0">No props match those filters. Loosen the minimum hit rate or pick a different stat.</p></div>';
  var lim=Math.min(state.ws.shown||WS_PAGE,rows.length);
  for(var ri=0;ri<lim;ri++){ var p=rows[ri];
    var line=lineFor(p); var w=line!==p.line?windowsFor(p.values,line,true):p.over;
    h+='<article class="card" style="padding:13px 14px;margin-top:10px"><div style="display:flex;gap:10px;align-items:center">'+playerAvatar(p.playerName,p.playerId,state.league,"")
      +'<div style="flex:1;min-width:0"><button type="button" class="namebtn display" data-detail="'+esc(p.playerId)+'">'+esc(p.playerName)+'</button>'
      +'<p class="sub" style="margin:1px 0 0">'+esc(p.teamAbbr)+' · '+esc(p.statLabel)+(p.nextGame?' · '+(p.nextGame.home?"vs ":"@ ")+esc(p.nextGame.oppAbbr):"")+'</p></div>'
      +'<div class="rate display tnum" style="font-size:24px">'+pct(w.l10.h,w.l10.n)+'%<small>L10</small></div></div>'
      +'<div style="margin-top:8px">'+winRow("L5",w.l5,p.values,line,true)+winRow("L10",w.l10,p.values,line,true)+'</div>'
      +'<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap">'+stepper(p)
      +'<span class="sub tnum">Avg '+p.avgL10+' · Edge '+(p.avgL10-line>=0?"+":"")+(Math.round((p.avgL10-line)*10)/10)+'</span>'
      +'</div></article>';
  }
  if(rows.length>lim)h+='<button type="button" class="btn block" id="wsMore" style="margin-top:12px">Show more props \u00b7 '+(rows.length-lim)+' more of '+rows.length+'</button>';
  return h;
}
function viewWorkstation(){
  var b=board(),ws=state.ws;
  var seen={},opts="";
  b.props.forEach(function(p){if(!seen[p.statKey]){seen[p.statKey]=p.statLabel;}});
  Object.keys(seen).forEach(function(k){opts+='<button type="button" data-stat="'+esc(k)+'" aria-pressed="'+(ws.stat===k)+'">'+esc(seen[k])+'</button>';});
  var rows=filteredWs();
  var h='<section class="card" style="padding:14px;margin-top:12px"><label class="fl" for="wsSearch">Search players</label>'
    +'<input class="txt" id="wsSearch" type="search" placeholder="Player name…" value="'+esc(ws.search)+'" />'
    +'<div class="chips" role="group" aria-label="Filter by stat"><button type="button" data-stat="all" aria-pressed="'+(ws.stat==="all")+'">All stats</button>'+opts+'</div>'
    +'<div style="margin-top:12px"><label class="fl" for="wsMin">Min L10 hit rate · <span class="tnum" id="wsMinVal" style="color:var(--text)">'+wsMinLabel(ws.min)+'</span></label>'
    +'<input type="range" id="wsMin" min="0" max="100" step="1" value="'+ws.min+'" />'
    +'<div style="display:flex;justify-content:space-between" aria-hidden="true"><span class="sub">Any</span><span class="sub">50%</span><span class="sub">100%</span></div></div>'
    +'<div style="margin-top:12px"><label class="fl" for="wsSort">Sort by</label><select class="sel" id="wsSort">'
    +'<option value="l10"'+(ws.sort==="l10"?" selected":"")+'>L10 hit rate</option><option value="l5"'+(ws.sort==="l5"?" selected":"")+'>L5 hit rate</option><option value="avg"'+(ws.sort==="avg"?" selected":"")+'>L10 average</option><option value="edge"'+(ws.sort==="edge"?" selected":"")+'>Average vs line</option></select></div></section>'
    +'<div id="wsResults">'+wsResultsHtml(rows)+'</div>';
  return h;
}
var csCache={key:"",rows:null};
function csRows(){
  var cs=state.cs;
  var ck=state.league+"|"+cs.win+"|"+cs.minPct+"|"+(state.boardStamp[state.league]||"")+"|"+board().props.length+"|"+lineRev;
  if(csCache.key===ck&&csCache.rows)return csCache.rows;
  var rows=board().props.map(function(p){
    var line=lineFor(p); var w=line!==p.line?windowsFor(p.values,line,true):p.over;
    var win=w[cs.win]; return {p:p,line:line,w:win,rate:pct(win.h,win.n)};
  }).filter(function(r){return r.rate>=cs.minPct&&r.w.n>=4;})
    .sort(function(a,b){return b.rate-a.rate||b.w.h-a.w.h;}).slice(0,30);
  csCache={key:ck,rows:rows};
  return rows;
}
var lastCs=[];
function viewCheatsheet(){
  var cs=state.cs; var rows=csRows(); lastCs=rows;
  var h='<section class="card" style="padding:14px;margin-top:12px"><div class="fields"><div><label class="fl" for="csWin">Window</label>'
    +'<select class="sel" id="csWin"><option value="l5"'+(cs.win==="l5"?" selected":"")+'>Last 5</option><option value="l10"'+(cs.win==="l10"?" selected":"")+'>Last 10</option><option value="l20"'+(cs.win==="l20"?" selected":"")+'>Last 20</option></select></div>'
    +'</div>'
    +'<div style="margin-top:12px"><label class="fl" for="csMin">Minimum hit rate · <span class="tnum" style="color:var(--text)">'+cs.minPct+'%</span></label>'
    +'<input type="range" id="csMin" min="50" max="100" step="5" value="'+cs.minPct+'" /></div>'
    +'<div style="display:flex;gap:8px;margin-top:8px"><button type="button" class="btn" style="flex:1" id="csDlCsv" '+(rows.length?"":"disabled")+'>↓ Cheatsheet (.csv)</button>'
    +'<button type="button" class="btn" style="flex:1" id="csDlTxt" '+(rows.length?"":"disabled")+'>↓ Cheatsheet (.txt)</button></div></section>';
  if(!rows.length){h+='<div class="card" style="padding:18px;margin-top:10px"><p class="note" style="margin:0">Nothing clears '+cs.minPct+'% over the '+cs.win.toUpperCase()+' window yet. Lower the bar or widen the window.</p></div>';}
  rows.forEach(function(r,i){
    h+='<div class="card rank"><span class="no display tnum">'+(i+1)+'</span>'+playerAvatar(r.p.playerName,r.p.playerId,state.league,"sm")+'<div style="flex:1;min-width:0">'
      +'<button type="button" class="namebtn display" data-detail="'+esc(r.p.playerId)+'">'+esc(r.p.playerName)+'</button>'
      +'<p class="sub" style="margin:1px 0 0">'+esc(r.p.teamAbbr)+' · Over '+fmtLine(r.line)+' '+esc(r.p.statLabel)+(r.p.nextGame?' · '+(r.p.nextGame.home?"vs ":"@ ")+esc(r.p.nextGame.oppAbbr):"")+'</p></div>'
      +'<div class="rate display tnum" style="font-size:23px">'+r.rate+'%<small>'+r.w.h+'/'+r.w.n+' '+cs.win.toUpperCase()+'</small></div></div>';
  });
  return h;
}
/* ---------- live (snapshot of in-progress games at build time) ---------- */
function liveBoard(){return (typeof LIVE!=="undefined"&&LIVE[state.league])?LIVE[state.league]:{games:[]};}
function liveCount(lg){var b=(typeof LIVE!=="undefined"&&LIVE[lg])?LIVE[lg]:null;if(!b)return 0;return b.games.filter(function(g){return g.state==="in";}).length;}
function periodLabel(i){return state.league==="NBA"?(i===3?"Q4":"Q"+(i+1)):state.league==="NHL"?("P"+(i+1)):state.league==="MLB"?String(i+1):("Q"+(i+1));}
function scoreTable(g){
  var maxL=0; g.teams.forEach(function(t){if(t.lines&&t.lines.length>maxL)maxL=t.lines.length;});
  var head="",rows="";
  if(maxL>1){head='<div style="display:flex;gap:0;font-size:11px;font-weight:700;color:var(--dim)"><span style="width:52px"></span>';
    for(var hi=0;hi<maxL;hi++){head+='<span style="width:26px;text-align:right">'+periodLabel(hi)+'</span>';}
    head+='<span style="width:38px;text-align:right">T</span></div>';}
  g.teams.forEach(function(t){
    var cells=(t.lines||[]).map(function(v){return '<span style="width:26px;text-align:right" class="tnum">'+v+'</span>';}).join("");
    for(var k=(t.lines||[]).length;k<maxL;k++){cells+='<span style="width:26px;text-align:right">·</span>';}
    rows+='<div style="display:flex;align-items:center;margin-top:2px"><span style="width:52px;font-weight:800">'+esc(t.abbr)+'</span>'+cells
      +'<span style="width:38px;text-align:right;font-weight:800;font-size:17px" class="tnum">'+(t.score==null?"—":esc(t.score))+'</span></div>';
  });
  return head+rows;
}
function leadersHtml(g,limit){
  if(!g.leaders||!g.leaders.length)return "";
  /* Leader photos: refreshed leaders carry the ESPN athlete id; leaders in
     the baked snapshot don't, so fall back to matching the name against the
     tracked pool. No id either way -> plain text pill, exactly as before. */
  var byName={};
  board().players.forEach(function(pl){if(!byName[pl.name])byName[pl.name]=pl.id;});
  ensurePwProps(state.league);
  var exMap=(typeof PW_PLAYERS!=="undefined"&&PW_PLAYERS[state.league])||{};
  Object.keys(exMap).forEach(function(k){var pl=exMap[k]; if(pl&&pl.name&&!byName[pl.name])byName[pl.name]=pl.id;});
  var items=g.leaders.slice(0,limit||6).map(function(l){
    var url=headshotUrl(state.league,l.id||byName[l.name]);
    var img=url?'<img class="ldimg" src="'+url+'" alt="" loading="lazy" decoding="async" onerror="this.remove()">':"";
    return '<span style="display:inline-block;background:var(--surface2);border:1px solid var(--border);border-radius:999px;padding:3px 9px;font-size:12px;margin:0 5px 5px 0">'+img+'<b>'+esc(l.label)+':</b> '+esc(l.name)+(l.team?' ('+esc(l.team)+')':"")+' · <b class="tnum">'+esc(l.val)+'</b></span>';
  }).join("");
  return '<div style="margin-top:10px">'+items+'</div>';
}
function boxLine(r){
  var s=r.stats, parts=[];
  if(state.league==="NBA")return (s.points||0)+' PTS · '+(s.totalRebounds||0)+' REB · '+(s.assists||0)+' AST · '+(s.minutes||0)+' MIN';
  if(state.league==="NFL"){
    if(s.passingYards!=null)parts.push(s.passingYards+' PASS YDS');
    if(s.passingTouchdowns!=null)parts.push(s.passingTouchdowns+' PASS TD');
    if(s.rushingYards!=null)parts.push(s.rushingYards+' RUSH YDS');
    if(s.rushingAttempts!=null)parts.push(s.rushingAttempts+' CAR');
    if(s.receptions!=null)parts.push(s.receptions+' REC');
    if(s.receivingYards!=null)parts.push(s.receivingYards+' REC YDS');
    return parts.join(' · ');
  }
  if(state.league==="NHL")return (s.goals||0)+' G · '+(s.assists||0)+' A · '+(s.points||0)+' PTS · '+(s.shotsTotal||0)+' SOG';
  if(state.league==="MLB"){
    if(s.atBats!=null)parts.push((s.hits||0)+'-'+s.atBats);
    if(s.runs!=null)parts.push(s.runs+' R');
    if(s.RBIs!=null)parts.push(s.RBIs+' RBI');
    if(s.homeRuns!=null)parts.push(s.homeRuns+' HR');
    if(s.strikeouts!=null&&s.atBats==null)parts.push(s.strikeouts+' K');
    return parts.join(' · ');
  }
  return "";
}
function perfScore(r){
  var s=r.stats;
  if(state.league==="NBA")return s.points||0;
  if(state.league==="NFL")return (s.passingYards||0)+(s.rushingYards||0)+(s.receivingYards||0);
  if(state.league==="NHL")return (s.points||0)*10+(s.goals||0);
  if(state.league==="MLB")return (s.hits||0)*3+(s.RBIs||0)*2+(s.runs||0)+(s.strikeouts&&s.atBats==null?s.strikeouts:0);
  return 0;
}
function teamStatsHtml(g){
  var ts=g.teamStats;
  if(!ts||!ts.rows||!ts.rows.length)return "";
  var rows=ts.rows.map(function(r){
    return '<tr><td>'+esc(r.label)+'</td><td>'+esc(r.home)+'</td><td>'+esc(r.away)+'</td></tr>';
  }).join("");
  return '<div class="teamstats"><h3 class="sub" style="margin:0 0 4px;font-weight:800;letter-spacing:.05em">TEAM STATS</h3>'
    +'<table><thead><tr><th></th><th>'+esc(ts.homeAbbr)+'</th><th>'+esc(ts.awayAbbr)+'</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}
function propWatch(g){
  var b=board(),rows=[],inGame={};
  if(g.box&&g.box.length){
    g.box.forEach(function(r){
      b.props.forEach(function(p){
        if(p.playerId!==r.id)return;
        inGame[r.id]=1;
        var line=lineFor(p); var cur=statValueFor(r.stats,p.statKey);
        if(cur==null)return;
        rows.push({r:r,p:p,line:line,cur:cur,ratio:line?cur/line:0});
      });
    });
  }
  if(!rows.length){
    /* A live/final game always gets its Prop Watch section. Games whose box
       score holds no tracked board players (e.g. DAL @ SA — no DAL or SA
       player is in the tracked pool) used to render nothing at all here,
       which read as Prop Watch being broken for that game. */
    if(g.state!=="in"&&g.state!=="post")return "";
    var eKey=state.league+":"+String(g.id||g.short||"");
    var eOpen=state.pwOpen[eKey]===true;
    var eBodyId="pw-"+state.league+"-"+String(g.id||"x").replace(/[^A-Za-z0-9_-]/g,"");
    var eMsg;
    if(!g.box||!g.box.length){
      eMsg="Player stats for this game haven&rsquo;t loaded yet. Tap <b>Refresh live stats</b> above and the tracked players&rsquo; progress will appear here once ESPN posts the box score.";
    }else if(Object.keys(inGame).length){
      eMsg="Tracked players are in this game, but ESPN hasn&rsquo;t posted their stat lines yet. Tap <b>Refresh live stats</b> above to pull the latest box score.";
    }else{
      var eTeams=(g.teams||[]).map(function(t){return t.abbr;}).filter(Boolean).join(" / ");
      eMsg="No tracked players in this game&rsquo;s box score. Prop Watch follows the board&rsquo;s "+b.players.length+" tracked "+state.league+" players"+(eTeams?(" — none of them appear in the "+esc(eTeams)+" box score"):"")+", so there are no prop lines to follow in this one. Games with tracked players in the box score show their live progress in this section.";
    }
    return '<h3 style="margin:14px 0 0"><button type="button" class="pw-toggle" data-pw-toggle="'+esc(eKey)+'" aria-expanded="'+(eOpen?"true":"false")+'" aria-controls="'+eBodyId+'">'
      +'<span>PROP WATCH · TRACKED PLAYERS IN THIS GAME <span class="pw-count">(0)</span></span>'
      +'<span class="pw-chev" aria-hidden="true">▾</span></button></h3>'
      +'<div class="pw-body" id="'+eBodyId+'"'+(eOpen?"":" hidden")+'><p class="note" style="margin:8px 0 0">'+eMsg+'</p></div>';
  }
  rows.sort(function(a,b2){return b2.ratio-a.ratio;});
  var shown=rows.slice(0,8);
  var key=state.league+":"+String(g.id||g.short||"");
  var open=state.pwOpen[key]===true;
  var bodyId="pw-"+state.league+"-"+String(g.id||"x").replace(/[^A-Za-z0-9_-]/g,"");
  var body="";
  shown.forEach(function(x){
    var over=x.cur>x.line;
    var need=over?0:(Math.floor(x.line-x.cur)+1);
    var pctW=Math.min(100,Math.round(x.ratio*100));
    body+='<div style="margin-top:10px"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center">'
      +'<span style="display:flex;gap:8px;align-items:center;min-width:0">'+playerAvatar(x.r.name,x.r.id,state.league,"sm")+'<button type="button" class="namebtn display" data-detail="'+esc(x.r.id)+'">'+esc(x.r.name)+'</button></span>'
      +'<span class="tnum" style="font-size:13px;font-weight:700;white-space:nowrap">'+x.cur+' / '+fmtLine(x.line)+' '+esc(x.p.statLabel)+'</span></div>'
      +'<div style="height:8px;border-radius:99px;background:var(--miss);margin-top:5px;overflow:hidden"><div style="height:100%;width:'+pctW+'%;background:var(--accent-strong);border-radius:99px"></div></div>'
      +'<p class="sub" style="margin:3px 0 0">'+(over?'<b style="color:var(--accent-ink)">Already over the line ✓</b>':'Needs '+need+' more to clear Over '+fmtLine(x.line))+' · L10 avg '+x.p.avgL10+'</p></div>';
  });
  var h='<h3 style="margin:14px 0 0"><button type="button" class="pw-toggle" data-pw-toggle="'+esc(key)+'" aria-expanded="'+(open?"true":"false")+'" aria-controls="'+bodyId+'">'
    +'<span>PROP WATCH · TRACKED PLAYERS IN THIS GAME <span class="pw-count">('+shown.length+')</span></span>'
    +'<span class="pw-chev" aria-hidden="true">▾</span></button></h3>'
    +'<div class="pw-body" id="'+bodyId+'"'+(open?"":" hidden")+'>'+body+'</div>';
  return h;
}
function liveGameCard(g){
  var status=g.state==="in"?('<span class="livedot" aria-hidden="true"></span> <span data-clock-for="'+esc(g.id)+'">'+esc(g.detail||"In progress")+'</span>'):esc(g.detail||"Final");
  var h='<article class="card prop"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center">'
    +'<h3 class="display" style="margin:0;font-size:19px;font-weight:700">'+esc(g.short)+'</h3>'
    +'<span style="font-size:12px;font-weight:800;color:'+(g.state==="in"?"#dc2626":"var(--dim)")+'">'+status+'</span></div>'
    +'<div style="margin-top:8px">'+scoreTable(g)+'</div>';
  if(g.box&&g.box.length){
    var tops=g.box.slice().sort(function(a,b2){return perfScore(b2)-perfScore(a);}).slice(0,4);
    h+='<h3 class="sub" style="margin:14px 0 0;font-weight:800;letter-spacing:.05em">TOP PERFORMERS SO FAR</h3>'
      +tops.map(function(r){return '<div style="display:flex;gap:8px;align-items:center;margin-top:6px">'+playerAvatar(r.name,r.id,state.league,"sm")+'<p style="margin:0;font-size:14px"><b>'+esc(r.name)+'</b> <span class="sub">'+esc(r.team)+'</span> · <span class="tnum">'+boxLine(r)+'</span></p></div>';}).join("");
  }
  h+=leadersHtml(g,6);
  h+=teamStatsHtml(g);
  h+=propWatch(g);
  return h+'</article>';
}
/* ---------- live game popup (opened from a live game on Discover) ---------- */
function openLiveGame(gameId){
  var lg=null;
  (liveBoard().games||[]).forEach(function(g){if(String(g.id)===String(gameId))lg=g;});
  if(!lg){toast("That game\u2019s live stats aren\u2019t loaded yet \u2014 tap Refresh and try again");return;}
  /* The popup exists to show Prop Watch, so open that section expanded —
     but remember the game's prior Prop Watch state and restore it on
     close, so the Live tab keeps its own pre-collapsed default and any
     manual open/close choices made there. */
  if(state.livePwKey!=null)restoreLivePw();
  var key=state.league+":"+String(lg.id||lg.short||"");
  state.livePwKey=key;
  state.livePwHad=Object.prototype.hasOwnProperty.call(state.pwOpen,key);
  state.livePwPrev=state.pwOpen[key];
  state.pwOpen[key]=true;
  state.liveGameId=String(gameId);
  renderLivePopup();
}
function restoreLivePw(){
  if(state.livePwKey==null)return;
  if(state.livePwHad)state.pwOpen[state.livePwKey]=state.livePwPrev;
  else delete state.pwOpen[state.livePwKey];
  state.livePwKey=null; state.livePwHad=false; state.livePwPrev=null;
}
function closeLivePopup(){restoreLivePw(); state.liveGameId=null; renderLivePopup();}
function bindLivePopupBody(root){
  root.querySelectorAll("[data-pw-toggle]").forEach(function(btn){
    btn.addEventListener("click",function(){
      var key=btn.getAttribute("data-pw-toggle");
      var open=state.pwOpen[key]===true;
      state.pwOpen[key]=!open;
      btn.setAttribute("aria-expanded",open?"false":"true");
      var body=document.getElementById(btn.getAttribute("aria-controls"));
      if(body)body.hidden=open;
    });
  });
  root.querySelectorAll("[data-detail]").forEach(function(btn){
    btn.addEventListener("click",function(){openDetail(btn.getAttribute("data-detail"));});
  });
}
/* ---------- Players to Watch popup (opened from the Discover games strip) ----------
   Every strip card — upcoming, live or final — routes here (one consistent
   popup for the whole strip, including live games). It reuses the Prop Watch
   tab's per-game data: pwSlateGames() for the game object and pwTeamSection() /
   pwTop5() for both teams' top 5 players and their prop rows. Live games show
   the live score/clock in the header instead of opening the Live-section popup;
   that popup still serves the Live tab. */
function findWatchGame(gameId){
  var games=pwSlateGames();
  for(var i=0;i<games.length;i++){if(String(games[i].id)===String(gameId))return games[i];}
  var lb=liveBoard();
  for(var j=0;j<(lb.games||[]).length;j++){if(String(lb.games[j].id)===String(gameId))return lb.games[j];}
  var b=board();
  for(var k=0;k<b.games.length;k++){
    var bg=b.games[k];
    if(String(bg.id)===String(gameId))return {id:bg.id,date:bg.date,short:bg.shortName||((bg.awayAbbr||"")+" @ "+(bg.homeAbbr||"")),state:bg.state,detail:bg.detail||"",teams:[{abbr:bg.awayAbbr,home:false,score:bg.awayScore,lines:[],record:""},{abbr:bg.homeAbbr,home:true,score:bg.homeScore,lines:[],record:""}],leaders:[],box:[],teamStats:null,_board:bg};
  }
  var tg=todaysGames();
  for(var m=0;m<tg.length;m++){
    var x=tg[m];
    if(String(x.id)===String(gameId))return {id:x.id,date:x.date,short:(x.awayAbbr+" @ "+x.homeAbbr),state:x.state,detail:x.detail||"",teams:[{abbr:x.awayAbbr,home:false,score:x.awayScore,lines:[],record:""},{abbr:x.homeAbbr,home:true,score:x.homeScore,lines:[],record:""}],leaders:[],box:[],teamStats:null};
  }
  return null;
}
function openWatchGame(gameId){state.watchGameId=String(gameId);renderWatchPopup();}
function closeWatchPopup(){state.watchGameId=null;renderWatchPopup();}
function bindWatchPopupBody(root){
  root.querySelectorAll("[data-detail]").forEach(function(btn){
    btn.addEventListener("click",function(){openDetail(btn.getAttribute("data-detail"));});
  });
}
function renderWatchPopup(){
  var root=document.getElementById("watchModalRoot");
  if(!root)return;
  if(!state.watchGameId){root.innerHTML="";if(!state.detail&&!state.liveGameId)document.body.style.overflow="";return;}
  var g=findWatchGame(state.watchGameId);
  if(!g){
    root.innerHTML="";state.watchGameId=null;if(!state.detail&&!state.liveGameId)document.body.style.overflow="";
    toast("That game isn\u2019t on the slate anymore \u2014 tap Refresh and try again");
    return;
  }
  var teamAbbrs=pwGameTeams(g);
  var matchup=g.short||((teamAbbrs[0]||"")+" @ "+(teamAbbrs[1]||""));
  var statusHtml;
  if(g.state==="in"){
    statusHtml='<span class="livedot" aria-hidden="true"></span><span data-clock-for="'+esc(g.id)+'">LIVE'+(g.detail?" \u00B7 "+esc(g.detail):"")+'</span>';
  }else if(g.state==="post"){
    statusHtml='<span>FINAL</span>';
  }else{
    statusHtml='<span>'+esc(fmtEtTime(g.date)||fmtGameTime(g.date))+' \u00B7 Today</span>';
  }
  var scoreHtml="";
  if(g.state!=="pre"&&g.teams&&g.teams.length&&g.teams.some(function(tm){return tm.score!=null;})){
    scoreHtml='<div style="margin-top:8px">'+scoreTable(g)+'</div>';
  }
  var wOdds=g.odds||(g._board?(g._board.odds||null):null);
  var wOddsHtml=(g.state==="pre"&&wOdds)?oddsLineHtml(wOdds,teamAbbrs[0],teamAbbrs[1])+oddsNoteHtml(wOdds.provider):"";
  var boxById={};
  (g.box||[]).forEach(function(r){boxById[r.id]=r;});
  var sections="", totalPlayers=0;
  teamAbbrs.forEach(function(team){
    if(!team)return;
    totalPlayers+=pwTop5(team).length;
    sections+=pwTeamSection(g,team,boxById);
  });
  var bodyHtml;
  if(!totalPlayers){
    bodyHtml='<p class="note" style="margin:10px 0 0">No players-to-watch data for this game yet \u2014 neither team has players in the board\u2019s tracked pool or in recent ESPN box scores, so there are no prop lines to show for this one. Games with coverage are under the Prop Watch tab, and tapping Refresh at the top pulls the latest ESPN data when you\u2019re online.</p>';
  }else{
    bodyHtml=sections;
  }
  var footNote=g.state==="pre"
    ? "Lines are research lines set from each player\u2019s recent average, with L5/L10 hit rates. Tap a player\u2019s name for their full game log."
    : "In-game totals so far against each player\u2019s research line, with progress bars and already-over markers. Tap a player\u2019s name for their full game log.";
  if(g.state!=="pre"&&!(g.box&&g.box.length)){
    footNote="Player stats for this game haven\u2019t loaded yet, so the rows below show lines and hit rates \u2014 tap Refresh at the top and in-game progress will appear once ESPN posts the box score. "+footNote;
  }
  root.innerHTML='<div class="modalwrap watch-modalwrap" role="dialog" aria-modal="true" aria-label="Players to Watch \u2014 '+esc(matchup)+'">'
    +'<button type="button" class="modalbg" data-watch-close aria-label="Close players to watch"></button>'
    +'<div class="modal"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px">'
    +'<div style="min-width:0"><h2 class="display" style="font-size:23px;font-weight:700;line-height:1.1">Players to Watch</h2>'
    +'<p class="sub" style="margin:3px 0 0;font-weight:800;letter-spacing:.04em;display:flex;align-items:center;gap:6px;flex-wrap:wrap"><span>'+esc(matchup)+' \u00B7 '+esc(state.league)+'</span>'+statusHtml+'</p></div>'
    +'<button type="button" class="iconbtn" data-watch-close aria-label="Close">\u00D7</button></div>'
    +'<article class="card prop" style="padding:14px">'
    +'<div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><h3 class="display" style="margin:0;font-size:19px;font-weight:700">'+esc(matchup)+'</h3>'
    +'<span style="font-size:12px;font-weight:800;color:'+(g.state==="in"?"#dc2626":"var(--dim)")+';display:flex;align-items:center;gap:6px;white-space:nowrap">'+statusHtml+'</span></div>'
    +scoreHtml+wOddsHtml+bodyHtml
    +'<p class="note" style="margin-top:12px">'+footNote+'</p>'
    +'</article></div></div>';
  document.body.style.overflow="hidden";
  root.querySelectorAll("[data-watch-close]").forEach(function(btn){btn.addEventListener("click",closeWatchPopup);});
  bindWatchPopupBody(root);
}
function renderLivePopup(){
  var root=document.getElementById("liveModalRoot");
  if(!root)return;
  if(!state.liveGameId){root.innerHTML="";if(!state.detail&&!state.watchGameId)document.body.style.overflow="";return;}
  var g=null;
  (liveBoard().games||[]).forEach(function(x){if(String(x.id)===String(state.liveGameId))g=x;});
  if(!g){root.innerHTML="";restoreLivePw();state.liveGameId=null;if(!state.detail&&!state.watchGameId)document.body.style.overflow="";return;}
  root.innerHTML='<div class="modalwrap live-modalwrap" role="dialog" aria-modal="true" aria-label="Live game \u2014 '+esc(g.short)+'">'
    +'<button type="button" class="modalbg" data-live-close aria-label="Close live game"></button>'
    +'<div class="modal"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px">'
    +'<p class="sub" style="margin:0;font-weight:800;letter-spacing:.06em;display:flex;align-items:center;gap:7px"><span class="livedot" aria-hidden="true"></span><span>LIVE GAME \u00B7 '+esc(state.league)+'</span></p>'
    +'<button type="button" class="iconbtn" data-live-close aria-label="Close">\u00D7</button></div>'
    +liveGameCard(g)
    +'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px"><button type="button" class="btn primary refresh-btn" data-refresh-live '+(state.refreshing?"disabled":"")+'>'
    +'<span class="refresh-icon" aria-hidden="true">\u21BB</span><span>'+(state.refreshing?"Refreshing\u2026":"Refresh live stats")+'</span></button>'
    +'<span class="sub">Scores &amp; player stats as of <b style="color:var(--text)">'+esc(typeof LIVE_AS_OF!=="undefined"?LIVE_AS_OF:"")+'</b> (ESPN).</span></div>'
    +'<p class="note" style="margin-top:10px">The same live view as the Live tab \u2014 score by period, top performers, game leaders, team stats and Prop Watch for the tracked players in this game. Tap a player in Prop Watch to open their game log.</p>'
    +'</div></div>';
  document.body.style.overflow="hidden";
  root.querySelectorAll("[data-live-close]").forEach(function(btn){btn.addEventListener("click",closeLivePopup);});
  root.querySelectorAll("[data-refresh-live]").forEach(function(btn){btn.addEventListener("click",function(){refreshLiveScores(true);});});
  bindLivePopupBody(root);
}
function viewLive(){
  var lb=liveBoard(), games=lb.games||[];
  var live=games.filter(function(g){return g.state==="in";});
  var finals=games.filter(function(g){return g.state==="post";});
  var upcoming=games.filter(function(g){return g.state==="pre";});
  var h='<section class="card" style="padding:16px;margin-top:12px"><div style="display:flex;align-items:center;gap:8px">'
    +(live.length?'<span class="livedot" aria-hidden="true"></span>':"")
    +'<h2 class="display" style="font-size:21px">'+(live.length?("Live now · "+live.length+" game"+(live.length===1?"":"s")+" in progress"):"Tonight\u2019s slate")+' · '+state.league+'</h2></div>'
    +'<p class="sub" style="margin:5px 0 0">Scores &amp; player stats as of <b style="color:var(--text)">'+esc(typeof LIVE_AS_OF!=="undefined"?LIVE_AS_OF:"")+'</b> (ESPN).</p>'
    +'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px"><button type="button" class="btn primary refresh-btn" data-refresh-live '+(state.refreshing?"disabled":"")+'><span class="refresh-icon" aria-hidden="true">↻</span><span>'+(state.refreshing?"Refreshing…":"Refresh live stats")+'</span></button><span class="sub">Pulls the latest ESPN scores, box scores and team stats for '+state.league+' when you&rsquo;re online. While games are in progress this tab re-checks on its own about every minute.</span></div></section>';
  if(!games.length){
    h+='<div class="card" style="padding:18px;margin-top:10px"><p class="note" style="margin:0">No '+state.league+' games on the slate captured for this section.</p></div>';
  }
  live.forEach(function(g){h+=liveGameCard(g);});
  if(finals.length){
    h+='<h2 class="section-h">Final</h2>';
    finals.forEach(function(g){
      h+='<article class="card prop"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><h3 class="display" style="margin:0;font-size:18px;font-weight:700">'+esc(g.short)+'</h3><span class="sub" style="font-weight:800">FINAL</span></div>'
        +'<div style="margin-top:6px">'+scoreTable(g)+'</div>'+leadersHtml(g,4)+teamStatsHtml(g)+propWatch(g)+'</article>';
    });
  }
  if(upcoming.length){
    h+='<h2 class="section-h">'+(live.length||finals.length?"Still to come":"Coming up")+'</h2>';
    upcoming.forEach(function(g){
      var oa="",oh="";
      (g.teams||[]).forEach(function(t){if(t.home)oh=t.abbr;else oa=t.abbr;});
      h+='<article class="card" style="padding:13px 14px;margin-top:10px"><div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline"><b class="display" style="font-size:16px">'+esc(g.short)+'</b><span class="sub" style="font-weight:700;white-space:nowrap">'+esc(fmtGameTime(g.date))+'</span></div>'
        +'<p class="sub" style="margin:2px 0 0">'+g.teams.map(function(t){return esc(t.abbr)+(t.record?' '+esc(t.record):"");}).join(" · ")+'</p>'
        +(g.odds?oddsLineHtml(g.odds,oa,oh)+oddsNoteHtml(g.odds.provider):"")
        +leadersHtml(g,4)+'</article>';
    });
  }
  h+='<p class="note" style="margin-top:14px">Tap <b>Refresh live stats</b> above (or Refresh at the top of the page) to pull the latest ESPN data for this league when you&rsquo;re online: scores, period lines, game leaders, full box-score lines, team stats and Prop Watch all update from ESPN&rsquo;s game summaries, and the props board rebuilds from fresh game logs. While games are in progress this tab also re-checks on its own about every 20 seconds, and the game clock ticks down every second between checks. If ESPN can&rsquo;t be reached, the last stats you see stay in place. Prop Watch compares each tracked player&rsquo;s in-game total so far with the same research line used across this board.</p>';
  return h;
}

/* ---------- Prop Watch tab: every game, top 5 per team ---------- */
function pwSlateGames(){
  var b=board(), lb=liveBoard(), liveById={};
  (lb.games||[]).forEach(function(g){liveById[String(g.id)]=g;});
  var out=[], seen={};
  b.games.forEach(function(g){
    var lg=liveById[String(g.id)];
    if(lg)out.push(lg);
    else out.push({id:g.id,date:g.date,short:g.shortName||((g.awayAbbr||"")+" @ "+(g.homeAbbr||"")),state:g.state,detail:g.detail||"",teams:[{abbr:g.awayAbbr,home:false,score:g.awayScore,lines:[],record:""},{abbr:g.homeAbbr,home:true,score:g.homeScore,lines:[],record:""}],leaders:[],box:[],teamStats:null,_board:g});
    seen[String(g.id)]=1;
  });
  if(b.games.length){
    var ds=b.games.map(function(g){return new Date(g.date).getTime();}).filter(function(t){return !isNaN(t);});
    if(ds.length){
      var lo=Math.min.apply(null,ds)-36*3600*1000, hi=Math.max.apply(null,ds)+36*3600*1000;
      (lb.games||[]).forEach(function(g){
        if(seen[String(g.id)])return;
        var t=new Date(g.date).getTime();
        if(isNaN(t)||t<lo||t>hi)return;
        out.push(g); seen[String(g.id)]=1;
      });
    }
  }
  out.sort(function(a,c){return new Date(a.date)-new Date(c.date);});
  return out;
}
function pwGameTeams(g){
  if(g._board)return [g._board.awayAbbr,g._board.homeAbbr];
  var home="",away="";
  (g.teams||[]).forEach(function(t){if(t.home)home=t.abbr;else away=t.abbr;});
  return [away,home];
}
function pwTop5(team){
  var lg=state.league;
  ensurePwProps(lg);
  var ids=(typeof PW!=="undefined"&&PW[lg]&&PW[lg].top5)?(PW[lg].top5[team]||[]):[];
  var order={}; (PW_STAT_SETS[lg]||[]).forEach(function(s,i){order[s[0]]=i;});
  var out=[];
  ids.forEach(function(id){
    var pl=findPlayer(id); if(!pl)return;
    var props=findProps(id).slice().sort(function(a,c){return (order[a.statKey]==null?99:order[a.statKey])-(order[c.statKey]==null?99:order[c.statKey]);}).slice(0,3);
    out.push({player:pl,props:props});
  });
  if(out.length<5){
    var have={}; out.forEach(function(x){have[x.player.id]=1;});
    var rest=[];
    board().players.forEach(function(pl){if(pl.teamAbbr===team&&!have[pl.id])rest.push(pl);});
    var exMap=PW_PLAYERS[lg]||{};
    Object.keys(exMap).forEach(function(k){var pl=exMap[k]; if(pl.teamAbbr===team&&!have[pl.id])rest.push(pl);});
    rest.forEach(function(pl){
      if(out.length>=5)return;
      var props=findProps(pl.id).slice().sort(function(a,c){return (order[a.statKey]==null?99:order[a.statKey])-(order[c.statKey]==null?99:order[c.statKey]);}).slice(0,3);
      out.push({player:pl,props:props});
    });
  }
  return out.slice(0,5);
}
function pwPropRowLive(p,boxRow,final){
  var line=lineFor(p), cur=statValueFor(boxRow.stats,p.statKey);
  if(cur==null)return "";
  var over=cur>line, need=over?0:(Math.floor(line-cur)+1), pctW=Math.min(100,Math.round((line?cur/line:0)*100));
  var sub=over
    ? '<b style="color:var(--accent-ink)">'+(final?"Finished over the line ✓":"Already over the line ✓")+'</b> · L10 avg '+p.avgL10
    : (final?("Finished at "+cur+" — needed "+need+" more to clear Over "+fmtLine(line)):("Needs "+need+" more to clear Over "+fmtLine(line)))+' · L10 avg '+p.avgL10;
  return '<div class="pw-prop"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center">'
    +'<span class="tnum" style="font-size:13px;font-weight:700">'+cur+' / '+fmtLine(line)+' '+esc(p.statLabel)+'</span>'
    +'</div>'
    +'<div style="height:8px;border-radius:99px;background:var(--miss);margin-top:5px;overflow:hidden"><div style="height:100%;width:'+pctW+'%;background:var(--accent-strong);border-radius:99px"></div></div>'
    +'<p class="sub" style="margin:3px 0 0">'+sub+'</p></div>';
}
function pwPropRowPre(p){
  var line=lineFor(p);
  var w=line!==p.line?windowsFor(p.values,line,true):p.over;
  return '<div class="pw-prop"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center">'
    +'<span style="font-size:13px"><b>Over '+fmtLine(line)+'</b> <span style="color:var(--dim)">'+esc(p.statLabel)+'</span></span>'
    +'</div>'
    +'<div style="height:6px;border-radius:99px;background:var(--miss);margin-top:5px;overflow:hidden"><div style="height:100%;width:'+pct(w.l10.h,w.l10.n)+'%;background:var(--accent-strong);border-radius:99px"></div></div>'
    +'<p class="sub tnum" style="margin:3px 0 0">L5 '+w.l5.h+'/'+w.l5.n+' · L10 '+w.l10.h+'/'+w.l10.n+' · '+pct(w.l10.h,w.l10.n)+'% hit rate · Avg L10 '+p.avgL10+'</p></div>';
}
function pwTeamSection(g,team,boxById){
  var tops=pwTop5(team);
  var h='<h4 class="pw-team-h">'+esc(team)+' · TOP 5</h4>';
  if(!tops.length){
    return h+'<p class="note" style="margin:6px 0 0">No ESPN player data for '+esc(team)+' yet — neither the board\u2019s tracked pool nor recent box scores have players for this team, so there are no prop lines to watch in this one yet.</p>';
  }
  var hasBox=!!(g.box&&g.box.length);
  tops.forEach(function(x){
    var pl=x.player, boxRow=boxById[pl.id]||null;
    h+='<div class="pw-player"><div style="display:flex;gap:8px;align-items:center">'
      +playerAvatar(pl.name,pl.id,state.league,"sm")
      +'<div style="flex:1;min-width:0;display:flex;justify-content:space-between;gap:8px;align-items:baseline"><button type="button" class="namebtn display" data-detail="'+esc(pl.id)+'">'+esc(pl.name)+'</button>'
      +'<span class="sub" style="white-space:nowrap">'+esc(pl.teamAbbr)+(pl.position?' · '+esc(pl.position):'')+'</span></div></div>';
    if(boxRow)h+='<p class="sub tnum" style="margin:2px 0 0">'+esc(boxLine(boxRow))+'</p>';
    if(!x.props.length){
      h+='<p class="note" style="margin:4px 0 0">Not enough recent games in ESPN\u2019s log to set research lines for this player yet.</p>';
    }else if(g.state==="pre"||!hasBox){
      x.props.forEach(function(p){h+=pwPropRowPre(p);});
      if(g.state!=="pre"&&!boxRow)h+='<p class="note" style="margin:4px 0 0">No stats posted for this player in this game yet — showing their lines and hit rates until the box score has them.</p>';
    }else if(!boxRow){
      h+='<p class="note" style="margin:4px 0 0">No stats posted for this player in this game yet.</p>';
    }else{
      x.props.forEach(function(p){h+=pwPropRowLive(p,boxRow,g.state==="post");});
    }
    h+='</div>';
  });
  return h;
}
function viewPropWatch(){
  var games=pwSlateGames();
  var liveN=games.filter(function(g){return g.state==="in";}).length;
  var finN=games.filter(function(g){return g.state==="post";}).length;
  var h='<section class="card" style="padding:16px;margin-top:12px"><div style="display:flex;align-items:center;gap:8px">'
    +(liveN?'<span class="livedot" aria-hidden="true"></span>':"")
    +'<h2 class="display" style="font-size:21px">Prop Watch · '+state.league+'</h2></div>'
    +'<p class="sub" style="margin:5px 0 0">The top 5 players from <b style="color:var(--text)">each team</b> in <b style="color:var(--text)">every game</b> on the slate — picked from recent ESPN box-score production (top 5s as of '+esc(typeof PW_AS_OF!=="undefined"?PW_AS_OF:"")+'; lines and hit rates refresh with the board). Live and final games show in-game progress toward each player\u2019s research line; upcoming games show the line with L5/L10 hit rates. Tap a player\u2019s name for their full game log.</p>'
    +'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px"><button type="button" class="btn primary refresh-btn" data-refresh-live '+(state.refreshing?"disabled":"")+'><span class="refresh-icon" aria-hidden="true">↻</span><span>'+(state.refreshing?"Refreshing…":"Refresh live stats")+'</span></button><span class="sub">'+games.length+' game'+(games.length===1?"":"s")+' · '+liveN+' live · '+finN+' final · '+(games.length-liveN-finN)+' upcoming</span></div></section>';
  var pwProv=firstOddsProvider(games);
  if(pwProv)h+=oddsNoteHtml(pwProv);
  if(!games.length){
    return h+'<div class="card" style="padding:18px;margin-top:10px"><p class="note" style="margin:0">No '+state.league+' games on the current slate, so there is nothing to watch yet. Tap Refresh when you\u2019re online to pull the latest ESPN slate.</p></div>';
  }
  games.forEach(function(g){
    var status, statusColor;
    if(g.state==="in"){status='<span class="livedot" aria-hidden="true"></span> <span data-clock-for="'+esc(g.id)+'">'+esc(g.detail||"In progress")+'</span>'; statusColor="#dc2626";}
    else if(g.state==="post"){status="FINAL"; statusColor="var(--dim)";}
    else{status=esc(fmtGameTime(g.date)); statusColor="var(--dim)";}
    h+='<article class="card prop"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center">'
      +'<h3 class="display" style="margin:0;font-size:19px;font-weight:700">'+esc(g.short)+'</h3>'
      +'<span style="font-size:12px;font-weight:800;color:'+statusColor+';display:flex;align-items:center;gap:6px;white-space:nowrap">'+status+'</span></div>';
    if(g.state!=="pre"&&g.teams&&g.teams.length&&g.teams.some(function(t){return t.score!=null;})){
      h+='<div style="margin-top:8px">'+scoreTable(g)+'</div>';
    }
    if(g.state==="pre"&&g.odds){var pwt=pwGameTeams(g); h+=oddsLineHtml(g.odds,pwt[0],pwt[1]);}
    var boxById={};
    (g.box||[]).forEach(function(r){boxById[r.id]=r;});
    if(g.state!=="pre"&&!(g.box&&g.box.length)){
      h+='<p class="note" style="margin:10px 0 0">Player stats for this game haven\u2019t loaded yet — tap <b>Refresh live stats</b> above and in-game progress will replace the lines and hit rates below once ESPN posts the box score.</p>';
    }
    pwGameTeams(g).forEach(function(team){if(team)h+=pwTeamSection(g,team,boxById);});
    h+='</article>';
  });
  h+='<p class="note" style="margin-top:14px">Top 5s are picked from each team\u2019s recent ESPN box scores (production over their last several games) and cover every team on the slate — including teams with few or no players in the board\u2019s tracked pool. Lines are the same research lines used across this board, set from each player\u2019s recent-game average.</p>';
  return h;
}

/* ---------- Game Logs: top 25 per stat category ---------- */
var GL_ORDER={NBA:["points","totalRebounds","assists","pra","pr","pa","threePointersMade","steals","blocks"],NFL:["passingYards","passRushYards","passingTouchdowns","rushingYards","rushingAttempts","receivingYards","receptions"],NHL:["points","goals","assists","shotsTotal"],MLB:["hits","totalBases","runs","RBIs","homeRuns","stolenBases","pitcherStrikeouts"]};
function glCats(){
  var seen={},cats=[];
  board().props.forEach(function(p){if(!seen[p.statKey]){seen[p.statKey]=1;cats.push({key:p.statKey,label:p.statLabel});}});
  var ord=GL_ORDER[state.league]||[];
  cats.sort(function(a,c){var ia=ord.indexOf(a.key),ic=ord.indexOf(c.key);return (ia<0?99:ia)-(ic<0?99:ic);});
  return cats;
}
function viewGameLogs(){
  var cats=glCats();
  if(!cats.length)return '<div class="card" style="padding:18px;margin-top:12px"><p class="note" style="margin:0">No tracked stats for '+state.league+' in this snapshot.</p></div>';
  var cur=state.gl.stat, ok=false;
  cats.forEach(function(c){if(c.key===cur)ok=true;});
  if(!ok){cur=cats[0].key; state.gl.stat=cur;}
  var catLabel=""; cats.forEach(function(c){if(c.key===cur)catLabel=c.label;});
  var all=board().props.filter(function(p){return p.statKey===cur;});
  var rows=all.slice().sort(function(a,c){
    if(c.avgL10!==a.avgL10)return c.avgL10-a.avgL10;
    if(c.avgAll!==a.avgAll)return c.avgAll-a.avgAll;
    return c.values.length-a.values.length;
  }).slice(0,25);
  var chips=cats.map(function(c){return '<button type="button" data-glstat="'+esc(c.key)+'" aria-pressed="'+(c.key===cur)+'">'+esc(c.label)+'</button>';}).join("");
  var h='<section class="card" style="padding:14px 16px;margin-top:12px"><h2 class="display" style="font-size:21px">Game Logs · Top 25 — '+esc(catLabel)+'</h2>'
    +'<p class="sub" style="margin:5px 0 0">Ranked by <b style="color:var(--text)">last-10-game average</b> among the '+all.length+' players tracked for '+esc(catLabel)+' on this board. Tap any player to open their full game log — game-by-game chart vs the line, home/away splits, line tools and Last 5 / 10 / 25 / 50 game views.</p>'
    +'<div class="chips" role="group" aria-label="Choose stat category" style="margin-top:10px">'+chips+'</div></section>';
  rows.forEach(function(p,i){
    var l5=p.values.slice(0,5).join(" · ");
    h+='<button type="button" class="card gl-row" data-glog="'+esc(p.playerId)+'" data-gstat="'+esc(p.statKey)+'" aria-label="Open game log for '+esc(p.playerName)+', '+esc(p.statLabel)+'">'
      +'<span class="no display">'+(i+1)+'</span>'
      +playerAvatar(p.playerName,p.playerId,state.league,"sm")
      +'<span style="flex:1;min-width:0"><span style="display:block;font-weight:800;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(p.playerName)+'</span>'
      +'<span class="sub" style="display:block;font-size:11px">'+esc(p.teamAbbr)+(p.position?' · '+esc(p.position):'')+' · Line '+fmtLine(lineFor(p))+' '+esc(p.statLabel)+'</span>'
      +'<span class="sub tnum" style="display:block;font-size:11px">L5: '+esc(l5)+'</span></span>'
      +'<span style="text-align:right;flex-shrink:0"><span class="gl-avg tnum display">'+p.avgL10+'</span><span class="sub" style="display:block;font-size:9.5px;font-weight:800;letter-spacing:.05em">L10 AVG · '+p.over.l10.n+' GP</span></span>'
      +'</button>';
  });
  if(!rows.length)h+='<p class="note" style="margin-top:10px">No players tracked for this stat yet.</p>';
  else if(all.length<25)h+='<p class="note" style="margin-top:10px">Only '+all.length+' player'+(all.length===1?"":"s")+' are tracked for '+esc(catLabel)+' on this board — showing all of them.</p>';
  return h;
}

/* ---------- injury report (NBA only, live from ESPN) ---------- */
function injNorm(s){return String(s||"").toLowerCase().replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ").trim();}
function injTrackedMap(){
  var m={}; var b=DATA.NBA;
  if(b&&b.players)b.players.forEach(function(pl){m[injNorm(pl.name)]=pl.id;});
  return m;
}
function injRetLabel(iso){
  if(!iso)return "";
  var d=new Date(iso+"T12:00:00"); if(isNaN(d.getTime()))return "";
  try{return new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric"}).format(d);}catch(e){return iso;}
}
function parseInjuries(json){
  var rank=function(s){s=String(s||"").toLowerCase(); if(s.indexOf("out")===0)return 0; if(s.indexOf("doubt")===0)return 1; if(s.indexOf("question")===0)return 2; if(s.indexOf("day")===0)return 3; return 4;};
  var teams=[];
  (json.injuries||[]).forEach(function(t){
    var abbr="", list=[];
    (t.injuries||[]).forEach(function(x){
      var a=x.athlete||{}, d=x.details||{};
      if(!abbr&&a.team&&a.team.abbreviation)abbr=a.team.abbreviation;
      var bits=[];
      if(d.side)bits.push(d.side);
      if(d.type)bits.push(d.type);
      list.push({name:a.displayName||"",pos:(a.position&&a.position.abbreviation)||"",status:x.status||"",detail:bits.join(" "),ret:d.returnDate||"",comment:x.shortComment||""});
    });
    list.sort(function(p,q){var r=rank(p.status)-rank(q.status); return r!==0?r:(p.name<q.name?-1:p.name>q.name?1:0);});
    if(list.length)teams.push({name:t.displayName||"",abbr:abbr,list:list});
  });
  teams.sort(function(a,b){return a.name<b.name?-1:a.name>b.name?1:0;});
  return teams;
}
function fetchInjuries(manual){
  if(state.inj.status==="loading")return;
  state.inj.status="loading";
  if(state.tab==="injuries"&&state.league==="NBA")render();
  fetchJson("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries").then(function(json){
    state.inj.teams=parseInjuries(json);
    state.inj.asOf=json.timestamp?refreshTimeLabel(new Date(json.timestamp)):"";
    state.inj.status="ok";
    if(manual)toast("Injury report updated");
    if(state.tab==="injuries"&&state.league==="NBA")render();
  }).catch(function(){
    state.inj.status=state.inj.teams?"ok":"error";
    if(manual)toast("Couldn\u2019t reach ESPN for the injury report");
    if(state.tab==="injuries"&&state.league==="NBA")render();
  });
}
function ensureInjuries(){if(state.inj.status==="idle")fetchInjuries(false);}
function viewInjuries(){
  var inj=state.inj;
  var h='<section class="card" style="padding:8px 10px;margin-top:12px"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap"><h2 class="display" style="font-size:15px">NBA Injury Report</h2>'
    +'<button type="button" class="btn small" data-inj-refresh'+(inj.status==="loading"?" disabled":"")+'>'+(inj.status==="loading"?"Loading\u2026":"\u21bb Refresh injuries")+'</button></div>'
    +'<p class="sub" style="margin:5px 0 0">Official statuses from ESPN\u2019s NBA injury report'+(inj.asOf?' \u00b7 as of <b style="color:var(--text)">'+esc(inj.asOf)+'</b>':"")+'. Players tracked on this props board are tagged <span class="badge inj-tracked" style="margin-left:0">ON BOARD</span>.</p>'
    +'<label class="fl" style="margin-top:6px">Search player or team<input class="txt" type="search" id="injSearch" placeholder="e.g. Doncic or Lakers" value="'+esc(inj.q)+'"></label></section>';
  if(inj.status==="loading"&&!inj.teams){
    h+='<div class="card" style="padding:18px;margin-top:10px"><p class="note" style="margin:0">Pulling the latest NBA injury report from ESPN\u2026</p></div>';
    return h;
  }
  if(!inj.teams){
    h+='<div class="card" style="padding:18px;margin-top:10px"><p class="note" style="margin:0">'+(inj.status==="error"?'Couldn\u2019t reach ESPN for the injury report. It loads live from ESPN, so check your connection and tap <b>Refresh injuries</b> to try again.':'Tap <b>Refresh injuries</b> to pull the latest report from ESPN.')+'</p></div>';
    return h;
  }
  var tracked=injTrackedMap();
  var q=injNorm(inj.q);
  var outN=0, otherN=0, shown=0;
  inj.teams.forEach(function(t){t.list.forEach(function(x){if(String(x.status).toLowerCase().indexOf("out")===0)outN++; else otherN++;});});
  var bodyHtml="";
  inj.teams.forEach(function(t){
    var rows=t.list.filter(function(x){return !q||injNorm(x.name).indexOf(q)>=0||injNorm(t.name).indexOf(q)>=0||injNorm(t.abbr).indexOf(q)>=0;});
    if(!rows.length)return;
    shown+=rows.length;
    bodyHtml+='<h2 class="section-h inj-h">'+esc(t.abbr||t.name)+(t.abbr?' \u00b7 '+esc(t.name):"")+' \u2014 '+rows.length+'</h2><section class="card" style="padding:1px 7px 3px;margin-top:3px">';
    rows.forEach(function(x){
      var st=String(x.status||"");
      var cls=st.toLowerCase().indexOf("out")===0?"out":(/(doubt|question|day)/i.test(st)?"dq":"other");
      var tid=tracked[injNorm(x.name)];
      bodyHtml+='<div class="inj-row"><span class="inj-status '+cls+'">'+esc(st.toUpperCase())+'</span><div style="flex:1;min-width:0">'
        +'<div class="inj-name">'+esc(x.name)+(x.pos?' <span class="sub" style="font-weight:700">'+esc(x.pos)+'</span>':"")+(tid?'<span class="badge inj-tracked">ON BOARD</span>':"")+'</div>'
        +((x.detail||x.ret)?'<div class="sub inj-detail">'+esc(x.detail)+(x.ret?' \u00b7 est. return '+esc(injRetLabel(x.ret)):"")+'</div>':"")
        +(x.comment?'<p class="note inj-comment">'+esc(x.comment)+'</p>':"")
        +(tid?'<div style="margin-top:3px"><button type="button" class="btn inj-log" data-detail="'+esc(tid)+'">Game log</button></div>':"")
        +'</div></div>';
    });
    bodyHtml+='</section>';
  });
  h+='<p class="note" style="margin-top:12px"><b style="color:var(--text)">'+outN+' out</b> \u00b7 <b style="color:var(--text)">'+otherN+' day-to-day / questionable</b> across '+inj.teams.length+' teams'+(q?(' \u00b7 showing '+shown+' matching \u201c'+esc(inj.q)+'\u201d'):"")+'.</p>';
  h+= bodyHtml || '<div class="card" style="padding:18px;margin-top:10px"><p class="note" style="margin:0">No injuries match \u201c'+esc(inj.q)+'\u201d.</p></div>';
  h+='<p class="note" style="margin-top:14px">Statuses, injury details and estimated return dates come straight from ESPN\u2019s NBA injury report and update when you open this tab or tap Refresh injuries. If a player tagged ON BOARD is out or doubtful, think twice before relying on his props.</p>';
  return h;
}

/* ---------- player detail ---------- */
function statValueFor(stats,statKey){
  var from=STAT_FROM[statKey]||[statKey]; var sum=0;
  for(var i=0;i<from.length;i++){var v=stats[from[i]]; if(v==null)return null; sum+=v;}
  return sum;
}
function findPlayer(playerId){
  var pl=null; board().players.forEach(function(x){if(x.id===playerId)pl=x;});
  if(pl)return pl;
  ensurePwProps(state.league);
  var m=(typeof PW_PLAYERS!=="undefined"&&PW_PLAYERS[state.league])||{};
  return m[playerId]||null;
}
function findProps(playerId){
  var ps=board().props.filter(function(p){return p.playerId===playerId;});
  if(ps.length)return ps;
  ensurePwProps(state.league);
  return ((typeof PW_PROPS!=="undefined"&&PW_PROPS[state.league])||[]).filter(function(p){return p.playerId===playerId;});
}
function findPropById(pid){
  var found=null; board().props.forEach(function(x){if(x.id===pid)found=x;});
  if(found)return found;
  ensurePwProps(state.league);
  ((typeof PW_PROPS!=="undefined"&&PW_PROPS[state.league])||[]).forEach(function(x){if(x.id===pid)found=x;});
  return found;
}
function openDetail(playerId,statKey){
  var player=findPlayer(playerId);
  var props=findProps(playerId);
  if(!player||!props.length){toast("That player\u2019s log isn\u2019t in this snapshot");return;}
  var sk=props[0].statKey;
  if(statKey)props.forEach(function(p){if(p.statKey===statKey)sk=statKey;});
  state.detail={playerId:playerId,statKey:sk,direction:"over",league:state.league,win:25,l25:{status:"idle",games:null,prev:null,prevStatus:"idle"}};
  renderModal();
  ensureDetailL25();
}
/* Previous-season extension for the player detail only: when this season's log
   is shorter than the largest game-log window (50), the FULL previous-season
   ESPN gamelog is fetched on demand through the same 12s-timeout fetchJson,
   cached in-page for the session, and merged after this season's games in the
   detail views (chart, game list, splits, in-detail window rates) so the
   merged log can reach the Last 50 window where the data exists.
   The board's hit rates and lines never see these games. */
var PREV_LOG_CACHE={};
function prevSeasonParam(lg){
  var y=parseInt(teamSeasonYear(lg),10);
  return isNaN(y)?null:y-1;
}
function prevSeasonShort(lg){ /* "25\u201326" for NBA/NHL, "2025" for NFL/MLB */
  var label=(DATA[lg]&&DATA[lg].seasonLabel)||"";
  var y=parseInt(label,10); if(isNaN(y))return "prev";
  return label.indexOf("-")>=0?(String(y-1).slice(2)+"\u2013"+String(y).slice(2)):String(y-1);
}
function prevSeasonName(lg){ /* "2025\u201326" for NBA/NHL, "2025" for NFL/MLB */
  var label=(DATA[lg]&&DATA[lg].seasonLabel)||"";
  var y=parseInt(label,10); if(isNaN(y))return "previous";
  return label.indexOf("-")>=0?((y-1)+"\u2013"+String(y).slice(2)):String(y-1);
}
function ensureDetailL25(){
  var d=state.detail; if(!d||!d.l25)return;
  var player=findPlayer(d.playerId); if(!player)return;
  var lg=d.league||state.league;
  function curCount(){
    var base=(player.games||[]).length;
    return (d.l25.games&&d.l25.games.length>base)?d.l25.games.length:base;
  }
  function maybePrev(){
    if(state.detail!==d)return;
    if(curCount()>=50){d.l25.prevStatus="none";return;}
    if(d.l25.prevStatus!=="idle")return;
    var key=lg+":"+d.playerId;
    if(PREV_LOG_CACHE[key]){d.l25.prev=PREV_LOG_CACHE[key]; d.l25.prevStatus="ok"; renderModal(); return;}
    var sp=prevSeasonParam(lg);
    if(typeof fetch!=="function"||sp==null){d.l25.prevStatus="error"; renderModal(); return;}
    d.l25.prevStatus="loading";
    fetchJson("https://site.api.espn.com/apis/common/v3/sports/"+ESPN_SPORT[lg]+"/athletes/"+d.playerId+"/gamelog?season="+sp).then(function(json){
      var games=parseGamelog(json,lg,300)||[];
      PREV_LOG_CACHE[key]=games;
      if(state.detail!==d)return;
      d.l25.prev=games; d.l25.prevStatus="ok";
      renderModal();
    }).catch(function(){
      if(state.detail!==d)return;
      d.l25.prevStatus="error";
      renderModal();
    });
  }
  if((player.games||[]).length>=50){d.l25.status="ok"; maybePrev(); return;}
  if(d.l25.status!=="idle"){maybePrev(); return;}
  if(typeof fetch!=="function"){d.l25.status="error"; maybePrev(); return;}
  d.l25.status="loading";
  fetchJson("https://site.api.espn.com/apis/common/v3/sports/"+ESPN_SPORT[lg]+"/athletes/"+d.playerId+"/gamelog").then(function(json){
    var games=parseGamelog(json,lg,50);
    if(state.detail!==d)return;
    if(games&&games.length){d.l25.games=games; d.l25.status="ok";}
    else d.l25.status="error";
    maybePrev();
    renderModal();
  }).catch(function(){
    if(state.detail!==d)return;
    d.l25.status="error";
    maybePrev();
    renderModal();
  });
}
function renderModal(){
  var root=document.getElementById("modalRoot");
  if(!state.detail){root.innerHTML="";if(!state.liveGameId&&!state.watchGameId)document.body.style.overflow="";return;}
  var b=board(), d=state.detail;
  var player=findPlayer(d.playerId);
  var props=findProps(d.playerId);
  if(!player||!props.length){state.detail=null;root.innerHTML="";if(!state.liveGameId&&!state.watchGameId)document.body.style.overflow="";return;}
  var active=null; props.forEach(function(p){if(p.statKey===d.statKey)active=p;}); if(!active)active=props[0];
  var line=lineFor(active), over=d.direction==="over";
  var dlg=d.league||state.league;
  /* detail-only merged log: the fullest current-season games first, then the
     previous-season games fetched on demand appended after them */
  var curSrc=player.games||[];
  if(d.l25&&d.l25.games&&d.l25.games.length>=curSrc.length)curSrc=d.l25.games;
  var detailGames=curSrc.concat((d.l25&&d.l25.prev)||[]);
  var nCurGames=curSrc.length;
  var winW=(d.win===5||d.win===10||d.win===50)?d.win:25;
  var detailValues=detailGames.map(function(g){return statValueFor(g.stats,active.statKey);}).filter(function(v){return v!=null;});
  var wValues=detailValues.length>=active.values.length?detailValues:active.values;
  var w=windowsFor(wValues,line,over);
  /* the single game-by-game window: merged log entries with a value for the
     selected stat, most recent first, cut to the active Last 5/10/25/50 window */
  var winEntries=detailGames.map(function(g,i){return {g:g,v:statValueFor(g.stats,active.statKey),prev:i>=nCurGames};}).filter(function(r){return r.v!=null;}).slice(0,winW);
  /* chart data oldest -> newest, same window as the list */
  var pts=winEntries.slice().reverse();
  var maxV=line; pts.forEach(function(r){if(r.v>maxV)maxV=r.v;}); maxV=Math.max(maxV*1.15,line+1);
  var W=620,H=170,padB=18,padT=10,bw=pts.length?(W/pts.length):W;
  var bars="";
  var nPrevPts=0; pts.forEach(function(r){if(r.prev)nPrevPts++;});
  pts.forEach(function(r,i){
    var bh=Math.max(2,(r.v/maxV)*(H-padB-padT)); var x=i*bw+bw*0.18, y=H-padB-bh;
    var hit=over?r.v>line:r.v<line;
    bars+='<rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+(bw*0.64).toFixed(1)+'" height="'+bh.toFixed(1)+'" rx="3" fill="'+(hit?"var(--accent-strong)":"var(--miss-dark)")+'"'+(r.prev?' fill-opacity="0.45"':'')+'><title>'+esc(new Date(r.g.date).toLocaleDateString(undefined,{month:"short",day:"numeric"}))+' vs '+esc(r.g.opp)+': '+r.v+'</title></rect>';
  });
  var lineY=H-padB-(line/maxV)*(H-padB-padT);
  var boundary="";
  if(nPrevPts>0&&nPrevPts<pts.length){
    var bx=(nPrevPts*bw).toFixed(1);
    boundary='<line x1="'+bx+'" x2="'+bx+'" y1="'+padT+'" y2="'+(H-padB)+'" stroke="var(--dim)" stroke-width="1" stroke-dasharray="3 3"/>'
      +'<text x="'+(nPrevPts*bw-4).toFixed(1)+'" y="'+(padT+8)+'" text-anchor="end" font-size="9.5" font-weight="700" fill="var(--dim)">'+esc(prevSeasonShort(dlg))+'</text>';
  }
  var chart='<svg viewBox="0 0 '+W+' '+H+'" width="100%" role="img" aria-label="Game by game '+esc(active.statLabel)+' against the line" style="display:block">'
    +bars+boundary+'<line x1="0" x2="'+W+'" y1="'+lineY.toFixed(1)+'" y2="'+lineY.toFixed(1)+'" stroke="var(--warn)" stroke-width="1.5" stroke-dasharray="6 4"/>'
    +'<text x="4" y="'+(lineY-5).toFixed(1)+'" font-size="11" font-weight="700" fill="var(--warn)">LINE '+fmtLine(line)+'</text>'
    +'<text x="2" y="'+(H-4)+'" font-size="10" fill="var(--dim)">Oldest</text><text x="'+(W-2)+'" y="'+(H-4)+'" text-anchor="end" font-size="10" fill="var(--dim)">Most recent</text></svg>';
  function rate(sel){var played=sel.filter(function(r){return r.v!=null;});var hh=played.filter(function(r){return over?r.v>line:r.v<line;}).length;return {h:hh,n:played.length};}
  var rowsAll=detailGames.map(function(g){return {g:g,v:statValueFor(g.stats,active.statKey)};});
  var home=rate(rowsAll.filter(function(r){return r.g.home===true;}));
  var away=rate(rowsAll.filter(function(r){return r.g.home===false;}));
  var vsNext=active.nextGame?rate(rowsAll.filter(function(r){return r.g.opp===active.nextGame.oppAbbr;})):null;
  var statChips=props.map(function(p){return '<button type="button" data-dstat="'+esc(p.statKey)+'" aria-pressed="'+(active.statKey===p.statKey)+'" style="'+(active.statKey===p.statKey?"background:var(--accent);border-color:transparent;color:#131a08;":"")+'">'+esc(p.statLabel)+'</button>';}).join("");
  /* unified game-by-game list for the active window — merged current +
     previous-season log (see ensureDetailL25); one list only, no separate
     Last 25 section */
  var l25rows=winEntries;
  var l25n=l25rows.length;
  var l25PrevShown=0; l25rows.forEach(function(r){if(r.prev)l25PrevShown++;});
  var l25complete=l25n>=winW||!d.l25||(d.l25.status==="ok"&&d.l25.prevStatus!=="loading"&&d.l25.prevStatus!=="idle");
  var l25title=l25n>=winW?("GAME BY GAME \u2014 LAST "+winW):(l25complete&&l25n?("GAME BY GAME \u2014 LAST "+l25n+" GAME"+(l25n===1?"":"S")+" \u2014 ALL AVAILABLE"):("GAME BY GAME \u2014 LAST "+l25n+" GAMES"));
  var l25hits=0,l25over=0,l25under=0,l25push=0,l25sum=0;
  l25rows.forEach(function(r){l25sum+=r.v; if(r.v>line){l25over++; if(over)l25hits++;} else if(r.v<line){l25under++; if(!over)l25hits++;} else l25push++;});
  var l25listArr=[], l25divDone=false;
  l25rows.forEach(function(r){
    if(r.prev&&!l25divDone){l25divDone=true; l25listArr.push('<li class="l25-divider">\u2014 '+esc(prevSeasonName(dlg))+' season \u2014</li>');}
    var hit=over?r.v>line:r.v<line;
    var tag=r.v>line?"OVER":(r.v<line?"UNDER":"PUSH");
    l25listArr.push('<li class="l25-row"><span class="l25-date">'+esc(new Date(r.g.date).toLocaleDateString(undefined,{month:"short",day:"numeric"}))+'</span>'
      +'<span class="l25-opp">'+(r.g.home===true?"vs ":r.g.home===false?"@ ":"\u00b7 ")+esc(r.g.opp)+(r.prev?' <span class="prevtag">'+esc(prevSeasonShort(dlg))+'</span>':"")+'</span>'
      +'<span class="l25-val tnum" style="'+(hit?"color:var(--accent-ink)":"")+'">'+r.v+(hit?" \u2713":"")+'</span>'
      +'<span class="l25-tag '+(tag==="OVER"?"over":tag==="UNDER"?"under":"push")+'">'+tag+'</span></li>');
  });
  var l25list=l25listArr.join("");
  var l25note="";
  if(l25n){
    l25note='<p class="note l25-note">Avg <b style="color:var(--text)">'+(Math.round(l25sum/l25n*10)/10)+'</b> across these '+l25n+' \u00b7 <b style="color:var(--text)">'+l25over+' over</b> / <b style="color:var(--text)">'+l25under+' under</b> the '+fmtLine(line)+' line'+(l25push?(' \u00b7 '+l25push+' push'+(l25push===1?"":"es")):"")+' \u00b7 hit the '+(over?"Over":"Under")+' in <b style="color:var(--text)">'+l25hits+' of '+l25n+'</b> ('+Math.round(l25hits/l25n*100)+'%)</p>';
  }
  if(d.l25&&d.l25.status==="loading")l25note+='<p class="note l25-note">Pulling this player\u2019s full ESPN game log for more games\u2026</p>';
  else if(d.l25&&d.l25.status==="error")l25note+='<p class="note l25-note">Couldn\u2019t pull the fuller ESPN log (offline?) \u2014 showing the '+l25n+' game'+(l25n===1?"":"s")+' saved in this file.</p>';
  if(l25PrevShown>0)l25note+='<p class="note l25-note">Last '+l25n+' incl. <b style="color:var(--text)">'+l25PrevShown+' game'+(l25PrevShown===1?"":"s")+' from '+esc(prevSeasonName(dlg))+'</b> \u2014 tagged '+esc(prevSeasonShort(dlg))+' above; averages, counts and rates include them.</p>';
  if(d.l25&&d.l25.prevStatus==="loading")l25note+='<p class="note l25-note">Pulling '+esc(prevSeasonName(dlg))+' games from ESPN to extend this log\u2026</p>';
  else if(d.l25&&d.l25.prevStatus==="error")l25note+='<p class="note l25-note">Previous-season ('+esc(prevSeasonName(dlg))+') games need a connection \u2014 showing this season\u2019s games only.</p>';
  var winPills=[5,10,25,50].map(function(n){return '<button type="button" data-dwin="'+n+'" aria-pressed="'+(winW===n)+'">Last '+n+'</button>';}).join("");
  var logSection='<section class="card" style="padding:14px;margin-top:12px"><h3 class="sub" style="margin:0 0 8px;font-weight:800;letter-spacing:.05em">'+l25title+' \u00b7 '+esc(active.statLabel.toUpperCase())+' VS LINE '+fmtLine(line)+'</h3>'
    +'<div class="chips glwinpills" role="group" aria-label="Game log window">'+winPills+'</div>'
    +'<div style="margin-top:4px">'+chart+'</div>'
    +(l25n?('<ul class="l25-list">'+l25list+'</ul>'):('<p class="note l25-note">No games with '+esc(active.statLabel)+' in the log yet.</p>'))
    +l25note+'</section>';
  root.innerHTML='<div class="modalwrap" role="dialog" aria-modal="true" aria-label="Player game log"><button type="button" class="modalbg" id="modalClose" aria-label="Close player detail"></button>'
    +'<div class="modal"><div style="display:flex;gap:12px;align-items:flex-start">'+playerAvatar(player.name,player.id,dlg,"lg")
    +'<div style="flex:1;min-width:0"><h2 class="display" style="font-size:24px;font-weight:700">'+esc(player.name)+'</h2>'
    +'<p class="sub" style="margin:2px 0 0">'+esc(player.teamAbbr)+(player.position?" · "+esc(player.position):"")+' · '+state.league+(player.nextGame?' · Next: '+(player.nextGame.home?"vs ":"@ ")+esc(player.nextGame.oppAbbr)+', '+esc(fmtGameTime(player.nextGame.date)):" · No upcoming game on the slate")+'</p></div>'
    +'<button type="button" class="iconbtn" id="modalX" aria-label="Close">×</button></div>'
    +'<div class="chips" role="group" aria-label="Choose stat">'+statChips+'</div>'
    +'<section class="card" style="padding:14px;margin-top:12px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
    +'<div class="ou" role="group" aria-label="Over or under"><button type="button" data-dir="over" aria-pressed="'+(over)+'">Over</button><button type="button" data-dir="under" aria-pressed="'+(!over)+'">Under</button></div>'
    +stepper(active)+'<span class="sub">'+esc(active.statLabel)+'</span></div>'
    +'<div class="rate display tnum" style="font-size:26px">'+pct(w.l10.h,w.l10.n)+'%<small>L10</small></div></div>'
    +'<div style="margin-top:8px">'+winRow("L5",w.l5,wValues,line,over)+winRow("L10",w.l10,wValues,line,over)+winRow("L20",w.l20,wValues,line,over)+'</div>'
    +'<div class="splits"><div class="split"><b class="tnum">'+home.h+'/'+home.n+'</b><span>Home</span></div><div class="split"><b class="tnum">'+away.h+'/'+away.n+'</b><span>Away</span></div><div class="split"><b class="tnum">'+(vsNext?vsNext.h+'/'+vsNext.n:"—")+'</b><span>vs '+esc(active.nextGame?active.nextGame.oppAbbr:"next opp")+'</span></div></div>'
    +'</section>'
    +logSection
    +'</div></div>';
  document.body.style.overflow="hidden";
  document.getElementById("modalClose").addEventListener("click",closeModal);
  document.getElementById("modalX").addEventListener("click",closeModal);
  root.querySelectorAll("[data-dstat]").forEach(function(btn){btn.addEventListener("click",function(){state.detail.statKey=btn.getAttribute("data-dstat");renderModal();});});
  root.querySelectorAll("[data-dir]").forEach(function(btn){btn.addEventListener("click",function(){state.detail.direction=btn.getAttribute("data-dir");renderModal();});});
  root.querySelectorAll("[data-dwin]").forEach(function(btn){btn.addEventListener("click",function(){state.detail.win=parseInt(btn.getAttribute("data-dwin"),10)||25;renderModal();ensureDetailL25();});});
  bindSteppers(root);
}
function closeModal(){state.detail=null;renderModal();}

/* ---------- team detail (game-by-game team log popup) ---------- */
function openTeamDetail(propId){
  var p=findTeamProp(propId); if(!p){toast("That team prop isn\u2019t in this snapshot");return;}
  state.detail=null; renderModal();
  state.teamDetail={propId:propId,statKey:p.statKey,direction:"over",league:state.league};
  renderTeamModal();
}
function closeTeamModal(){state.teamDetail=null;renderTeamModal();}
function renderTeamModal(){
  var root=document.getElementById("modalRoot");
  if(!state.teamDetail){if(!state.detail){root.innerHTML="";if(!state.liveGameId&&!state.watchGameId)document.body.style.overflow="";}return;}
  var d=state.teamDetail;
  var tb=(typeof TEAM_DATA!=="undefined"&&TEAM_DATA[d.league])?TEAM_DATA[d.league]:{teams:[],props:[]};
  var abbr=d.propId.split(":")[0];
  var team=null; tb.teams.forEach(function(x){if(x.abbr===abbr)team=x;});
  var props=tb.props.filter(function(x){return x.teamAbbr===abbr;});
  var active=null; props.forEach(function(p){if(p.statKey===d.statKey)active=p;}); if(!active)active=props[0];
  if(!team||!active){state.teamDetail=null;root.innerHTML="";document.body.style.overflow="";return;}
  var line=teamLineFor(active), over=d.direction==="over";
  var w=windowsFor(active.values,line,over);
  var rowsAll=team.games.map(function(g){return {g:g,v:tstatValue(g,active.statKey)};});
  function rate(sel){var played=sel.filter(function(r){return r.v!=null;});var hh=played.filter(function(r){return over?r.v>line:r.v<line;}).length;return {h:hh,n:played.length};}
  var home=rate(rowsAll.filter(function(r){return r.g.home===true;}));
  var away=rate(rowsAll.filter(function(r){return r.g.home===false;}));
  var vsNext=active.nextGame?rate(rowsAll.filter(function(r){return r.g.opp===active.nextGame.oppAbbr;})):null;
  var statChips=props.map(function(p){return '<button type="button" data-tdstat="'+esc(p.statKey)+'" aria-pressed="'+(active.statKey===p.statKey)+'" style="'+(active.statKey===p.statKey?"background:var(--accent);border-color:transparent;color:#131a08;":"")+'">'+esc(p.statLabel)+'</button>';}).join("");
  var listRows=rowsAll.filter(function(r){return r.v!=null;}).slice(0,20);
  var hits=0,ov=0,un=0,pu=0,sum=0;
  listRows.forEach(function(r){sum+=r.v; if(r.v>line){ov++; if(over)hits++;} else if(r.v<line){un++; if(!over)hits++;} else pu++;});
  var list=listRows.map(function(r){
    var hit=over?r.v>line:r.v<line;
    var tag=r.v>line?"OVER":(r.v<line?"UNDER":"PUSH");
    return '<li class="l25-row"><span class="l25-date">'+esc(new Date(r.g.date).toLocaleDateString(undefined,{month:"short",day:"numeric"}))+'</span>'
      +'<span class="l25-opp">'+(r.g.home===true?"vs ":r.g.home===false?"@ ":"\u00b7 ")+esc(r.g.opp)+'</span>'
      +'<span class="l25-val tnum" style="'+(hit?"color:var(--accent-ink)":"")+'">'+r.v+(hit?" \u2713":"")+'</span>'
      +'<span class="l25-tag '+(tag==="OVER"?"over":tag==="UNDER"?"under":"push")+'">'+tag+'</span></li>';
  }).join("");
  root.innerHTML='<div class="modalwrap" role="dialog" aria-modal="true" aria-label="Team game log"><button type="button" class="modalbg" id="tModalClose" aria-label="Close team detail"></button>'
    +'<div class="modal"><div style="display:flex;gap:12px;align-items:flex-start"><div class="avatar lg" aria-hidden="true" style="font-size:15px;letter-spacing:-.02em">'+esc(team.abbr)+'</div>'
    +'<div style="flex:1;min-width:0"><h2 class="display" style="font-size:24px;font-weight:700">'+esc(team.name)+'</h2>'
    +'<p class="sub" style="margin:2px 0 0">'+esc(team.abbr)+' · Team props · '+esc(d.league)+(active.nextGame?' · Next: '+(active.nextGame.home?"vs ":"@ ")+esc(active.nextGame.oppAbbr)+', '+esc(fmtGameTime(active.nextGame.date)):" · No upcoming game on the slate")+'</p></div>'
    +'<button type="button" class="iconbtn" id="tModalX" aria-label="Close">×</button></div>'
    +'<div class="chips" role="group" aria-label="Choose stat">'+statChips+'</div>'
    +'<section class="card" style="padding:14px;margin-top:12px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
    +'<div class="ou" role="group" aria-label="Over or under"><button type="button" data-tdir="over" aria-pressed="'+(over)+'">Over</button><button type="button" data-tdir="under" aria-pressed="'+(!over)+'">Under</button></div>'
    +teamStepper(active)+'<span class="sub">'+esc(active.statLabel)+'</span></div>'
    +'<div class="rate display tnum" style="font-size:26px">'+pct(w.l10.h,w.l10.n)+'%<small>L10</small></div></div>'
    +'<div style="margin-top:8px">'+winRow("L5",w.l5,active.values,line,over)+winRow("L10",w.l10,active.values,line,over)+winRow("L20",w.l20,active.values,line,over)+'</div>'
    +'<div class="splits"><div class="split"><b class="tnum">'+home.h+'/'+home.n+'</b><span>Home</span></div><div class="split"><b class="tnum">'+away.h+'/'+away.n+'</b><span>Away</span></div><div class="split"><b class="tnum">'+(vsNext?vsNext.h+'/'+vsNext.n:"—")+'</b><span>vs '+esc(active.nextGame?active.nextGame.oppAbbr:"next opp")+'</span></div></div>'
    +'</section>'
    +'<section class="card" style="padding:10px 12px;margin-top:12px"><h3 class="sub" style="margin:0;font-weight:800;letter-spacing:.05em">GAME BY GAME · '+esc(active.statLabel.toUpperCase())+' VS LINE '+fmtLine(line)+'</h3>'
    +(listRows.length?('<ul class="l25-list">'+list+'</ul><p class="note l25-note">Avg <b style="color:var(--text)">'+(Math.round(sum/listRows.length*10)/10)+'</b> across these '+listRows.length+' · <b style="color:var(--text)">'+ov+' over</b> / <b style="color:var(--text)">'+un+' under</b> the '+fmtLine(line)+' line'+(pu?(' · '+pu+' push'+(pu===1?"":"es")):"")+' · hit the '+(over?"Over":"Under")+' in <b style="color:var(--text)">'+hits+' of '+listRows.length+'</b></p>'):('<p class="note l25-note">No games with '+esc(active.statLabel)+' in the log yet.</p>'))
    +'</section></div></div>';
  document.body.style.overflow="hidden";
  document.getElementById("tModalClose").addEventListener("click",closeTeamModal);
  document.getElementById("tModalX").addEventListener("click",closeTeamModal);
  root.querySelectorAll("[data-tdstat]").forEach(function(btn){btn.addEventListener("click",function(){state.teamDetail.statKey=btn.getAttribute("data-tdstat");renderTeamModal();});});
  root.querySelectorAll("[data-tdir]").forEach(function(btn){btn.addEventListener("click",function(){state.teamDetail.direction=btn.getAttribute("data-tdir");renderTeamModal();});});
  bindTeamCards(root);
}

/* ---------- site info modal (Privacy Policy / About / Contact) ----------
   The three sections are static HTML in #infoModal (in the page DOM, so
   the text is crawlable); this code
   only toggles which panel is visible and swaps the title/subtitle from
   the active panel's data attributes. Closes via the × button, the
   backdrop or Escape. */
var infoOpen=false;
var infoSection="privacy";
function openInfoModal(section){infoOpen=true;infoSection=section||"privacy";renderInfoModal();}
function closeInfoModal(){infoOpen=false;renderInfoModal();}
function renderInfoModal(){
  var wrap=document.getElementById("infoModal"); if(!wrap)return;
  if(!infoOpen){wrap.hidden=true;if(!state.detail&&!state.teamDetail&&!state.liveGameId&&!state.watchGameId)document.body.style.overflow="";return;}
  wrap.hidden=false;
  document.body.style.overflow="hidden";
  var active=null;
  document.querySelectorAll("[data-info-panel]").forEach(function(p){var on=p.getAttribute("data-info-panel")===infoSection;p.hidden=!on;if(on)active=p;});
  var t=document.getElementById("infoModalTitle"); if(t&&active)t.textContent=active.getAttribute("data-title")||"";
  var s=document.getElementById("infoModalSub"); if(s&&active){var sub=active.getAttribute("data-sub")||"";s.textContent=sub;s.style.display=sub?"":"none";}
}
function bindInfoFooter(){
  document.querySelectorAll("[data-info-open]").forEach(function(b){b.addEventListener("click",function(){openInfoModal(b.getAttribute("data-info-open"));});});
  document.querySelectorAll("[data-info-close]").forEach(function(b){b.addEventListener("click",closeInfoModal);});
}

/* ---------- refresh from ESPN: scores, live box scores, schedule + full props board (in-browser, snapshot fallback) ---------- */
var ESPN_SPORT={NBA:"basketball/nba",NFL:"football/nfl",NHL:"hockey/nhl",MLB:"baseball/mlb"};
var LIVE_SNAPSHOT_LABEL=(typeof LIVE_AS_OF!=="undefined"?LIVE_AS_OF:"");
function refreshTimeLabel(d){
  try{
    return new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",year:"numeric"}).format(d)+" · "+new Intl.DateTimeFormat(undefined,{hour:"numeric",minute:"2-digit"}).format(d);
  }catch(e){return d.toLocaleString();}
}
function setRefreshStatus(kind,msg){
  var wrap=document.getElementById("refreshStatus");
  var txt=document.getElementById("refreshStatusText");
  if(txt)txt.textContent=msg;
  if(wrap){wrap.classList.remove("is-live");wrap.classList.remove("is-ok");wrap.classList.remove("is-error");if(kind)wrap.classList.add(kind);}
}
function dataLabel(lg){
  if(lg&&state.boardStamp[lg])return "ESPN data updated "+state.boardStamp[lg];
  if(!lg){for(var i=0;i<LEAGUES.length;i++){if(state.boardStamp[LEAGUES[i]])return "ESPN data updated "+state.boardStamp[LEAGUES[i]];}}
  return "ESPN snapshot "+FETCHED_LABEL;
}
function refreshStatusForLeague(){
  var lg=state.league, bs=state.boardStamp[lg], sc=state.refreshed[lg];
  if(bs){
    setRefreshStatus("is-ok",lg+" board updated "+bs+" from ESPN — props, hit rates and game logs are current as of then"+(sc?(", and live scores/stats were pulled "+sc):"")+". Tap Refresh to update again.");
  }else if(sc){
    setRefreshStatus("is-ok","Live scores and player stats for "+lg+" updated "+sc+" from ESPN. The props board is still on its "+FETCHED_LABEL+" snapshot — tap Refresh to rebuild it from fresh game logs too.");
  }else{
    setRefreshStatus("",lg+" is showing the snapshot baked into this file ("+FETCHED_LABEL+"). Tap Refresh when you're online to pull the latest ESPN scores, live player stats and game logs — the props board updates too. Offline, the snapshot stays.");
  }
}
function setRefreshing(on){
  state.refreshing=on;
  var btn=document.getElementById("refreshBtn");
  if(btn){btn.disabled=on;btn.classList.toggle("is-refreshing",on);btn.setAttribute("aria-busy",on?"true":"false");}
  document.querySelectorAll("[data-refresh-live]").forEach(function(b){b.disabled=on;b.classList.toggle("is-refreshing",on);});
}
function leadersFromCompetitors(competitors){
  var out=[];
  (competitors||[]).forEach(function(c){
    var abbr=(c.team&&c.team.abbreviation)||"";
    (c.leaders||[]).forEach(function(group){
      if(group.name==="rating")return;
      var first=(group.leaders||[])[0];
      if(!first||!first.athlete)return;
      out.push({label:group.displayName||group.name||"",name:first.athlete.displayName||first.athlete.fullName||"",val:first.displayValue!=null?String(first.displayValue):"",team:abbr,id:first.athlete.id||""});
    });
  });
  return out;
}
/* ----- ESPN pre-game odds: scoreboard competitions carry an odds array
   (provider-named spread / total / moneylines). Parsed exactly like the
   online app; rendered for upcoming games only — there is no in-play
   line, and a game ESPN publishes no odds for simply shows nothing. ----- */
function mlStr(v){
  if(v==null)return null;
  if(typeof v==="string"&&v.trim())return v.trim();
  if(typeof v==="number"&&isFinite(v))return v>0?"+"+v:String(v);
  return null;
}
function parseOdds(comp){
  var arr=(comp&&comp.odds)||[];
  var o=arr[0];
  if(!o||typeof o!=="object")return null;
  var provider=(o.provider&&typeof o.provider.name==="string"&&o.provider.name)||(o.provider&&typeof o.provider.displayName==="string"&&o.provider.displayName)||null;
  var details=(typeof o.details==="string"&&o.details)?o.details:null;
  var spread=(typeof o.spread==="number"&&isFinite(o.spread))?o.spread:(o.spread!=null&&isFinite(parseFloat(String(o.spread)))?parseFloat(String(o.spread)):null);
  var overUnder=(typeof o.overUnder==="number"&&isFinite(o.overUnder))?o.overUnder:(o.overUnder!=null&&isFinite(parseFloat(String(o.overUnder)))?parseFloat(String(o.overUnder)):null);
  var homeMoneyline=mlStr(o.moneyline&&o.moneyline.home&&o.moneyline.home.close&&o.moneyline.home.close.odds)||mlStr(o.moneyline&&o.moneyline.home&&o.moneyline.home.close&&o.moneyline.home.close.summary)||mlStr(o.moneyline&&o.moneyline.home&&o.moneyline.home.odds)||mlStr(o.homeTeamOdds&&o.homeTeamOdds.moneyLine)||mlStr(o.homeTeamOdds&&o.homeTeamOdds.summary);
  var awayMoneyline=mlStr(o.moneyline&&o.moneyline.away&&o.moneyline.away.close&&o.moneyline.away.close.odds)||mlStr(o.moneyline&&o.moneyline.away&&o.moneyline.away.close&&o.moneyline.away.close.summary)||mlStr(o.moneyline&&o.moneyline.away&&o.moneyline.away.odds)||mlStr(o.awayTeamOdds&&o.awayTeamOdds.moneyLine)||mlStr(o.awayTeamOdds&&o.awayTeamOdds.summary);
  if(!details&&spread==null&&overUnder==null&&!homeMoneyline&&!awayMoneyline)return null;
  return {provider:provider?String(provider):null,details:details,spread:spread,overUnder:overUnder,homeMoneyline:homeMoneyline,awayMoneyline:awayMoneyline};
}
function oddsParts(odds,awayAbbr,homeAbbr){
  if(!odds)return null;
  var spreadText=odds.details||(odds.spread!=null?"Spread "+odds.spread:null);
  var totalText=odds.overUnder!=null?"O/U "+odds.overUnder:null;
  var mlParts=[];
  if(odds.awayMoneyline&&awayAbbr)mlParts.push(awayAbbr+" "+odds.awayMoneyline);
  if(odds.homeMoneyline&&homeAbbr)mlParts.push(homeAbbr+" "+odds.homeMoneyline);
  var mlText=mlParts.length?mlParts.join(" \u00B7 "):null;
  if(!spreadText&&!totalText&&!mlText)return null;
  return {spreadText:spreadText,totalText:totalText,mlText:mlText,provider:odds.provider||null};
}
function oddsLineHtml(odds,awayAbbr,homeAbbr){
  var parts=oddsParts(odds,awayAbbr,homeAbbr);
  if(!parts)return "";
  return '<div class="odds" aria-label="Pre-game line from ESPN">'
    +(parts.spreadText?'<span class="ochip">'+esc(parts.spreadText)+'</span>':"")
    +(parts.totalText?'<span class="ochip">'+esc(parts.totalText)+'</span>':"")
    +(parts.mlText?'<span class="oml">ML '+esc(parts.mlText)+'</span>':"")
    +'</div>';
}
function oddsCompactHtml(odds,awayAbbr,homeAbbr){
  var parts=oddsParts(odds,awayAbbr,homeAbbr);
  if(!parts)return "";
  var top=[parts.spreadText,parts.totalText].filter(Boolean).join(" \u00B7 ");
  return '<span class="odds-c">'
    +(top?'<span class="l1">'+esc(top)+'</span>':"")
    +(parts.mlText?'<span class="l2">'+esc(parts.mlText)+'</span>':"")
    +'</span>';
}
function oddsNoteHtml(provider){
  return '<p class="odds-note">Pre-game lines via ESPN'+(provider?' \u00B7 '+esc(provider):'')+'</p>';
}
function firstOddsProvider(items){
  for(var i=0;i<items.length;i++){var it=items[i]; if(it.state==="pre"&&it.odds&&it.odds.provider)return it.odds.provider;}
  return null;
}
function clockSecondsFrom(statusObj){
  if(!statusObj)return null;
  if(typeof statusObj.clock==="number"&&isFinite(statusObj.clock))return statusObj.clock;
  var dc=String(statusObj.displayClock||"");
  var m=dc.match(/^(\d{1,3}):(\d{2})(?:\.(\d+))?$/);
  if(!m)return null;
  var sec=parseInt(m[1],10)*60+parseInt(m[2],10);
  if(m[3])sec+=parseFloat("0."+m[3]);
  return sec;
}
function clockShouldRun(type,statusObj){
  if(!type||type.state!=="in")return false;
  var sec=clockSecondsFrom(statusObj);
  if(sec==null||sec<=0)return false;
  var txt=((type.detail||"")+" "+(type.shortDetail||"")).toLowerCase();
  if(/half|end of|intermission|delay|break|shootout|warmup|pregame/.test(txt))return false;
  return true;
}
function fmtTickClock(remain){
  if(remain<60){
    var whole=Math.floor(remain), tenth=Math.floor((remain-whole)*10);
    return "0:"+String(whole).padStart(2,"0")+"."+tenth;
  }
  var m2=Math.floor(remain/60), s2=Math.floor(remain-m2*60);
  return m2+":"+String(s2).padStart(2,"0");
}
function parseScoreboard(json,prevGames){
  var prevById={};
  (prevGames||[]).forEach(function(g){prevById[g.id]=g;});
  var games=[];
  ((json&&json.events)||[]).forEach(function(ev){
    var comp=((ev.competitions||[])[0])||{};
    var statusObj=comp.status||ev.status||{};
    var type=statusObj.type||{};
    var competitors=(comp.competitors||[]).slice();
    competitors.sort(function(a,b){return (a.homeAway==="home"?0:1)-(b.homeAway==="home"?0:1);});
    var teams=competitors.map(function(c){
      var rec="";
      (c.records||[]).forEach(function(r){if(!rec&&(r.name==="overall"||r.type==="total"))rec=r.summary||"";});
      if(!rec&&c.records&&c.records[0])rec=c.records[0].summary||"";
      return {abbr:(c.team&&c.team.abbreviation)||"",home:c.homeAway==="home",score:c.score!=null?String(c.score):null,lines:(c.linescores||[]).map(function(l){return typeof l.value==="number"?l.value:(parseFloat(l.displayValue)||0);}),record:rec};
    });
    var leaders=leadersFromCompetitors(competitors);
    var prev=prevById[ev.id];
    if(!leaders.length&&prev&&prev.leaders)leaders=prev.leaders;
    games.push({id:ev.id,date:ev.date||comp.date||"",short:ev.shortName||"",state:type.state||"pre",detail:type.detail||type.shortDetail||"",clock:statusObj.displayClock||"",clockSec:clockSecondsFrom(statusObj),clockAt:Date.now(),clockRun:clockShouldRun(type,statusObj),period:statusObj.period||0,teams:teams,leaders:leaders,box:prev?(prev.box||[]):[],teamStats:prev?(prev.teamStats||null):null,odds:parseOdds(comp)||(prev?(prev.odds||null):null)});
  });
  return games;
}
function syncBoardGames(games){
  var byId={};
  games.forEach(function(g){byId[g.id]=g;});
  board().games.forEach(function(g){
    var fresh=byId[g.id]; if(!fresh)return;
    g.state=fresh.state; if(fresh.detail)g.detail=fresh.detail;
    if(fresh.odds)g.odds=fresh.odds;
    if(fresh.state==="pre"){g.homeScore=null;g.awayScore=null;return;}
    fresh.teams.forEach(function(t){
      if(t.abbr===g.homeAbbr)g.homeScore=t.score;
      if(t.abbr===g.awayAbbr)g.awayScore=t.score;
    });
  });
}
/* ----- fetch helpers ----- */
/* Every ESPN request is time-boxed. A stalled connection on a phone can
   leave a bare fetch() pending forever — neither resolved nor rejected —
   and because the refresh pipeline waits for every request to settle,
   one hung request used to wedge the whole app on "Refreshing…" with the
   Refresh button disabled and nothing ever loading. The timeout turns a
   stall into an ordinary failure, which the snapshot fallback already
   handles. AbortController cancels the socket where available; the race
   guarantees the promise settles even where it is not. */
var FETCH_TIMEOUT_MS=12000;
function fetchJson(url){
  var ctrl=(typeof AbortController!=="undefined")?new AbortController():null;
  var timer=setTimeout(function(){ if(ctrl)ctrl.abort(); },FETCH_TIMEOUT_MS);
  var req=fetch(url,{cache:"no-store",signal:ctrl?ctrl.signal:undefined}).then(function(res){
    if(!res.ok)throw new Error("ESPN returned "+res.status);
    return res.json();
  });
  function done(){ clearTimeout(timer); }
  req.then(done,done);
  var deadline=new Promise(function(resolve,reject){
    setTimeout(function(){ reject(new Error("ESPN request timed out")); },FETCH_TIMEOUT_MS+500);
  });
  return Promise.race([req,deadline]);
}
function mapLimit(items,limit,fn,onProgress){
  return new Promise(function(resolve){
    var out=new Array(items.length);
    if(!items.length){resolve(out);return;}
    var idx=0,active=0,done=0;
    function pump(){
      while(active<limit&&idx<items.length){
        (function(i){
          active++;
          Promise.resolve().then(function(){return fn(items[i],i);}).then(function(v){out[i]={ok:true,v:v};},function(e){out[i]={ok:false};}).then(function(){
            active--; done++;
            if(onProgress)onProgress(done,items.length);
            if(done===items.length)resolve(out); else pump();
          });
        })(idx++);
      }
    }
    pump();
  });
}
function liveBoardFor(lg){return (typeof LIVE!=="undefined"&&LIVE[lg])?LIVE[lg]:{games:[]};}

/* ----- props board rebuild from ESPN game logs ----- */
/* Each player's stat menu, built for all four leagues up front — the board
   rebuild (auto-refresh on open / league switch, or a manual Refresh) reads
   it to know which props to rebuild from fresh game logs. */
var PLAYER_STAT_SETS={};
LEAGUES.forEach(function(lg){
  var m={};
  DATA[lg].props.forEach(function(p){(m[p.playerId]=m[p.playerId]||[]).push({key:p.statKey,label:p.statLabel});});
  PLAYER_STAT_SETS[lg]=m;
});
var GAME_STAT_KEYS={
  NBA:[["points","points","n"],["totalRebounds","totalRebounds","n"],["assists","assists","n"],["steals","steals","n"],["blocks","blocks","n"],["threePointFieldGoalsMade-threePointFieldGoalsAttempted","threePointFieldGoalsMade-threePointFieldGoalsAttempted","made"]],
  NFL:[["passingYards","passingYards","n"],["passingTouchdowns","passingTouchdowns","n"],["rushingAttempts","rushingAttempts","n"],["rushingYards","rushingYards","n"],["receptions","receptions","n"],["receivingYards","receivingYards","n"]],
  NHL:[["goals","goals","n"],["assists","assists","n"],["points","points","n"],["shotsTotal","shotsTotal","n"]],
  MLB:[["runs","runs","n"],["hits","hits","n"],["homeRuns","homeRuns","n"],["RBIs","RBIs","n"],["strikeouts","strikeouts","n"],["stolenBases","stolenBases","n"],["__totalBases",null,"tb"]]
};
function numAt(names,arr,name){
  var i=names.indexOf(name); if(i<0)return null;
  var v=parseFloat(arr[i]); return isNaN(v)?null:v;
}
function parseGamelog(json,league,limit){
  if(!json||!json.seasonTypes||!json.seasonTypes.length||!json.names)return null;
  var st=null;
  json.seasonTypes.forEach(function(s){if(!st&&/Regular Season/.test(s.displayName||""))st=s;});
  if(!st)st=json.seasonTypes[0];
  var names=json.names, byId={};
  (st.categories||[]).forEach(function(c){(c.events||[]).forEach(function(e){byId[e.eventId]=e.stats;});});
  var keys=GAME_STAT_KEYS[league]||[], out=[];
  Object.keys(byId).forEach(function(eid){
    var ev=(json.events||{})[eid];
    if(!ev||!ev.gameDate)return;
    var arr=byId[eid]||[], stats={};
    keys.forEach(function(k){
      var dest=k[0],mode=k[2],v=null;
      if(mode==="tb"){
        var h=numAt(names,arr,"hits"),d=numAt(names,arr,"doubles"),t=numAt(names,arr,"triples"),hr=numAt(names,arr,"homeRuns");
        if(h==null||d==null||t==null||hr==null)return;
        v=h+d+2*t+3*hr;
      }else{
        var idx=names.indexOf(k[1]); if(idx<0)return;
        var raw=arr[idx]; if(raw==null||raw==="")return;
        v=mode==="made"?parseFloat(String(raw).split("-")[0]):parseFloat(raw);
        if(isNaN(v))return;
      }
      stats[dest]=v;
    });
    if(!Object.keys(stats).length)return;
    out.push({date:ev.gameDate,opp:(ev.opponent&&ev.opponent.abbreviation)||"",home:ev.atVs==="vs"?true:(ev.atVs==="@"?false:null),stats:stats});
  });
  out.sort(function(a,b){return new Date(b.date)-new Date(a.date);});
  return out.slice(0,limit||20);
}
function round1(x){return Math.round(x*10)/10;}
function buildProp(league,player,statKey,statLabel,games,nextGame){
  var rows=[];
  games.forEach(function(g){var v=statValueFor(g.stats,statKey); if(v!=null)rows.push({home:g.home,v:v});});
  rows=rows.slice(0,20);
  if(rows.length<3)return null;
  var values=rows.map(function(r){return r.v;});
  var s10=0,n10=Math.min(10,values.length);
  for(var i=0;i<n10;i++)s10+=values[i];
  var avgL10=s10/n10, sAll=0;
  values.forEach(function(v){sAll+=v;});
  var avgAll=sAll/values.length;
  var line=Math.max(0.5,Math.floor(avgL10-0.25)+0.5);
  var streak=0;
  for(var j=0;j<values.length;j++){if(values[j]>line)streak++;else break;}
  var badges=[];
  var l5=windowsFor(values,line,true).l5;
  if(l5.n>=4&&l5.h>=4&&l5.h/l5.n>=0.8)badges.push("HOT L5 · "+l5.h+"/"+l5.n);
  if(streak>=3)badges.push("STREAK · "+streak+" STRAIGHT OVERS");
  var edge=(avgL10-line)/line*100;
  if(edge>=10)badges.push("AVG EDGE · +"+Math.round(edge)+"% VS LINE");
  if(nextGame){
    var want=nextGame.home===true, sh=0, sn=0;
    rows.forEach(function(r){if(r.home===want){sn++; if(r.v>line)sh++;}});
    if(sn>=3&&sh/sn>=0.7)badges.push((want?"HOME":"AWAY")+" SPLIT · "+sh+"/"+sn);
  }
  return {id:player.id+":"+statKey,playerId:player.id,playerName:player.name,teamAbbr:player.teamAbbr,position:player.position||"",statKey:statKey,statLabel:statLabel,line:line,avgL10:round1(avgL10),avgAll:round1(avgAll),over:windowsFor(values,line,true),under:windowsFor(values,line,false),values:values,badges:badges,streak:streak,nextGame:nextGame};
}
function detailFor(iso){
  var d=new Date(iso); if(isNaN(d.getTime()))return "";
  try{
    var date=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",month:"numeric",day:"numeric"}).format(d);
    var time=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"numeric",minute:"2-digit",hour12:true}).format(d);
    var tz="";
    new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",timeZoneName:"short"}).formatToParts(d).forEach(function(p){if(p.type==="timeZoneName")tz=p.value;});
    return date+" - "+time.toUpperCase()+(tz?" "+tz:"");
  }catch(e){return "";}
}
function nextGameFor(games,abbr){
  var now=Date.now();
  var mine=games.filter(function(g){return g.homeAbbr===abbr||g.awayAbbr===abbr;}).slice().sort(function(a,b){return new Date(a.date)-new Date(b.date);});
  for(var i=0;i<mine.length;i++){
    var g=mine[i];
    if(g.state==="pre"||new Date(g.date).getTime()>now){
      var home=g.homeAbbr===abbr;
      return {oppAbbr:home?g.awayAbbr:g.homeAbbr,date:g.date,home:home,detail:detailFor(g.date)};
    }
  }
  return null;
}
function sortPropsDesc(arr){
  arr.sort(function(a,c){
    var pa=a.over.l10.n?a.over.l10.h/a.over.l10.n:0, pc=c.over.l10.n?c.over.l10.h/c.over.l10.n:0;
    if(pc!==pa)return pc-pa;
    if(c.over.l5.h!==a.over.l5.h)return c.over.l5.h-a.over.l5.h;
    if(c.over.l10.h!==a.over.l10.h)return c.over.l10.h-a.over.l10.h;
    return c.avgL10-a.avgL10;
  });
  return arr;
}
/* Discover and the top play read the boards in
   best-first order — every league's baked player and team boards are
   normalized (best-first) up front on open, so a snapshot saved in any
   other order can never surface worst-first in any league. */
function sortAllBoards(){
  LEAGUES.forEach(function(lg){
    if(typeof DATA!=="undefined"&&DATA[lg]&&DATA[lg].props)sortPropsDesc(DATA[lg].props);
    if(typeof TEAM_DATA!=="undefined"&&TEAM_DATA[lg]&&TEAM_DATA[lg].props)sortPropsDesc(TEAM_DATA[lg].props);
  });
}
function rebuildBoard(league,freshGames,scheduleGames){
  var b=DATA[league], updated=0;
  var useSchedule=scheduleGames&&scheduleGames.length?scheduleGames:null;
  if(useSchedule)b.games=useSchedule;
  var allProps=[];
  b.players.forEach(function(pl){
    var fresh=freshGames?freshGames[pl.id]:null;
    var games=(fresh&&fresh.length)?fresh:pl.games;
    var ng=useSchedule?nextGameFor(useSchedule,pl.teamAbbr):pl.nextGame;
    var set=PLAYER_STAT_SETS[league][pl.id]||[];
    var props=[];
    set.forEach(function(s){var p=buildProp(league,pl,s.key,s.label,games,ng); if(p)props.push(p);});
    if(!props.length){
      /* the fresh log couldn't support this player's props (e.g. an MLB pitcher
         whose gamelog view carries no batting line) — keep their snapshot rows */
      b.props.forEach(function(p){if(p.playerId===pl.id)allProps.push(p);});
      return;
    }
    if(fresh&&fresh.length){pl.games=games; updated++;}
    pl.nextGame=ng;
    props.forEach(function(p){allProps.push(p);});
  });
  sortPropsDesc(allProps);
  b.props=allProps;
  return updated;
}

/* ----- team props rebuild from ESPN team schedules + summaries ----- */
var TEAM_STAT_MENU={
  NBA:[["teamTotal","Team Total"],["teamAllowed","Team Total Allowed"],["gameTotal","Game Total"],["teamRebounds","Team Rebounds"],["teamAssists","Team Assists"],["teamThrees","Team 3-Pointers"]],
  NFL:[["teamTotal","Team Total"],["teamAllowed","Team Total Allowed"],["gameTotal","Game Total"],["teamYards","Team Total Yards"]],
  NHL:[["teamTotal","Team Total"],["teamAllowed","Team Total Allowed"],["gameTotal","Game Total"],["teamShots","Team Shots on Goal"]],
  MLB:[["teamTotal","Team Total"],["teamAllowed","Team Total Allowed"],["gameTotal","Game Total"],["teamHits","Team Hits"]]
};
function buildTeamProp(league,team,statKey,statLabel,games,nextGame){
  var rows=[];
  games.forEach(function(g){var v=g.stats[statKey]; if(v!=null)rows.push({home:g.home,v:v});});
  rows=rows.slice(0,20);
  if(rows.length<3)return null;
  var values=rows.map(function(r){return r.v;});
  var s10=0,n10=Math.min(10,values.length);
  for(var i=0;i<n10;i++)s10+=values[i];
  var avgL10=s10/n10, sAll=0; values.forEach(function(v){sAll+=v;});
  var avgAll=sAll/values.length;
  var line=Math.max(0.5,Math.floor(avgL10-0.25)+0.5);
  var streak=0;
  for(var j=0;j<values.length;j++){if(values[j]>line)streak++;else break;}
  var badges=[];
  var l5=windowsFor(values,line,true).l5;
  if(l5.n>=4&&l5.h>=4&&l5.h/l5.n>=0.8)badges.push("HOT L5 · "+l5.h+"/"+l5.n);
  if(streak>=3)badges.push("STREAK · "+streak+" STRAIGHT OVERS");
  var edge=(avgL10-line)/line*100;
  if(edge>=10)badges.push("AVG EDGE · +"+Math.round(edge)+"% VS LINE");
  if(nextGame){
    var want=nextGame.home===true, sh=0, sn=0;
    rows.forEach(function(r){if(r.home===want){sn++; if(r.v>line)sh++;}});
    if(sn>=3&&sh/sn>=0.7)badges.push((want?"HOME":"AWAY")+" SPLIT · "+sh+"/"+sn);
  }
  return {id:team.abbr+":"+statKey,playerId:"team:"+team.abbr,playerName:team.name,teamAbbr:team.abbr,position:"",statKey:statKey,statLabel:statLabel,line:line,avgL10:round1(avgL10),avgAll:round1(avgAll),over:windowsFor(values,line,true),under:windowsFor(values,line,false),values:values,badges:badges,streak:streak,nextGame:nextGame,kind:"team"};
}
function teamSeasonYear(lg){
  var label=(DATA[lg]&&DATA[lg].seasonLabel)||"";
  var y=parseInt(label,10); if(isNaN(y))return "";
  return label.indexOf("-")>=0?String(y+1):String(y);
}
function parseTeamSchedule(json,team){
  var games=[];
  ((json&&json.events)||[]).forEach(function(ev){
    var comp=((ev.competitions||[])[0])||{};
    var st=((comp.status||{}).type||{});
    if(st.state!=="post")return;
    var mine=null,opp=null;
    (comp.competitors||[]).forEach(function(c){
      var s=c.score; if(s&&typeof s==="object")s=(s.displayValue!=null?s.displayValue:s.value);
      var v=parseFloat(s); if(isNaN(v))return;
      var rec={id:String((c.team&&c.team.id)||""),abbr:(c.team&&c.team.abbreviation)||"",score:v,home:c.homeAway==="home"};
      if(rec.id===team.id||rec.abbr===team.abbr)mine=rec; else opp=rec;
    });
    if(!mine||!opp)return;
    if(mine.abbr)team.abbr=mine.abbr;
    games.push({eventId:String(ev.id),date:ev.date||"",opp:opp.abbr,home:mine.home,stats:{teamTotal:mine.score,teamAllowed:opp.score,gameTotal:mine.score+opp.score}});
  });
  games.sort(function(a,b){return new Date(b.date)-new Date(a.date);});
  return games.slice(0,20);
}
function parseTeamSummaryExtras(league,json){
  var out={};
  var teams=(json&&json.boxscore&&json.boxscore.teams)||[];
  teams.forEach(function(t){
    var abbr=(t.team&&t.team.abbreviation)||""; if(!abbr)return;
    var stats={};
    if(league==="MLB"){
      (t.statistics||[]).forEach(function(grp){
        if(grp.name!=="batting")return;
        (grp.stats||[]).forEach(function(s){if(s.name==="hits"&&s.value!=null)stats.teamHits=Number(s.value);});
      });
    }else{
      (t.statistics||[]).forEach(function(s){
        if(s.displayValue==null||s.displayValue==="")return;
        var v=parseFloat(s.displayValue);
        if(league==="NBA"){
          if(s.name==="totalRebounds"&&!isNaN(v))stats.teamRebounds=v;
          else if(s.name==="assists"&&!isNaN(v))stats.teamAssists=v;
          else if(s.name==="threePointFieldGoalsMade-threePointFieldGoalsAttempted"){var mv=parseFloat(String(s.displayValue).split("-")[0]); if(!isNaN(mv))stats.teamThrees=mv;}
        }else if(league==="NHL"){
          if(s.name==="shotsTotal"&&!isNaN(v))stats.teamShots=v;
        }else if(league==="NFL"){
          if(s.name==="totalYards"&&!isNaN(v))stats.teamYards=v;
        }
      });
    }
    if(Object.keys(stats).length)out[abbr]=stats;
  });
  return out;
}
function refreshTeamData(league){
  if(typeof fetch!=="function"||typeof TEAM_DATA==="undefined")return Promise.resolve(false);
  var sport=ESPN_SPORT[league], yr=teamSeasonYear(league);
  var qs=yr?("?season="+yr+"&seasontype=2"):"?seasontype=2";
  return fetchJson("https://site.api.espn.com/apis/site/v2/sports/"+sport+"/teams").then(function(tj){
    var list=[];
    try{ tj.sports[0].leagues[0].teams.forEach(function(e){list.push({id:String(e.team.id),abbr:e.team.abbreviation,name:e.team.displayName});}); }catch(e){}
    if(!list.length)throw new Error("no teams");
    return mapLimit(list,6,function(team){
      return fetchJson("https://site.api.espn.com/apis/site/v2/sports/"+sport+"/teams/"+team.id+"/schedule"+qs).then(function(json){
        return {team:team,games:parseTeamSchedule(json,team)};
      });
    }).then(function(results){
      var built=[], seenEv={}, eidList=[];
      results.forEach(function(r){ if(r.ok&&r.v){ built.push(r.v); r.v.games.forEach(function(g){ if(!seenEv[g.eventId]){seenEv[g.eventId]=1; eidList.push(g.eventId);} }); } });
      if(!built.length)throw new Error("no schedules");
      return mapLimit(eidList,6,function(eid){
        return fetchJson("https://site.api.espn.com/apis/site/v2/sports/"+sport+"/summary?event="+eid).then(function(json){return parseTeamSummaryExtras(league,json);});
      }).then(function(sumRes){
        var byEvent={};
        sumRes.forEach(function(r,i){ if(r.ok&&r.v)byEvent[eidList[i]]=r.v; });
        /* if a summary didn't come through, reuse the baked extras for the same game */
        var old=(TEAM_DATA[league]&&TEAM_DATA[league].teams)||[];
        var oldExtras={};
        old.forEach(function(t){ (t.games||[]).forEach(function(g){ var ex={}; Object.keys(g.stats||{}).forEach(function(k){ if(k!=="teamTotal"&&k!=="teamAllowed"&&k!=="gameTotal")ex[k]=g.stats[k]; }); if(Object.keys(ex).length)oldExtras[t.abbr+"|"+g.date+"|"+g.opp]=ex; }); });
        var teams=[], props=[];
        var menu=TEAM_STAT_MENU[league]||[];
        built.forEach(function(b){
          b.games.forEach(function(g){
            var ex=byEvent[g.eventId]&&byEvent[g.eventId][b.team.abbr];
            if(ex)Object.keys(ex).forEach(function(k){g.stats[k]=ex[k];});
            else{ var oe=oldExtras[b.team.abbr+"|"+g.date+"|"+g.opp]; if(oe)Object.keys(oe).forEach(function(k){ if(g.stats[k]==null)g.stats[k]=oe[k]; }); }
            delete g.eventId;
          });
          var team={id:b.team.id,abbr:b.team.abbr,name:b.team.name,games:b.games};
          teams.push(team);
          var ng=nextGameFor(DATA[league].games,team.abbr);
          menu.forEach(function(s){ var p=buildTeamProp(league,team,s[0],s[1],b.games,ng); if(p)props.push(p); });
        });
        props.sort(function(a,c){
          var pa=a.over.l10.n?a.over.l10.h/a.over.l10.n:0, pc=c.over.l10.n?c.over.l10.h/c.over.l10.n:0;
          if(pc!==pa)return pc-pa;
          if(c.over.l5.h!==a.over.l5.h)return c.over.l5.h-a.over.l5.h;
          if(c.over.l10.h!==a.over.l10.h)return c.over.l10.h-a.over.l10.h;
          return c.avgL10-a.avgL10;
        });
        if(props.length){ TEAM_DATA[league]={teams:teams,props:props}; TEAM_AS_OF=refreshTimeLabel(new Date()); }
        if(league===state.league&&state.tab==="discover")render();
        return props.length>0;
      });
    });
  }).catch(function(){ return false; });
}

/* ----- Prop Watch tab data: top-5-per-team pool beyond the tracked board ----- */
var PW_STAT_SETS={
  NBA:[["points","Points"],["pra","Pts + Reb + Ast"],["totalRebounds","Rebounds"],["assists","Assists"]],
  NFL:[["passingYards","Passing Yards"],["passRushYards","Pass + Rush Yards"],["rushingYards","Rushing Yards"],["receivingYards","Receiving Yards"],["receptions","Receptions"],["rushingAttempts","Rush Attempts"],["passingTouchdowns","Passing TDs"]],
  NHL:[["points","Points"],["goals","Goals"],["shotsTotal","Shots on Goal"],["assists","Assists"]],
  MLB:[["hits","Hits"],["totalBases","Total Bases"],["runs","Runs Scored"],["RBIs","RBIs"],["homeRuns","Home Runs"],["stolenBases","Stolen Bases"],["pitcherStrikeouts","Pitcher Strikeouts"]]
};
var PW_PROPS={}, PW_PLAYERS={}, PW_BUILT={};
function pwBuildProp(player,statKey,statLabel){
  var values=[];
  player.games.forEach(function(g){var v=statValueFor(g.stats,statKey); if(v!=null)values.push(v);});
  values=values.slice(0,10);
  if(values.length<2)return null;
  var s=0; values.forEach(function(v){s+=v;});
  var avg=s/values.length;
  var line=Math.max(0.5,Math.floor(avg-0.25)+0.5);
  return {id:player.id+":"+statKey,playerId:player.id,playerName:player.name,teamAbbr:player.teamAbbr,position:player.position||"",statKey:statKey,statLabel:statLabel,line:line,avgL10:round1(avg),avgAll:round1(avg),over:windowsFor(values,line,true),under:windowsFor(values,line,false),values:values,badges:[],streak:0,nextGame:player.nextGame||null};
}
function rebuildPwProps(lg){
  var sets=PW_STAT_SETS[lg]||[];
  var src=(typeof PW!=="undefined"&&PW[lg])?PW[lg]:{extras:[]};
  var pmap={}, props=[];
  (src.extras||[]).forEach(function(pl){
    pl.nextGame=nextGameFor(DATA[lg].games,pl.teamAbbr);
    pmap[pl.id]=pl;
    sets.forEach(function(s){var p=pwBuildProp(pl,s[0],s[1]); if(p)props.push(p);});
  });
  PW_PLAYERS[lg]=pmap; PW_PROPS[lg]=props; PW_BUILT[lg]=true;
}
/* PW props are built for all four leagues up front on open (see init);
   ensurePwProps stays as the guard for any read that lands first, and
   refreshPwExtras rebuilds them again after fresh extra-player logs land. */
function ensurePwProps(lg){
  if(!lg)lg=state.league;
  if(PW_BUILT[lg])return;
  rebuildPwProps(lg);
}
function refreshPwExtras(lg){
  var extras=(typeof PW!=="undefined"&&PW[lg])?PW[lg].extras:[];
  if(!extras||!extras.length||typeof fetch!=="function")return;
  mapLimit(extras,6,function(pl){
    return fetchJson("https://site.api.espn.com/apis/common/v3/sports/"+ESPN_SPORT[lg]+"/athletes/"+pl.id+"/gamelog").then(function(json){return parseGamelog(json,lg);});
  }).then(function(results){
    var n=0;
    results.forEach(function(r,i){if(r.ok&&r.v&&r.v.length){extras[i].games=r.v.slice(0,10); n++;}});
    if(n){rebuildPwProps(lg); if(lg===state.league&&state.tab==="propwatch")render();}
  },function(){});
}
function ensurePropWatch(){
  var lg=state.league;
  if(state.pwFresh[lg])return;
  state.pwFresh[lg]=true;
  if(typeof fetch!=="function"||state.refreshing)return;
  refreshScores(lg).then(function(r){return refreshLiveBoxes(lg,r.games);}).then(function(){
    renderTabs();
    if(lg===state.league&&state.tab==="propwatch")render();
    if(lg===state.league&&state.liveGameId)renderLivePopup();
  },function(){});
  /* Opening Prop Watch also pulls fresh game logs for its extra
     (beyond-the-board) players and rebuilds their props in place.
     In app mode this automatic pull is deferred (see autoLater);
     the scoreboard pull above stays immediate in every mode. */
  autoLater(function(){refreshPwExtras(lg);});
}

/* ----- schedule (board slate + next games) ----- */
function boardGameFromEvent(ev){
  var comp=((ev.competitions||[])[0])||{};
  var statusObj=comp.status||ev.status||{};
  var type=statusObj.type||{};
  var home=null, away=null;
  (comp.competitors||[]).forEach(function(c){
    var rec={abbr:(c.team&&c.team.abbreviation)||"",score:c.score!=null?String(c.score):null};
    if(c.homeAway==="home")home=rec; else away=rec;
  });
  if(!home||!away)return null;
  var st=type.state||"pre";
  return {id:ev.id,date:ev.date||comp.date||"",name:ev.name||"",shortName:ev.shortName||"",state:st,detail:type.detail||type.shortDetail||"",homeAbbr:home.abbr,awayAbbr:away.abbr,homeScore:st==="pre"?null:home.score,awayScore:st==="pre"?null:away.score,odds:parseOdds(comp)};
}
function ymdStr(d){
  function p(n){return (n<10?"0":"")+n;}
  return ""+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate());
}
function fetchSchedule(league,todayEvents){
  var byId={}, order=[];
  function add(ev){try{var g=boardGameFromEvent(ev); if(g&&!byId[g.id]){byId[g.id]=g; order.push(g);}}catch(e){}}
  (todayEvents||[]).forEach(add);
  var days=[];
  for(var i=1;i<=8;i++){var d=new Date(); d.setDate(d.getDate()+i); days.push(ymdStr(d));}
  return mapLimit(days,4,function(ds){
    return fetchJson("https://site.api.espn.com/apis/site/v2/sports/"+ESPN_SPORT[league]+"/scoreboard?dates="+ds);
  }).then(function(results){
    results.forEach(function(r){if(r.ok&&r.v)((r.v.events||[]).forEach(add));});
    order.sort(function(a,b){return new Date(a.date)-new Date(b.date);});
    return order;
  });
}

/* ----- live box scores + team stats from ESPN game summaries ----- */
function boxStatsFor(league,group,labels,arr){
  function at(label){var i=labels.indexOf(label); if(i<0)return null; var v=parseFloat(arr[i]); return isNaN(v)?null:v;}
  function made(label){var i=labels.indexOf(label); if(i<0)return null; var v=parseFloat(String(arr[i]==null?"":arr[i]).split("-")[0]); return isNaN(v)?null:v;}
  var stats={};
  if(league==="NBA"){
    var mi=labels.indexOf("MIN");
    if(mi>=0){
      var min=String(arr[mi]==null?"":arr[mi]);
      if(min.indexOf(":")>0){var mp=min.split(":"); var mv2=parseFloat(mp[0])+parseFloat(mp[1])/60; if(!isNaN(mv2))stats.minutes=Math.round(mv2*10)/10;}
      else if(min!==""){var mv=parseFloat(min); if(!isNaN(mv))stats.minutes=mv;}
    }
    [["PTS","points"],["REB","totalRebounds"],["AST","assists"],["STL","steals"],["BLK","blocks"]].forEach(function(m){var v=at(m[0]); if(v!=null)stats[m[1]]=v;});
    var tp=made("3PT"); if(tp!=null)stats["threePointFieldGoalsMade-threePointFieldGoalsAttempted"]=tp;
  }else if(league==="NFL"){
    var gname=group.name||"";
    if(gname==="passing"){var y=at("YDS"),t=at("TD"); if(y!=null)stats.passingYards=y; if(t!=null)stats.passingTouchdowns=t;}
    else if(gname==="rushing"){var c=at("CAR"),ry=at("YDS"); if(c!=null)stats.rushingAttempts=c; if(ry!=null)stats.rushingYards=ry;}
    else if(gname==="receiving"){var rc=at("REC"),cy=at("YDS"); if(rc!=null)stats.receptions=rc; if(cy!=null)stats.receivingYards=cy;}
    else return null;
  }else if(league==="NHL"){
    if(labels.indexOf("G")<0||(labels.indexOf("S")<0&&labels.indexOf("SOG")<0))return null;
    var g2=at("G"),a2=at("A"),sog=labels.indexOf("S")>=0?at("S"):at("SOG");
    if(g2!=null)stats.goals=g2;
    if(a2!=null)stats.assists=a2;
    if(g2!=null&&a2!=null)stats.points=g2+a2;
    if(sog!=null)stats.shotsTotal=sog;
  }else if(league==="MLB"){
    if(labels.indexOf("H-AB")>=0){
      [["R","runs"],["H","hits"],["HR","homeRuns"],["RBI","RBIs"],["K","strikeouts"],["SB","stolenBases"],["AB","atBats"]].forEach(function(m){var v=at(m[0]); if(v!=null)stats[m[1]]=v;});
      var h=at("H"),d=at("2B"),t3=at("3B"),hr=at("HR");
      if(h!=null&&d!=null&&t3!=null&&hr!=null)stats.__totalBases=h+d+2*t3+3*hr;
    }else if(labels.indexOf("IP")>=0){
      var k=at("K"); if(k!=null)stats.strikeouts=k;
    }else return null;
  }
  return Object.keys(stats).length?stats:null;
}
function parseSummaryBox(json,league){
  var rows=[], seen={};
  var blocks=(json&&json.boxscore&&json.boxscore.players)||[];
  blocks.forEach(function(tb){
    var abbr=(tb.team&&tb.team.abbreviation)||"";
    (tb.statistics||[]).forEach(function(group){
      var labels=group.labels||group.names||[];
      (group.athletes||[]).forEach(function(a){
        if(!a.athlete||a.athlete.id==null||a.didNotPlay)return;
        var stats=boxStatsFor(league,group,labels,a.stats||[]);
        if(!stats)return;
        var id=String(a.athlete.id);
        if(seen[id]){for(var k in stats)seen[id].stats[k]=stats[k];}
        else{var row={id:id,name:a.athlete.displayName||a.athlete.fullName||"",team:abbr,stats:stats}; seen[id]=row; rows.push(row);}
      });
    });
  });
  return rows;
}
function parseSummaryTeamStats(json,game){
  var teams=(json&&json.boxscore&&json.boxscore.teams)||[];
  if(teams.length<2)return null;
  var homeT=null, awayT=null;
  teams.forEach(function(t){
    var abbr=(t.team&&t.team.abbreviation)||"";
    var isHome=t.homeAway==="home";
    game.teams.forEach(function(gt){if(gt.abbr===abbr&&gt.home)isHome=true; if(gt.abbr===abbr&&!gt.home)isHome=false;});
    if(isHome)homeT=t; else awayT=t;
  });
  if(!homeT||!awayT)return null;
  function vals(t){
    var m={},order=[];
    (t.statistics||[]).forEach(function(s){if(s.displayValue!=null&&s.displayValue!==""){m[s.name]={label:s.label||s.name,val:String(s.displayValue)}; order.push(s.name);}});
    return {m:m,order:order};
  }
  var hv=vals(homeT), av=vals(awayT), rows=[];
  hv.order.forEach(function(n){if(av.m[n]&&rows.length<10)rows.push({label:hv.m[n].label,home:hv.m[n].val,away:av.m[n].val});});
  if(!rows.length)return null;
  var hAbbr="", aAbbr="";
  game.teams.forEach(function(gt){if(gt.home)hAbbr=gt.abbr; else aAbbr=gt.abbr;});
  return {homeAbbr:hAbbr,awayAbbr:aAbbr,rows:rows};
}
function refreshLiveBoxes(league,games,onlyIn){
  var targets=games.filter(function(g){return g.state==="in"||(!onlyIn&&g.state==="post");});
  if(!targets.length)return Promise.resolve(0);
  return mapLimit(targets,4,function(g){
    return fetchJson("https://site.api.espn.com/apis/site/v2/sports/"+ESPN_SPORT[league]+"/summary?event="+g.id).then(function(json){
      var box=parseSummaryBox(json,league);
      if(box.length)g.box=box;
      var ts=parseSummaryTeamStats(json,g);
      if(ts)g.teamStats=ts;
      return box.length;
    });
  }).then(function(results){
    var n=0; results.forEach(function(r){if(r.ok)n++;});
    return n;
  });
}
function refreshScores(league){
  return fetchJson("https://site.api.espn.com/apis/site/v2/sports/"+ESPN_SPORT[league]+"/scoreboard").then(function(json){
    var games=parseScoreboard(json,liveBoardFor(league).games||[]);
    if(!games.length)throw new Error("No games returned");
    if(typeof LIVE==="undefined")window.LIVE={};
    LIVE[league]={games:games};
    LIVE_AS_OF=refreshTimeLabel(new Date());
    state.refreshed[league]=LIVE_AS_OF;
    if(league===state.league)syncBoardGames(games);
    return {games:games,events:(json&&json.events)||[]};
  });
}

/* ----- the full refresh: scores + live boxes + schedule + props board ----- */
function finishRefresh(league,res,manual){
  var stamp=refreshTimeLabel(new Date());
  var liveN=(typeof LIVE!=="undefined"&&LIVE[league])?LIVE[league].games.filter(function(g){return g.state==="in";}).length:0;
  if(res.board){
    setRefreshStatus(liveN?"is-live":"is-ok","Updated "+stamp+" · "+league+": props board rebuilt from fresh ESPN game logs ("+res.playersUpdated+" of "+res.playersTotal+" players updated)"+(res.scores?", scores and live box scores pulled":"")+(liveN?(", "+liveN+" game"+(liveN===1?"":"s")+" in progress"):"")+".");
    if(manual)toast(league+" board refreshed · "+stamp);
  }else if(res.scores){
    setRefreshStatus(liveN?"is-live":"is-ok","Live scores and player stats updated "+stamp+" · "+league+(liveN?(" · "+liveN+" in progress"):"")+" from ESPN. The props board kept its "+FETCHED_LABEL+" snapshot this time — the game-log pull didn't come through.");
    if(manual)toast("Live stats refreshed · "+stamp);
  }else{
    if(manual){
      setRefreshStatus("is-error","Couldn't reach ESPN — showing the last "+league+" data on screen (props snapshot "+FETCHED_LABEL+"). Check your connection and tap Refresh again.");
      toast("Couldn't refresh — showing the snapshot instead");
    }else{
      refreshStatusForLeague();
    }
  }
  renderTabs(); render();
  if(state.detail)renderModal();
  if(state.liveGameId)renderLivePopup();
  if(state.watchGameId)renderWatchPopup();
  /* If the user switched leagues while this refresh ran, the league now
     on screen may still be unrefreshed — auto-pull it too. (Deferred
     like every automatic pull in app mode; immediate otherwise.) */
  if(state.league!==league)autoLater(function(){maybeAutoRefresh();});
}
function refreshLiveScores(manual){
  if(state.refreshing)return;
  if(typeof fetch!=="function"){
    setRefreshStatus("is-error","Refresh isn't available in this browser — showing the snapshot from "+(typeof LIVE_AS_OF!=="undefined"?LIVE_AS_OF:"")+".");
    toast("Refresh isn't available here — showing the snapshot");
    return;
  }
  var league=state.league;
  setRefreshing(true);
  setRefreshStatus("","Refreshing "+league+" from ESPN — scores, live player stats and game logs…");
  if(manual)toast("Refreshing "+league+" from ESPN…");
  var res={scores:false,boxes:0,board:false,playersUpdated:0,playersTotal:DATA[league].players.length};
  /* Watchdog: however the pipeline below ends up, the refresh state is
     always cleared and the app returns to the data it has. If the chain
     still finishes afterwards, its fresh data is rendered then. */
  var finished=false, watchdog=null;
  function completeRefresh(){
    if(finished)return;
    finished=true;
    if(watchdog)clearTimeout(watchdog);
    setRefreshing(false);
    finishRefresh(league,res,manual);
  }
  watchdog=setTimeout(completeRefresh,120000);
  var todayEvents=[];
  refreshScores(league).then(function(r){
    res.scores=true; todayEvents=r.events;
    return refreshLiveBoxes(league,r.games).then(function(n){res.boxes=n||0;},function(){});
  },function(){}).then(function(){
    return fetchSchedule(league,todayEvents).then(function(scheduleGames){
      if(scheduleGames&&scheduleGames.length&&league===state.league&&!res.board)DATA[league].games=scheduleGames;
      var players=DATA[league].players;
      return mapLimit(players,6,function(pl){
        return fetchJson("https://site.api.espn.com/apis/common/v3/sports/"+ESPN_SPORT[league]+"/athletes/"+pl.id+"/gamelog").then(function(json){
          return parseGamelog(json,league);
        });
      },function(done,total){
        if(league===state.league)setRefreshStatus("","Refreshing "+league+" from ESPN — game logs "+done+"/"+total+" players…");
      }).then(function(results){
        var fresh={};
        results.forEach(function(r2,i){if(r2.ok&&r2.v&&r2.v.length)fresh[players[i].id]=r2.v;});
        if(Object.keys(fresh).length){
          res.playersUpdated=rebuildBoard(league,fresh,scheduleGames&&scheduleGames.length?scheduleGames:null);
          res.board=true;
          state.boardStamp[league]=refreshTimeLabel(new Date());
        }
        if(manual)refreshPwExtras(league);
        else if(state.tab==="propwatch")autoLater(function(){refreshPwExtras(league);});
        refreshTeamData(league);
      },function(){});
    },function(){});
  }).then(function(){
    if(finished){ renderTabs(); render(); return; }
    completeRefresh();
  },function(){
    if(finished){ renderTabs(); render(); return; }
    completeRefresh();
  });
}
function refreshLiveOnly(){
  if(state.refreshing||state.liveRefreshing)return;
  if(typeof fetch!=="function")return;
  var league=state.league;
  state.liveRefreshing=true;
  refreshScores(league).then(function(r){
    return refreshLiveBoxes(league,r.games,true);
  }).then(function(){
    state.liveRefreshing=false;
    renderTabs();
    syncLiveDom();
    if(league===state.league&&(state.tab==="live"||state.tab==="propwatch"))render();
    if(league===state.league&&state.liveGameId)renderLivePopup();
  },function(){
    state.liveRefreshing=false;
  });
}
/* ----- auto-refresh: opening online pulls the selected league's fresh
   ESPN game logs and rebuilds its board; switching to a league that has
   not been refreshed yet this session does the same. The safety rails
   are the refresh pipeline's own: 12s per-request timeout
   (FETCH_TIMEOUT_MS), a 2-minute watchdog that always ends the refresh,
   ~6 requests at a time, and any player whose log pull fails keeps their
   baked data. Offline, every pull simply fails over to the snapshot and
   the status line says so. ----- */
var autoTried={};
function maybeAutoRefresh(){
  var lg=state.league;
  if(typeof fetch!=="function")return;
  if(state.refreshing||state.boardStamp[lg]||autoTried[lg])return;
  autoTried[lg]=true;
  refreshLiveScores(false);
}
/* Live scoreboard re-checks (refreshLiveOnly — one scoreboard request
   plus box scores for in-progress games, no game logs) run on their own
   about every 20 seconds on the Discover / Live / Prop Watch tabs while
   games are in progress, and the player popup fetches its full
   current/previous-season logs on demand. */
setInterval(function(){
  try{
    if(document.hidden)return;
    if(state.tab!=="live"&&state.tab!=="propwatch"&&state.tab!=="discover"&&!state.liveGameId)return;
    if(liveCount(state.league)>0)refreshLiveOnly();
  }catch(e){}
},20000);

/* ----- the ticking game clock -----
   ESPN's feed only moves when it is re-polled (~20s above), so between
   polls the displayed clock counts down locally, one second at a time,
   from the last clock ESPN reported. Each new poll re-anchors the clock,
   which also corrects any drift from stoppages (timeouts, reviews) where
   the real clock was stopped. The same pass keeps the Discover strip's
   score numbers in step with the latest polled data. When a ticking
   clock reaches zero it stops and one re-check is triggered so the next
   period's clock arrives promptly. */
function syncLiveDom(){
  try{
    if(typeof LIVE==="undefined"||!LIVE[state.league])return;
    (LIVE[state.league].games||[]).forEach(function(g){
      if(g.state!=="in")return;
      (g.teams||[]).forEach(function(t){
        if(t.score==null)return;
        var els=document.querySelectorAll('[data-score-for="'+g.id+':'+t.abbr+'"]');
        els.forEach(function(el){ if(el.textContent!==String(t.score))el.textContent=String(t.score); });
      });
    });
  }catch(e){}
}
var tickResyncFor={};
setInterval(function(){
  try{
    if(document.hidden)return;
    if(typeof LIVE==="undefined")return;
    var now=Date.now();
    Object.keys(LIVE).forEach(function(lg){
      var board=LIVE[lg]; if(!board||!board.games)return;
      board.games.forEach(function(g){
        if(g.state!=="in"||!g.clockRun||g.clockSec==null||g._tickStop)return;
        var remain=g.clockSec-(now-(g.clockAt||now))/1000;
        if(remain<=0){
          remain=0; g._tickStop=true;
          var key=g.id+":"+g.period;
          if(!tickResyncFor[key]){ tickResyncFor[key]=true; if(lg===state.league)refreshLiveOnly(); }
        }
        var txt=fmtTickClock(remain);
        var spans=document.querySelectorAll('[data-clock-for="'+g.id+'"]');
        spans.forEach(function(el){
          if(/\d{1,2}:\d{2}(\.\d+)?/.test(el.textContent)){
            var next=el.textContent.replace(/\d{1,2}:\d{2}(\.\d+)?/,txt);
            if(next!==el.textContent)el.textContent=next;
          }
        });
      });
    });
  }catch(e){}
},1000);

/* ---------- Make me a Lay: random parlay generator (ported from the online app) ----------
   Fresh Fisher-Yates shuffle on EVERY Generate press. Pool = player props +
   team props of the picker's selected leagues at/above the Min hit rate
   (L10, Over at current research lines), ranked by hit rate. NBA and NHL
   draw from the full top-200 tracked-player pool (no cap); NFL and MLB
   keep the top-30-props cap. One leg per player/team per lay; a short
   pool deals what honestly qualifies — never padded, never below the bar. */
function laySelected(){
  if(!state.lay.selected)state.lay.selected=[state.league];
  return LEAGUES.filter(function(l){return state.lay.selected.indexOf(l)>=0;});
}
function layPool(){
  var sel=laySelected(), min=state.lay.minPct, out=[];
  sel.forEach(function(lg){
    var items=[];
    DATA[lg].props.forEach(function(pp){items.push({p:pp,kind:"player"});});
    var tb=(typeof TEAM_DATA!=="undefined"&&TEAM_DATA[lg])?TEAM_DATA[lg]:{props:[]};
    (tb.props||[]).forEach(function(pp){items.push({p:pp,kind:"team"});});
    var scored=items.map(function(it){
      var line=lineForLg(lg,it.p);
      var w=line!==it.p.line?windowsFor(it.p.values,line,true):it.p.over;
      return {p:it.p,kind:it.kind,league:lg,rate:pct(w.l10.h,w.l10.n),h:w.l10.h,avg:it.p.avgL10};
    });
    var elig=scored.filter(function(s){return s.rate>=min;});
    elig.sort(function(a,b){return b.rate-a.rate||b.h-a.h||b.avg-a.avg;});
    if(lg!=="NBA"&&lg!=="NHL")elig=elig.slice(0,30);
    elig.forEach(function(s){out.push({p:s.p,kind:s.kind,league:lg});});
  });
  return out;
}
function layGenerate(){
  var pool=layPool();
  var shuffled=pool.slice();
  for(var i=shuffled.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)); var tmp=shuffled[i]; shuffled[i]=shuffled[j]; shuffled[j]=tmp;}
  var picked=[], used={};
  for(var k=0;k<shuffled.length;k++){
    if(picked.length>=state.lay.legs)break;
    var it=shuffled[k], key=it.league+":"+it.p.playerId;
    if(used[key])continue;
    used[key]=1; picked.push(it);
  }
  var dealSet={}; pool.forEach(function(it){dealSet[it.league+":"+it.p.playerId]=1;});
  state.lay.generated=picked;
  state.lay.genCount++;
  state.lay.genMeta={requested:state.lay.legs,poolSize:pool.length,dealable:Object.keys(dealSet).length,minPct:state.lay.minPct};
  render();
}
function findLayProp(lg,kind,pid){
  var src=kind==="team"?((typeof TEAM_DATA!=="undefined"&&TEAM_DATA[lg])?TEAM_DATA[lg].props:[]):DATA[lg].props;
  var f=null; src.forEach(function(x){if(x.id===pid)f=x;}); return f;
}
function openDetailLg(lg,playerId){
  if(lg!==state.league){state.league=lg; state.ws.stat="all"; renderLeagues(); renderTabs(); refreshStatusForLeague(); render(); autoLater(function(){maybeAutoRefresh();});}
  openDetail(playerId);
}
function openTeamDetailLg(lg,pid){
  if(lg!==state.league){state.league=lg; renderLeagues(); renderTabs(); refreshStatusForLeague(); render(); autoLater(function(){maybeAutoRefresh();});}
  openTeamDetail(pid);
}
function layTagsHtml(item,showLg){
  var tags="";
  if(showLg)tags+='<span class="lay-tag">'+esc(item.league)+'</span>';
  if(item.kind==="team")tags+='<span class="lay-tag team">TEAM PROP</span>';
  if(!tags)return "";
  return '<div style="display:flex;gap:5px;align-items:center;margin:10px 2px 0;flex-wrap:wrap">'+tags+'<span style="font-size:12px;font-weight:700">'+esc(item.p.playerName)+'</span></div>';
}
function layPropCard(item){
  var pp=item.p, lg=item.league;
  var line=lineForLg(lg,pp), custom=line!==pp.line;
  var w=custom?windowsFor(pp.values,line,true):pp.over;
  var badges=pp.badges.map(function(b){var hot=b.indexOf("HOT")===0||b.indexOf("STREAK")===0;return '<span class="badge'+(hot?" hot":"")+'">'+esc(b)+'</span>';}).join("");
  return '<article class="card prop compact">'
    +'<div style="display:flex;gap:7px;align-items:flex-start">'+playerAvatar(pp.playerName,pp.playerId,lg,"")
    +'<div style="flex:1;min-width:0"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">'
    +'<h3 class="display" style="margin:0;font-size:13px;font-weight:700">'+esc(pp.playerName)+'</h3>'
    +'<div class="rate display tnum">'+pct(w.l10.h,w.l10.n)+'%<small>L10 HIT RATE</small></div></div>'
    +'<p class="sub" style="margin:2px 0 0">'+esc(pp.teamAbbr)+(pp.position?" \u00B7 "+esc(pp.position):"")+(pp.nextGame?' \u00B7 '+(pp.nextGame.home?"vs ":"@ ")+esc(pp.nextGame.oppAbbr)+' \u00B7 '+esc(fmtGameTime(pp.nextGame.date)):" \u00B7 No upcoming game on the slate")+'</p></div></div>'
    +'<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:8px;margin-top:6px"><p style="margin:0;font-size:12px"><b>Over '+fmtLine(line)+'</b> <span style="color:var(--dim)">'+esc(pp.statLabel)+'</span></p>'
    +'<p class="sub tnum" style="margin:0">Avg L10 <b style="color:var(--text)">'+pp.avgL10+'</b> \u00B7 Season <b style="color:var(--text)">'+pp.avgAll+'</b></p></div>'
    +(custom?'<p style="margin:4px 0 0;font-size:12px;font-weight:700;color:var(--accent-ink)">Your line \u2014 rates recomputed from the game log</p>':"")
    +'<div style="margin-top:4px">'+winRow("L5",w.l5,pp.values,line,true)+winRow("L10",w.l10,pp.values,line,true)+winRow("L20",w.l20,pp.values,line,true)+'</div>'
    +(badges?'<div class="badges">'+badges+'</div>':"")
    +'<div style="display:flex;gap:6px;margin-top:7px"><button type="button" class="btn" style="flex:1" data-laydetail="'+esc(pp.playerId)+'" data-laylg="'+lg+'">Game log</button></div>'
    +'<div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px"><span class="sub" style="font-weight:800;letter-spacing:.05em;font-size:9px">RESEARCH LINE</span>'
    +'<div class="stepper"><button type="button" data-laystep="-0.5" data-laylg="'+lg+'" data-laykind="player" data-laypid="'+esc(pp.id)+'" aria-label="Lower line for '+esc(pp.playerName)+'">\u2212</button><span class="lv tnum">'+fmtLine(line)+'</span><button type="button" data-laystep="0.5" data-laylg="'+lg+'" data-laykind="player" data-laypid="'+esc(pp.id)+'" aria-label="Raise line for '+esc(pp.playerName)+'">+</button></div></div>'
    +'</article>';
}
function layTeamCard(item){
  var pp=item.p, lg=item.league;
  var line=lineForLg(lg,pp), custom=line!==pp.line;
  var w=custom?windowsFor(pp.values,line,true):pp.over;
  var badges=pp.badges.map(function(b){var hot=b.indexOf("HOT")===0||b.indexOf("STREAK")===0;return '<span class="badge'+(hot?" hot":"")+'">'+esc(b)+'</span>';}).join("");
  return '<article class="card prop compact">'
    +'<div style="display:flex;gap:7px;align-items:flex-start"><div class="avatar" aria-hidden="true" style="font-size:10px;letter-spacing:-.02em">'+esc(pp.teamAbbr)+'</div>'
    +'<div style="flex:1;min-width:0"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">'
    +'<h3 class="display" style="margin:0;font-size:13px;font-weight:700">'+esc(pp.playerName)+'</h3>'
    +'<div class="rate display tnum">'+pct(w.l10.h,w.l10.n)+'%<small>L10 HIT RATE</small></div></div>'
    +'<p class="sub" style="margin:2px 0 0">'+esc(pp.teamAbbr)+' \u00B7 Team prop'+(pp.nextGame?' \u00B7 '+(pp.nextGame.home?"vs ":"@ ")+esc(pp.nextGame.oppAbbr)+' \u00B7 '+esc(fmtGameTime(pp.nextGame.date)):" \u00B7 No upcoming game on the slate")+'</p></div></div>'
    +'<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:8px;margin-top:6px"><p style="margin:0;font-size:12px"><b>Over '+fmtLine(line)+'</b> <span style="color:var(--dim)">'+esc(pp.statLabel)+'</span></p>'
    +'<p class="sub tnum" style="margin:0">Avg L10 <b style="color:var(--text)">'+pp.avgL10+'</b> \u00B7 Season <b style="color:var(--text)">'+pp.avgAll+'</b></p></div>'
    +(custom?'<p style="margin:4px 0 0;font-size:12px;font-weight:700;color:var(--accent-ink)">Your line \u2014 rates recomputed from the game log</p>':"")
    +'<div style="margin-top:4px">'+winRow("L5",w.l5,pp.values,line,true)+winRow("L10",w.l10,pp.values,line,true)+winRow("L20",w.l20,pp.values,line,true)+'</div>'
    +(badges?'<div class="badges">'+badges+'</div>':"")
    +'<div style="display:flex;gap:6px;margin-top:7px"><button type="button" class="btn" style="flex:1" data-laytdetail="'+esc(pp.id)+'" data-laylg="'+lg+'">Game log</button></div>'
    +'<div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px"><span class="sub" style="font-weight:800;letter-spacing:.05em;font-size:9px">RESEARCH LINE</span>'
    +'<div class="stepper"><button type="button" data-laystep="-0.5" data-laylg="'+lg+'" data-laykind="team" data-laypid="'+esc(pp.id)+'" aria-label="Lower line for '+esc(pp.playerName)+' '+esc(pp.statLabel)+'">\u2212</button><span class="lv tnum">'+fmtLine(line)+'</span><button type="button" data-laystep="0.5" data-laylg="'+lg+'" data-laykind="team" data-laypid="'+esc(pp.id)+'" aria-label="Raise line for '+esc(pp.playerName)+' '+esc(pp.statLabel)+'">+</button></div></div>'
    +'</article>';
}
function viewMakeLay(){
  var lay=state.lay, sel=laySelected();
  var mixed=sel.length>1;
  var selShort=sel.length===4?"All":sel.join(" + ");
  var selLong=sel.length===4?"All leagues":sel.join(" + ");
  var pool=layPool();
  var gen=lay.generated, meta=lay.genMeta;
  var isJordan=!!(gen&&gen.length===9);
  var layMixed=!!(gen&&(function(){var s={}; gen.forEach(function(g){s[g.league]=1;}); return Object.keys(s).length>1;})());
  var showTags=mixed||layMixed;
  var combined=1;
  if(gen)gen.forEach(function(it){var line=lineForLg(it.league,it.p); var w=line!==it.p.line?windowsFor(it.p.values,line,true):it.p.over; combined*=w.l10.n?w.l10.h/w.l10.n:0;});
  var legsHtml=[2,3,4,5,6,9].map(function(n){
    var on=lay.legs===n;
    var style=on?"background:var(--text);color:var(--bg);border-color:var(--text)":"background:var(--surface2);color:var(--dim)";
    return '<button type="button" data-laylegs="'+n+'" aria-pressed="'+on+'" aria-label="'+(n===9?"9 legs \u2014 Jordan Parlay":n+" legs")+'" style="'+style+';border:1px solid var(--border);border-radius:9px;height:36px;font-weight:800;font-size:'+(n===9?"12px":"14px")+(n===9?";width:auto;padding:0 10px;white-space:nowrap":";width:40px")+'">'+(n===9?"9 \u00B7 Jordan":n)+'</button>';
  }).join("");
  var pickerHtml="";
  if(lay.pickerOpen){
    var allOn=sel.length===4;
    var grid=LEAGUES.map(function(lg){
      var on=sel.indexOf(lg)>=0, last=on&&sel.length===1;
      var st=on?"background:var(--text);color:var(--bg);border-color:var(--text)":"background:var(--surface);color:var(--dim)";
      return '<button type="button" data-laytoggle="'+lg+'" aria-pressed="'+on+'"'+(last?' aria-disabled="true" title="At least one league must stay selected"':"")+' aria-label="Include '+lg+' in lay generator" style="'+st+';border:1px solid var(--border);border-radius:9px;height:40px;font-weight:800;font-size:14px;min-width:0">'+(on?"\u2713 ":"")+lg+'</button>';
    }).join("");
    pickerHtml='<div role="group" aria-label="Choose leagues to mix" style="margin-top:8px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:12px">'
      +'<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span style="font-size:11px;font-weight:800;letter-spacing:.05em;color:var(--dim)">CLICK LEAGUES TO MIX</span>'
      +'<button type="button" data-laydone style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:4px 10px;font-size:11px;font-weight:800">Done</button></div>'
      +'<button type="button" data-layall aria-pressed="'+allOn+'" aria-label="All leagues" style="'+(allOn?"background:var(--text);color:var(--bg);border-color:var(--text)":"background:var(--surface);color:var(--text)")+';border:1px solid var(--border);border-radius:9px;height:36px;width:100%;margin-top:8px;font-weight:800;font-size:14px">'+(allOn?"\u2713 ":"")+'All leagues</button>'
      +'<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px" role="group" aria-label="Leagues">'+grid+'</div>'
      +'<p class="note" style="margin:8px 0 0;font-size:11px">Tap a league to add or remove it. At least one league stays selected'+(sel.length===1?(" \u2014 "+esc(sel[0])+" can\u2019t be removed on its own"):"")+'. Selected: '+esc(selLong)+'.</p>'
      +'</div>';
  }
  var h='<section aria-label="Make me a Lay generator"><div class="card" style="padding:16px;margin-top:12px">'
    +'<h2 class="display" style="font-size:21px">Make me a Lay \u00B7 '+esc(selLong)+'</h2>'
    +'<p class="sub" style="margin:5px 0 0">'
    +(mixed
      ? 'A fresh random parlay drawn from the selected leagues\u2019 top props by L10 hit rate ('+esc(selLong)+') \u2014 legs can mix those leagues freely, player props and team props together, Over at their current research lines. Every press of Generate builds a completely new lay.'
      : 'A fresh random parlay drawn from the '+esc(sel[0]||state.league)+' board\u2019s top props by L10 hit rate \u2014 player props and team props together, Over at their current research lines. Every press of Generate builds a completely new lay.')
    +'</p>'
    +'<div style="margin-top:12px"><span class="sub" style="font-weight:800;letter-spacing:.05em;font-size:11px">LEGS</span>'
    +'<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap" role="group" aria-label="Number of legs">'+legsHtml+'</div></div>'
    +'<div style="margin-top:12px"><label class="fl" for="layMin">Min hit rate</label>'
    +'<select class="sel" id="layMin" aria-label="Minimum L10 hit rate" style="width:auto;margin-top:6px;font-weight:800">'
    +[50,70,80,90].map(function(v){return '<option value="'+v+'"'+(lay.minPct===v?" selected":"")+'>'+v+'%+</option>';}).join("")
    +'</select>'
    +'<p class="note" style="margin:6px 0 0;font-size:11px">Higher chance to hit: only props whose L10 hit rate clears the bar can be dealt.</p></div>'
    +'<div style="margin-top:12px" id="layPickerWrap"><span class="sub" style="font-weight:800;letter-spacing:.05em;font-size:11px">MIX LEAGUES</span>'
    +'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">'
    +'<button type="button" id="layMixBtn" aria-expanded="'+lay.pickerOpen+'" aria-haspopup="true" aria-label="Mix leagues: '+esc(selShort)+' \u2014 choose leagues to mix" style="'+((mixed||lay.pickerOpen)?"background:var(--text);color:var(--bg);border-color:var(--text)":"background:var(--surface2);color:var(--text)")+';border:1px solid var(--border);border-radius:9px;height:36px;padding:0 12px;font-weight:800;font-size:14px;max-width:100%">Mix leagues: '+esc(selShort)+' '+(lay.pickerOpen?"\u25B4":"\u25BE")+'</button>'
    +'<p class="note" style="margin:0;font-size:11px" aria-live="polite">Pool: '+pool.length+' prop'+(pool.length===1?"":"s")+' at '+lay.minPct+'%+ \u00B7 '+esc(selLong)+'</p>'
    +'</div>'+pickerHtml+'</div>'
    +'<button type="button" class="btn primary block" data-laygen style="margin-top:14px;padding:13px;font-size:16px" '+(pool.length?"":"disabled")+'>'+(gen?"Generate again":"Generate")+'</button>'
    +(gen?'<p class="note" style="margin:8px 0 0;text-align:center;font-size:11px">'+(isJordan?"Jordan Parlay":"Lay #"+lay.genCount)+' \u00B7 drawn from a pool of '+(meta?meta.poolSize:pool.length)+(meta?' at '+meta.minPct+'%+':'')+' \u2014 press Generate again for a different one.</p>':"")
    +'</div>';
  if(!gen){
    h+='<div class="card" style="padding:26px 18px;margin-top:12px;text-align:center"><h3 class="display" style="margin:0;font-size:19px">No lay yet</h3>'
      +'<p class="note">Pick how many legs you want, then press Generate and a random lay from today\u2019s top props will appear here.</p></div>';
    return h+'</section>';
  }
  if(!gen.length){
    h+='<div class="card" style="padding:18px;margin-top:12px"><p class="note" style="margin:0">'+(meta?("No props at "+meta.minPct+"%+ right now \u2014 lower the minimum hit rate or try Refresh at the top."):"No top props available to draw from yet \u2014 try Refresh at the top.")+'</p></div>';
    return h+'</section>';
  }
  h+='<div class="card" style="padding:16px;margin-top:12px"><div style="display:flex;justify-content:space-between;align-items:flex-end;gap:10px;flex-wrap:wrap"><div>'
    +(isJordan?'<h3 class="display" style="margin:0;font-size:21px">Jordan Parlay</h3>':"")
    +'<p class="sub" style="margin:0;font-weight:800;letter-spacing:.05em">'+gen.length+' LEG'+(gen.length===1?"":"S")+' \u00B7 ALL MUST HIT</p>'
    +'<p class="rate display tnum" style="font-size:38px;margin-top:4px">'+(Math.round(combined*1000)/10)+'%</p>'
    +'<p class="sub" style="margin:2px 0 0">combined hit-rate estimate</p></div>'
    +'</div>'
    +(meta&&gen.length<meta.requested?'<p style="margin:10px 0 0;font-size:11px;font-weight:700;color:var(--warn)">Only '+meta.dealable+' prop'+(meta.dealable===1?"":"s")+' at '+meta.minPct+'%+ right now \u2014 made a '+gen.length+'-leg lay.</p>':"")
    +'<p class="note" style="margin-top:10px">Estimate multiplies each leg\u2019s L10 hit rate, treating legs as independent \u2014 a research gauge, not a sportsbook payout. Lines are research lines from player averages.</p></div>';
  h+='<div data-testid="generated-lay">';
  gen.forEach(function(it){ h+=layTagsHtml(it,showTags)+(it.kind==="team"?layTeamCard(it):layPropCard(it)); });
  h+='</div>';
  h+='<button type="button" class="btn block" data-laygen style="margin-top:12px">Generate a new lay</button>';
  return h+'</section>';
}

/* ---------- render ---------- */
function renderTabs(){
  var lc=liveCount(state.league); var tabs=[["discover","Discover",0],["live","Live",lc],["propwatch","Prop Watch",0],["workstation","Workstation",0],["cheatsheet","Cheatsheet",0],["logs","Logs",0],["makelay","Make me a Lay",0]];
  if(state.league==="NBA")tabs.push(["injuries","Injuries",0]);
  var TAB_ROUTES={discover:"",live:"live/",propwatch:"prop-watch/",workstation:"workstation/",cheatsheet:"cheatsheet/",logs:"logs/",makelay:"make-me-a-lay/",injuries:"injuries/"};
  var TAB_BASE=window.LEGLOCK_BASE||"";
  document.getElementById("tabBar").innerHTML=tabs.map(function(t){
    var href=TAB_BASE+(TAB_ROUTES[t[0]]||""); if(!href)href="./";
    return '<a href="'+href+'" data-tab="'+t[0]+'"'+(state.tab===t[0]?' aria-current="page"':'')+'><span class="tab-label">'+t[1]+'</span>'+(t[2]?'<span class="tab-count" aria-label="'+t[2]+' selected">'+t[2]+'</span>':'')+'</a>';
  }).join("");
}
function renderLeagues(){
  document.getElementById("leagueSwitch").innerHTML=LEAGUES.map(function(l){
    return '<button type="button" data-league="'+l+'" aria-pressed="'+(state.league===l)+'">'+l+'</button>';
  }).join("");
  document.querySelectorAll("#leagueSwitch [data-league]").forEach(function(btn){
    btn.addEventListener("click",function(){closeWatchPopup();state.league=btn.getAttribute("data-league");state.ws.stat="all";state.ws.shown=WS_PAGE;if(state.tab==="injuries"&&state.league!=="NBA")state.tab="discover";renderLeagues();renderTabs();render();refreshStatusForLeague();if(state.tab==="propwatch")ensurePropWatch();autoLater(function(){maybeAutoRefresh();});});
  });
}
function bindSteppers(scope){
  (scope||document).querySelectorAll("[data-step]").forEach(function(btn){
    btn.addEventListener("click",function(){
      var pid=btn.getAttribute("data-pid"), delta=parseFloat(btn.getAttribute("data-step"));
      var p=null; board().props.forEach(function(x){if(x.id===pid)p=x;}); if(!p)return;
      var nl=Math.round((lineFor(p)+delta)*2)/2; if(nl<0.5)nl=0.5;
      setLine(p,nl);
      if(state.detail)renderModal(); else render();
    });
  });
}
function bindPropCards(scope){
  bindSteppers(scope);
  scope.querySelectorAll("[data-detail]").forEach(function(btn){
    btn.addEventListener("click",function(){openDetail(btn.getAttribute("data-detail"));});
  });
}
function bindView(){
  var view=document.getElementById("view");
  bindPropCards(view);
  bindTeamCards(view);
  view.querySelectorAll("[data-live-game]").forEach(function(btn){
    btn.addEventListener("click",function(){openLiveGame(btn.getAttribute("data-live-game"));});
  });
  view.querySelectorAll("[data-watch-game]").forEach(function(btn){
    btn.addEventListener("click",function(){openWatchGame(btn.getAttribute("data-watch-game"));});
  });
  view.querySelectorAll("[data-refresh-live]").forEach(function(btn){
    btn.addEventListener("click",function(){refreshLiveScores(true);});
  });
  view.querySelectorAll("[data-pw-toggle]").forEach(function(btn){
    btn.addEventListener("click",function(){
      var key=btn.getAttribute("data-pw-toggle");
      var open=state.pwOpen[key]===true;
      state.pwOpen[key]=!open;
      btn.setAttribute("aria-expanded",open?"false":"true");
      var body=document.getElementById(btn.getAttribute("aria-controls"));
      if(body)body.hidden=open;
    });
  });
  view.querySelectorAll("[data-glstat]").forEach(function(btn){
    btn.addEventListener("click",function(){state.gl.stat=btn.getAttribute("data-glstat");render();});
  });
  view.querySelectorAll("[data-glog]").forEach(function(btn){
    btn.addEventListener("click",function(){openDetail(btn.getAttribute("data-glog"),btn.getAttribute("data-gstat"));});
  });
  if(state.tab==="injuries"){
    view.querySelectorAll("[data-inj-refresh]").forEach(function(btn){btn.addEventListener("click",function(){fetchInjuries(true);});});
    var iq=document.getElementById("injSearch");
    if(iq)iq.addEventListener("input",function(){state.inj.q=iq.value;var pos=iq.selectionStart;render();var q2=document.getElementById("injSearch");if(q2){q2.focus();try{q2.setSelectionRange(pos,pos);}catch(e){}}});
  }
  if(state.tab==="workstation"){
    var s=document.getElementById("wsSearch");
    if(s)s.addEventListener("input",function(){state.ws.search=s.value;state.ws.shown=WS_PAGE;var pos=s.selectionStart;render();var s2=document.getElementById("wsSearch");s2.focus();try{s2.setSelectionRange(pos,pos);}catch(e){}});
    view.querySelectorAll("[data-stat]").forEach(function(btn){btn.addEventListener("click",function(){state.ws.stat=btn.getAttribute("data-stat");state.ws.shown=WS_PAGE;render();});});
    var mn=document.getElementById("wsMin");
    if(mn)mn.addEventListener("input",function(){
      state.ws.min=Number(mn.value);
      var lv=document.getElementById("wsMinVal"); if(lv)lv.textContent=wsMinLabel(state.ws.min);
      var res=document.getElementById("wsResults");
      if(res){res.innerHTML=wsResultsHtml(filteredWs()); bindPropCards(res); bindWsMore(res);}
    });
    var so=document.getElementById("wsSort"); if(so)so.addEventListener("change",function(){state.ws.sort=so.value;state.ws.shown=WS_PAGE;render();});
    bindWsMore(view);
  }
  if(state.tab==="cheatsheet"){
    var w=document.getElementById("csWin"); if(w)w.addEventListener("change",function(){state.cs.win=w.value;render();});
    var cm=document.getElementById("csMin"); if(cm)cm.addEventListener("input",function(){state.cs.minPct=Number(cm.value);render();});
    var dc=document.getElementById("csDlCsv"); if(dc)dc.addEventListener("click",function(){
      var head=["Rank","Player","Team","Stat","Line","Hit Rate %","Hits","Games","Window","League"];
      var lines=[head.join(",")];
      lastCs.forEach(function(r,i){lines.push([i+1,r.p.playerName,r.p.teamAbbr,r.p.statLabel,fmtLine(r.line),r.rate,r.w.h,r.w.n,state.cs.win.toUpperCase(),state.league].map(csvCell).join(","));});
      saveBlob(new Blob([lines.join("\n")],{type:"text/csv"}),"cheatsheet-"+state.league.toLowerCase()+".csv"); toast("Cheatsheet CSV downloading");
    });
    var dt=document.getElementById("csDlTxt"); if(dt)dt.addEventListener("click",function(){
      var out=["CHEATSHEET — "+state.league+" · "+state.cs.win.toUpperCase()+" window · min "+state.cs.minPct+"%","Data: "+dataLabel(state.league),""];
      lastCs.forEach(function(r,i){out.push((i+1)+". "+r.p.playerName+" ("+r.p.teamAbbr+") — Over "+fmtLine(r.line)+" "+r.p.statLabel+" · "+r.rate+"% ("+r.w.h+"/"+r.w.n+")");});
      saveBlob(new Blob([out.join("\n")],{type:"text/plain"}),"cheatsheet-"+state.league.toLowerCase()+".txt"); toast("Cheatsheet file downloading");
    });
  }
  if(state.tab==="makelay"){
    view.querySelectorAll("[data-laylegs]").forEach(function(btn){btn.addEventListener("click",function(){state.lay.legs=Number(btn.getAttribute("data-laylegs"));render();});});
    var lm=document.getElementById("layMin"); if(lm)lm.addEventListener("change",function(){state.lay.minPct=Number(lm.value);render();});
    var mb=document.getElementById("layMixBtn"); if(mb)mb.addEventListener("click",function(){state.lay.pickerOpen=!state.lay.pickerOpen;render();});
    view.querySelectorAll("[data-laydone]").forEach(function(btn){btn.addEventListener("click",function(){state.lay.pickerOpen=false;render();});});
    view.querySelectorAll("[data-layall]").forEach(function(btn){btn.addEventListener("click",function(){state.lay.selected=LEAGUES.slice();render();});});
    view.querySelectorAll("[data-laytoggle]").forEach(function(btn){btn.addEventListener("click",function(){
      var lg=btn.getAttribute("data-laytoggle"), sel=laySelected();
      if(sel.indexOf(lg)>=0){ if(sel.length<=1){toast("At least one league must stay selected");return;} state.lay.selected=sel.filter(function(x){return x!==lg;}); }
      else{ state.lay.selected=LEAGUES.filter(function(x){return x===lg||sel.indexOf(x)>=0;}); }
      render();
    });});
    view.querySelectorAll("[data-laygen]").forEach(function(btn){btn.addEventListener("click",function(){layGenerate();});});
    view.querySelectorAll("[data-laystep]").forEach(function(btn){btn.addEventListener("click",function(){
      var lg=btn.getAttribute("data-laylg"), kind=btn.getAttribute("data-laykind"), pp=findLayProp(lg,kind,btn.getAttribute("data-laypid")); if(!pp)return;
      var nl=Math.round((lineForLg(lg,pp)+parseFloat(btn.getAttribute("data-laystep")))*2)/2; if(nl<0.5)nl=0.5;
      state.lineOverrides[lg+":"+pp.id]=nl; lineRev++; render();
    });});
    view.querySelectorAll("[data-laydetail]").forEach(function(btn){btn.addEventListener("click",function(){openDetailLg(btn.getAttribute("data-laylg"),btn.getAttribute("data-laydetail"));});});
    view.querySelectorAll("[data-laytdetail]").forEach(function(btn){btn.addEventListener("click",function(){openTeamDetailLg(btn.getAttribute("data-laylg"),btn.getAttribute("data-laytdetail"));});});
  }
}
function render(){
  var view=document.getElementById("view");
  var b=board();
  var meta='<p class="note" style="margin-top:12px">'+state.league+(b.seasonLabel?' · '+esc(b.seasonLabel)+' season':"")+' · '+b.props.length+' props from '+b.players.length+' tracked players · '+esc(dataLabel(state.league))+'</p>';
  var body= state.tab==="discover"?viewDiscover(): state.tab==="live"?viewLive(): state.tab==="propwatch"?viewPropWatch(): state.tab==="workstation"?viewWorkstation(): state.tab==="cheatsheet"?viewCheatsheet(): state.tab==="logs"?viewGameLogs(): state.tab==="makelay"?viewMakeLay(): state.tab==="injuries"&&state.league==="NBA"?viewInjuries(): viewDiscover();
  view.innerHTML=meta+body;
  bindView();
}

/* ---------- init ---------- */
document.getElementById("footDate").textContent=FETCHED_LABEL;
/* Light/Dark toggle: flips html[data-theme] and stores the choice in
   localStorage ("lm-theme"); the head script re-applies it before first
   paint on reload. Nothing else changes the palette — the page never
   follows the device appearance. */
function themeNow(){return document.documentElement.getAttribute("data-theme")==="dark"?"dark":"light";}
function syncThemeBtn(){
  var b=document.getElementById("themeToggle"); if(!b)return;
  var d=themeNow()==="dark";
  b.textContent=d?"\u263E Dark":"\u2600 Light";
  b.setAttribute("aria-pressed",d?"true":"false");
  b.setAttribute("aria-label",d?"Switch to light mode":"Switch to dark mode");
}
var themeBtnEl=document.getElementById("themeToggle");
if(themeBtnEl)themeBtnEl.addEventListener("click",function(){
  var next=themeNow()==="dark"?"light":"dark";
  document.documentElement.setAttribute("data-theme",next);
  try{window.localStorage.setItem("lm-theme",next);}catch(e){}
  syncThemeBtn();
});
syncThemeBtn();
document.addEventListener("pointerdown",function(e){
  if(state.lay&&state.lay.pickerOpen){
    var wrap=document.getElementById("layPickerWrap");
    if(wrap&&!wrap.contains(e.target)){state.lay.pickerOpen=false; if(state.tab==="makelay")render();}
  }
});
var refreshBtnEl=document.getElementById("refreshBtn"); if(refreshBtnEl)refreshBtnEl.addEventListener("click",function(){refreshLiveScores(true);});
refreshStatusForLeague();
document.addEventListener("keydown",function(e){if(e.key!=="Escape")return; if(state.detail)closeModal(); else if(state.teamDetail)closeTeamModal(); else if(infoOpen)closeInfoModal(); else if(state.watchGameId)closeWatchPopup(); else if(state.liveGameId)closeLivePopup();});
bindInfoFooter();
/* Eager preparation: sort every league's baked boards best-first and
   build every league's Prop Watch props before the first render. */
sortAllBoards();
LEAGUES.forEach(function(lg){rebuildPwProps(lg);});
renderLeagues(); renderTabs(); render();
if(state.tab==="injuries"&&typeof fetch==="function")ensureInjuries(); if(state.tab==="propwatch")ensurePropWatch();
/* Opening online auto-pulls the selected league's game logs and rebuilds
   its board (see maybeAutoRefresh); offline it stays on the snapshot.
   In app mode the board has just painted from the baked snapshot, so
   the status line says the refresh is coming in the background and
   autoLater defers the pull by ~1.2s; in a browser the pull fires
   immediately, exactly as before. */
if(APP_MODE&&typeof fetch==="function")setRefreshStatus("","App mode · paints instantly — Refreshing in background…");
autoLater(function(){maybeAutoRefresh();});
