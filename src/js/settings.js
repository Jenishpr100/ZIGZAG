/* settings.js — persistent user settings (volume, seed, theme, toggles...).

   EVERY setting here is written through Z.Storage to the single localStorage key
   `zigzag.settings`, so the whole block survives a reload (and falls back to an
   in-memory copy when a browser blocks storage on file:// pages). See storage.js for
   the namespace and the other modules' raw keys.

   Also hosts the hidden Developer unlock: tapping the "Expert" button 5 times in Settings. */
(function () {
  const Z = (window.ZZ = window.ZZ || {});
  const reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  const DEFAULTS = {
    master: 0.8, music: 0.8, sfx: 0.7, offset: 0,          // sliders: 0..1 (offset is ms)
    seed: 'zigzag', difficulty: 'normal', theme: 'neon',
    reducedMotion: reduce, shake: true, hitFx: true, practice: false,
    lastSong: null
  };
  /* bumped when a key is renamed or reshaped; migrate() moves old values forward. */
  const VERSION = 1;
  const listeners = [];

  /* Volume sliders (#set-master / #set-music / #set-sfx), the timing offset, the seed
     boxes, the difficulty/theme segments and the four checkboxes all funnel through
     Z.Settings.set(), so there is exactly one write path to localStorage. */
  const KEY = Z.Storage.KEYS.settings;                    // -> localStorage 'zigzag.settings'
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

  function stored() {
    const raw = Z.Storage.get(KEY, null);
    return isObj(raw) ? raw : {};                          // corrupt / non-object -> defaults
  }
  function migrate(s) {
    if (typeof s.version !== 'number') s.version = 0;
    if (s.version < VERSION) s.version = VERSION;           // no renames yet; hook goes here
    // drop keys this build no longer knows about so the blob can't grow forever
    for (const k of Object.keys(s)) if (!(k in DEFAULTS) && k !== 'version') delete s[k];
    return s;
  }
  /* A single value that can't be JSON-encoded (a function, a DOM node, a cycle) must not
     take the whole settings blob down with it — drop just that key and keep the rest. */
  function serialisable(obj) {
    const out = {};
    for (const k of Object.keys(obj)) {
      try { if (JSON.stringify(obj[k]) !== undefined) out[k] = obj[k]; } catch (e) {}
    }
    return out;
  }
  function save() { Z.Storage.set(KEY, serialisable(Z.Settings.data)); }

  Z.Settings = {
    DEFAULTS, VERSION, KEY,
    data: migrate(Object.assign({}, DEFAULTS, stored())),

    get(k) { return this.data[k]; },
    has(k) { return Object.prototype.hasOwnProperty.call(this.data, k); },
    keys() { return Object.keys(this.data); },

    /* The one and only write path: update in memory, push the whole blob to
       localStorage, then notify listeners. */
    set(k, v) { this.data[k] = v; save(); listeners.forEach(f => f(k, v)); },
    setAll(obj) { Object.assign(this.data, obj || {}); save(); listeners.forEach(f => f('*', null)); },

    reset() {
      const keep = this.data.lastSong;
      this.data = Object.assign({}, DEFAULTS, { lastSong: keep, version: VERSION });
      save(); listeners.forEach(f => f('*', null));
    },

    flush: save,
    onChange(f) { listeners.push(f); }
  };
  save();   // normalise + prune the stored blob on first load

  /* Developer mode — hidden "Expert" button in Settings must be tapped 5 times.
     The flag stays RAW localStorage (not Z.Storage) under 'zigzag-dev' so other pages
     (DevEdit.html) and the LittleJS lane read it without the Settings wrapper. */
  const DEV_KEY = (Z.Storage.RAW_KEYS && Z.Storage.RAW_KEYS.dev) || 'zigzag-dev';
  Z.Dev = {
    KEY: DEV_KEY,
    taps: 0,
    isUnlocked() { try { return localStorage.getItem(DEV_KEY) === 'true'; } catch (e) { return false; } },
    unlock() { try { localStorage.setItem(DEV_KEY, 'true'); } catch (e) {} },
    lock() { try { localStorage.removeItem(DEV_KEY); } catch (e) {} Z.Dev.taps = 0; },
    /* One tap of the Expert button. Returns true the moment dev mode turns on. */
    tap() {
      if (Z.Dev.isUnlocked()) return true;
      Z.Dev.taps++;
      if (Z.Dev.taps >= 5) { Z.Dev.unlock(); return true; }
      return false;
    }
  };
})();