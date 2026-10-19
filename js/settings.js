/* settings.js — persistent user settings (volume, timing, theme, toggles...).
   Also hosts the hidden Developer unlock: tapping the "Expert" button 5 times in Settings. */
(function () {
  const Z = (window.ZZ = window.ZZ || {});
  const reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const DEFAULTS = {
    master: 0.8, music: 0.8, sfx: 0.7, offset: 0,
    difficulty: 'normal', theme: 'neon',
    reducedMotion: reduce, shake: true, hitFx: true, practice: false,
    lastSong: null
  };
  const listeners = [];
  Z.Settings = {
    DEFAULTS, data: Object.assign({}, DEFAULTS, Z.Storage.get('settings', {})),
    get(k) { return this.data[k]; },
    set(k, v) { this.data[k] = v; Z.Storage.set('settings', this.data); listeners.forEach(f => f(k, v)); },
    reset() { const keep = this.data.lastSong; this.data = Object.assign({}, DEFAULTS, { lastSong: keep }); Z.Storage.set('settings', this.data); listeners.forEach(f => f('*', null)); },
    onChange(f) { listeners.push(f); }
  };

  /* Developer mode — hidden "Expert" button in Settings must be tapped 5 times.
     Flag lives in raw localStorage (not Z.Storage) under 'zigzag-dev' so other pages
     the level editor and lanes can read it without the Settings wrapper. */
  const DEV_KEY = 'zigzag-dev';
  Z.Dev = {
    KEY: DEV_KEY,
    taps: 0,
    isUnlocked() { try { return localStorage.getItem(DEV_KEY) === 'true'; } catch (e) { return false; } },
    unlock() { try { localStorage.setItem(DEV_KEY, 'true'); } catch (e) {} },
    /* One tap of the Expert button. Returns true the moment dev mode turns on. */
    tap() {
      if (Z.Dev.isUnlocked()) return true;
      Z.Dev.taps++;
      if (Z.Dev.taps >= 5) { Z.Dev.unlock(); return true; }
      return false;
    }
  };
})();
