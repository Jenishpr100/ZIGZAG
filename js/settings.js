/* settings.js — persistent user settings (volume, seed, theme, toggles...). */
(function () {
  const Z = (window.ZZ = window.ZZ || {});
  const reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const DEFAULTS = {
    master: 0.8, music: 0.8, sfx: 0.7, offset: 0,
    seed: 'zigzag', difficulty: 'normal', theme: 'neon',
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
})();
