// ============================================================
// data.js — ALL tuning numbers and colors live here.
// Tune the game by editing this file only.
// ============================================================

const DATA = {
  bpm: 120,
  hit:  { perfect: .06, great: .11, good: .16 }, // seconds early/late
  fallTime: 1.5,          // seconds from spawn to judge line
  lineY: -5,              // judge line (world units)
  topY: 7,                // note spawn height
  laneX: [-3, 3],         // two columns — presses zigzag between them
  noteSize: vec2(1.6, 1),
  score: { perfect: 100, great: 70, good: 40 },
  colors: {
    bg:    rgb(.05, .04, .08),
    left:  rgb(1, .3, .55),   // Teto-pink placeholder
    right: rgb(.3, .9, 1),    // cyan placeholder
    line:  rgb(1, 1, 1, .5),
  },
  penta: [0, 2, 4, 7, 9],     // pentatonic steps — every tap sounds musical
};

// Demo chart: 24 notes, one per beat, alternating sides = ZIGZAG.
// Later: load real charts from assets/charts/*.json
function makeChart() {
  const beat = 60 / DATA.bpm;
  const chart = [];
  for (let i = 0; i < 24; i++)
    chart.push({ t: DATA.fallTime + (i + 2) * beat, side: i % 2 });
  return chart;
}
