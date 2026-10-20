/* chart-generator.js — shared difficulty tuning and menu star estimates.
   Playable notes come only from the matching levels/stageN.level file. */
(function () {
  const Z = (window.ZZ = window.ZZ || {});
  const LANES = 4;
  const DIFFS = {
    easy:   { label: 'Easy',   minGap: .62, rest: .26, hold: .12, drag: .07, win: [.070, .130, .200], hp: 3, tol: .90, fall: 1.75 },
    normal: { label: 'Normal', minGap: .46, rest: .18, hold: .16, drag: .13, win: [.055, .105, .160], hp: 5, tol: .78, fall: 1.50 },
    hard:   { label: 'Hard',   minGap: .34, rest: .12, hold: .18, drag: .19, win: [.045, .090, .135], hp: 6, tol: .68, fall: 1.25 },
    expert: { label: 'Expert', minGap: .26, rest: .08, hold: .18, drag: .24, win: [.035, .075, .115], hp: 7, tol: .60, fall: 1.05 }
  };
  const ORDER = ['easy', 'normal', 'hard', 'expert'];

  function gridStep(bpm, difficulty) {
    const limits = DIFFS[difficulty] || DIFFS.normal;
    let step = 60 / Math.max(1, bpm);
    while (step < limits.minGap) step *= 2;
    while (step / 2 >= limits.minGap) step /= 2;
    return step;
  }

  function estimateStars(bpm, difficulty) {
    const diff = DIFFS[difficulty] || DIFFS.normal;
    const nps = (1 - diff.rest) / gridStep(bpm, difficulty);
    return Math.max(1, Math.min(10, Math.round(nps * 1.9 + (diff.hold + diff.drag) * 4 + ORDER.indexOf(difficulty) * .5)));
  }

  /* Deterministic string→integer seed (FNV-1a). The same seed string always
     yields the same 32-bit integer, so the menu's numeric-seed hint and any
     numeric consumer stay stable across sessions. */
  function seedToNumber(seed) {
    const s = String(seed == null ? '' : seed);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h | 0;
  }

  function randomSeed() {
    return Math.floor(Math.random() * 0x100000000) - 0x80000000;
  }

  Z.Chart = { LANES, DIFFS, ORDER, gridStep, estimateStars, seedToNumber, randomSeed };
})();
