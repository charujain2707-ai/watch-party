# 🍿 PopSync: watch together, perfectly in sync

A real-time watch-party web app. Create a room, share the link, and everyone watches the same video at the same moment, with live chat, flying emoji reactions, a shared playlist, polls and movie discovery.

**Live demo:** `https://<your-app>.onrender.com`

## Features
| Requirement | How PopSync does it |
|---|---|
| Rooms via invite link or code | 6-character room codes, a one-click **Copy invite** link (`/?room=CODE`), and a **QR code** for phones. |
| Synced play / pause / seek | The server keeps one authoritative playback state. Every action goes through it and is broadcast to everyone. |
| Any video link | Paste a **YouTube link** (watch, youtu.be, shorts, embed) or any **direct video file** (.mp4 / .webm). |
| Movie discovery | Catalog of free open movies with **categories**, **filters** (length, sort by rating / newest / A–Z), **fuzzy search** that tolerates typos ("dragn" → Sintel, "robts" → Tears of Steel), and **"Picked for this room"** recommendations based on what the room has watched and queued. |
| Emoji reactions | 8 reactions float over everyone's video with the sender's name. |
| Live chat | Includes system messages (joins, new video, host changes, poll results). |
| Shared playlist | Anyone can add. **Upvote** to reorder, and the top video **autoplays** when the current one ends. |
| Group polls | Custom polls, plus **🗳 Movie vote**, which builds a poll from the playlist; the winner plays automatically. |
| Host transfer | The host can hand over the crown. If the host disconnects for 10 s, the next person becomes host automatically. The host can also lock controls ("Everyone can control" toggle). |
| Drift detection and correction | Every client checks its position against the room every 400 ms (details below). |
| Late joins, reconnects, concurrent actions | See *Failure handling*. |

### Creative extras
- **3·2·1 countdown start:** a synced countdown on everyone's screen, then the video starts at the same server timestamp for all.
- **Hype meter:** reactions from everyone fill a shared meter. When it's full, the room hits **HYPE MODE 🔥** with confetti.
- **Live sync badges:** every person's drift is shown in the People tab (green < 150 ms, yellow < 500 ms, red above), and your own drift plus the room's p95 latency show in the top bar.
- **Auto-buffer start:** a new video starts 2.5 s in the future, so slow connections have time to buffer and everyone starts together.

## Tech stack
- **Server:** Node.js, `http` + [`ws`](https://github.com/websockets/ws) WebSockets, `qrcode`. No database, since rooms live in memory.
- **Client:** vanilla JavaScript, HTML, CSS, with the YouTube IFrame API for YouTube links and the HTML5 `<video>` element for files.
- **Deploy:** any Node host. Render's free plan works.

```
server.js          rooms, authoritative state, chat/playlist/poll logic, /stats, /qr.svg
public/app.js      client: connection, clock sync, drift correction, all UI
public/player.js   one interface over YouTube + HTML5 video
public/catalog.js  movie catalog for discovery
loadtest.js        latency + concurrency test with simulated users
```

## How sync works
1. **Authoritative state.** The server stores `{ v, src, playing, pos, at, rate }`: "at server time `at`, the video was at `pos`". The expected position at any moment is `pos + (serverNow − at) × rate`.
2. **Clock sync.** Each client pings every 2 s and estimates its offset from the server, NTP-style: `offset = serverTime + rtt/2 − localTime`. It keeps the sample with the **lowest round-trip time** of the last 10, which is the least noisy.
3. **Actions.** Play, pause and seek are sent to the server, which applies them **in arrival order**, increments the version `v`, and broadcasts the new state to everyone, the sender included. Clients ignore any state older than the one they have, so everyone converges on the same result.
4. **Drift correction** (every 400 ms on each client):
   - drift > **500 ms**: hard seek to the expected position
   - drift 80–500 ms: smooth catch-up by changing the playback speed by up to ±8% (direct files), so there's no visible jump
   - drift < 80 ms: normal speed
   - YouTube can't change speed smoothly, so it only uses the seek step.
5. **Scheduled starts.** Countdown and new-video actions set `at` in the future, so all clients start at the same server instant rather than when the message arrives.

## Latency measurements
**Test conditions:** server and `loadtest.js` on the same machine (Node 22, Linux, localhost), with simulated users who share one clock, so one-way latency is exact. Actions are sent every 120 ms by random users.

| Users in room | Actions | Samples | p50 | p95 | max | All updates delivered | Concurrent burst converged |
|---|---|---|---|---|---|---|---|
| 10 | 60 | 600 | 1 ms | 2 ms | 4 ms | ✅ | ✅ |
| 25 | 90 | 2250 | 1 ms | 4 ms | 8 ms | ✅ | ✅ |

**Target:** ≤ 250 ms p95 on a local network. Re-run it on your own network, with the server on one laptop and the test on another:
```bash
npm run loadtest -- ws://<server-ip>:3000 10 60
```

**Live measurements in the app:** each viewer measures how long every play/pause/seek took to reach them (`receive time − send time`, both in server time) and reports it to the server. The top bar shows the room's **p95**, and `GET /stats` returns p50/p95/sample count and the drift p95 for every room.

**Drift (browser test, 2 tabs, local .webm file):** after correction, drift stayed at **8–76 ms**. A forced 3-second jump on one viewer was corrected within one tick (< 0.5 s), with the two viewers ending up 40 ms apart. Target: ≤ 500 ms.

## Failure handling
| Situation | What happens |
|---|---|
| Late join | The snapshot contains the full state. The video loads, then seeks to the expected position and plays. |
| Connection drop | Auto-reconnect with exponential back-off (0.3 s → 5 s); reconnects immediately when the tab becomes visible again. A heartbeat closes silent dead links after 7 s. |
| Rejoining | Each tab keeps its id, so a reconnecting user keeps their name, colour, votes and host role (60 s grace period). |
| Host leaves | After 10 s the next online member becomes host automatically. |
| Server restart | The first client to reconnect rebuilds the room from its last known state (video, position, playlist). |
| Concurrent actions | Applied one at a time in server arrival order, with a version number, so the last action wins and everyone converges (verified by the load test burst). |
| Duplicate "video ended" | Only the first message for the current version advances the playlist. |
| Autoplay blocked by the browser | A "Tap to join the stream" overlay appears and one tap resumes sync. |
| Bad / unembeddable link | Clear message, e.g. "This YouTube video does not allow playing on other sites". |
| Spam | Rate limit of 20 messages/s per user, 300-character chat limit, 100-item playlist cap, 50 users per room. |
| Same session in 2 tabs | The newer tab takes over and the old one shows a message instead of fighting in a reconnect loop. |

## Run locally
```bash
npm install
npm start            # http://localhost:3000
```

## Deploy on Render (free)
1. Sign in to render.com with GitHub, then choose **New → Web Service** and pick this repo.
2. Build command `npm install`, start command `npm start`, instance type **Free**.
3. Open the `.onrender.com` link. Free instances sleep after ~15 min idle, so the first load can take up to a minute.
