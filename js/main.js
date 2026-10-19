/* main.js — boot sequence and global listeners. */
(function () {
  const Z = (window.ZZ = window.ZZ || {});
  function boot() {
    Z.applyTheme(Z.Settings.get('theme'));
    Z.Game.init(document.getElementById('s-game'), { show: (n, m) => Z.Menu.showOverlay(n, m) });
    Z.Songs.load(() => Z.Menu.init());

    document.addEventListener('keydown', e => {
      const st = Z.Game.state;
      if (Z.Menu.current !== 'game') return;
      if (st === 'playing' || st === 'countdown') { if (Z.Input.keyDown(e)) e.preventDefault(); }
      else if (st === 'paused' && (e.code === 'Escape' || e.code === 'KeyP')) { e.preventDefault(); document.getElementById('p-resume').click(); }
      else if ((st === 'paused' || st === 'results') && e.code === 'KeyR') { e.preventDefault(); Z.Game.restart(); }
    });
    document.addEventListener('keyup', e => { if (Z.Input.keyUp(e)) e.preventDefault(); });
    // Safety: pause when the tab/window loses focus during play.
    const autoPause = () => { if (Z.Game.state === 'playing' || Z.Game.state === 'countdown') Z.Game.pause(); };
    window.addEventListener('blur', autoPause);
    document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });
    window.addEventListener('error', ev => console.warn('ZIGZAG error:', ev.message));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
