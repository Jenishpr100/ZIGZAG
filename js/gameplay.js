/* gameplay.js — GUTTED. The rhythm gameplay was ported to LittleJS; see the
   `play` state in js/littlejs-game.js (PlayNote, playUpdate, judgeUnit,
   buildPlayChart). The old DOM/canvas state machine that lived here is gone.

   This file now only keeps no-op stubs so the legacy DOM boot path
   (js/main.js + js/menu.js) can still load and call into ZZ.Game without
   crashing. Nothing here runs the game anymore. */
(function () {
  const Z = (window.ZZ = window.ZZ || {});

  Z.Game = {
    // fields the legacy menu reads
    state: 'idle', song: null, diff: 'normal', seed: '', chart: null, d: null,
    notes: [], t: 0, score: 0, combo: 0, maxCombo: 0, counts: [0, 0, 0, 0],
    failed: false, newBest: false, best: null, ui: {},
    // no-op API surface (kept so menu.js/main.js never throw)
    init: function () {},
    resize: function () {},
    start: function () {},
    stopLoop: function () {},
    loop: function () {},
    togglePause: function () {},
    pause: function () {},
    resume: function () {},
    restart: function () {},
    quit: function () {},
    grade: function () { return 'S'; },
    accuracy: function () { return 1; },
    highScore: function () { return null; },
  };
})();
