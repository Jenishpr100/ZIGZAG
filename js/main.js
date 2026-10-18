// ============================================================
// ZIGZAG SYNTH — M0 template
// States: title -> play (demo chart) -> results -> title
// Tap rule (M1 open point): time-only for now; position rule TBD.
// ============================================================

showSplashScreen = false;
cameraScale = 32;
canvasClearColor = DATA.colors.bg;

// ---- state ----
let state = 'title';            // 'title' | 'play' | 'results'
let chart = [], notes = [];      // notes = chart copies + judged flag
let songTime = 0;
let score = 0, combo = 0, best = 0, hits = 0;
let counts = { perfect: 0, great: 0, good: 0, miss: 0 };
let flash = { text: '', color: WHITE, at: -9 };
const SAVE_KEY = 'zigzag_save';

// ---- helpers ----
function screenText(str, dy, size, color, align = 'center', right = false) {
  const x = right ? mainCanvasSize.x - 24 : mainCanvasSize.x / 2;
  drawTextScreen(str, vec2(x, mainCanvasSize.y / 2 + dy), size, color,
      0, BLACK, right ? 'right' : align);
}

function noteY(n) {  // 1 at spawn, 0 at the judge line
  const p = (n.t - songTime) / DATA.fallTime;
  return DATA.lineY + p * (DATA.topY - DATA.lineY);
}
function noteX(n) { return DATA.laneX[n.side]; }

// ---- flow ----
function startSong() {
  chart = makeChart();
  notes = chart.map(n => ({ ...n, judged: false }));
  songTime = 0; score = 0; combo = 0; hits = 0;
  counts = { perfect: 0, great: 0, good: 0, miss: 0 };
  state = 'play';
}

function endSong() {
  if (score > best) { best = score; writeSaveData(SAVE_KEY, { best }); }
  state = 'results';
}

function tap() {
  audioUnlock();
  if (state == 'title')   return startSong();
  if (state == 'results') return state = 'title';

  // judge nearest unjudged note inside the GOOD window
  let target = null, dt = DATA.hit.good;
  for (const n of notes) {
    if (n.judged) continue;
    const d = Math.abs(songTime - n.t);
    if (d <= dt) { target = n; dt = d; }
  }
  if (!target) return;              // empty tap = no penalty (M1 decides)

  target.judged = true;
  hits++;
  let j, pts, color;
  if (dt <= DATA.hit.perfect) { j = 'PERFECT'; pts = DATA.score.perfect; color = rgb(1, .9, .3); counts.perfect++; }
  else if (dt <= DATA.hit.great) { j = 'GREAT'; pts = DATA.score.great; color = rgb(.4, 1, .6); counts.great++; }
  else { j = 'GOOD'; pts = DATA.score.good; color = rgb(.4, .7, 1); counts.good++; }

  combo++;
  score += pts + combo * 2;
  flash = { text: j, color, at: time };
  synthNote(DATA.penta[hits % DATA.penta.length]); // your tap = the song
}

// ---- engine callbacks ----
function gameInit() {
  best = readSaveData(SAVE_KEY, { best: 0 }).best;
}

function gameUpdate() {
  if (state != 'play') {
    if (keyWasPressed('Space') || keyWasPressed('Enter') || mouseWasPressed(0)) tap();
    return;
  }

  songTime += timeDelta;

  // auto-miss notes that passed the window
  for (const n of notes)
    if (!n.judged && songTime > n.t + DATA.hit.good) {
      n.judged = true; combo = 0; hits = 0; counts.miss++;
      flash = { text: 'MISS', color: rgb(1, .3, .3), at: time };
    }

  const last = chart[chart.length - 1];
  if (notes.every(n => n.judged) && songTime > last.t + 1) return endSong();

  if (keyWasPressed('Space') || keyWasPressed('Enter') || mouseWasPressed(0)) tap();
}

function gameUpdatePost() {}

function gameRender() {
  if (state != 'play') return;

  // zigzag polyline between upcoming notes — THE THEME
  for (let i = 0; i < notes.length - 1; i++) {
    const a = notes[i], b = notes[i + 1];
    if (a.judged || b.judged) continue;
    drawLine(vec2(noteX(a), noteY(a)), vec2(noteX(b), noteY(b)), .08, rgb(1, 1, 1, .25));
  }

  // judge line
  drawRect(vec2(0, DATA.lineY), vec2(12, .12), DATA.colors.line);

  // falling notes
  for (const n of notes) {
    if (n.judged) continue;
    const y = noteY(n);
    if (y > DATA.topY + 1 || y < DATA.lineY - 1) continue;
    drawRect(vec2(noteX(n), y), DATA.noteSize,
        n.side ? DATA.colors.right : DATA.colors.left);
  }
}

function gameRenderPost() {
  if (state == 'title') {
    screenText('ZIGZAG SYNTH', -70, 64, DATA.colors.left);
    screenText('tap / space to start', 20, 28, rgb(1, 1, 1, .8));
    screenText('best  ' + best, 70, 24, rgb(1, 1, 1, .5));
  }
  else if (state == 'play') {
    drawTextScreen('SCORE ' + score, vec2(24, 34), 28, WHITE, 0, BLACK, 'left');
    if (combo > 1) screenText(combo + ' COMBO', -mainCanvasSize.y / 2 + 34, 28,
        DATA.colors.right, 'right', true);
    if (time - flash.at < .4)
      screenText(flash.text, mainCanvasSize.y * .15, 44, flash.color);
  }
  else if (state == 'results') {
    screenText('RESULTS', -100, 56, DATA.colors.left);
    screenText('SCORE  ' + score, -40, 36, WHITE);
    screenText('PERFECT ' + counts.perfect + '   GREAT ' + counts.great, 10, 24, rgb(1, .9, .3));
    screenText('GOOD ' + counts.good + '   MISS ' + counts.miss, 45, 24, rgb(.4, .7, 1));
    screenText('best  ' + best, 90, 24, rgb(1, 1, 1, .5));
    screenText('tap / space for title', 140, 22, rgb(1, 1, 1, .6));
  }
}

engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost);
