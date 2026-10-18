/* input.js — unified pointer + keyboard input.
   Everything is converted to "lane units" u (0..4 across the field; lane i centre = i + 0.5).
   Mouse, touch and pen all use Pointer Events. Keyboard keys act as virtual pointers parked on a
   lane centre, so taps, holds and drags work with D F J K too (keyboard is optional). */
(function () {
  const Z = (window.ZZ = window.ZZ || {});
  const KEYS = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };
  const pointers = new Map();       // id -> { u }
  let canvas = null, toU = () => 0, onPress = () => {}, onPauseKey = () => {}, onRestartKey = () => {};

  Z.Input = {
    KEYS, pointers,
    attach(c, converter) {
      canvas = c; toU = converter;
      c.addEventListener('pointerdown', e => {
        e.preventDefault();
        try { c.setPointerCapture(e.pointerId); } catch (_) {}
        const u = toU(e.clientX);
        pointers.set(e.pointerId, { u });
        onPress(u, e.pointerId);
      });
      c.addEventListener('pointermove', e => { const p = pointers.get(e.pointerId); if (p) p.u = toU(e.clientX); });
      const up = e => pointers.delete(e.pointerId);
      c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up); c.addEventListener('lostpointercapture', up);
      c.addEventListener('contextmenu', e => e.preventDefault());
      c.style.touchAction = 'none';
    },
    handlers(h) { onPress = h.press; onPauseKey = h.pause; onRestartKey = h.restart; },
    clear() { pointers.clear(); },
    /* Called by the global keydown/keyup listeners in main.js while a song is active. */
    keyDown(e) {
      if (e.code in KEYS) {
        if (e.repeat) return true;
        const id = 'k' + KEYS[e.code], u = KEYS[e.code] + .5;
        pointers.set(id, { u }); onPress(u, id); return true;
      }
      if (e.code === 'Escape' || e.code === 'KeyP' || e.code === 'Space') { if (!e.repeat) onPauseKey(); return true; }
      if (e.code === 'KeyR') { if (!e.repeat) onRestartKey(); return true; }
      return false;
    },
    keyUp(e) { if (e.code in KEYS) { pointers.delete('k' + KEYS[e.code]); return true; } return false; }
  };
})();
