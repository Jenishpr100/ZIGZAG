/* menu.js — screens, song select, settings controls, overlays. Pure DOM; no framework. */
(function () {
  const Z = (window.ZZ = window.ZZ || {});
  const $ = (s, r) => (r || document).querySelector(s), $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const S = () => Z.Settings.data, set = (k, v) => Z.Settings.set(k, v);
  let current = 'menu', selected = null;

  const M = Z.Menu = {
    get current() { return current; },
    go(name) {
      if (name !== 'game') { Z.Game.quit(); Z.Audio.stop(); setOverlay(null); $('#btn-preview').textContent = 'Preview'; }
      $$('.screen').forEach(s => s.classList.toggle('active', s.id === 's-' + name));
      current = name;
      if (name === 'songs') { renderSongs(); }
      if (name === 'menu') updatePlaySub();
      if (name === 'game') Z.Game.resize();
      const first = $('#s-' + name + ' ' + (name === 'menu' ? '#btn-play' : name === 'songs' ? '.song[aria-current=true], .song, #btn-start' : 'button, input'));
      if (first && name !== 'game') setTimeout(() => first.focus({ preventScroll: true }), 60);
    },
    init() {
      buildLogo(); buildSegments(); bindNav(); bindSongs(); bindSettings(); bindOverlays();
      const last = Z.Songs.byId(S().lastSong);
      selected = last && (!Z.Game.canStartStage || Z.Game.canStartStage(last.id))
        ? last : Z.Songs.list.find(sg => !Z.Game.canStartStage || Z.Game.canStartStage(sg.id)) || null;
      syncAll(); if (Z.Dev && Z.Dev.isUnlocked()) showLevelEditorButton(); M.go('menu');
    },
    refreshAfterSongReload() { selected = Z.Songs.byId(S().lastSong) || Z.Songs.list[0] || null; renderSongs(); updatePlaySub(); }
  };

  /* ---------- title / nav ---------- */
  function buildLogo() {
    const l = $('#logo'); l.textContent = '';
    'MuZiC'.split('').forEach(ch => { const s = document.createElement('span'); s.textContent = ch; l.appendChild(s); });
    const sub = document.createElement('span'); sub.className = 'logo-second'; sub.textContent = 'SWITCH'; l.appendChild(sub);
  }
  function bindNav() {
    $$('[data-go]').forEach(b => b.addEventListener('click', () => { Z.Audio.unlock(); Z.Audio.sfx('ui'); M.go(b.dataset.go); }));
    $('#btn-play').addEventListener('click', () => { Z.Audio.unlock(); if (selected) startGame(); else M.go('songs'); });
    $$('.fs-btn').forEach(b => b.addEventListener('click', toggleFullscreen));
    // Arrow keys move focus between controls; Left/Right move within segmented groups.
    document.addEventListener('keydown', e => {
      if (current === 'game' || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target, tag = t.tagName;
      if (e.key === 'Escape') {
        const overlay = $('.overlay.on');
        if (overlay && overlay.id === 'ov-reset-progress') $('#reset-progress-cancel').click();
        else if (current !== 'menu' && !overlay) M.go('menu');
        return;
      }
      if (tag === 'INPUT' && (t.type === 'text' || t.type === 'range')) { if (!(t.type === 'range' && (e.key === 'ArrowUp' || e.key === 'ArrowDown'))) return; }
      if (tag === 'SELECT') return;
      const scope = $('.overlay.on') || $('.screen.active');
      const all = $$('button:not([disabled]), input:not([type=file]), summary', scope).filter(x => x.offsetParent !== null);
      let i = all.indexOf(t);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); i = i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length; all[i].focus();
      } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && t.closest && t.closest('.seg')) {
        const sib = $$('button', t.closest('.seg')), j = sib.indexOf(t) + (e.key === 'ArrowRight' ? 1 : -1);
        if (sib[j]) { e.preventDefault(); sib[j].focus(); }
      }
    });
  }
  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    } catch (e) {}
  }

  /* ---------- difficulty / theme segmented buttons (shared by menu, song select and settings) ---------- */
  function buildSegments() {
    $$('.diff-seg').forEach(box => Z.Chart.ORDER.forEach(id => {
      const b = document.createElement('button'); b.className = 'btn mini'; b.dataset.diff = id; b.textContent = Z.Chart.DIFFS[id].label;
      b.addEventListener('click', () => { set('difficulty', id); syncAll(); }); box.appendChild(b);
    }));
    $$('.theme-seg').forEach(box => Object.keys(Z.THEMES).forEach(id => {
      const b = document.createElement('button'); b.className = 'btn mini'; b.dataset.theme = id; b.textContent = Z.THEMES[id].name;
      b.addEventListener('click', () => { set('theme', id); syncAll(); }); box.appendChild(b);
    }));
  }

  /* ---------- song select ---------- */
  function fmtTime(s) { return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
  function renderSongs() {
    const ul = $('#song-list'); ul.textContent = '';
    Z.Songs.list.forEach(sg => {
      const li = document.createElement('li'), b = document.createElement('button');
      const locked = Z.Game.canStartStage && !Z.Game.canStartStage(sg.id);
      b.className = 'song' + (locked ? ' locked' : ''); b.dataset.id = sg.id;
      b.setAttribute('aria-current', selected && selected.id === sg.id); b.disabled = !!locked;
      const id = document.createElement('span'); id.className = 'id'; id.textContent = '#' + sg.id;
      const nm = document.createElement('span'); nm.textContent = sg.name;
      const bp = document.createElement('span'); bp.className = 'bpm'; bp.textContent = sg.bpm + ' BPM';
      if (locked) { const lock = document.createElement('span'); lock.className = 'stage-lock'; lock.textContent = 'LOCKED'; bp.appendChild(lock); }
      b.append(id, nm, bp); b.addEventListener('click', () => { selectSong(sg); });
      li.appendChild(b); ul.appendChild(li);
    });
    $('#song-empty').hidden = Z.Songs.list.length > 0;
    const locked = !!(selected && Z.Game.canStartStage && !Z.Game.canStartStage(selected.id));
    $('#btn-start').disabled = $('#btn-preview').disabled = !selected || locked;
    const n = Z.Songs.notices; $('#n-count').textContent = n.length; $('#bpm-src').textContent = Z.Songs.bpmSource;
    const nl = $('#notices'); nl.textContent = ''; n.forEach(x => { const li = document.createElement('li'); li.textContent = x; nl.appendChild(li); });
    $('.notices').open = n.length > 0 && !Z.Songs.list.length;
    updateDetail();
  }
  function selectSong(sg) {
    selected = sg; set('lastSong', sg.id); Z.Audio.stop(); $('#btn-preview').textContent = 'Preview';
    $$('.song').forEach(b => b.setAttribute('aria-current', +b.dataset.id === sg.id)); updateDetail(); updatePlaySub();
  }
  function updateDetail() {
    const sg = selected, d = S().difficulty;
    const locked = !!(sg && Z.Game.canStartStage && !Z.Game.canStartStage(sg.id));
    $('#d-name').textContent = sg ? sg.name : 'No song selected';
    $('#d-id').textContent = sg ? sg.id : '—'; $('#d-bpm').textContent = sg ? sg.bpm : '—';
    $('#d-len').textContent = sg && sg.status === 'ok' ? fmtTime(sg.duration) : '—';
    const st = sg ? Z.Chart.estimateStars(sg.bpm, d) : 0;
    $('#d-stars').textContent = sg ? '★'.repeat(st) + '  ' + st + '/10' : '—';
    const hs = sg && Z.Game.highScore(sg.id);
    $('#d-best').textContent = hs ? hs.score + ' (' + hs.grade + ')' : 'none yet';
    $('#d-msg').textContent = sg && locked ? 'Clear the previous stage to unlock this one.' : '';
    if (sg && sg.status === 'unknown') Z.Audio.probe(sg, (err, dur) => {
      if (selected !== sg) return;
      if (err) $('#d-msg').textContent = err; else $('#d-len').textContent = fmtTime(dur);
    });
    else if (sg && sg.status === 'error') $('#d-msg').textContent = sg.error;
    drawPreview();
  }
  function drawPreview() {
    const cv = $('#theme-preview'), c = cv.getContext('2d'), T = Z.theme, w = cv.width, h = cv.height;
    const g = c.createLinearGradient(0, 0, w, 0); g.addColorStop(0, T.bg[0]); g.addColorStop(1, T.bg[1]);
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    const xs = [40, 120, 200, 280]; c.strokeStyle = T.path; c.globalAlpha = .5; c.lineWidth = 3; c.setLineDash([8, 6]); c.beginPath();
    [[0, 70], [2, 40], [1, 22], [3, 50], [2, 70]].forEach((p, i) => i ? c.lineTo(xs[p[0]], p[1]) : c.moveTo(xs[p[0]], p[1])); c.stroke(); c.setLineDash([]); c.globalAlpha = 1;
    c.fillStyle = T.tap; c.fillRect(xs[0] - 24, 62, 48, 16); c.fillStyle = T.hold; c.fillRect(xs[2] - 24, 32, 48, 16);
    c.strokeStyle = T.drag; c.lineWidth = 8; c.lineJoin = 'round'; c.beginPath(); c.moveTo(xs[1], 18); c.lineTo(xs[3], 40); c.lineTo(xs[2], 62); c.stroke();
  }
  function bindSongs() {
    $('#btn-start').addEventListener('click', () => { Z.Audio.unlock(); startGame(); });
    $('#btn-preview').addEventListener('click', () => {
      if (!selected) return; const b = $('#btn-preview');
      if (b.textContent === 'Stop') { Z.Audio.stop(); b.textContent = 'Preview'; return; }
      b.textContent = 'Stop';
      Z.Audio.preview(selected, err => { if (err) { $('#d-msg').textContent = err; b.textContent = 'Preview'; } });
      setTimeout(() => { if (b.textContent === 'Stop') b.textContent = 'Preview'; }, 10200);
    });
    const file = $('#file-bmp');
    $('#btn-import').addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files[0]; if (!f) return; const r = new FileReader();
      r.onload = () => { Z.Songs.importBmp(String(r.result)); M.refreshAfterSongReload(); }; r.readAsText(f); file.value = '';
    });
    $('#btn-unimport').addEventListener('click', () => { Z.Songs.clearImport(); M.refreshAfterSongReload(); });
  }
  function startGame() {
    if (!selected) return M.go('songs');
    if (Z.Game.canStartStage && !Z.Game.canStartStage(selected.id)) return;
    set('lastSong', selected.id); M.go('game');
    Z.Game.start(selected, S().difficulty);
  }
  function updatePlaySub() { $('#play-sub').textContent = selected ? '#' + selected.id + ' ' + selected.name : ''; }

  /* ---------- settings ---------- */
  function bindSettings() {
    [['master', 100], ['music', 100], ['sfx', 100], ['offset', 1]].forEach(([k, mult]) => {
      const el = $('#set-' + k), out = el.parentNode.querySelector('output');
      el.addEventListener('input', () => { set(k, mult === 100 ? el.value / 100 : +el.value); out.textContent = mult === 100 ? el.value + '%' : el.value + ' ms'; Z.Audio.applyVolume(); });
    });
    ['reducedMotion', 'shake', 'hitFx', 'practice'].forEach(k => $('#set-' + k).addEventListener('change', e => { set(k, e.target.checked); syncAll(); }));
    $('#btn-reset').addEventListener('click', () => { Z.Settings.reset(); syncAll(); });
    $('#btn-reset-progress').addEventListener('click', () => { Z.Audio.sfx('ui'); setOverlay('reset-progress'); });
    bindDevUnlock();
  }

  /* ---------- hidden Developer unlock (Expert button x5) + DevLevelEdit menu entry ---------- */
  function toast(msg) {
    let t = $('#dev-toast');
    if (!t) {
      t = document.createElement('div'); t.id = 'dev-toast'; t.setAttribute('role', 'status');
      t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#15151c;color:#fff;' +
        'padding:10px 20px;border-radius:8px;border:1px solid #444;box-shadow:0 4px 18px rgba(0,0,0,.5);' +
        'font:600 14px/1.3 system-ui,sans-serif;z-index:10000;pointer-events:none;transition:opacity .4s;opacity:0';
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(toast._h); toast._h = setTimeout(() => { t.style.opacity = '0'; }, 2200);
  }
  function bindDevUnlock() {
    const panel = $('#s-settings .panel.form'); if (!panel) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn mini'; b.id = 'btn-expert';
    b.setAttribute('aria-label', 'Expert');
    const sync = () => { b.textContent = Z.Dev.isUnlocked() ? 'Developer: ON' : 'Expert'; };
    sync();
    b.addEventListener('click', () => {
      Z.Audio.unlock(); Z.Audio.sfx('ui');
      if (Z.Dev.isUnlocked()) { toast('Developer mode is already unlocked.'); return; }
      if (Z.Dev.tap()) { toast('You are now a Developer'); sync(); showLevelEditorButton(); }
      else toast('Expert ' + Z.Dev.taps + '/5');
    });
    panel.appendChild(b);
  }
  function showLevelEditorButton() {
    if ($('#btn-level-editor')) return;
    const nav = $('#s-menu nav') || $('#s-menu .stack') || $('#s-menu'); if (!nav) return;
    const b = document.createElement('button');
    b.className = 'btn'; b.id = 'btn-level-editor'; b.textContent = 'Level Editor';
    b.addEventListener('click', () => { window.location.href = 'LevelEditor.html'; });
    nav.appendChild(b);
  }
  function syncAll() {
    const s = S();
    Z.applyTheme(s.theme); document.body.classList.toggle('reduce', s.reducedMotion);
    $$('.diff-seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.diff === s.difficulty));
    $$('.theme-seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.theme === s.theme));
    [['master', s.master * 100, '%'], ['music', s.music * 100, '%'], ['sfx', s.sfx * 100, '%'], ['offset', s.offset, ' ms']].forEach(([k, v, u]) => {
      const el = $('#set-' + k); el.value = Math.round(v); el.parentNode.querySelector('output').textContent = Math.round(v) + u;
    });
    ['reducedMotion', 'shake', 'hitFx', 'practice'].forEach(k => $('#set-' + k).checked = !!s[k]);
    Z.Audio.applyVolume(); if (current === 'songs') updateDetail();
    if (Z.Game.resize) Z.Game.resize();
  }

  /* ---------- overlays (loading / error / pause / results) ---------- */
  function setOverlay(name) { $$('.overlay').forEach(o => o.classList.toggle('on', o.id === 'ov-' + name)); if (name) { const b = $('#ov-' + name + ' button'); if (b) setTimeout(() => b.focus(), 50); } }
  function bindOverlays() {
    const G = Z.Game;
    $('#btn-pause').addEventListener('click', () => G.pause());
    $('#p-resume').addEventListener('click', () => { setOverlay(null); G.resume(); });
    $('#p-restart').addEventListener('click', () => { setOverlay(null); G.restart(); });
    $('#p-songs').addEventListener('click', () => M.go('songs')); $('#p-menu').addEventListener('click', () => M.go('menu'));
    $('#r-restart').addEventListener('click', () => { setOverlay(null); G.restart(); });
    $('#r-songs').addEventListener('click', () => M.go('songs')); $('#r-menu').addEventListener('click', () => M.go('menu'));
    $('#err-back').addEventListener('click', () => M.go('songs'));
    $('#reset-progress-cancel').addEventListener('click', () => { Z.Audio.sfx('ui'); setOverlay(null); $('#btn-reset-progress').focus(); });
    $('#reset-progress-confirm').addEventListener('click', () => {
      if (!G.resetProgress || !G.resetProgress()) return;
      const firstStage = Z.Songs.list.find(song => song.id === 1 && song.status !== 'error') || Z.Songs.list.find(song => song.id > 0 && Z.Game.canStartStage(song.id)) || null;
      selected = firstStage;
      if (selected) set('lastSong', selected.id);
      renderSongs(); updatePlaySub();
      Z.Audio.sfx('ui'); setOverlay(null); $('#btn-reset-progress').focus();
    });
  }
  M.showOverlay = function (name, msg) {
    const G = Z.Game;
    if (name === 'loading') setOverlay('loading');
    else if (name === 'play') setOverlay(null);
    else if (name === 'error') { $('#err-msg').textContent = msg || 'Unknown audio error.'; setOverlay('error'); }
    else if (name === 'pause') { $('#pause-msg').textContent = msg || 'Tap, hold, drag. Keys: D F J K.'; setOverlay('pause'); }
    else if (name === 'results') {
      const sg = G.song, acc = G.accuracy();
      $('#r-title').textContent = G.failed ? 'Failed — health ran out' : 'Song complete';
      $('#r-song').textContent = sg.name; $('#r-meta').textContent = 'ID ' + sg.id + '  ·  ' + sg.bpm + ' BPM  ·  ' + Z.Chart.DIFFS[G.diff].label;
      $('#r-grade').textContent = G.failed ? 'F' : G.grade(acc);
      $('#r-score').textContent = G.score; $('#r-acc').textContent = (acc * 100).toFixed(2) + '%';
      $('#r-combo').textContent = G.maxCombo; $('#r-miss').textContent = G.counts[3];
      $('#r-pgg').textContent = G.counts[0] + ' / ' + G.counts[1] + ' / ' + G.counts[2];
      $('#r-best').textContent = G.failed ? '' : G.newBest ? 'New best score for this stage!' : (G.best ? 'Best score: ' + G.best : '');
      setOverlay('results');
    }
  };
})();
