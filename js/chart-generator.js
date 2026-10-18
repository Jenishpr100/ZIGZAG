/* chart-generator.js — deterministic, seeded chart generation.
   Same (songId, bpm, difficulty, seed, firstBeatOffset) => identical notes, every time, in every browser.
   Only the seeded PRNG below is used for randomness (never Math.random).
   Notes are placed strictly one event at a time (tap, hold or drag), so a single mouse or finger can play everything. */
(function () {
  const Z = (window.ZZ = window.ZZ || {});
  const LANES = 4;

  /* Difficulty table. minGap = smallest time between events (s) -> caps density at high BPM.
     speed = max lanes per second a path/jump may require. win = [perfect, great, good] seconds. */
  const DIFFS = {
    easy:   { label: 'Easy',   minGap: .62, rest: .26, hold: .12, drag: .07, dragNodes: [3, 3], maxJump: 1, speed: 3.0, win: [.070, .130, .200], hp: 3, tol: .90, fall: 1.75 },
    normal: { label: 'Normal', minGap: .46, rest: .18, hold: .16, drag: .13, dragNodes: [3, 4], maxJump: 2, speed: 4.5, win: [.055, .105, .160], hp: 5, tol: .78, fall: 1.50 },
    hard:   { label: 'Hard',   minGap: .34, rest: .12, hold: .18, drag: .19, dragNodes: [3, 5], maxJump: 3, speed: 6.0, win: [.045, .090, .135], hp: 6, tol: .68, fall: 1.25 },
    expert: { label: 'Expert', minGap: .26, rest: .08, hold: .18, drag: .24, dragNodes: [4, 6], maxJump: 3, speed: 7.5, win: [.035, .075, .115], hp: 7, tol: .60, fall: 1.05 }
  };
  const ORDER = ['easy', 'normal', 'hard', 'expert'];

  /* ---- seeding ---- */
  function hashString(str) {               // cyrb53-style 32-bit hash; integer math only => identical everywhere
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h1 ^ h2) >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /* Text or number seed -> numeric seed. */
  function seedToNumber(seed) { return hashString('seed:' + String(seed).trim()); }
  function randomSeed() {                  // only used for the "Random Seed" button, never for charts
    const a = new Uint32Array(1);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return String(a[0] % 1000000).padStart(6, '0');
  }

  /* Smallest grid step (s) so density stays playable: fast BPM => half-time; slow BPM => double-time. */
  function gridStep(bpm, d) {
    let s = 60 / bpm;
    while (s < d.minGap) s *= 2;
    while (s / 2 >= d.minGap) s /= 2;
    return s;
  }
  /* Rough star rating (1-10) from BPM and difficulty alone. */
  function estimateStars(bpm, diff) {
    const d = DIFFS[diff] || DIFFS.normal;
    const nps = (1 - d.rest) / gridStep(bpm, d);
    return Math.max(1, Math.min(10, Math.round(nps * 1.9 + (d.hold + d.drag) * 4 + ORDER.indexOf(diff) * .5)));
  }

  const r3 = x => Math.round(x * 1000) / 1000;

  /* ---- custom LevelFormat levels (js/levelFormat.js) ----
     When a song entry carries a hand-mapped level (Z.Songs.customById), its notes are used
     as-is — no seeded randomness — so the same custom level always plays identically. */
  const LANE_TO_U = { bottom: 0, center: 1, top: 2 };   // LevelFormat lane name -> game lane index (0..3)
  function chartFromLevel(level, diffKey) {
    const key = String(diffKey || 'normal').toUpperCase();
    const diff = DIFFS[String(diffKey || 'normal').toLowerCase()] || DIFFS.normal;
    const empty = { notes: [], units: 0, step: gridStep(level && level.bpm || 120, diff), lanes: LANES, difficulty: key.toLowerCase(), seedNumber: 0, custom: true };
    if (!level || !level.difficulties || !level.difficulties[key] || !Array.isArray(level.difficulties[key].notes)) return empty;
    const bpm = (level.bpm > 0 && level.bpm) || 120;
    const step = 60 / bpm;
    const tickEvery = step >= .5 ? step / 2 : Math.max(step, .2);   // score ticks along holds (same cadence as generated holds)
    const notes = [];
    level.difficulties[key].notes.forEach(n => {
      if (!n || typeof n.t !== 'number' || !LANE_TO_U.hasOwnProperty(n.lane)) return;
      const lane = LANE_TO_U[n.lane];
      if (n.type === 'hold' && typeof n.dur === 'number' && n.dur > 0) {
        const end = r3(n.t + n.dur), ticks = [];
        for (let tt = n.t + tickEvery; tt <= end + 1e-6; tt += tickEvery) ticks.push(r3(tt));
        notes.push({ id: notes.length, type: 'hold', t: r3(n.t), lane, end, ticks, flicks: Array.isArray(n.flicks) ? n.flicks.slice() : [] });
      } else {
        notes.push({ id: notes.length, type: 'tap', t: r3(n.t), lane, end: r3(n.t), ticks: [] });
      }
    });
    notes.sort((a, b) => a.t - b.t).forEach((n, i) => { n.id = i; });
    const units = notes.reduce((s, n) => s + 1 + n.ticks.length, 0);
    return { notes, units, step, lanes: LANES, difficulty: key.toLowerCase(), seedNumber: 0, custom: true };
  }

  /* Chart -> LevelFormat JSON (needs js/levelFormat.js loaded). meta: { title, artist, audioPath, bpm, offsetMs } */
  function toLevelFormat(chart, meta) {
    if (!window.LevelFormat || !window.LevelFormat.fromGeneratedChart) return null;
    meta = meta || {};
    return window.LevelFormat.fromGeneratedChart(chart, meta.title || 'Untitled', meta.artist || '', meta.audioPath || '', meta.bpm || 120, meta.offsetMs || 0);
  }

  function generate(o) {
    try {                                     // custom mapped level wins over the seeded generator
      const S = window.ZZ && window.ZZ.Songs;
      const custom = S && S.customById ? S.customById(o.songId) : null;
      if (custom && custom.level) return chartFromLevel(custom.level, o.difficulty);
    } catch (e) {}
    const d = DIFFS[o.difficulty] || DIFFS.normal;
    const rng = mulberry32(hashString([o.songId, o.bpm, o.difficulty, seedToNumber(o.seed), r3(o.offset || 0)].join('|')));
    const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
    const step = gridStep(o.bpm, d);
    const endT = o.duration - 1.3;
    const anchor = o.offset || 0;
    let t = anchor + Math.ceil((2.2 - anchor) / step) * step;

    const notes = [];
    let lane = ri(0, LANES - 1), dir = rng() < .5 ? -1 : 1, lastKind = 'tap', style = 'zig', stepsInPhrase = 0, prevEnd = 0, k = 0;

    /* pick next lane: zigzag by default; styles add variety. Never moves faster than d.speed lanes/s. */
    function nextLane(from, gap) {
      let m = style === 'burst' ? (rng() < .5 ? 0 : 1) : ri(1, d.maxJump);
      m = Math.min(m, Math.max(0, Math.floor(d.speed * gap)));
      let to = from + dir * m;
      if (to < 0 || to > LANES - 1) { dir = -dir; to = from + dir * m; }
      to = Math.max(0, Math.min(LANES - 1, to));
      if (style !== 'stair') dir = -dir;                 // zigzag = flip direction each time
      return to;
    }

    while (t < endT) {
      if (stepsInPhrase-- <= 0) {                        // new phrase every 4-8 steps picks a style
        stepsInPhrase = ri(4, 8);
        const s = rng();
        style = s < .5 ? 'zig' : s < .7 ? 'stair' : s < .85 ? 'burst' : 'wide';
        if (style === 'wide') dir = lane < 2 ? 1 : -1;
      }
      if (k > 3 && rng() < d.rest) { t += step; k++; continue; }

      const gap = Math.max(.05, t - prevEnd);
      const r = rng();
      let kind = 'tap';
      if (k > 4 && lastKind === 'tap') {
        if (r < d.drag) kind = 'drag'; else if (r < d.drag + d.hold) kind = 'hold';
      }
      if (style === 'wide' && kind === 'tap') lane = nextLane(lane, gap) === lane ? lane : nextLane(lane, gap);
      else lane = nextLane(lane, gap);

      const tickEvery = step >= .5 ? step / 2 : step;    // hold/drag score ticks (never faster than ~5/s)
      const note = { id: notes.length, type: kind, t: r3(t), lane, end: r3(t), ticks: [] };

      if (kind === 'hold') {
        const dur = step * ri(1, 3);
        if (t + dur > endT) kind = note.type = 'tap';
        else { note.end = r3(t + dur); }
      }
      if (kind === 'drag') {
        const n = ri(d.dragNodes[0], d.dragNodes[1]);
        if (t + (n - 1) * step > endT) kind = note.type = 'tap';
        else {
          note.nodes = [{ t: r3(t), lane }];
          let l = lane;
          for (let i = 1; i < n; i++) {
            l = nextLane(l, step);
            if (l === note.nodes[i - 1].lane) l = l === 0 ? 1 : l === LANES - 1 ? l - 1 : l + dir;   // force a real zigzag turn
            note.nodes.push({ t: r3(t + i * step), lane: l });
          }
          note.end = note.nodes[n - 1].t; note.endLane = l;
        }
      }
      if (note.type !== 'tap') for (let tt = note.t + tickEvery; tt <= note.end + 1e-6; tt += tickEvery) note.ticks.push(r3(tt));
      if (note.type === 'drag') lane = note.endLane;
      notes.push(note);
      lastKind = note.type === 'tap' ? 'tap' : 'special';
      prevEnd = note.end;
      t = note.end + step;                               // keep events on the beat grid, never overlapping
      k++;
    }
    const units = notes.reduce((s, n) => s + 1 + n.ticks.length, 0);
    return { notes, units, step, lanes: LANES, difficulty: o.difficulty, seedNumber: seedToNumber(o.seed) };
  }

  Z.Chart = { LANES, DIFFS, ORDER, generate, gridStep, estimateStars, hashString, seedToNumber, randomSeed, chartFromLevel, toLevelFormat };
})();
