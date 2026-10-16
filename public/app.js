// PopSync client
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = t => { t = Math.max(0, Math.floor(t || 0)); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
const EMOJIS = ['🔥', '😂', '😱', '😍', '👏', '🍿', '💀', '🎉'];

const S = {
  cid: sessionStorage.ps_cid || (sessionStorage.ps_cid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)), // per tab, survives reloads
  name: localStorage.ps_name || '', room: null, host: null, free: true,
  state: null, members: [], playlist: [], poll: null, history: [], chat: [],
  offset: 0, samples: [], drift: 0, corrections: 0,
  ws: null, retry: 0, rtimer: null, fatal: false, everJoined: false, needTap: false
};
const serverNow = () => Date.now() + S.offset;
const isHost = () => S.host === S.cid;
const canControl = () => S.free || isHost();

// ---------------- landing ----------------
const qs = new URLSearchParams(location.search);
$('#nameIn').value = S.name;
$('#codeIn').value = (qs.get('room') || '').toUpperCase();
if (qs.get('room')) { $('#joinBtn').textContent = 'Join party'; $('#createBtn').classList.add('ghost'); }
function enter(create) {
  const name = $('#nameIn').value.trim(); const code = $('#codeIn').value.trim().toUpperCase();
  if (!name) return ($('#landErr').textContent = 'Add your name first 🙂');
  if (!create && !/^[A-Z0-9]{6}$/.test(code)) return ($('#landErr').textContent = 'Room codes have 6 characters');
  S.name = localStorage.ps_name = name; S.room = create ? null : code; S.create = create;
  $('#landing').classList.add('hide'); $('#room').classList.remove('hide');
  connect();
}
$('#createBtn').onclick = () => enter(true);
$('#joinBtn').onclick = () => enter(false);
$('#codeIn').addEventListener('keydown', e => e.key === 'Enter' && enter(false));
$('#nameIn').addEventListener('keydown', e => e.key === 'Enter' && enter(!$('#codeIn').value.trim()));

// ---------------- connection ----------------
const send = m => S.ws?.readyState === 1 && S.ws.send(JSON.stringify(m));
function setConn(state) {
  const map = { connecting: ['', 'Connecting…'], live: ['on', 'Live'], reconnecting: ['', 'Reconnecting…'], off: ['off', 'Offline'] };
  $('#conn .dot').className = 'dot ' + map[state][0]; $('#connTxt').textContent = map[state][1];
}
function connect() {
  clearTimeout(S.rtimer);
  setConn(S.everJoined ? 'reconnecting' : 'connecting');
  const ws = S.ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => {
    S.retry = 0; S.samples = []; ping();
    const join = { t: 'join', name: S.name, cid: S.cid };
    if (S.create && !S.room) join.create = true;
    else { join.room = S.room; if (S.everJoined) { join.resume = true; join.restore = restoreData(); } }
    send(join);
  };
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = e => {
    if (ws !== S.ws || S.fatal) return;
    if (e.code === 4000) { S.fatal = true; setConn('off'); return toast('This party is open in another tab with the same session', 6000); }
    setConn('reconnecting');
    S.rtimer = setTimeout(connect, Math.min(5000, 300 * 2 ** S.retry++));
  };
}
// what we know about the room, in case the server restarted and lost it
const restoreData = () => S.state && { src: S.state.src, title: S.state.title, pos: expected(), playing: S.state.playing, playlist: S.playlist.map(p => ({ title: p.title, src: p.src, thumb: p.thumb, by: p.by })) };
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.everJoined && (!S.ws || S.ws.readyState > 1)) { S.retry = 0; connect(); } });

// ---------------- clock sync (NTP-style) ----------------
function ping() { send({ t: 'ping', c: Date.now() }); }
setInterval(ping, 2000);
let lastPong = Date.now();
setInterval(() => { if (S.ws?.readyState === 1 && Date.now() - lastPong > 7000) S.ws.close(); }, 2000); // dead link → reconnect
function onPong(m) {
  lastPong = Date.now();
  const rtt = Date.now() - m.c, off = m.s + rtt / 2 - Date.now();
  S.samples.push({ rtt, off }); if (S.samples.length > 10) S.samples.shift();
  S.offset = S.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off; // use the fastest round trip: least noisy
}

// ---------------- messages ----------------
function handle(m) {
  switch (m.t) {
    case 'pong': return onPong(m);
    case 'snapshot':
      S.everJoined = true; S.room = m.room; S.host = m.host; S.free = m.free; S.members = m.members;
      S.playlist = m.playlist; S.poll = m.poll; S.history = m.history; S.chat = m.chat; S.state = null;
      history.replaceState(null, '', '?room=' + m.room);
      $('#roomCode').textContent = m.room; setConn('live');
      applyState(m.s, null); renderAll(); renderStats(m.stats);
      return;
    case 'err':
      if (m.code === 'noroom' && S.everJoined) return; // keep retrying with resume
      S.fatal = true; S.ws.close();
      $('#room').classList.add('hide'); $('#landing').classList.remove('hide'); $('#landErr').textContent = m.msg;
      return;
    case 'state': {
      if (m.from && m.from !== S.cid && m.sent) send({ t: 'lat', ms: Math.max(0, Math.round(serverNow() - m.sent)) }); // propagation sample
      applyState(m.s, m);
      return;
    }
    case 'members': S.members = m.list; S.host = m.host; S.free = m.free; renderPeople(); renderControls(); renderPlaylist(); renderPoll(); return;
    case 'tick': S.members = m.list; renderPeople(); renderStats(m.stats); return;
    case 'playlist': S.playlist = m.list; renderPlaylist(); renderReco(); return;
    case 'chat': S.chat.push(m.m); if (S.chat.length > 100) S.chat.shift(); addMsg(m.m); return;
    case 'react': if (m.from !== S.cid) floatEmoji(m.e, m.name); return;
    case 'poll': S.poll = m.poll; renderPoll(); return;
    case 'toast': return toast(m.msg);
  }
}

// ---------------- playback sync ----------------
function expected() {
  const s = S.state; if (!s) return 0;
  const now = serverNow();
  if (!s.playing || now < s.at) return s.pos;
  return s.pos + (now - s.at) / 1000 * s.rate;
}
function applyState(s, meta) {
  if (S.state && s.v < S.state.v) return; // stale
  const srcChanged = !S.state || S.state.src !== s.src;
  S.state = s;
  if (srcChanged) {
    $('#empty').classList.toggle('hide', !!s.src);
    $('#nowTitle').textContent = s.title || '–';
    if (s.src) Player.load(s.src); else Player.destroy();
    if (s.src) S.history.push({ src: s.src, title: s.title, cats: (CATALOG.find(c => c.src === s.src) || {}).cats || [] });
    renderReco();
  }
  if (meta?.by && meta.a && meta.from !== S.cid) {
    const label = { play: '▶ played', pause: '⏸ paused', seek: '⏩ jumped to ' + fmt(s.pos), countdown: '⏳ started a countdown', load: '🎬 started a video' }[meta.a];
    if (label) toast(`${meta.by} ${label}`);
  }
  renderControls(); syncTick();
}
Player.onReady = () => { syncTick(); renderControls(); };
Player.onEnded = () => { if (S.state) send({ t: 'ended', v: S.state.v }); };
Player.onError = msg => toast(msg, 5000);

// The drift loop: compare where the video is with where the room says it should be.
function syncTick() {
  const s = S.state;
  if (!s || !s.src || !Player.ready || S.needTap) return;
  const now = serverNow(), exp = expected();
  const waiting = s.playing && now < s.at;
  showCountdown(waiting ? Math.ceil((s.at - now) / 1000) : 0);
  if (!s.playing || waiting) {
    if (!Player.paused()) Player.pause();
    if (Math.abs(Player.time() - exp) > 0.25) Player.seek(exp);
    Player.setRate(1); S.drift = 0; return;
  }
  if (Player.paused()) {
    Player.seek(exp);
    Player.play().catch(() => { S.needTap = true; $('#tapover').classList.remove('hide'); });
    return;
  }
  const d = Player.time() - exp; S.drift = d;
  if (Math.abs(d) > 0.5) { Player.seek(exp + (Player.kind === 'yt' ? 0.12 : 0.03)); Player.setRate(1); S.corrections++; } // hard correction
  else if (Player.canRate && Math.abs(d) > 0.08) Player.setRate(1 - Math.max(-0.08, Math.min(0.08, d * 0.5)));          // gentle catch-up
  else Player.setRate(1);
}
setInterval(syncTick, 400);
setInterval(() => { if (S.state?.playing && Player.ready && S.ws?.readyState === 1) send({ t: 'drift', ms: Math.abs(S.drift) * 1000 }); }, 2000);
$('#tapover').onclick = () => { S.needTap = false; $('#tapover').classList.add('hide'); syncTick(); };

function showCountdown(n) {
  const el = $('#countdown');
  if (n > 0) { el.textContent = n; el.classList.remove('hide'); } else el.classList.add('hide');
}

// ---------------- controls ----------------
function ctl(a, pos) { send({ t: 'ctl', a, pos, sent: Math.round(serverNow()) }); }
$('#playBtn').onclick = () => { if (!S.state?.src) return; S.state.playing && serverNow() >= S.state.at ? ctl('pause', Player.time()) : ctl('play', Player.time()); };
$('#cdBtn').onclick = () => S.state?.src && ctl('countdown', Player.time());
let dragging = false;
$('#seek').addEventListener('input', () => { dragging = true; $('#tNow').textContent = fmt(+$('#seek').value); });
$('#seek').addEventListener('change', () => { dragging = false; ctl('seek', +$('#seek').value); });
let muted = false;
$('#muteBtn').onclick = () => { muted = !muted; $('#muteBtn').textContent = muted ? '🔇' : '🔊'; Player.setVolume(+$('#vol').value, muted); };
$('#vol').oninput = () => Player.setVolume(+$('#vol').value, muted);
$('#fsBtn').onclick = () => document.fullscreenElement ? document.exitFullscreen() : $('#screen').requestFullscreen?.();
document.addEventListener('keydown', e => { if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && !$('#room').classList.contains('hide')) { e.preventDefault(); $('#playBtn').click(); } });

function renderControls() {
  const ok = canControl() && !!S.state?.src;
  $('#controls').classList.toggle('locked', !canControl());
  for (const el of ['#playBtn', '#seek', '#cdBtn']) $(el).disabled = !ok;
  $('#controls').title = canControl() ? '' : 'The host has locked playback controls';
  const playing = S.state?.playing && serverNow() >= S.state.at;
  $('#playBtn').textContent = playing ? '⏸' : '▶';
}
(function frame() { // smooth seek bar
  if (Player.ready) {
    const d = Player.duration(); $('#seek').max = d || 100; $('#tDur').textContent = fmt(d);
    if (!dragging) { const t = Player.time(); $('#seek').value = t; $('#tNow').textContent = fmt(t); }
  }
  renderControls();
  requestAnimationFrame(frame);
})();

function renderStats(st) {
  if (!st) return;
  $('#latChip').textContent = st.p95 != null ? `p95 ${st.p95} ms` : 'p95 –';
  $('#latChip').title = `Play/pause propagation in this room: p50 ${st.p50 ?? '–'} ms, p95 ${st.p95 ?? '–'} ms (${st.samples} samples)`;
}
setInterval(() => {
  const ms = Math.round(Math.abs(S.drift) * 1000);
  $('#driftChip').textContent = S.state?.playing ? `drift ${ms} ms` : 'drift –';
  $('#driftChip').style.color = ms < 150 ? 'var(--ok)' : ms < 500 ? 'var(--warn)' : 'var(--bad)';
}, 500);

// ---------------- invite / QR ----------------
const invite = () => `${location.origin}/?room=${S.room}`;
$('#codeChip').onclick = async () => { try { await navigator.clipboard.writeText(invite()); toast('🔗 Invite link copied! Send it to your friends'); } catch { prompt('Copy this invite link:', invite()); } };
$('#qrBtn').onclick = () => { $('#qrImg').src = '/qr.svg?d=' + encodeURIComponent(invite()); $('#qrLink').textContent = invite(); $('#qrModal').classList.remove('hide'); };
$('#qrClose').onclick = () => $('#qrModal').classList.add('hide');

// ---------------- reactions + hype ----------------
$('#reactions').innerHTML = EMOJIS.map(e => `<button data-e="${e}" aria-label="React ${e}">${e}</button>`).join('');
$('#reactions').onclick = e => { const b = e.target.closest('button'); if (!b) return; send({ t: 'react', e: b.dataset.e }); floatEmoji(b.dataset.e, 'You'); };
let hype = 0, hypeCooldown = 0;
function floatEmoji(e, who) {
  const f = document.createElement('div'); f.className = 'floater';
  f.style.left = (8 + Math.random() * 84) + '%'; f.style.setProperty('--dx', (Math.random() * 80 - 40) + 'px');
  f.innerHTML = `${e}<small>${esc(who)}</small>`;
  $('#floaters').appendChild(f); setTimeout(() => f.remove(), 2700);
  hype = Math.min(100, hype + 7);
  if (hype >= 100 && Date.now() > hypeCooldown) hypeMode();
}
function hypeMode() {
  hypeCooldown = Date.now() + 12000; hype = 45;
  $('#hypeMode').classList.remove('hide'); setTimeout(() => $('#hypeMode').classList.add('hide'), 1800);
  const colors = ['#FF3D8B', '#FFD23F', '#2EE6D6', '#9B7BFF', '#fff'];
  for (let i = 0; i < 70; i++) {
    const c = document.createElement('i'); c.className = 'confetti';
    c.style.left = Math.random() * 100 + '%'; c.style.background = colors[i % colors.length]; c.style.animationDelay = Math.random() * .5 + 's';
    $('#floaters').appendChild(c); setTimeout(() => c.remove(), 2600);
  }
}
setInterval(() => {
  hype = Math.max(0, hype - 2);
  $('#hypeFill').style.width = hype + '%';
  $('#hypeTxt').textContent = hype > 70 ? 'The room is going wild 🔥🔥' : hype > 30 ? 'Hype is building… 🔥' : 'Hype meter: react to fill it 🔥';
}, 250);

// ---------------- tabs ----------------
function tab(name) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('hide', p.id !== 'pane-' + name));
}
$('#tabs').onclick = e => { const b = e.target.closest('button'); if (b) tab(b.dataset.tab); };
$('#emptyDiscover').onclick = () => tab('discover');
$('#emptyLink').onclick = () => { tab('playlist'); $('#linkIn').focus(); };

// ---------------- chat ----------------
function addMsg(m) {
  const box = $('#chatList'), near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const d = document.createElement('div');
  d.className = 'msg' + (m.sys ? ' sys' : '');
  d.innerHTML = m.sys ? esc(m.text) : `<b style="color:${m.color}">${esc(m.name)}</b>${esc(m.text)}`;
  box.appendChild(d); if (near) box.scrollTop = box.scrollHeight;
}
function renderChat() { $('#chatList').innerHTML = ''; S.chat.forEach(addMsg); $('#chatList').scrollTop = 1e9; }
$('#chatForm').onsubmit = e => { e.preventDefault(); const t = $('#chatIn').value.trim(); if (t) send({ t: 'chat', text: t }); $('#chatIn').value = ''; };

// ---------------- discover: categories, filters, fuzzy search, recommendations ----------------
let cat = 'All';
$('#cats').innerHTML = CATEGORIES.map(c => `<button data-c="${c}" class="${c === 'All' ? 'on' : ''}">${c}</button>`).join('');
$('#cats').onclick = e => { const b = e.target.closest('button'); if (!b) return; cat = b.dataset.c; document.querySelectorAll('#cats button').forEach(x => x.classList.toggle('on', x === b)); renderDiscover(); };
['#search', '#fLen', '#fSort'].forEach(id => $(id).addEventListener('input', renderDiscover));

const norm = s => s.toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, ' ');
function lev(a, b) { // edit distance, for typos like "sintl" → "sintel"
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { let prev = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
  return d[b.length];
}
function fuzzy(q, item) {
  q = norm(q).trim(); if (!q) return 1;
  const hay = norm([item.title, ...item.cats, ...item.tags, item.year].join(' '));
  if (hay.includes(q)) return 100 - hay.indexOf(q) * 0.1;
  const words = hay.split(/\s+/).filter(Boolean); let total = 0;
  for (const qw of q.split(/\s+/)) {
    let best = 0;
    for (const w of words) {
      if (w.startsWith(qw)) best = Math.max(best, 40);
      else { const dist = Math.min(lev(qw, w), lev(qw, w.slice(0, qw.length))); const tol = qw.length <= 3 ? 0 : qw.length <= 5 ? 1 : 2; if (dist <= tol) best = Math.max(best, 30 - dist * 8); }
    }
    if (!best) return 0; total += best;
  }
  return total;
}
function card(item, compact) {
  const i = CATALOG.indexOf(item);
  return `<div class="card"><div class="th" style="background-image:url('${esc(item.thumb)}')"><span class="rt">★ ${item.rating}</span></div>
    <div class="bd"><div class="tt">${esc(item.title)}</div><div class="mt">${item.year} · ${item.mins} min · ${item.cats.slice(0, 2).join(', ')}</div>
    ${compact ? '' : `<div class="mt">${esc(item.blurb)}</div>`}
    <div class="bt"><button data-play="${i}" ${canControl() ? '' : 'disabled'}>▶ Watch</button><button class="ghost" data-add="${i}">+ List</button></div></div></div>`;
}
function renderDiscover() {
  const q = $('#search').value, len = $('#fLen').value, sort = $('#fSort').value;
  let list = CATALOG.map(it => ({ it, s: fuzzy(q, it) })).filter(x => x.s > 0)
    .filter(x => cat === 'All' || x.it.cats.includes(cat))
    .filter(x => len === 'any' || (len === 'short' ? x.it.mins < 5 : x.it.mins >= 5 && x.it.mins <= 15));
  if (q.trim()) list.sort((a, b) => b.s - a.s);
  else list.sort((a, b) => sort === 'new' ? b.it.year - a.it.year : sort === 'az' ? a.it.title.localeCompare(b.it.title) : b.it.rating - a.it.rating);
  $('#resTitle').textContent = q.trim() ? `Results for "${q.trim()}"` : cat === 'All' ? 'All movies' : cat;
  $('#results').innerHTML = list.length ? list.map(x => card(x.it)).join('') : '<p class="empty-note">No matches. Try another word, or paste a link in Playlist.</p>';
  $('#recoWrap').classList.toggle('hide', !!q.trim());
}
function renderReco() { // recommend by the categories this room has watched / queued
  const seen = new Set(S.history.map(h => h.src));
  const w = {}; [...S.history, ...S.playlist.map(p => ({ cats: p.cats || [] }))].forEach(h => (h.cats || []).forEach(c => (w[c] = (w[c] || 0) + 1)));
  const has = Object.keys(w).length;
  const list = CATALOG.filter(c => !seen.has(c.src)).map(c => ({ c, s: c.cats.reduce((a, k) => a + (w[k] || 0) * 2, 0) + c.rating })).sort((a, b) => b.s - a.s).slice(0, 6);
  $('#recoTitle').textContent = has ? 'Picked for this room ✨' : 'Crowd favourites 🔥';
  $('#reco').innerHTML = list.map(x => card(x.c, true)).join('');
}
document.addEventListener('click', e => {
  const p = e.target.closest('[data-play]'), a = e.target.closest('[data-add]');
  if (p) { const it = CATALOG[p.dataset.play]; send({ t: 'load', src: it.src, title: it.title, cats: it.cats }); }
  if (a) { const it = CATALOG[a.dataset.add]; send({ t: 'pl:add', src: it.src, title: it.title, thumb: it.thumb, cats: it.cats }); toast(`➕ Added "${it.title}"`); }
});

// ---------------- playlist ----------------
$('#linkForm').onsubmit = e => {
  e.preventDefault();
  const src = $('#linkIn').value.trim(), act = e.submitter?.value || 'add';
  if (!/^https?:\/\//i.test(src)) return toast('Paste a full link starting with https://');
  const id = ytId(src), title = $('#linkTitle').value.trim() || (id ? 'YouTube video' : decodeURIComponent(src.split('/').pop().split('?')[0]).slice(0, 60) || 'Video');
  const thumb = id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : '';
  send(act === 'play' ? { t: 'load', src, title } : { t: 'pl:add', src, title, thumb });
  $('#linkIn').value = ''; $('#linkTitle').value = '';
};
function renderPlaylist() {
  $('#plCount').textContent = S.playlist.length || '';
  $('#plList').innerHTML = S.playlist.length ? S.playlist.map(p => `
    <div class="pl"><div class="th" style="background-image:url('${esc(p.thumb)}')"></div>
      <div class="info"><b>${esc(p.title)}</b><span class="muted small">added by ${esc(p.by)}</span></div>
      <button class="vote ${p.votes.includes(S.cid) ? 'on' : ''}" data-vote="${p.id}" title="Upvote">▲ ${p.votes.length}</button>
      <button class="icon" data-plplay="${p.id}" title="Play now" ${canControl() ? '' : 'disabled'}>▶</button>
      ${p.byId === S.cid || isHost() ? `<button class="icon" data-plrm="${p.id}" title="Remove">✕</button>` : ''}
    </div>`).join('') : '<p class="empty-note">Nothing queued. Add movies from Discover or paste a link above.</p>';
}
$('#plList').onclick = e => {
  const v = e.target.closest('[data-vote]'), p = e.target.closest('[data-plplay]'), r = e.target.closest('[data-plrm]');
  if (v) send({ t: 'pl:vote', id: v.dataset.vote }); if (p) send({ t: 'pl:play', id: p.dataset.plplay }); if (r) send({ t: 'pl:remove', id: r.dataset.plrm });
};
$('#movieVote').onclick = () => {
  if (S.playlist.length < 2) return toast('Add at least 2 videos to the playlist first');
  send({ t: 'poll:new', kind: 'movie', q: 'What do we watch next? 🍿', options: S.playlist.slice(0, 4).map(p => ({ label: p.title, src: p.src, thumb: p.thumb, pid: p.id })) });
  tab('poll');
};

// ---------------- polls ----------------
function renderPoll() {
  const p = S.poll, box = $('#pollBox');
  if (!p || !p.open && !p.options) return pollForm();
  const counts = p.options.map((_, i) => Object.values(p.votes).filter(v => v === i).length), total = counts.reduce((a, b) => a + b, 0), mine = p.votes[S.cid];
  const canClose = p.open && (p.byId === S.cid || isHost());
  box.innerHTML = `<div class="poll"><div class="muted small">${p.open ? 'Live poll' : 'Poll closed'} · by ${esc(p.by)}</div><h2>${esc(p.q)}</h2>
    ${p.options.map((o, i) => `<button class="opt ${mine === i ? 'mine' : ''}" data-opt="${i}" ${p.open ? '' : 'disabled'}><div class="fill" style="width:${total ? counts[i] / total * 100 : 0}%"></div><span>${esc(o.label)}</span><span class="n">${counts[i]}</span></button>`).join('')}
    <div class="muted small">${total} vote${total === 1 ? '' : 's'}${p.kind === 'movie' ? ' · the winner plays automatically' : ''}</div>
    ${canClose ? '<button id="pollClose">Close poll & show winner</button>' : ''}
    ${!p.open ? '<button class="ghost" id="pollNew">Start a new poll</button>' : ''}</div>`;
}
function pollForm() {
  $('#pollBox').innerHTML = `<div class="poll"><h2>Ask the room 📊</h2>
    <input id="pq" maxlength="140" placeholder="Question, e.g. Snacks break now?">
    <input class="po" maxlength="80" placeholder="Option 1"><input class="po" maxlength="80" placeholder="Option 2"><input class="po" maxlength="80" placeholder="Option 3 (optional)"><input class="po" maxlength="80" placeholder="Option 4 (optional)">
    <button id="pollCreate">Start poll</button><p class="muted small">Tip: the 🗳 Movie vote button in Playlist makes a poll from your queue, and the winner auto-plays.</p></div>`;
}
$('#pollBox').onclick = e => {
  const o = e.target.closest('[data-opt]');
  if (o) return send({ t: 'poll:vote', i: +o.dataset.opt });
  if (e.target.id === 'pollClose') return send({ t: 'poll:close' });
  if (e.target.id === 'pollNew') { S.poll = null; return pollForm(); }
  if (e.target.id === 'pollCreate') send({ t: 'poll:new', q: $('#pq').value, options: [...document.querySelectorAll('.po')].map(i => i.value.trim()).filter(Boolean) });
};

// ---------------- people ----------------
function renderPeople() {
  const on = S.members.filter(m => m.online);
  $('#pplCount').textContent = on.length;
  $('#freeWrap').classList.toggle('hide', !isHost()); $('#freeToggle').checked = S.free;
  $('#pplList').innerHTML = [...S.members].sort((a, b) => b.online - a.online || b.host - a.host).map(m => {
    const d = m.drift, cls = d == null ? '' : d < 150 ? 'g' : d < 500 ? 'y' : 'r';
    return `<div class="person" style="${m.online ? '' : 'opacity:.45'}"><div class="av" style="background:${m.color}">${esc(m.name[0] || '?').toUpperCase()}</div>
      <div class="nm"><b>${esc(m.name)}</b>${m.host ? ' 👑' : ''}${m.id === S.cid ? ' <span class="muted small">(you)</span>' : ''}<br><span class="muted small">${m.online ? 'watching' : 'reconnecting…'}</span></div>
      ${m.online && d != null ? `<span class="badge ${cls}">±${d} ms</span>` : ''}
      ${isHost() && !m.host && m.online ? `<button class="ghost small" data-host="${m.id}">Make host</button>` : ''}</div>`;
  }).join('');
}
$('#pplList').onclick = e => { const b = e.target.closest('[data-host]'); if (b) send({ t: 'host:give', id: b.dataset.host }); };
$('#freeToggle').onchange = e => send({ t: 'free', on: e.target.checked });

// ---------------- misc ----------------
let toastT;
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
function renderAll() { renderChat(); renderDiscover(); renderReco(); renderPlaylist(); renderPoll(); renderPeople(); renderControls(); }
