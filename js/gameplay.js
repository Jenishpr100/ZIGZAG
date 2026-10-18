/* gameplay.js — game state machine, judging, scoring and canvas rendering.
   States: idle -> loading -> countdown -> playing <-> paused -> results.
   Time source: Z.Audio.now() (real audio position minus the user's offset). There is no separate timer. */
(function () {
  const Z = (window.ZZ = window.ZZ || {});
  const LANES = 4, WEIGHT = [1, .75, .4, 0], NAMES = ['PERFECT', 'GREAT', 'GOOD', 'MISS'];
  const G = Z.Game = {
    state: 'idle', song: null, diff: 'normal', seed: '', chart: null, d: null, notes: [], t: 0,
    score: 0, earned: 0, judged: 0, combo: 0, maxCombo: 0, health: 100, counts: [0, 0, 0, 0],
    fx: [], flash: null, shake: 0, countdownEnd: 0, countdownLabel: '', failed: false, ui: {}
  };
  let canvas, c2, W = 0, H = 0, dpr = 1, fieldL = 0, laneW = 0, judgeY = 0, raf = 0, resumeTime = 0, bgPhase = 0;
  const S = () => Z.Settings.data;
  const approach = () => G.d.fall;
  const uToX = u => fieldL + u * laneW;
  const yAt = t => judgeY - (t - G.t) / approach() * (judgeY + 30);

  /* ---------- setup ---------- */
  G.init = function (cv, ui) {
    canvas = cv; c2 = cv.getContext('2d'); G.ui = ui;
    Z.Input.attach(cv, x => (x - fieldL - cv.getBoundingClientRect().left) / laneW);
    Z.Input.handlers({ press, pause: () => G.togglePause(), restart: () => G.restart() });
    window.addEventListener('resize', resize); resize();
  };
  function resize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const fw = Math.min(W * .98, H * .72, 560);
    laneW = fw / LANES; fieldL = (W - fw) / 2; judgeY = H * .82;
  }
  G.resize = resize;

  /* ---------- flow ---------- */
  G.start = function (song, diff, seed) {
    G.stopLoop();
    G.song = song; G.diff = diff; G.seed = seed; G.d = Z.Chart.DIFFS[diff];
    G.state = 'loading'; G.failed = false; ui('loading');
    Z.Audio.unlock();
    Z.Audio.probe(song, (err, dur) => {
      if (G.song !== song || G.state !== 'loading') return;
      if (err) return fail(err);
      Z.Audio.load(song, err2 => {
        if (G.song !== song || G.state !== 'loading') return;
        if (err2) return fail(err2);
        G.chart = Z.Chart.generate({ songId: song.id, bpm: song.bpm, duration: dur, difficulty: diff, seed, offset: song.offset });
        G.notes = G.chart.notes.map(n => Object.assign({}, n, { state: 'pending', tickIdx: 0, ticksHit: 0 }));
        G.score = G.earned = G.judged = G.combo = G.maxCombo = 0; G.health = 100; G.counts = [0, 0, 0, 0]; G.fx = []; G.flash = null;
        G.t = 0; resumeTime = 0; Z.Input.clear();
        Z.Audio.onEnded(() => { if (G.state === 'playing') finish(false); });
        beginCountdown(3.2, 'start');
        G.loop();
      });
    });
  };
  function fail(msg) { G.state = 'idle'; Z.Audio.stop(); ui('error', msg); }
  function beginCountdown(sec, why) {
    G.state = 'countdown'; G.countdownEnd = performance.now() + sec * 1000; G.countdownWhy = why; ui('play');
  }
  G.togglePause = function () {
    if (G.state === 'playing' || G.state === 'countdown') G.pause();
    else if (G.state === 'paused') G.resume();
  };
  G.pause = function () {
    if (G.state !== 'playing' && G.state !== 'countdown') return;
    if (G.state === 'playing') resumeTime = Z.Audio.now();
    Z.Audio.pause(); Z.Input.clear(); G.state = 'paused'; ui('pause');
  };
  G.resume = function () { if (G.state === 'paused') { Z.Audio.unlock(); beginCountdown(2.2, 'resume'); } };
  G.restart = function () { if (G.song) { Z.Audio.stop(); G.start(G.song, G.diff, G.seed); } };
  G.quit = function () { G.stopLoop(); Z.Audio.stop(); Z.Input.clear(); G.state = 'idle'; };
  G.stopLoop = function () { cancelAnimationFrame(raf); raf = 0; };
  G.loop = function () { if (!raf) raf = requestAnimationFrame(frame); };

  function finish(failed) {
    G.failed = failed; G.state = 'results'; Z.Audio.stop(); Z.Input.clear();
    G.notes.forEach(n => { if (n.state === 'pending' || n.state === 'active') breakNote(n, true); });
    const acc = G.judged ? G.earned / G.judged : 0;
    const key = [G.song.id, G.diff, G.seed].join('|'), all = Z.Storage.get('highscores', {});
    const prev = all[key] || null;
    G.newBest = !failed && (!prev || G.score > prev.score);
    if (G.newBest) { all[key] = { score: G.score, acc, maxCombo: G.maxCombo, grade: grade(acc) }; Z.Storage.set('highscores', all); }
    G.best = G.newBest ? all[key] : prev;
    ui('results');
  }
  const grade = a => a >= .95 ? 'S' : a >= .9 ? 'A' : a >= .8 ? 'B' : a >= .7 ? 'C' : 'D';
  G.grade = grade;
  G.accuracy = () => G.judged ? G.earned / G.judged : 1;
  G.highScore = (id, diff, seed) => (Z.Storage.get('highscores', {})[[id, diff, seed].join('|')] || null);

  /* ---------- judging ---------- */
  function judgeUnit(q, u, silent, lane) {            // q: 0 perfect, 1 great, 2 good, 3 miss
    G.counts[q]++; G.judged++; G.earned += WEIGHT[q];
    G.score = Math.round(G.earned / G.chart.units * 1e6);
    if (q < 3) {
      G.combo++; G.maxCombo = Math.max(G.maxCombo, G.combo);
      G.health = Math.min(100, G.health + (silent ? .3 : 1));
    } else {
      G.combo = 0; G.health -= G.d.hp * (silent ? .5 : 1.6);
      if (!silent && S().shake && !S().reducedMotion) G.shake = 1;
      if (G.health <= 0 && !S().practice && G.state === 'playing') { G.health = 0; setTimeout(() => G.state === 'playing' && finish(true), 0); }
      if (S().practice && G.health < 20) G.health = 20;
    }
    if (!silent) {
      G.flash = { text: NAMES[q], q, at: performance.now() };
      Z.Audio.sfx(['perfect', 'great', 'good', 'miss'][q]);
      if (q < 3 && S().hitFx) burst(lane + .5, q);
    } else if (q < 3) Z.Audio.sfx('tick');
  }
  function burst(u, q) {
    const x = uToX(u), n = S().reducedMotion ? 3 : 14, cols = Z.theme.particles;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 200;
      G.fx.push({ x, y: judgeY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, life: .5, max: .5, col: cols[i % cols.length], r: 2 + Math.random() * 3 });
    }
    G.fx.push({ ring: true, x, y: judgeY, life: .35, max: .35, col: q === 0 ? '#ffffff' : Z.theme.tap });
  }
  function breakNote(n, silentEnd) {                  // head missed or note abandoned: remaining units count as misses
    const remaining = (n.state === 'pending' ? 1 : 0) + (n.ticks.length - n.tickIdx);
    n.state = 'missed';
    for (let i = 0; i < remaining; i++) judgeUnit(3, 0, i > 0, n.lane);
    n.tickIdx = n.ticks.length;
  }

  /* Path position (in lane units) of a note at time t. Taps/holds sit in one lane; drags zigzag between nodes. */
  function pathU(n, t) {
    if (n.type !== 'drag') return n.lane + .5;
    const a = n.nodes;
    if (t <= a[0].t) return a[0].lane + .5;
    for (let i = 1; i < a.length; i++) if (t <= a[i].t) { const f = (t - a[i - 1].t) / (a[i].t - a[i - 1].t); return a[i - 1].lane + .5 + (a[i].lane - a[i - 1].lane) * f; }
    return a[a.length - 1].lane + .5;
  }
  const tolFor = n => n.type === 'drag' ? G.d.tol : .75;
  const anyPointerNear = (u, tol) => { for (const p of Z.Input.pointers.values()) if (Math.abs(p.u - u) <= tol) return true; return false; };

  /* A new press: find the unjudged head nearest in time that this press is positioned on. */
  function press(u) {
    if (G.state !== 'playing') return;
    Z.Audio.unlock();
    const now = Z.Audio.now() - S().offset / 1000, win = G.d.win;
    let best = null, bd = win[2] + .0001;
    for (const n of G.notes) {
      if (n.state !== 'pending') continue;
      const dt = Math.abs(now - n.t);
      if (dt <= bd && Math.abs(u - (n.lane + .5)) <= (n.type === 'drag' ? G.d.tol + .15 : .65 + .1)) { best = n; bd = dt; }
      if (n.t - now > win[2]) break;
    }
    if (!best) return;
    const q = bd <= win[0] ? 0 : bd <= win[1] ? 1 : 2;
    judgeUnit(q, u, false, best.lane);
    best.state = best.type === 'tap' ? 'done' : 'active';
    best.hitAt = now;
  }

  /* ---------- per-frame update ---------- */
  function update(dt) {
    const raw = Z.Audio.now();
    G.t = Math.max(G.t, raw - S().offset / 1000);
    const win = G.d.win;
    for (const n of G.notes) {
      if (n.state === 'done' || n.state === 'missed') continue;
      if (n.state === 'pending') {
        if (G.t > n.t + win[2]) breakNote(n);
        else if (n.t - G.t > approach() + 1) break;
        continue;
      }
      // active hold/drag: judge each tick by whether any pointer is on the path right now
      while (n.tickIdx < n.ticks.length && G.t >= n.ticks[n.tickIdx]) {
        const tt = n.ticks[n.tickIdx++];
        if (anyPointerNear(pathU(n, tt), tolFor(n))) { n.ticksHit++; judgeUnit(0, 0, true, n.lane); if (S().hitFx) tickFx(n, tt); }
        else judgeUnit(3, 0, true, n.lane);
      }
      if (G.t >= n.end && n.tickIdx >= n.ticks.length) n.state = 'done';
    }
    for (const f of G.fx) { f.life -= dt; if (!f.ring) { f.x += f.vx * dt; f.y += f.vy * dt; f.vy += 400 * dt; } }
    G.fx = G.fx.filter(f => f.life > 0);
    G.shake = Math.max(0, G.shake - dt * 4);
  }
  function tickFx(n, tt) {
    if (S().reducedMotion) return;
    const x = uToX(pathU(n, tt));
    G.fx.push({ x, y: judgeY, vx: (Math.random() - .5) * 120, vy: -80, life: .3, max: .3, col: Z.theme.drag, r: 2.5 });
  }

  function frame(ts) {
    raf = 0;
    const dt = Math.min(.05, (ts - (frame.last || ts)) / 1000); frame.last = ts;
    if (G.state === 'countdown') {
      const left = G.countdownEnd - performance.now();
      G.countdownLabel = left > 0 ? String(Math.ceil(left / 1000)) : '';
      if (left <= 0) {
        if (G.countdownWhy === 'resume') Z.Audio.seek(Math.max(0, resumeTime - .0));
        Z.Audio.play().then(() => { if (G.state === 'countdown') G.state = 'playing'; })
          .catch(() => { G.state = 'paused'; ui('pause', 'The browser blocked audio — press Resume.'); });
        G.state = 'playing';
      } else { G.t = G.countdownWhy === 'resume' ? resumeTime : 0; }
    }
    if (G.state === 'playing') update(dt);
    else for (const f of G.fx) f.life -= dt;
    render(ts);
    if (G.state === 'results' || G.state === 'idle') { render(ts); return; }
    raf = requestAnimationFrame(frame);
  }

  /* ---------- rendering ---------- */
  function render(ts) {
    const T = Z.theme, ctx = c2, reduce = S().reducedMotion;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, T.bg[0]); g.addColorStop(1, T.bg[1]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (G.shake > 0 && !reduce) ctx.translate((Math.random() - .5) * 10 * G.shake, (Math.random() - .5) * 10 * G.shake);
    if (!G.chart) return;

    // backdrop zigzag bands (slow drift; frozen under reduced motion)
    bgPhase = reduce ? 0 : (ts / 40) % 80;
    ctx.strokeStyle = T.grid; ctx.lineWidth = 2; ctx.beginPath();
    for (let y = -80 + bgPhase; y < H + 80; y += 80) { ctx.moveTo(0, y); for (let x = 0; x <= W; x += 60) ctx.lineTo(x, y + ((x / 60) % 2 ? 22 : 0)); }
    ctx.stroke();

    // field + lanes
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(fieldL, 0, laneW * LANES, H);
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
    for (let i = 0; i <= LANES; i++) { ctx.beginPath(); ctx.moveTo(fieldL + i * laneW, 0); ctx.lineTo(fieldL + i * laneW, H); ctx.stroke(); }
    // lane lights for held pointers
    for (const p of Z.Input.pointers.values()) {
      const l = Math.max(0, Math.min(LANES - 1, Math.floor(p.u)));
      const lg = ctx.createLinearGradient(0, judgeY - 220, 0, judgeY); lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(1, 'rgba(255,255,255,.2)');
      ctx.fillStyle = lg; ctx.fillRect(fieldL + l * laneW, judgeY - 220, laneW, 220);
    }

    // upcoming zigzag path: faint line connecting the next notes in time order
    ctx.strokeStyle = T.path; ctx.globalAlpha = .22; ctx.lineWidth = 3; ctx.setLineDash([10, 8]); ctx.beginPath();
    let first = true, shown = 0;
    for (const n of G.notes) {
      if (n.state === 'done' || n.state === 'missed') continue;
      const y = yAt(n.t); if (y < -40) break; if (y > judgeY + 20 && n.state === 'pending') continue;
      const x = uToX(n.lane + .5), yy = Math.min(y, judgeY);
      if (first) { ctx.moveTo(x, yy); first = false; } else ctx.lineTo(x, yy);
      if (n.type === 'drag') for (const nd of n.nodes) ctx.lineTo(uToX(nd.lane + .5), Math.min(yAt(nd.t), judgeY));
      if (++shown > 10) break;
    }
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;

    // judge line
    ctx.strokeStyle = '#fff'; ctx.globalAlpha = .85; ctx.lineWidth = 3; ctx.shadowColor = T.tap; ctx.shadowBlur = reduce ? 0 : 14;
    ctx.beginPath(); ctx.moveTo(fieldL, judgeY); ctx.lineTo(fieldL + laneW * LANES, judgeY); ctx.stroke(); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.font = '600 ' + Math.round(laneW * .22) + 'px system-ui,sans-serif'; ctx.textAlign = 'center';
    ['D', 'F', 'J', 'K'].forEach((k, i) => ctx.fillText(k, fieldL + (i + .5) * laneW, judgeY + laneW * .38));

    // notes (draw far to near)
    for (let i = G.notes.length - 1; i >= 0; i--) {
      const n = G.notes[i];
      if (n.state === 'done' && n.type === 'tap') continue;
      const top = yAt(n.end), bot = yAt(n.t);
      if (top > H + 40 || bot < -60 && top < -60) continue;
      if (n.t - G.t > approach() * 1.02 + .1 && n.type === 'tap') continue;
      drawNote(ctx, n, T);
    }

    // particles
    for (const f of G.fx) {
      const a = Math.max(0, f.life / f.max);
      ctx.globalAlpha = a;
      if (f.ring) { ctx.strokeStyle = f.col; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(f.x, f.y, laneW * (.3 + (1 - a) * .6), 0, 7); ctx.stroke(); }
      else { ctx.fillStyle = f.col; ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 7); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawHud(ctx, T);
  }

  function drawNote(ctx, n, T) {
    const nh = laneW * .34, x0 = uToX(n.lane + .5), missed = n.state === 'missed';
    ctx.globalAlpha = missed ? .3 : 1;
    if (n.type === 'tap') {
      roundRect(ctx, x0 - laneW * .44, yAt(n.t) - nh / 2, laneW * .88, nh, nh * .35, T.tap); ctx.globalAlpha = 1; return;
    }
    const act = n.state === 'active';
    const yHead = act ? judgeY : yAt(n.t);
    if (n.type === 'hold') {
      const yTail = yAt(n.end);
      ctx.fillStyle = T.hold; ctx.globalAlpha = (missed ? .2 : .4);
      roundRect(ctx, x0 - laneW * .3, yTail, laneW * .6, Math.max(2, yHead - yTail), laneW * .15, T.hold);
      ctx.globalAlpha = missed ? .3 : 1;
      roundRect(ctx, x0 - laneW * .44, yTail - nh * .3, laneW * .88, nh * .6, nh * .25, T.hold);        // tail cap
      if (!act) roundRect(ctx, x0 - laneW * .44, yHead - nh / 2, laneW * .88, nh, nh * .35, T.hold);   // head
      else { ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.strokeRect(x0 - laneW * .44, judgeY - nh / 2, laneW * .88, nh); }
    } else {
      // drag ribbon through its zigzag nodes; once active, start from the current path position
      const pts = [];
      if (act) pts.push([uToX(pathU(n, G.t)), judgeY]);
      for (const nd of n.nodes) if (!act || nd.t > G.t) pts.push([uToX(nd.lane + .5), yAt(nd.t)]);
      if (pts.length < 2) { ctx.globalAlpha = 1; return; }
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = T.drag; ctx.globalAlpha = missed ? .12 : .35; ctx.lineWidth = laneW * (G.d.tol * .9);
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke();
      ctx.globalAlpha = missed ? .3 : 1; ctx.lineWidth = 4;
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke();
      for (let i = 1; i < pts.length; i++) { ctx.fillStyle = T.drag; ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], 6, 0, 7); ctx.fill(); }
      const hp = pts[0]; ctx.fillStyle = act ? '#fff' : T.drag; ctx.beginPath(); ctx.arc(hp[0], hp[1], nh * .75, 0, 7); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function roundRect(ctx, x, y, w, h, r, fill) {
    ctx.fillStyle = fill; ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    ctx.fill();
  }

  function drawHud(ctx, T) {
    const fs = Math.max(14, laneW * .24), right = fieldL + laneW * LANES;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.font = '800 ' + fs * 1.5 + 'px system-ui,sans-serif';
    ctx.fillText(String(G.score).padStart(7, '0'), fieldL + 10, fs * 2);
    ctx.font = '600 ' + fs * .8 + 'px system-ui,sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.7)';
    ctx.fillText((G.accuracy() * 100).toFixed(1) + '%  ·  ' + grade(G.accuracy()), fieldL + 10, fs * 3.1);
    // health bar
    const bw = laneW * LANES - 20, hx = fieldL + 10, hy = fs * 3.5;
    ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.fillRect(hx, hy, bw, 6);
    ctx.fillStyle = G.health > 30 ? T.hold : '#ff4d4d'; ctx.fillRect(hx, hy, bw * G.health / 100, 6);
    if (S().practice) { ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.textAlign = 'right'; ctx.fillText('PRACTICE', right - 10, fs * 2); }
    ctx.textAlign = 'center';
    if (G.combo > 1) { ctx.fillStyle = '#fff'; ctx.font = '900 ' + fs * 2.2 + 'px system-ui,sans-serif'; ctx.fillText(String(G.combo), W / 2, H * .4); ctx.font = '700 ' + fs * .8 + 'px system-ui,sans-serif'; ctx.fillText('COMBO', W / 2, H * .4 + fs); }
    if (G.flash) {
      const age = (performance.now() - G.flash.at) / 1000;
      if (age < .5) {
        ctx.globalAlpha = 1 - age / .5; ctx.fillStyle = ['#ffe45e', '#7dffb0', '#7cc8ff', '#ff5c5c'][G.flash.q];
        ctx.font = '900 ' + fs * 1.4 * (1 + (S().reducedMotion ? 0 : (.3 - Math.min(.3, age)))) + 'px system-ui,sans-serif'; ctx.fillText(G.flash.text, W / 2, judgeY - laneW * 1.1); ctx.globalAlpha = 1;
      }
    }
    if (G.state === 'countdown') {
      ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff'; ctx.font = '900 ' + fs * 5 + 'px system-ui,sans-serif'; ctx.fillText(G.countdownLabel, W / 2, H * .45);
      ctx.font = '600 ' + fs * .9 + 'px system-ui,sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.fillText('Tap  ·  Hold  ·  Drag the zigzag     (keys: D F J K)', W / 2, H * .45 + fs * 2.2);
    }
  }
  function ui(name, msg) { G.ui.show && G.ui.show(name, msg); }
})();
