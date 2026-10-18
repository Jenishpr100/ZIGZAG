///////////////////////////////////////////////////////////////////////////////
// ZIGZAG SYNTH — data.js
// Every number the game reads lives in this one file.
// Tune here, reload the page, feel the difference.
///////////////////////////////////////////////////////////////////////////////

// hex string -> engine Color ('#rgb', '#rrggbb' and '#rrggbbaa' all parse)
const col = (hex, a)=> new Color().setHex(hex).setAlpha(a === undefined ? 1 : a);
// same color, different alpha — used constantly for neon glow layers
const alpha = (c, a)=> c.withAlpha(a);

const SAVE_KEY = 'zigzag_save';

const DATA = {
    // ---- song / chart -------------------------------------------------------
    bpm: 120,
    beatsPerNote: 0.5,      // one tap every half beat
    noteCount: 24,          // demo chart length
    fallTime: 1.5,          // seconds a note takes to reach the judge line
    laneX: [-3, 3],         // world x of the two lanes — the two sides of the zigzag
    laneColor: ['#2ff3ff', '#ff2e88'],
    lineY: -5,              // judge line world y
    topY: 7,                // where notes spawn
    // windows in seconds; the last entry is the catch-all MISS
    judgments: [
        { name: 'PERFECT', window: 0.060, score: 100, color: '#ffe98a' },
        { name: 'GREAT',   window: 0.110, score:  70, color: '#2ff3ff' },
        { name: 'GOOD',    window: 0.160, score:  40, color: '#7cff9b' },
        { name: 'MISS',    window:  99,   score:   0, color: '#ff4d7d' },
    ],
    comboBonus: 2,          // score gained per combo point on top of the judgment
    penta: [0, 2, 4, 7, 9], // pentatonic degrees the synth plays on a hit

    // ---- palette: Teto magenta + cyan neon on deep violet -------------------
    colors: {
        bg:      '#0b0616',   // page / clear color
        bgTop:   '#150a2c',
        bgMid:   '#1d0d3a',
        bgBot:   '#3a1152',
        panel:   '#140a26',
        neon:    '#ff2e88',   // Teto magenta — the star
        neonSoft:'#ff8fc4',
        magenta: '#c81e6e',
        cyan:    '#2ff3ff',
        cyanSoft:'#0e7f9e',
        violet:  '#7a3cff',
        ink:     '#fff0fb',
        dim:     '#9b83bd',
        gold:    '#ffd76a',
        // world tiles
        floor:     '#120a24',
        floorAlt:  '#170e2d',
        floorEdge: '#1d1236',
        path:      '#241046',
        pathEdge:  '#4a1f8a',
        wall:      '#1b0f32',
        wallTop:   '#33204f',
        block:     '#2a1550',
        blockTop:  '#4a2a86',
        // judgment colors (mirrors judgments[].color, kept here for the HUD)
        good: '#7cff9b', ok: '#ffe98a', bad: '#ff4d7d',
    },

    // ---- overworld ----------------------------------------------------------
    world: {
        w: 40, h: 30,       // hub size in tiles (border walls included)
        camScale: 46,       // px per world unit while walking around
        camLerp: 0.12,      // how soft the camera trails the player (per frame)
        camLead: 1.5,       // how far ahead the camera looks in the move direction
        speed: 11,          // max walk speed, units / second
        accel: 90,          // how quickly you reach it
        friction: 26,       // how quickly you stop
        radius: 0.32,       // player collision radius
        zigLeg: 0.45,       // minimum length of one zigzag leg toward the cursor
        portalRange: 1.05,  // walk inside this to drop into the stage
        portalPrompt: 3.6,  // show the "press to enter" prompt inside this
        seed: 20261018,
        sparkRate: 18,      // ambient particles per second
    },
    playCamScale: 32,        // px per world unit inside the rhythm stage
    volume: 0.6,

    // ---- interface ----------------------------------------------------------
    ui: {
        font:  '"Arial Black", "Helvetica Neue", Arial, sans-serif',
        soft:  '"Trebuchet MS", Verdana, sans-serif',
        mono:  '"Courier New", ui-monospace, monospace',
    },
};

// resolve the palette once into real Color objects the engine can draw with
DATA.c = {};
for (const key in DATA.colors)
    DATA.c[key] = col(DATA.colors[key]);
DATA.c.judge = DATA.judgments.map(j=> col(j.color));
DATA.c.lane  = DATA.laneColor.map(c=> col(c));

// ---------------------------------------------------------------------------
// chart generator — the ZIGZAG: every note flips to the other lane
// ---------------------------------------------------------------------------
function makeChart()
{
    const notes = [], beat = 60 / DATA.bpm, gap = beat * DATA.beatsPerNote;
    for (let i = 0; i < DATA.noteCount; ++i)
        notes.push({ time: 1.2 + i * gap, side: i % 2 });
    return { notes, length: notes[notes.length - 1].time + 1.5 };
}
