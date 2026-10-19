/* levelFormat.js — legacy JSON level schema v0 ("zigzag-level") migration helpers.
   Current playable stages use LevelFormatV1 and levels/stageN.level files. */
(function () {
  'use strict';

  const FORMAT = 'zigzag-level';
  const VERSION = 0;
  const PREFIX = 'zigzag-level-';
  const DIFF_KEYS = ['EASY', 'NORMAL', 'HARD', 'EXPERT'];
  const LANES = ['top', 'bottom', 'center'];
  const TYPES = ['tap', 'hold'];

  /* ---- storage (localStorage with in-memory fallback for file:// lockdowns) ---- */
  const mem = {};
  function lsGet(k) {
    try { return localStorage.getItem(k); } catch (e) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; }
  }
  function lsRemove(k) {
    try { localStorage.removeItem(k); } catch (e) {}
    delete mem[k];
  }
  function lsKeys() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) out.push(k);
      }
    } catch (e) {
      Object.keys(mem).forEach(k => { if (k.indexOf(PREFIX) === 0) out.push(k); });
    }
    return out;
  }

  /* ---- helpers ---- */
  function slug(title) {
    return String(title == null ? '' : title)
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '') || 'untitled';
  }
  const r3 = x => Math.round(x * 1000) / 1000;
  const isNum = x => typeof x === 'number' && isFinite(x);

  function sortedNotes(notes) {
    return (notes || []).slice().sort((a, b) => (a.t - b.t) || String(a.lane).localeCompare(String(b.lane)));
  }
  function sortLevel(level) {
    DIFF_KEYS.forEach(k => {
      if (level.difficulties && level.difficulties[k] && Array.isArray(level.difficulties[k].notes))
        level.difficulties[k].notes = sortedNotes(level.difficulties[k].notes);
    });
    return level;
  }

  /* ---- validation ---- */
  function validate(level) {
    const errors = [];
    if (!level || typeof level !== 'object' || Array.isArray(level)) return { valid: false, errors: ['Level must be an object.'] };
    if (level.format !== FORMAT) errors.push('format must be "' + FORMAT + '" (got ' + JSON.stringify(level.format) + ').');
    if (!isNum(level.version)) errors.push('version must be a number.');
    else if (level.version !== VERSION) errors.push('version must be ' + VERSION + ' (got ' + level.version + ').');
    if (typeof level.title !== 'string' || !level.title.trim()) errors.push('title must be a non-empty string.');
    if (typeof level.artist !== 'string') errors.push('artist must be a string.');
    if (level.author != null && typeof level.author !== 'string') errors.push('author must be a string when present.');
    if (typeof level.audio !== 'string' || !level.audio.trim()) errors.push('audio must be a non-empty path string.');
    if (!isNum(level.bpm) || level.bpm <= 0) errors.push('bpm must be a positive number.');
    if (!isNum(level.offsetMs)) errors.push('offsetMs must be a number (milliseconds).');
    if (!level.difficulties || typeof level.difficulties !== 'object') {
      errors.push('difficulties must be an object with keys ' + DIFF_KEYS.join(', ') + '.');
    } else {
      DIFF_KEYS.forEach(k => {
        const d = level.difficulties[k];
        if (!d || typeof d !== 'object') { errors.push('difficulties.' + k + ' is missing.'); return; }
        if (!Array.isArray(d.notes)) { errors.push('difficulties.' + k + '.notes must be an array.'); return; }
        d.notes.forEach((n, i) => {
          const where = 'difficulties.' + k + '.notes[' + i + ']';
          if (!n || typeof n !== 'object') { errors.push(where + ' must be an object.'); return; }
          if (!isNum(n.t) || n.t < 0) errors.push(where + '.t must be a number >= 0 (got ' + JSON.stringify(n.t) + ').');
          if (LANES.indexOf(n.lane) < 0) errors.push(where + '.lane must be "top", "bottom" or "center" (got ' + JSON.stringify(n.lane) + ').');
          if (TYPES.indexOf(n.type) < 0) errors.push(where + '.type must be "tap" or "hold" (got ' + JSON.stringify(n.type) + ').');
          if (n.type === 'hold') {
            if (!isNum(n.dur) || n.dur <= 0) errors.push(where + '.dur must be a positive number for hold notes.');
            if (n.flicks != null) {
              if (!Array.isArray(n.flicks)) errors.push(where + '.flicks must be an array of times.');
              else n.flicks.forEach((f, j) => {
                if (!isNum(f) || f <= n.t || (isNum(n.dur) && f > n.t + n.dur + 1e-6))
                  errors.push(where + '.flicks[' + j + '] must be a time inside the hold (t < f <= t+dur).');
              });
            }
          } else if (n.dur != null) {
            errors.push(where + '.dur is only allowed on hold notes.');
          }
        });
      });
    }
    return { valid: !errors.length, errors };
  }

  /* ---- template ---- */
  function createBlank(title, artist, audioPath, bpm, offsetMs) {
    const difficulties = {};
    DIFF_KEYS.forEach(k => { difficulties[k] = { notes: [] }; });
    return {
      format: FORMAT,
      version: VERSION,
      title: title || 'Untitled',
      artist: artist || '',
      author: '',
      audio: audioPath || '',
      bpm: isNum(bpm) ? bpm : 120,
      offsetMs: isNum(offsetMs) ? offsetMs : 0,
      difficulties
    };
  }

  /* ---- chart-generator -> LevelFormat ----
     Input chart: { notes: [{ type:'tap'|'hold'|'drag', t, lane:0..3, end, ticks:[abs times], nodes?, endLane? }], ... }
     Mapping: game lanes 0,1 -> "bottom"; 2,3 -> "top" (center left for hand-mapping).
     Holds keep dur = end - t; every other score tick becomes a flick.
     Drags expand to one tap per zigzag node. */
  const LANE_NAMES = ['bottom', 'bottom', 'top', 'top'];
  function fromGeneratedChart(chart, title, artist, audioPath, bpm, offsetMs) {
    const level = createBlank(title, artist, audioPath, bpm, offsetMs);
    if (!chart || !Array.isArray(chart.notes)) return level;
    const diffKey = DIFF_KEYS.indexOf(String(chart.difficulty || '').toUpperCase()) >= 0
      ? String(chart.difficulty).toUpperCase() : 'NORMAL';
    const out = [];
    chart.notes.forEach(n => {
      if (!n || !isNum(n.t)) return;
      const laneName = LANE_NAMES[Math.max(0, Math.min(3, n.lane | 0))] || 'bottom';
      if (n.type === 'hold' && isNum(n.end) && n.end > n.t) {
        const note = { t: r3(n.t), lane: laneName, type: 'hold', dur: r3(n.end - n.t) };
        if (Array.isArray(n.ticks) && n.ticks.length) {
          const flicks = n.ticks.filter((tt, i) => i % 2 === 1 && tt > note.t && tt <= note.t + note.dur).map(r3);
          if (flicks.length) note.flicks = flicks;
        }
        out.push(note);
      } else if (n.type === 'drag' && Array.isArray(n.nodes) && n.nodes.length) {
        n.nodes.forEach(nd => { if (nd && isNum(nd.t)) out.push({ t: r3(nd.t), lane: LANE_NAMES[Math.max(0, Math.min(3, nd.lane | 0))] || 'bottom', type: 'tap' }); });
      } else {
        out.push({ t: r3(n.t), lane: laneName, type: 'tap' });
      }
    });
    level.difficulties[diffKey].notes = sortedNotes(out);
    return level;
  }

  /* ---- persistence ---- */
  function save(level) {
    const v = validate(level);
    if (!v.valid) return { saved: false, slug: null, errors: v.errors };
    sortLevel(level);
    const s = slug(level.title);
    lsSet(PREFIX + s, JSON.stringify(level));
    return { saved: true, slug: s, errors: [] };
  }
  function load(s) {
    const raw = lsGet(PREFIX + s);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function list() {
    return lsKeys().map(k => {
      const s = k.slice(PREFIX.length);
      let lv = null;
      try { lv = JSON.parse(lsGet(k)); } catch (e) {}
      if (!lv || typeof lv !== 'object') return { slug: s, title: s, artist: '', difficultyCount: 0 };
      let difficultyCount = 0;
      DIFF_KEYS.forEach(d => { if (lv.difficulties && lv.difficulties[d] && Array.isArray(lv.difficulties[d].notes) && lv.difficulties[d].notes.length) difficultyCount++; });
      return { slug: s, title: lv.title || s, artist: lv.artist || '', difficultyCount };
    }).sort((a, b) => a.title.localeCompare(b.title));
  }
  function remove(s) { lsRemove(PREFIX + s); }

  /* ---- JSON import/export ---- */
  function toJSON(level) { return JSON.stringify(level, null, 2); }
  function fromJSON(jsonString) {
    let level = null;
    try { level = JSON.parse(String(jsonString)); }
    catch (e) { return { valid: false, level: null, errors: ['Invalid JSON: ' + e.message] }; }
    const v = validate(level);
    return { valid: v.valid, level: v.valid ? level : null, errors: v.errors };
  }

  window.LevelFormat = {
    FORMAT, VERSION, DIFF_KEYS, LANES, TYPES,
    slug, validate, createBlank, fromGeneratedChart,
    save, load, list, remove, toJSON, fromJSON
  };
})();
