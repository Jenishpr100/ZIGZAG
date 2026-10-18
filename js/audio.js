/* audio.js — music playback (HTMLAudioElement, works from file://) + synthesized sound effects
   (Web Audio oscillators, no sound files needed). Only ONE music element ever exists:
   stop() tears it down before any new song/preview loads. */
(function () {
  const Z = (window.ZZ = window.ZZ || {});
  let el = null, ctx = null, sfxGain = null, lastA = 0, lastP = 0, loadToken = 0, previewTimer = 0;
  const S = () => Z.Settings.data;

  const A = Z.Audio = {
    /* Must be called from a user gesture (click/key). Creates/resumes the AudioContext. */
    unlock() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!ctx) { ctx = new AC(); sfxGain = ctx.createGain(); sfxGain.connect(ctx.destination); }
        if (ctx.state === 'suspended') ctx.resume();
        A.applyVolume();
      } catch (e) {}
    },
    applyVolume() {
      if (el) el.volume = Math.max(0, Math.min(1, S().master * S().music));
      if (sfxGain) sfxGain.gain.value = S().master * S().sfx;
    },
    /* Read a song's real duration without playing it. cb(errorOrNull, seconds). */
    probe(song, cb) {
      if (song.status === 'ok') return cb(null, song.duration);
      if (song.status === 'error') return cb(song.error);
      const a = new Audio();
      let done = false;
      const finish = (err, d) => {
        if (done) return; done = true; clearTimeout(timer);
        a.removeAttribute('src'); a.load();
        if (err) { song.status = 'error'; song.error = err; } else { song.status = 'ok'; song.duration = d; }
        cb(err, d);
      };
      const timer = setTimeout(() => finish('Timed out reading ' + song.file), 8000);
      a.preload = 'metadata';
      a.onloadedmetadata = () => (isFinite(a.duration) && a.duration > 0) ? finish(null, a.duration) : finish('Could not read the length of ' + song.file);
      a.onerror = () => finish('Cannot load songs/' + song.file + ' — check that the file exists and the name matches songs/songs.js exactly.');
      a.src = song.url;
    },
    /* Load a song for playing. cb(errorOrNull). */
    load(song, cb) {
      A.stop();
      const token = ++loadToken;
      el = new Audio();
      el.preload = 'auto';
      lastA = 0; lastP = performance.now();
      el.onerror = () => { if (token === loadToken) cb('Cannot load songs/' + song.file + ' — is the file in the songs folder with the exact name?'); };
      el.oncanplaythrough = () => { if (token === loadToken && el) { el.oncanplaythrough = null; cb(null); } };
      el.src = song.url;
      A.applyVolume();
      el.load();
    },
    onEnded(fn) { if (el) el.onended = fn; },
    play() { if (!el) return Promise.reject(new Error('no audio')); lastP = performance.now(); return el.play(); },
    pause() { if (el) el.pause(); },
    seek(t) { if (el) { el.currentTime = t; lastA = t; lastP = performance.now(); } },
    isPlaying() { return !!el && !el.paused && !el.ended; },
    /* Playback position in seconds. The element's clock updates in coarse steps, so between
       updates we extrapolate with performance.now(), never drifting more than 100 ms ahead. */
    now() {
      if (!el) return 0;
      const a = el.currentTime, p = performance.now();
      if (a !== lastA) { lastA = a; lastP = p; }
      if (el.paused || el.ended) return a;
      return a + Math.min((p - lastP) / 1000, 0.1);
    },
    stop() {
      loadToken++; clearTimeout(previewTimer);
      if (el) { try { el.onended = el.onerror = el.oncanplaythrough = null; el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {} }
      el = null;
    },
    /* Song Select preview: ~10 s starting at 35% of the song. */
    preview(song, cb) {
      A.unlock();
      A.load(song, err => {
        if (err) return cb && cb(err);
        const d = song.duration || el.duration || 60;
        try { el.currentTime = Math.max(0, Math.min(d - 12, d * 0.35)); } catch (e) {}
        A.play().then(() => cb && cb(null)).catch(() => cb && cb('The browser blocked audio. Click Preview again.'));
        previewTimer = setTimeout(() => A.stop(), 10000);
      });
    },
    /* Sound effects: type = perfect | great | good | miss | tick | ui */
    sfx(type) {
      if (!ctx || ctx.state !== 'running') return;
      const P = { perfect: [988, 'triangle', .11, .5], great: [740, 'triangle', .1, .45], good: [554, 'triangle', .09, .4],
                  miss: [96, 'sawtooth', .18, .35], tick: [1320, 'sine', .05, .18], ui: [660, 'sine', .05, .2] }[type];
      if (!P) return;
      const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = P[1]; o.frequency.setValueAtTime(P[0], t);
      if (type === 'miss') o.frequency.exponentialRampToValueAtTime(55, t + P[2]);
      g.gain.setValueAtTime(P[3], t); g.gain.exponentialRampToValueAtTime(.001, t + P[2]);
      o.connect(g); g.connect(sfxGain); o.start(t); o.stop(t + P[2] + .02);
    }
  };
})();
