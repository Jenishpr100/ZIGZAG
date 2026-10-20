/* Rhythm gameplay now lives in js/littlejs-game.js. The live ZZ.Game
   controller is installed there after LittleJS and its world modules load.
   Keep this file as a compatibility placeholder for older local checkouts;
   do not assign a second, no-op controller here. */
window.ZZ = window.ZZ || {};
window.ZZ.Game = {
  init() {},
  resize() {},
  start() {},
  pause() {},
  resume() {},
  restart() {},
  quit() {},
  stopLoop() {},
  togglePause() {},
  grade() { return ''; },
  accuracy() { return 0; },
  highScore() { return 0; }
};
