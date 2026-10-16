// One small interface for two kinds of video: YouTube links and direct files (.mp4/.webm/...).
function ytId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1, 12) || null;
    if (u.hostname.includes('youtube.com') || u.hostname.includes('youtube-nocookie.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v').slice(0, 11);
      const m = u.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{11})/); if (m) return m[2];
    }
  } catch {}
  return null;
}

let ytApi;
const loadYT = () => ytApi || (ytApi = new Promise(res => {
  window.onYouTubeIframeAPIReady = res;
  const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
}));

const Player = {
  kind: null, src: null, ready: false, video: null, yt: null, volume: 1, muted: false,
  onEnded: () => {}, onError: () => {}, onReady: () => {},

  async load(src) {
    this.destroy(); this.src = src;
    const host = document.getElementById('playerHost');
    const id = ytId(src);
    if (id) {
      this.kind = 'yt';
      await loadYT();
      if (this.src !== src) return;
      const div = document.createElement('div'); host.appendChild(div);
      this.yt = new YT.Player(div, {
        videoId: id,
        playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0 },
        events: {
          onReady: () => { this.ready = true; this.applyVolume(); this.onReady(); },
          onStateChange: e => { if (e.data === 0) this.onEnded(); },
          onError: e => this.onError([101, 150].includes(e.data) ? 'This YouTube video does not allow playing on other sites. Try another one.' : 'YouTube could not play this video.')
        }
      });
    } else {
      this.kind = 'html5';
      const v = document.createElement('video');
      v.playsInline = true; v.preload = 'auto'; v.src = src;
      v.addEventListener('loadedmetadata', () => { this.ready = true; this.applyVolume(); this.onReady(); }, { once: true });
      v.addEventListener('ended', () => this.onEnded());
      v.addEventListener('error', () => this.onError('This link could not be played. Use a direct video file (.mp4/.webm) or a YouTube link.'));
      host.appendChild(v); this.video = v;
    }
  },
  destroy() {
    this.ready = false;
    if (this.yt) { try { this.yt.destroy(); } catch {} this.yt = null; }
    if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); this.video = null; }
    document.getElementById('playerHost').innerHTML = '';
    this.kind = null; this.src = null;
  },
  play() { if (!this.ready) return Promise.resolve(); if (this.yt) { this.yt.playVideo(); return Promise.resolve(); } return this.video.play(); },
  pause() { if (!this.ready) return; this.yt ? this.yt.pauseVideo() : this.video.pause(); },
  seek(t) { if (!this.ready) return; this.yt ? this.yt.seekTo(t, true) : (this.video.currentTime = t); },
  time() { if (!this.ready) return 0; return this.yt ? this.yt.getCurrentTime() || 0 : this.video.currentTime; },
  duration() { if (!this.ready) return 0; return (this.yt ? this.yt.getDuration() : this.video.duration) || 0; },
  paused() { if (!this.ready) return true; if (this.yt) { const s = this.yt.getPlayerState(); return s !== 1 && s !== 3; } return this.video.paused; },
  get canRate() { return this.kind === 'html5'; },
  setRate(r) { if (this.video && Math.abs(this.video.playbackRate - r) > 0.001) this.video.playbackRate = r; },
  setVolume(v, muted) { this.volume = v; this.muted = muted; this.applyVolume(); },
  applyVolume() {
    if (this.video) { this.video.volume = this.volume; this.video.muted = this.muted; }
    if (this.yt?.setVolume) { this.yt.setVolume(this.volume * 100); this.muted ? this.yt.mute() : this.yt.unMute(); }
  }
};
