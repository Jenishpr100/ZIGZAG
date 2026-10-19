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
    laneX: [-3, 3],         // world x of the two lanes (legacy — the bands stack in y now)
    laneY: [-2.5, 2.5],     // world y of the two lanes — BOTTOM lower band, TOP upper band
    laneColor: ['#2ff3ff', '#ff2e88'],
    lineY: -5,              // judge line world y (legacy — each band has its own hit line)
    topY: 7,                // where notes spawn (legacy — notes fall to their band line)
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

        // ---- the two overworld palettes (ZIG real world / ZAG play world) ----
        // every world renderer reads DATA.pal.zig / DATA.pal.zag through owPal
        zig: {
            bg:        '#66b3ff',  // daytime sky
            bgTop:     '#9ad6ff',
            bgMid:     '#66b3ff',
            bgBot:     '#4d97e0',
            grass:     '#33b24a',  // green turf
            grassAlt:  '#2ea543',
            grassTuft: '#1c7d2e',  // darker blades scribbled on top
            path:      '#cdbe8a',  // sandy road
            pathEdge:  '#a3915f',
            pathSlash: '#a8945f',
            wall:      '#9a6b3f',  // timber / adobe walls
            wallTop:   '#b58552',
            wallEdge:  '#66401f',
            block:     '#8f6a45',
            blockTop:  '#ac8757',
            door:      '#e0a92e',  // wood-gold door
            doorOpen:  '#33d94d',  // passable
            shade:     '#12331c',  // shadows / underlays
            accent:    '#ffd76a',  // lamppost glow, decor lights
            sparkA:    '#ffe9a8',  // ambient motes
            sparkB:    '#ffd76a',
            glowA:     '#ffe9b0',  // backdrop light blobs
            glowB:     '#bfe6ff',
            ridgeStrokeFar:  '#3f9c55',  // far hills
            ridgeStrokeNear: '#49b862',
            ridgeFillFar:    '#1f5c30',
            ridgeFillNear:   '#2c7d3f',
            gridColor: '#ffffff',  // faint field lines
            gridAlpha: .05,
            starAlpha: 0,          // it is daytime
            flashA:    '#fff6d8',  // world-switch flash
        },
        zag: {
            bg:        '#0d001a',  // near-black purple
            bgTop:     '#14002a',
            bgMid:     '#0d001a',
            bgBot:     '#2a0044',
            grass:     '#260033',  // dark purple turf
            grassAlt:  '#2e0040',
            grassTuft: '#cc33ff',  // magenta neon crosshatch
            path:      '#33264d',
            pathEdge:  '#5a3f9e',
            pathSlash: '#7a4fff',
            wall:      '#1a1a26',
            wallTop:   '#262638',
            wallEdge:  '#00ffcc',  // cyan neon outline
            block:     '#1e1e2e',
            blockTop:  '#2c2c42',
            door:      '#ff4d00',  // orange neon
            doorOpen:  '#00ff80',  // green, passable
            shade:     '#05000d',
            accent:    '#2ff3ff',
            sparkA:    '#2ff3ff',
            sparkB:    '#ff2e88',
            glowA:     '#ff2e88',
            glowB:     '#2ff3ff',
            ridgeStrokeFar:  '#2ff3ff',
            ridgeStrokeNear: '#ff2e88',
            ridgeFillFar:    '#7a3cff',
            ridgeFillNear:   '#c81e6e',
            gridColor: '#7a3cff',  // the neon ground grid
            gridAlpha: .22,
            starAlpha: .5,
            flashA:    '#ff3ec8',
        },
    },

    // ---- tuning knobs for the systems that read from here -------------------
    tuning: {
        worldSwitchTime: 0.5,  // seconds for the ZIG <-> ZAG palette lerp
        dialogCps: 30,         // typewriter speed, characters per second
        npcRange: 1.6,         // world units to talk to an NPC
        doorRange: 1.35,       // world units that trips a door
        doorCooldown: 2.6,     // seconds before a locked door re-triggers
        doorFade: 0.35,        // seconds for each half of a door-warp fade (A3)
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

// ---------------------------------------------------------------------------
// player-facing progression state
//
// `window.playerState` is the single place the HUD reads hp / maxHp / level
// from, so the world HUD, the inventory panel and battle.js can never drift
// apart. js/hud.js mirrors the live battle hp back onto it every frame.
// ---------------------------------------------------------------------------
// guard: data.js is also loaded by headless harnesses that have no `window`
if (typeof window != 'undefined')
    window.playerState = window.playerState || {
        hp: 100, maxHp: 100, level: 1, exp: 0,
    };

// Starter inventory — there is no persistent inventory system yet, so the
// panel renders from this hardcoded seed (battle.js still keeps its own
// weapon/item list; both read the same shape).
//   weapons: { id, name, atk, power (alias), desc }
//   items:   { id, name, qty, desc }
DATA.playerInventory = DATA.playerInventory || {
    weapons: [
        { id: 'static_blade', name: 'Static Blade', atk: 10, power: 10,
          desc: 'Blade forged from a dead carrier wave.' },
    ],
    items: [
        { id: 'potion', name: 'Potion', qty: 1, desc: 'Restores 30 HP.' },
        { id: 'ether',  name: 'Ether',  qty: 1, desc: 'Restores 10 SP.' },
    ],
};

// resolve the palette once into real Color objects the engine can draw with
DATA.c = {};
for (const key in DATA.colors)
    if (typeof DATA.colors[key] == 'string')      // skip the zig/zag sub-palettes
        DATA.c[key] = col(DATA.colors[key]);
DATA.c.judge = DATA.judgments.map(j=> col(j.color));
DATA.c.lane  = DATA.laneColor.map(c=> col(c));

// both overworld palettes, resolved — overworld.js lerps between these
// (a few entries — gridAlpha / starAlpha — are plain numbers, kept as-is)
DATA.pal = {};
for (const world of ['zig', 'zag'])
{
    DATA.pal[world] = {};
    for (const key in DATA.colors[world])
    {
        const v = DATA.colors[world][key];
        DATA.pal[world][key] = typeof v == 'string' ? col(v) : v;
    }
}

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

// ---------------------------------------------------------------------------
// embedded sprite art
// kept as data URLs so the sprites load identically from file:// and http,
// no extra requests, no async pop-in, no canvas tainting under WebGL.
// source files: assets/img/spritesheet.png, assets/Tiny Neighbours Vol1/NPC_*.png
// ---------------------------------------------------------------------------
DATA.spriteInfo = {
    teto: { cellW: 20, cellH: 26, cols: 7, rows: 2 },   // Teto, 7 cols x 2 rows
    npc:  { cellW: 16, cellH: 16, cols: 8, rows: 13 },  // Tiny Neighbours sheets
};

DATA.sprites = {
    teto: 'data:image/png;base64,\
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',
    npc1: 'data:image/png;base64,\
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\
V/rtQ23/3YkAAAAASUVORK5CYII=',
    npc2: 'data:image/png;base64,\
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\
jK/rkBf//wMZHcfHnKy2OAAAAABJRU5ErkJggg==',
    npc3: 'data:image/png;base64,\
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',
    npc4: 'data:image/png;base64,\
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\
A82Eoq6NGA6iAAAAAElFTkSuQmCC',
    npc5: 'data:image/png;base64,\
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\
5/8BvDDpP19vhoQAAAAASUVORK5CYII=',
};
