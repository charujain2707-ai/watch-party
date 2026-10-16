// PopSync server: static files + WebSocket rooms with an authoritative playback state.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QR = require('qrcode');

const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const MAX_USERS = 50, HOST_GRACE = 10000, USER_GRACE = 60000, ROOM_TTL = 10 * 60000;
const EMOJIS = ['🔥', '😂', '😱', '😍', '👏', '🍿', '💀', '🎉'];
const COLORS = ['#FF3D8B', '#FFD23F', '#2EE6D6', '#9B7BFF', '#FF8A3D', '#4ADE80', '#60A5FA', '#F472B6', '#FACC15', '#34D399'];

const rooms = new Map();
const now = () => Date.now();
const uid = () => crypto.randomBytes(4).toString('hex');
const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => { let c; do c = Array.from({ length: 6 }, () => CH[crypto.randomInt(CH.length)]).join(''); while (rooms.has(c)); return c; };
const validSrc = s => typeof s === 'string' && /^https?:\/\/\S+$/i.test(s) && s.length < 2000;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const pct = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p / 100 * a.length))]; };

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/qr.svg') {
    return QR.toString(u.searchParams.get('d') || '', { type: 'svg', margin: 1 }, (e, svg) => { res.writeHead(e ? 500 : 200, { 'Content-Type': 'image/svg+xml' }); res.end(svg || ''); });
  }
  if (u.pathname === '/stats') { // latency + drift numbers for every live room (used in the README measurements)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([...rooms.values()].map(r => ({ room: r.code, online: online(r).length, ...stats(r) })), null, 2));
  }
  let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
  const file = path.join(PUB, path.normalize(p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = MIME[path.extname(file)] || 'application/octet-stream', range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) { // byte ranges let browsers seek inside video files served from /public
      const start = range[1] ? +range[1] : 0, end = range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
});

// ---------- rooms ----------
function makeRoom(code) {
  const r = { code, users: new Map(), host: null, free: true, playlist: [], chat: [], poll: null, history: [], lat: [], timers: {},
    state: { v: 0, src: null, title: '', playing: false, pos: 0, at: now(), rate: 1 } };
  rooms.set(code, r); return r;
}
const online = r => [...r.users.values()].filter(u => u.ws);
// where the video "should" be right now, according to the server clock
const cur = s => (!s.playing || now() < s.at) ? s.pos : s.pos + (now() - s.at) / 1000 * s.rate;
const send = (ws, m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));
const bcast = (r, m) => { const d = JSON.stringify(m); for (const u of r.users.values()) if (u.ws && u.ws.readyState === 1) u.ws.send(d); };
const members = r => [...r.users.values()].map(u => ({ id: u.id, name: u.name, color: u.color, online: !!u.ws, drift: u.drift, host: u.id === r.host }));
const playlist = r => [...r.playlist].sort((a, b) => b.votes.size - a.votes.size || a.added - b.added).map(p => ({ ...p, votes: [...p.votes] }));
const pubPoll = r => r.poll && { ...r.poll, votes: Object.fromEntries(r.poll.votes) };
function stats(r) {
  const d = online(r).map(u => u.drift).filter(x => typeof x === 'number');
  return { p50: pct(r.lat, 50), p95: pct(r.lat, 95), samples: r.lat.length, driftP95: pct(d, 95) };
}
function sys(r, text) { const m = { id: uid(), sys: true, text, t: now() }; r.chat.push(m); if (r.chat.length > 100) r.chat.shift(); bcast(r, { t: 'chat', m }); }
function pushState(r, by, extra = {}) { r.state.v++; bcast(r, { t: 'state', s: { ...r.state, server: now() }, by, ...extra }); }
const canControl = (r, u) => r.free || r.host === u.id;

function load(r, item, byName) {
  Object.assign(r.state, { src: item.src, title: item.title || 'Video', pos: 0, playing: true, at: now() + 2500, rate: 1 }); // 2.5 s countdown so everyone buffers
  r.history.push({ src: item.src, title: item.title, cats: item.cats || [] }); if (r.history.length > 30) r.history.shift();
  pushState(r, byName, { a: 'load' });
  sys(r, `🎬 ${byName} started "${r.state.title}"`);
}
function setHost(r, id, reason) { r.host = id; const u = r.users.get(id); bcast(r, { t: 'members', list: members(r), host: r.host, free: r.free }); if (u) sys(r, `👑 ${u.name} is now the host${reason ? ' (' + reason + ')' : ''}`); }

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, perMessageDeflate: false });
wss.on('connection', ws => {
  ws.isAlive = true; ws.on('pong', () => (ws.isAlive = true));
  ws._socket?.setNoDelay(true);
  let r = null, u = null;

  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf); } catch { return; }
    if (m.t === 'ping') return send(ws, { t: 'pong', c: m.c, s: now() });

    if (m.t === 'join') {
      const cid = clean(m.cid, 40) || uid(), name = clean(m.name, 20) || 'Guest';
      const code = clean(m.room, 6).toUpperCase();
      if (m.create) r = makeRoom(newCode());
      else if (rooms.has(code)) r = rooms.get(code);
      else if (m.resume && /^[A-Z0-9]{6}$/.test(code)) { // server restarted: rebuild the room from the first client that comes back
        r = makeRoom(code);
        const st = m.restore || {};
        if (validSrc(st.src)) Object.assign(r.state, { src: st.src, title: clean(st.title, 120), pos: Math.max(0, +st.pos || 0), playing: !!st.playing, at: now() + 1500 });
        if (Array.isArray(st.playlist)) r.playlist = st.playlist.filter(p => validSrc(p.src)).slice(0, 100).map(p => ({ id: uid(), title: clean(p.title, 120), src: p.src, thumb: validSrc(p.thumb) ? p.thumb : '', cats: [], by: clean(p.by, 20), byId: '', added: now(), votes: new Set() }));
      } else return send(ws, { t: 'err', code: 'noroom', msg: 'That party does not exist. Check the code or start a new one.' });

      u = r.users.get(cid);
      if (!u && online(r).length >= MAX_USERS) { r = null; return send(ws, { t: 'err', code: 'full', msg: 'This party is full.' }); }
      const isNew = !u;
      if (!u) { u = { id: cid, name, color: COLORS[r.users.size % COLORS.length], drift: null, bucket: [] }; r.users.set(cid, u); }
      if (u.ws && u.ws !== ws) u.ws.close(4000, 'replaced');
      u.ws = ws; u.name = name; clearTimeout(u.leaveTimer); clearTimeout(r.timers.empty);
      if (!r.host || !r.users.get(r.host)?.ws && r.host !== cid && online(r).length === 1) r.host = cid;
      if (r.host === cid) clearTimeout(r.timers.host);
      send(ws, { t: 'snapshot', you: cid, room: r.code, host: r.host, free: r.free, s: { ...r.state, server: now() }, members: members(r), playlist: playlist(r), chat: r.chat, poll: pubPoll(r), history: r.history, stats: stats(r) });
      bcast(r, { t: 'members', list: members(r), host: r.host, free: r.free });
      if (isNew) sys(r, `👋 ${u.name} joined the party`);
      return;
    }
    if (!r || !u) return;

    // simple rate limit: 20 messages per second per user (sync traffic is tiny)
    const t = now(); u.bucket = u.bucket.filter(x => t - x < 1000); if (u.bucket.length > 20) return; u.bucket.push(t);

    switch (m.t) {
      case 'ctl': { // play / pause / seek. Server applies actions in arrival order and bumps the version → everyone converges
        if (!r.state.src) return send(ws, { t: 'toast', msg: 'Pick a video first 🎬' });
        if (!canControl(r, u)) return send(ws, { t: 'toast', msg: '🔒 The host has locked the controls' });
        const s = r.state, pos = Number.isFinite(m.pos) ? Math.max(0, m.pos) : cur(s);
        if (m.a === 'play') Object.assign(s, { pos, playing: true, at: now() });
        else if (m.a === 'pause') Object.assign(s, { pos, playing: false, at: now() });
        else if (m.a === 'seek') Object.assign(s, { pos, at: now() });
        else if (m.a === 'countdown') Object.assign(s, { pos, playing: true, at: now() + 3000 }); // synced 3-2-1 start
        else return;
        return pushState(r, u.name, { a: m.a, sent: m.sent, from: u.id });
      }
      case 'load': {
        if (!canControl(r, u)) return send(ws, { t: 'toast', msg: '🔒 The host has locked the controls' });
        if (!validSrc(m.src)) return send(ws, { t: 'toast', msg: 'That link does not look right' });
        return load(r, { src: m.src, title: clean(m.title, 120), cats: Array.isArray(m.cats) ? m.cats.slice(0, 5).map(c => clean(c, 20)) : [] }, u.name);
      }
      case 'ended': { // first client to report the end advances the queue; duplicates are ignored by version
        if (m.v !== r.state.v || !r.state.src) return;
        const next = playlist(r)[0];
        if (next) { r.playlist = r.playlist.filter(p => p.id !== next.id); bcast(r, { t: 'playlist', list: playlist(r) }); return load(r, next, 'Autoplay'); }
        Object.assign(r.state, { playing: false, pos: cur(r.state), at: now() }); return pushState(r, 'Autoplay', { a: 'pause' });
      }
      case 'chat': {
        const text = clean(m.text, 300); if (!text) return;
        const c = { id: uid(), uid: u.id, name: u.name, color: u.color, text, t: now() };
        r.chat.push(c); if (r.chat.length > 100) r.chat.shift();
        return bcast(r, { t: 'chat', m: c });
      }
      case 'react': if (EMOJIS.includes(m.e)) bcast(r, { t: 'react', e: m.e, from: u.id, name: u.name }); return;
      case 'pl:add': {
        if (!validSrc(m.src) || r.playlist.length >= 100) return send(ws, { t: 'toast', msg: 'That link does not look right' });
        r.playlist.push({ id: uid(), title: clean(m.title, 120) || 'Untitled video', src: m.src, thumb: validSrc(m.thumb) ? m.thumb : '', cats: Array.isArray(m.cats) ? m.cats.slice(0, 5) : [], by: u.name, byId: u.id, added: now(), votes: new Set([u.id]) });
        bcast(r, { t: 'playlist', list: playlist(r) }); return sys(r, `➕ ${u.name} added "${clean(m.title, 60) || 'a video'}" to the playlist`);
      }
      case 'pl:vote': { const p = r.playlist.find(x => x.id === m.id); if (!p) return; p.votes.has(u.id) ? p.votes.delete(u.id) : p.votes.add(u.id); return bcast(r, { t: 'playlist', list: playlist(r) }); }
      case 'pl:remove': { const p = r.playlist.find(x => x.id === m.id); if (!p || (p.byId !== u.id && r.host !== u.id)) return; r.playlist = r.playlist.filter(x => x !== p); return bcast(r, { t: 'playlist', list: playlist(r) }); }
      case 'pl:play': {
        const p = r.playlist.find(x => x.id === m.id); if (!p) return;
        if (!canControl(r, u)) return send(ws, { t: 'toast', msg: '🔒 The host has locked the controls' });
        r.playlist = r.playlist.filter(x => x !== p); bcast(r, { t: 'playlist', list: playlist(r) }); return load(r, p, u.name);
      }
      case 'poll:new': {
        if (r.poll?.open) return send(ws, { t: 'toast', msg: 'Close the current poll first' });
        const opts = (Array.isArray(m.options) ? m.options : []).slice(0, 5).map(o => typeof o === 'string' ? { label: clean(o, 80) } : { label: clean(o.label, 80), src: validSrc(o.src) ? o.src : null, thumb: validSrc(o.thumb) ? o.thumb : '', pid: clean(o.pid, 20) }).filter(o => o.label);
        if (opts.length < 2) return send(ws, { t: 'toast', msg: 'A poll needs at least 2 options' });
        r.poll = { id: uid(), q: clean(m.q, 140) || 'What next?', kind: m.kind === 'movie' ? 'movie' : 'text', by: u.name, byId: u.id, open: true, options: opts, votes: new Map() };
        bcast(r, { t: 'poll', poll: pubPoll(r) }); return sys(r, `📊 ${u.name} started a poll: ${r.poll.q}`);
      }
      case 'poll:vote': { if (!r.poll?.open || !(m.i >= 0 && m.i < r.poll.options.length)) return; r.poll.votes.set(u.id, m.i); return bcast(r, { t: 'poll', poll: pubPoll(r) }); }
      case 'poll:close': {
        if (!r.poll?.open || (r.poll.byId !== u.id && r.host !== u.id)) return;
        r.poll.open = false;
        const counts = r.poll.options.map((_, i) => [...r.poll.votes.values()].filter(v => v === i).length);
        const win = counts.indexOf(Math.max(...counts)), w = r.poll.options[win];
        bcast(r, { t: 'poll', poll: pubPoll(r) }); sys(r, `🏆 Poll result: "${w.label}" wins with ${counts[win]} vote${counts[win] === 1 ? '' : 's'}`);
        if (r.poll.kind === 'movie' && w.src) { r.playlist = r.playlist.filter(p => p.id !== w.pid); bcast(r, { t: 'playlist', list: playlist(r) }); load(r, { src: w.src, title: w.label }, 'The crowd'); }
        return;
      }
      case 'host:give': { if (r.host !== u.id) return; const tgt = r.users.get(m.id); if (tgt?.ws) setHost(r, tgt.id, `handed over by ${u.name}`); return; }
      case 'free': { if (r.host !== u.id) return; r.free = !!m.on; bcast(r, { t: 'members', list: members(r), host: r.host, free: r.free }); return sys(r, r.free ? '🔓 Everyone can control playback' : '🔒 Only the host can control playback'); }
      case 'lat': if (m.ms >= 0 && m.ms < 10000) { r.lat.push(m.ms); if (r.lat.length > 1000) r.lat.shift(); } return;
      case 'drift': if (m.ms >= 0 && m.ms < 600000) u.drift = Math.round(m.ms); return;
    }
  });

  ws.on('close', () => {
    if (!r || !u || u.ws !== ws) return;
    u.ws = null;
    bcast(r, { t: 'members', list: members(r), host: r.host, free: r.free });
    u.leaveTimer = setTimeout(() => { if (u.ws) return; r.users.delete(u.id); bcast(r, { t: 'members', list: members(r), host: r.host, free: r.free }); sys(r, `🚪 ${u.name} left`); }, USER_GRACE);
    if (r.host === u.id) r.timers.host = setTimeout(() => { // host transfer if the host doesn't come back
      if (u.ws) return; const next = online(r)[0]; if (next) setHost(r, next.id, 'previous host disconnected');
    }, HOST_GRACE);
    if (!online(r).length) r.timers.empty = setTimeout(() => { if (!online(r).length) rooms.delete(r.code); }, ROOM_TTL);
  });
});

// heartbeat + periodic member/stat updates (drift numbers)
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 15000);
setInterval(() => rooms.forEach(r => { if (online(r).length) bcast(r, { t: 'tick', list: members(r), stats: stats(r) }); }), 2000);

server.listen(PORT, () => console.log(`PopSync running on http://localhost:${PORT}`));
