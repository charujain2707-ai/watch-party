// Load + latency test: N simulated viewers in one room, measures play/pause/seek propagation.
// Usage: node loadtest.js [ws://host:port] [users=10] [actions=60]
const WebSocket = require('ws');
const URL_ = process.argv[2] || 'ws://localhost:3000', N = +process.argv[3] || 10, A = +process.argv[4] || 60;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

function client(i, room) {
  return new Promise((resolve, reject) => {
    const cid = 'bot' + i + '-' + Date.now(), ws = new WebSocket(URL_), c = { ws, i, cid, states: [], last: null };
    ws.on('open', () => ws.send(JSON.stringify(room ? { t: 'join', room, name: 'Bot' + i, cid } : { t: 'join', create: true, name: 'Bot' + i, cid })));
    ws.on('message', d => {
      const m = JSON.parse(d);
      if (m.t === 'snapshot') { c.room = m.room; c.last = m.s; resolve(c); }
      if (m.t === 'state') { c.last = m.s; if (m.sent) c.states.push({ v: m.s.v, lat: Date.now() - m.sent, from: m.from }); }
      if (m.t === 'err') reject(new Error(m.msg));
    });
    ws.on('error', reject);
  });
}

(async () => {
  console.log(`Target ${URL_} · ${N} users · ${A} actions\n`);
  const host = await client(0);
  const others = await Promise.all(Array.from({ length: N - 1 }, (_, i) => client(i + 1, host.room)));
  const all = [host, ...others];
  console.log(`Room ${host.room}: ${all.length} users connected`);

  host.ws.send(JSON.stringify({ t: 'load', src: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4', title: 'Big Buck Bunny' }));
  await sleep(500);

  // 1) sequential actions from random users (all bots share one clock → exact one-way latency)
  const acts = ['play', 'pause', 'seek'];
  for (let k = 0; k < A; k++) {
    const sender = all[Math.floor(Math.random() * all.length)];
    sender.ws.send(JSON.stringify({ t: 'ctl', a: acts[k % 3], pos: Math.random() * 500, sent: Date.now() }));
    await sleep(120);
  }
  await sleep(800);
  const lats = all.flatMap(c => c.states.filter(s => s.from !== c.cid).map(s => s.lat));
  const received = all.map(c => c.states.length);

  // 2) concurrency: 5 users fire conflicting actions at the same instant
  const burst = all.slice(0, 5);
  burst.forEach((c, j) => c.ws.send(JSON.stringify({ t: 'ctl', a: j % 2 ? 'pause' : 'seek', pos: 100 + j * 10, sent: Date.now() })));
  await sleep(1000);
  const finals = all.map(c => JSON.stringify({ v: c.last.v, pos: c.last.pos, playing: c.last.playing }));
  const converged = finals.every(f => f === finals[0]);

  console.log(`\nPropagation (sender → server → every viewer), ${lats.length} samples`);
  console.log(`  p50 ${pct(lats, 50)} ms · p95 ${pct(lats, 95)} ms · max ${Math.max(...lats)} ms`);
  console.log(`  every user received all ${A} updates: ${received.every(n => n === A) ? 'YES' : 'NO ' + received}`);
  console.log(`Concurrent actions (5 users at once) → all ${all.length} users ended in the same state: ${converged ? 'YES' : 'NO'}`);
  console.log(`  final state ${finals[0]}`);
  console.log(`\n${pct(lats, 95) <= 250 ? 'PASS' : 'FAIL'}: p95 ≤ 250 ms target`);
  all.forEach(c => c.ws.close());
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
