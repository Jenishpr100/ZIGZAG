/* audio.js — music playback (HTMLAudioElement, works from file://) + synthesized sound effects
   (Web Audio oscillators, no sound files needed). Only ONE music element ever exists:
   stop() tears it down before any new song/preview loads. */
(function () {
  const Z = (window.ZZ = window.ZZ || {});
  let el = null, ctx = null, sfxGain = null, lastA = 0, lastP = 0, loadToken = 0, previewTimer = 0, loadTimer = 0, loadedSongFile = null;
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
      a.onerror = () => finish('Cannot load songs/' + song.file + ' — check that the file exists and matches js/song-manifest.js exactly.');
      a.src = song.url;
    },
    /* Load a song for playing. cb(errorOrNull). */
    load(song, cb, startImmediately, startAtSeconds) {
      A.stop();
      const token = ++loadToken;
      loadedSongFile = song && song.file || null;
      const audio = el = new Audio();
      audio.preload = 'auto';
      lastA = 0; lastP = performance.now();
      let finished = false;
      let initialSeekApplied = false;
      const applyInitialSeek = () => {
        if (initialSeekApplied || token !== loadToken || audio !== el) return;
        initialSeekApplied = true;
        const startAt = Number(startAtSeconds) || 0;
        if (startAt <= 0) return;
        const end = isFinite(audio.duration) && audio.duration > 0 ? Math.max(0, audio.duration - .02) : startAt;
        try { audio.currentTime = Math.max(0, Math.min(startAt, end)); } catch (e) {}
      };
      const finish = error => {
        if (finished || token !== loadToken || audio !== el) return;
        finished = true; clearTimeout(loadTimer);
        audio.onerror = audio.onloadedmetadata = audio.oncanplay = audio.oncanplaythrough = null;
        if (error) { song.status = 'error'; song.error = error; cb(error); return; }
        if (isFinite(audio.duration) && audio.duration > 0) { song.duration = audio.duration; song.status = 'ok'; }
        cb(null);
      };
      audio.onerror = () => finish('Cannot load ' + song.file + ' — check that the audio file exists and its format is supported.');
      audio.onloadedmetadata = () => { applyInitialSeek(); if (audio.readyState >= 2) finish(null); };
      audio.oncanplay = () => { applyInitialSeek(); finish(null); };
      audio.oncanplaythrough = () => { applyInitialSeek(); finish(null); };
      loadTimer = setTimeout(() => finish('Timed out reading ' + song.file + ' — check that the audio file exists and its format is supported.'), 12000);
      audio.src = song.url;
      A.applyVolume();
      audio.load();
      // Stage entry calls this from the portal's click/key gesture. Asking the
      // browser to play here preserves that gesture while the stage file loads.
      return startImmediately ? audio.play() : null;
    },
    currentSongFile() { return loadedSongFile; },
    onEnded(fn) { if (el) el.onended = fn; },
    play() { if (!el) return Promise.reject(new Error('no audio')); lastP = performance.now(); return el.play(); },
    pause() { if (el) el.pause(); },
    seek(t) { if (el) { el.currentTime = t; lastA = t; lastP = performance.now(); } },
    /* Direct HTMLAudioElement position for chart capture; no timer-derived value. */
    position() { return el ? el.currentTime : 0; },
    duration() { return el && isFinite(el.duration) ? el.duration : 0; },
    isLoaded() { return !!el && el.readyState >= 2; },
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
      loadToken++; clearTimeout(previewTimer); clearTimeout(loadTimer);
      if (el) { try { el.onended = el.onerror = el.onloadedmetadata = el.oncanplay = el.oncanplaythrough = null; el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {} }
      el = null; loadedSongFile = null;
    },
    /* Song Select preview: ~10 s starting at 35% of the song. */
    preview(song, cb) {
      A.unlock();
      let reported = false;
      const report = error => { if (!reported) { reported = true; if (cb) cb(error || null); } };
      const duration = song.duration || 60;
      const startAt = Math.max(0, Math.min(duration - 12, duration * 0.35));
      const playPromise = A.load(song, err => {
        if (err) return report(err);
        previewTimer = setTimeout(() => A.stop(), 10000);
      }, true, startAt);
      if (playPromise && playPromise.then)
        playPromise.then(() => report(null)).catch(() => report('The browser blocked audio. Click Preview again.'));
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

// ============================================================
// LittleJS-side synth helpers (from M0 template).
// The rhythm demo calls these; kept outside the ZZ namespace.
// ============================================================

function audioUnlock() {
  const ac = typeof audioContext != 'undefined' ? audioContext : 0;
  if (ac && ac.state == 'suspended') ac.resume(); // browsers need one gesture
}

function synthNote(semitone, dur = .25, type = 'sawtooth', vol = .22) {
  const ac = typeof audioContext != 'undefined' ? audioContext : 0;
  if (!ac || ac.state != 'running') return;
  const t = ac.currentTime;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.value = getNoteFrequency(semitone); // LittleJS helper
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(.001, t + dur);
  osc.connect(gain);
  gain.connect(typeof audioMasterGain != 'undefined' ? audioMasterGain : ac.destination);
  osc.start(t);
  osc.stop(t + dur);
}
