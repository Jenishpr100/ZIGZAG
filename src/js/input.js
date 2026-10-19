/* input.js — GUTTED. Rhythm input moved to LittleJS; see the `play` state in
   js/littlejs-game.js (playUpdate / tryStartHit / tryFlick — arrows L/R/UP/DOWN).

   This file only keeps no-op stubs so the legacy DOM boot path (js/main.js
   global key listeners) can still call Z.Input without crashing. */
(function () {
  const Z = (window.ZZ = window.ZZ || {});

  Z.Input = {
    KEYS: {},
    pointers: new Map(),
    attach: function () {},
    handlers: function () {},
    clear: function () {},
    keyDown: function () { return false; },
    keyUp: function () { return false; },
  };
})();
