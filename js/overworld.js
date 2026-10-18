///////////////////////////////////////////////////////////////////////////////
// MuZiC "Switch" — overworld.js
// A Pokémon-style multi-room overworld (amendment A3). Rooms are separate
// maps held in a registry that follows the shared `muzic-switch-world` v0
// schema (amendment A2) — the same shape WorldFormat.getWorld() returns, so
// the built-in default world and an authored GAME.BIN are interchangeable.
//
// Contract with the state machine (js/littlejs-game.js):
//   owUpdate(dt)     world logic — call once per frame while state == 'world'
//                    (safe to call at any time; it self-guards)
//   owRender()       extra overlay drawing — safe in any render pass; the
//                    dialog draws itself through an engine object layer and
//                    the door-warp fade draws here
//   owHandleKey(k,d) optional key feed if the state machine forwards raw keys
//   owSetWorld(w)    switch palette to 'zig' or 'zag' (never changes rooms —
//                    a Down-switch keeps the player where they stand)
//   owGetWorld()     current world name
//   owGetRoom()      current room id       owGetRoomDef()  its normalized def
//   owGetRoomName()  current room display name
//   owListRooms()    every room id in the registry
//   owLoadWorld(w)   force-install a muzic-switch-world object (dev/test)
//
// Battle contract: when a battle ends in victory the battle lane calls
//   ZZ.onEnemyDefeated(enemyId)
// and may read / write ZZ.defeatedEnemies[enemyId] directly. When an open
// ZAG gate / level-door is activated and its warden is already beaten we call
//   ZZ.startBattle(enemyId, def)      (def = the door's definition object)
// if the battle lane exposes it; otherwise a flavor dialog stands in.
///////////////////////////////////////////////////////////////////////////////

const TILE_FLOOR = 0, TILE_PATH = 1, TILE_WALL = 2, TILE_BLOCK = 3;

// little shared colors for the procedural cast (fixed, not palette-driven)
const OW_GUARD_CORE = col('#1a0b3a');
const OW_STANDIN_SKIN = col('#f4c9a3');
const OW_STANDIN_HUES = ['#ffd76a', '#2ff3ff', '#ff2e88', '#7cff9b', '#c86bff'].map(col);

let worldTiles, WORLD_W = 0, WORLD_H = 0;
let portalPos = vec2(), owPortalActive = false;
let player = null;
const worldDecor = [];

// ---- the two worlds ---------------------------------------------------------
let currentWorld = 'zig';               // 'zig' | 'zag' — persists across trips
let owPal = null;                       // active palette of engine Colors
let owSwitchT = 1;                      // 0..1 transition progress (1 = settled)
let owSwitchFrom = null, owSwitchTo = null, owSwitchFromName = null;

// live object lists (rebuilt every time a room is entered)
const owNpcs = [], owDoors = [], owEnemies = [], owAmbient = [], owBackdrops = [];
const owStatics = [];                   // floor / decor / portal — destroyed on room change
let owNear = null;                      // {kind:'npc'|'door', obj} the player can talk to

// ---- shared battle-state object --------------------------------------------
// created defensively so whichever lane loads first wins
var ZZ = typeof ZZ != 'undefined' && ZZ ? ZZ : {};
ZZ.defeatedEnemies = ZZ.defeatedEnemies || {};

///////////////////////////////////////////////////////////////////////////////
// sprite sheets — embedded data URLs (see data.js), decoded into engine
// textures as soon as an Image exists. Every draw falls back to procedural
// art when a sheet is unavailable.
///////////////////////////////////////////////////////////////////////////////

const owSheets = {};
let owSpritesTried = false;

function owLoadSprites()
{
    if (owSpritesTried) return;
    if (typeof DATA.sprites == 'undefined' || typeof Image == 'undefined') return;
    owSpritesTried = true;

    for (const key in DATA.sprites)
    {
        const info = key == 'teto' ? DATA.spriteInfo.teto : DATA.spriteInfo.npc;
        const img = new Image();
        img.onload = () =>
        {
            try
            {
                const tex = new TextureInfo(img, true, false, true);   // pixelated
                if (!tex.size.x) throw new Error('empty texture');
                const s = {
                    tex, img, cellW: info.cellW, cellH: info.cellH,
                    cols: info.cols, cells: [],
                };
                // pre-build one TileInfo per frame, row-major
                const count = Math.floor(tex.size.x / info.cellW) * Math.floor(tex.size.y / info.cellH);
                for (let i = 0; i < count; ++i)
                    s.cells.push(tile(i, vec2(info.cellW, info.cellH), tex));
                owSheets[key] = s;
            }
            catch (e) { owSheets[key] = null; }
        };
        img.onerror = () => { owSheets[key] = null; };
        img.src = DATA.sprites[key];
    }
}

function owCell(key, index)
{
    const s = owSheets[key];
    if (!s || !s.cells) return null;
    return s.cells[index] || null;
}

/** draw one spritesheet cell in world space; returns false if unavailable */
function owDrawCell(key, index, pos, size, color, mirror)
{
    const ti = owCell(key, index);
    if (!ti) return false;
    drawTile(pos, size, ti, color || WHITE, 0, !!mirror);
    return true;
}

///////////////////////////////////////////////////////////////////////////////
// palettes — owPal is always a full palette of Colors, either a direct
// reference to DATA.pal.zig/zag, or a per-frame lerp while switching.
// The ZIG <-> ZAG switch only swaps palette/layer visibility — room geometry
// is shared, so the player never moves when worlds flip (A3).
///////////////////////////////////////////////////////////////////////////////

function owGetWorld()      { return currentWorld; }
function owWorldSwitching(){ return owSwitchT < 1; }

function owSetWorld(world)
{
    world = world == 'zag' ? 'zag' : 'zig';
    if (world == currentWorld) return false;

    owSwitchFromName = currentWorld;
    currentWorld = world;
    owSwitchFrom = DATA.pal[owSwitchFromName];
    owSwitchTo   = DATA.pal[world];
    owSwitchT    = 0;

    // flash + shake + a burst of sparks around the player
    if (typeof flash != 'undefined')
    {
        flash = Math.max(flash, .85);
        flashColor = owSwitchTo.flashA.copy();
    }
    if (typeof shake != 'undefined') shake = Math.max(shake, .25);
    if (player)
    {
        const e = new ParticleEmitter(player.pos.copy(), PI/2, .7, .15, 60, PI, undefined,
            owSwitchTo.sparkA, owSwitchTo.sparkB,
            alpha(owSwitchTo.sparkA, 0), alpha(owSwitchTo.sparkB, 0),
            .9, .2, .02, .07, .05, .9, 1, 0, PI, .35, .6, false, true);
        owTrackBurst(e);
    }
    // ambient motes are baked at creation — respawn them in the new colors
    makeAmbient();
    return true;
}

function owTickPalette(dt)
{
    if (owSwitchT >= 1) return;
    owSwitchT = Math.min(1, owSwitchT + dt / DATA.tuning.worldSwitchTime);

    if (owSwitchT >= 1)
    {
        owPal = owSwitchTo;
        owSwitchFrom = owSwitchTo = owSwitchFromName = null;
    }
    else
    {
        // smoothstep lerp into a scratch palette for this frame
        // (gridAlpha / starAlpha are plain numbers — lerp those too)
        const t = owSwitchT, e = t*t*(3 - 2*t);
        const A = owSwitchFrom, B = owSwitchTo, s = {};
        for (const k in B)
        {
            const a = A[k] !== undefined ? A[k] : B[k], b = B[k];
            s[k] = a && typeof a.lerp == 'function' ? a.lerp(b, e)
                 : typeof a == 'number' && typeof b == 'number' ? a + (b - a)*e
                 : b;
        }
        owPal = s;
    }
    // the backdrop canvas bakes its colors — redraw it through the lerp
    for (const l of owBackdrops)
        if (!l.destroyed) l.redraw();
}

/** 0..1 visibility for objects that only live in one of the two worlds */
function owMembershipAlpha(worlds)
{
    const to = worlds.indexOf(currentWorld) >= 0 ? 1 : 0;
    if (owSwitchT >= 1 || !owSwitchFromName) return to;
    const from = worlds.indexOf(owSwitchFromName) >= 0 ? 1 : 0;
    const t = owSwitchT, e = t*t*(3 - 2*t);
    return from + (to - from)*e;
}

// ---- one-shot particle bursts get cleaned up -------------------------------
const owBursts = [];
function owTrackBurst(e) { owBursts.push(e); }
function owCleanBursts()
{
    for (let i = owBursts.length - 1; i >= 0; --i)
    {
        const e = owBursts[i];
        if (e.destroyed) { owBursts.splice(i, 1); continue; }
        if (e.emitElapsed > e.emitTime + e.particleTime + .2)
        { e.destroy(); owBursts.splice(i, 1); }
    }
}

// ---- input helpers ---------------------------------------------------------
// LittleJS mirrors WASD onto the arrow keys, so a press of S sets an ArrowDown
// edge too. The world switch only accepts a press where the physical ArrowDown
// key is genuinely held, and raw events forwarded through owHandleKey are
// accepted under the same rule.
const owKeyLatch = {};
let owPendingKeys = {}, owPendingFrame = {};

function owHandleKey(key, down)
{
    if (down && (key == 'ArrowDown' || key == 'Enter' || key == 'NumpadEnter' || key == 'Space'))
        owPendingKeys[key] = true;
}

/** did this key go down this frame? (engine edge + forwarded events, once) */
function owPressed(code)
{
    return !!owPendingFrame[code] || keyWasPressed(code);
}

function owArrowDownPhysical()
{
    return typeof inputKeysHeld == 'undefined' ? true : inputKeysHeld.has('ArrowDown');
}

///////////////////////////////////////////////////////////////////////////////
// world data — `muzic-switch-world` v0 registry (A2)
//
//   { format:'muzic-switch-world', version:0,
//     rooms: { id: { name, world:'zig'|'zag'|'both', size:[w,h],
//                    terrain:[row strings], spawn:[x,y], portal:[x,y],
//                    decor:[{kind,x,y}],
//                    doors:[{id,x,y,dir,to,tx,ty,lockedBy,worlds,...}],
//                    npcs:[{id,sprite,x,y,dir,dialog,worlds}],
//                    enemies:[{id,x,y,name,hp}],
//                    triggers:[{x,y,w,h,dialog}] } },
//     dialogs: { id: { name, pages:[...] } } }
//
// terrain chars: '#' wall  'X'/'B' block  '=' path  '.'/' ' floor
///////////////////////////////////////////////////////////////////////////////

let owWorldData = null;                 // the installed world object
let owWorldSource = 'default';          // 'default' | 'WorldFormat' | 'load'
let owRoomId = null;                    // current room id in the registry
const owRooms = {};                     // id -> normalized room def
const owTrigFlags = {};                 // per-trigger inside latch

function owGetRoom()      { return owRoomId; }
function owListRooms()    { return Object.keys(owRooms); }
function owGetRoomDef()   { return owRoomId ? owRooms[owRoomId] || null : null; }
function owGetRoomName()  { const r = owGetRoomDef(); return r ? r.name : ''; }
function owGetWorldData() { return owWorldData; }
function owGetWorldSource(){ return owWorldSource; }

/** is this object graph a usable muzic-switch-world bundle? */
function owValidateWorld(w)
{
    if (!w || typeof w != 'object') return false;
    if (w.format !== undefined && w.format != 'muzic-switch-world') return false;
    if (!w.rooms || typeof w.rooms != 'object') return false;
    let count = 0;
    for (const id in w.rooms)
    {
        const r = w.rooms[id];
        if (!r || typeof r != 'object') return false;
        if (!Array.isArray(r.size) || r.size.length < 2 ||
            !(r.size[0] >= 4) || !(r.size[1] >= 4)) return false;
        ++count;
    }
    return count > 0;
}

/** 'NPC_1' / 'npc1' -> 'npc1'; anything else passes through lowercased */
function owSheetFor(sprite)
{
    const s = String(sprite == undefined ? 'npc1' : sprite);
    if (/^teto$/i.test(s)) return 'teto';
    const m = s.match(/(\d+)\s*$/);
    if (/^npc/i.test(s)) return 'npc' + (m ? m[1] : '1');
    return s.toLowerCase();
}

/** per-object world membership: explicit `worlds` wins, else the room's tag */
function owWorldsOf(objWorlds, roomWorld)
{
    if (Array.isArray(objWorlds) && objWorlds.length) return objWorlds.slice();
    return roomWorld == 'both' ? ['zig', 'zag'] : [roomWorld];
}

/** normalize one room def against the world's dialog table */
function owNormalizeRoom(id, r, dialogs)
{
    const size = [Math.max(6, (r.size && r.size[0] | 0) || 24),
                  Math.max(6, (r.size && r.size[1] | 0) || 18)];
    const world = r.world == 'zig' || r.world == 'zag' ? r.world : 'both';
    const room = {
        id, name: r.name || id, world, size,
        terrain:  Array.isArray(r.terrain) && r.terrain.length ? r.terrain.slice() : null,
        spawn:    Array.isArray(r.spawn)   ? [+r.spawn[0] || 0, +r.spawn[1] || 0] : null,
        portal:   Array.isArray(r.portal)  ? [+r.portal[0], +r.portal[1]] : null,
        camScale: +r.camScale || 0,
        decor:    (r.decor || []).map(d => ({ kind: d.kind, x: +d.x || 0, y: +d.y || 0 })),
        doors:    (r.doors    || []).map(d => {
            const o = Object.assign({}, d);
            o.x = +o.x || 0; o.y = +o.y || 0;
            o.worlds = owWorldsOf(o.worlds, world);
            if (!o.lockedBy && o.enemy) o.lockedBy = o.enemy;   // A2 alias
            return o;
        }),
        npcs:     (r.npcs     || []).map(n => {
            const o = Object.assign({}, n);
            o.x = +o.x || 0; o.y = +o.y || 0;
            o.sheet = owSheetFor(o.sprite || o.sheet);
            o.cell  = o.cell === undefined ? 8 : o.cell;
            o.worlds = owWorldsOf(o.worlds, world);
            const dlg = o.dialog && dialogs && dialogs[o.dialog];
            o.name = (dlg && dlg.name) || o.name || o.id || 'TOWNSFOLK';
            return o;
        }),
        enemies:  (r.enemies  || []).map(e => {
            const o = Object.assign({}, e);
            o.x = +o.x || 0; o.y = +o.y || 0;
            o.worlds = owWorldsOf(o.worlds, world);
            return o;
        }),
        triggers: (r.triggers || []).map(t => {
            const o = Object.assign({}, t);
            o.x = +o.x || 0; o.y = +o.y || 0;
            o.w = Math.max(1, +o.w || 1); o.h = Math.max(1, +o.h || 1);
            o.worlds = owWorldsOf(o.worlds, world);
            return o;
        }),
    };
    if (!room.spawn) room.spawn = [size[0] >> 1, size[1] >> 1];
    return room;
}

/** install a whole world object into the registry (replaces every room) */
function owInstallRooms(w)
{
    for (const id in owRooms) delete owRooms[id];
    const dialogs = w.dialogs || {};
    for (const id in w.rooms)
        owRooms[id] = owNormalizeRoom(id, w.rooms[id], dialogs);
    return owListRooms();
}

/** a dialog table entry as {name, pages}; null when unknown */
function owDialogById(id)
{
    const d = owWorldData && owWorldData.dialogs && owWorldData.dialogs[id];
    if (!d) return null;
    const pages = Array.isArray(d.pages) ? d.pages.filter(p => typeof p == 'string' && p.length)
                 : typeof d.pages == 'string' ? [d.pages] : [];
    return { name: d.name || '…', pages: pages.length ? pages : ['…'] };
}

/**
 * Boot the world: prefer WorldFormat.getWorld() (the GAME.BIN / editor
 * pipeline, amendment A2), fall back to the built-in default world. Both
 * sources share the same schema, so nothing downstream changes.
 */
function owBootWorld()
{
    let src = null, source = 'default';
    try
    {
        const WF = (typeof window != 'undefined' && window.WorldFormat)
                || (typeof WorldFormat != 'undefined' ? WorldFormat : null);
        if (WF && typeof WF.getWorld == 'function')
        {
            const w = WF.getWorld();
            if (owValidateWorld(w)) { src = w; source = 'WorldFormat'; }
        }
    }
    catch (e) { src = null; }

    if (!src) { src = owBuildDefaultWorld(); source = 'default'; }

    if (src !== owWorldData)
    {
        owWorldData = src;
        owWorldSource = source;
        owInstallRooms(src);
        if (!owRooms[owRoomId]) owRoomId = owListRooms()[0];
    }
    else if (!owRooms[owRoomId])
        owRoomId = owListRooms()[0];
    return owWorldSource;
}

/** force-install a world object (dev tools / tests); re-boots the room */
function owLoadWorld(w)
{
    if (!owValidateWorld(w)) return false;
    owWorldData = w;
    owWorldSource = 'load';
    owInstallRooms(w);
    if (!owRooms[owRoomId]) owRoomId = owListRooms()[0];
    if (typeof state != 'undefined' && state == 'world') owEnterRoom(owRoomId, null, null);
    return true;
}

// ---------------------------------------------------------------------------
// the built-in default world — same schema WorldFormat returns
// ---------------------------------------------------------------------------

const OW_TOWN_W = 40, OW_TOWN_H = 30;

/** the original hub layout, expressed as terrain rows */
function owTerrainTown()
{
    const W = OW_TOWN_W, H = OW_TOWN_H, g = [];
    for (let y = 0; y < H; ++y) g.push(new Array(W).fill('.'));
    const fill = (x0, y0, x1, y1, ch)=>
    {
        for (let y = y0; y <= y1; ++y)
        for (let x = x0; x <= x1; ++x)
            if (g[y] && x >= 0 && x < W) g[y][x] = ch;
    };
    // border ring
    fill(0, 0, W-1, 0, '#'); fill(0, H-1, W-1, H-1, '#');
    fill(0, 0, 0, H-1, '#'); fill(W-1, 0, W-1, H-1, '#');
    // the zigzag road: plaza, then three switchbacks climbing north
    fill(7, 3, 15, 9,  '=');   // portal plaza
    fill(7, 9, 8, 15, '=');    // north
    fill(7, 15, 31, 16, '=');  // east
    fill(30, 16, 31, 21, '='); // north
    fill(10, 20, 31, 21, '='); // west
    fill(10, 21, 11, 25, '='); // north
    fill(10, 24, 32, 25, '='); // east
    fill(30, 22, 34, 26, '='); // viewing deck at the end of the road
    // neon-trimmed obstacle blocks, all clear of the road
    const blocks = [
        [18,5,20,7], [24,4,26,6], [30,7,33,9], [3,6,5,8],
        [3,12,5,14], [18,11,20,13], [25,12,27,14], [36,12,37,18],
        [3,18,5,19], [20,17,22,18],
        [3,23,5,26], [16,22,19,23], [16,27,20,28], [24,27,27,28],
        [12,1,14,2], [21,1,23,2], [34,2,36,3], [35,21,37,24],
    ];
    for (const b of blocks) fill(b[0], b[1], b[2], b[3], 'X');
    return g.map(r => r.join(''));
}

function owDefaultTownDecor()
{
    const pylons = [[6,10], [9,14], [32,17], [9,22], [36,27], [16,8], [23,6], [5,20], [28,14]];
    return pylons.map(p => ({ kind:'pylon', x:p[0], y:p[1] }))
        .concat([{ kind:'arch', x:33, y:24 }]);   // stage arch over the arena door
}

/** build a w×h terrain row array: floor with a wall ring, then fill ops */
function owMakeTerrain(w, h, fills)
{
    const g = [];
    for (let y = 0; y < h; ++y) g.push(new Array(w).fill('.'));
    const box = (x0, y0, x1, y1, ch)=>
    {
        for (let y = y0; y <= y1; ++y)
        for (let x = x0; x <= x1; ++x)
            if (g[y] && x >= 0 && x < w) g[y][x] = ch;
    };
    box(0, 0, w-1, 0, '#'); box(0, h-1, w-1, h-1, '#');
    box(0, 0, 0, h-1, '#'); box(w-1, 0, w-1, h-1, '#');
    for (const f of fills) box(f[0], f[1], f[2], f[3], f[4]);
    return g.map(r => r.join(''));
}

function owBuildDefaultWorld()
{
    return {
        format: 'muzic-switch-world', version: 0,
        rooms: {
            // ---- ZIG: town + two interiors ------------------------------------
            town: {
                name: 'Zig Zag Town', world: 'both',
                size: [OW_TOWN_W, OW_TOWN_H],
                terrain: owTerrainTown(),
                spawn: [11, 3], portal: [11, 6],
                decor: owDefaultTownDecor(),
                doors: [
                    { id:'house_door', x:16, y:10, dir:'up', worlds:['zig'],
                      to:'house', tx:7, ty:7, label:'HOUSE' },
                    { id:'shop_door',  x:4,  y:16, dir:'up', worlds:['zig'],
                      to:'shop',  tx:7, ty:9, label:'SHOP' },
                    { id:'arena_door', x:34, y:23, dir:'up', worlds:['zag'],
                      to:'arena', tx:15, ty:19, label:'ARENA' },
                    // the three warden gates — ZAG only, held shut until beaten
                    { id:'gate_north', x:33, y:27, worlds:['zag'],
                      lockedBy:'warden_north', enemy:'warden_north',
                      label:'NORTH GATE', enemyName:'NORTH WARDEN' },
                    { id:'gate_west',  x:9,  y:25, worlds:['zag'],
                      lockedBy:'warden_west', enemy:'warden_west',
                      label:'WEST GATE', enemyName:'WEST WARDEN' },
                    { id:'gate_east',  x:36, y:11, worlds:['zag'],
                      lockedBy:'warden_east', enemy:'warden_east',
                      label:'EAST GATE', enemyName:'EAST WARDEN' },
                ],
                npcs: [
                    { id:'ziggy', sprite:'NPC_1', x:10, y:8,  dir:'down', worlds:['zig'], dialog:'welcome' },
                    { id:'mira',  sprite:'NPC_2', x:21, y:12, dir:'down', worlds:['zig'], dialog:'mira_tip' },
                    { id:'rex',   sprite:'NPC_3', x:30, y:6,  dir:'down', worlds:['zig'], dialog:'rex_tip' },
                    { id:'pip',   sprite:'NPC_4', x:15, y:20, dir:'down', worlds:['zig'], dialog:'pip_inv' },
                    { id:'echo',  sprite:'NPC_5', x:25, y:18, dir:'down', worlds:['zig'], dialog:'echo_rhythm' },
                ],
                triggers: [
                    { id:'intro', x:12, y:7, w:4, h:2, dialog:'intro' },
                ],
            },
            house: {
                name: 'Practise House', world: 'zig', size: [14, 10],
                terrain: owMakeTerrain(14, 10, [
                    [3, 2, 3, 2, 'X'], [10, 2, 10, 2, 'X'],   // bookshelf corners
                    [6, 6, 7, 6, 'X'],                        // piano bench
                    [7, 8, 8, 8, '='],                        // the doorway back
                ]),
                spawn: [7, 7],
                doors: [
                    { id:'house_out', x:7, y:8, dir:'down', to:'town', tx:16, ty:11, label:'TOWN' },
                ],
                npcs: [
                    { id:'pianist', sprite:'NPC_3', x:5, y:3, dir:'down', dialog:'pianist' },
                ],
            },
            shop: {
                name: "Mira's Shop", world: 'zig', size: [16, 12],
                terrain: owMakeTerrain(16, 12, [
                    [3, 2, 8, 2, 'X'],                        // shuttered counter
                    [7, 5, 7, 5, 'X'],                        // a stacked crate
                    [7, 10, 8, 10, '='],                      // the doorway back
                ]),
                spawn: [7, 9],
                doors: [
                    { id:'shop_out', x:7, y:10, dir:'down', to:'town', tx:4, ty:15, label:'TOWN' },
                ],
                npcs: [
                    { id:'clerk', sprite:'NPC_2', x:11, y:3, dir:'down', dialog:'clerk' },
                ],
            },
            // ---- ZAG: battle areas --------------------------------------------
            arena: {
                name: 'Neon Arena', world: 'zag', size: [30, 22],
                terrain: owMakeTerrain(30, 22, [
                    [2, 3, 5, 3, 'X'],   [24, 3, 27, 3, 'X'],  // stand blocks
                    [15, 7, 16, 8, 'X'],                       // centre dais
                    [2, 12, 5, 12, 'X'],  [24, 12, 27, 12, 'X'],
                    [15, 19, 16, 20, '='],                     // doorway back to town
                ]),
                spawn: [15, 19],
                doors: [
                    { id:'arena_out', x:15, y:20, dir:'down', to:'town', tx:34, ty:24, label:'TOWN' },
                    { id:'pit_gate',  x:27, y:10, dir:'up',   to:'pit',  tx:11, ty:15,
                      lockedBy:'warden_east', enemy:'warden_east',
                      label:'PIT GATE', enemyName:'EAST WARDEN' },
                ],
                npcs: [
                    { id:'coach', sprite:'NPC_4', x:8, y:13, dir:'right', dialog:'coach' },
                ],
                enemies: [
                    { id:'spar_bot', x:20, y:15, name:'SPAR BOT', hp:40 },
                ],
                triggers: [
                    { id:'arena_banner', x:10, y:8, w:10, h:6, dialog:'arena_banner' },
                ],
            },
            pit: {
                name: 'Static Pit', world: 'zag', size: [24, 18],
                terrain: owMakeTerrain(24, 18, [
                    [3, 3, 6, 3, 'X'],   [13, 3, 16, 3, 'X'],  // rubble
                    [11, 7, 12, 8, 'X'],                       // the spike
                    [3, 12, 6, 12, 'X'],  [13, 12, 16, 12, 'X'],
                    [11, 16, 12, 16, '='],                     // doorway back to the arena
                ]),
                spawn: [11, 15],
                doors: [
                    { id:'pit_out', x:11, y:16, dir:'right', to:'arena', tx:26, ty:10, label:'ARENA' },
                ],
                enemies: [
                    { id:'glitch_wisp', x:6, y:6, name:'GLITCH WISP', hp:60 },
                ],
                triggers: [
                    { id:'pit_tip', x:8, y:2, w:8, h:3, dialog:'pit_tip' },
                ],
            },
        },
        dialogs: {
            welcome:      { name:'ZIGGY', pages:[
                'Welcome to Zig Zag Town! Press DOWN to switch worlds.',
                'One step down and the whole world flips. Try it!' ] },
            mira_tip:     { name:'MIRA', pages:[
                'The ZAG world is dangerous... but that\'s where the levels are.',
                'Gear up first. The neon side does not forgive.' ] },
            rex_tip:      { name:'REX', pages:[
                'I heard there\'s a powerful enemy guarding the north door.',
                'Clear it, and the north gate will answer to you.' ] },
            pip_inv:      { name:'PIP', pages:[
                'Press E to check your inventory. You\'ll need weapons!',
                'A bare-handed rhythm hero is a short-lived rhythm hero.' ] },
            echo_rhythm:  { name:'ECHO', pages:[
                'The rhythm of this world... can you hear it?',
                'Every step you take lands on the beat. Keep walking.' ] },
            intro:        { name:'TOWN CRIER', pages:[
                'Festival day in Zig Zag Town!',
                'Doors hum. The neon side waits beneath your feet.' ] },
            clerk:        { name:'CLERK', pages:[
                'Mira\'s shop — shuttered for the festival.',
                'Word is the ZAG arenas pay well. Try your luck there.' ] },
            pianist:      { name:'PIANO', pages:[
                'A note is taped to the keys: "Out practicing. Back at dusk."',
                'Faint piano drifts through the room anyway.' ] },
            coach:        { name:'COACH', pages:[
                'Welcome to the Neon Arena!',
                'Beat a warden at the town gates to unlock their trial.' ] },
            arena_banner: { name:'ARENA', pages:[
                'The crowd is made of static. It still cheers.',
                'Every note you hit lands harder in here.' ] },
            pit_tip:      { name:'SIGNAL', pages:[
                'Down here the static gets teeth.',
                'Clear the EAST GATE warden to open the way back.' ] },
        },
    };
}

// ---------------------------------------------------------------------------
// terrain parsing + tile <-> world helpers
// ---------------------------------------------------------------------------

function owParseTerrain(rows, W, H)
{
    const t = new Uint8Array(W*H);
    for (let y = 0; y < H; ++y)
    {
        const row = rows && typeof rows[y] == 'string' ? rows[y] : '';
        for (let x = 0; x < W; ++x)
        {
            const ch = row[x] || '.';
            t[y*W + x] = ch == '#' ? TILE_WALL
                       : ch == 'X' || ch == 'B' ? TILE_BLOCK
                       : ch == '=' ? TILE_PATH : TILE_FLOOR;
        }
    }
    return t;
}

// is a circle of radius r at p overlapping a solid tile?
function worldHits(p, r)
{
    const e = 1e-4;
    const x0 = Math.floor(p.x - r + WORLD_W/2 + e), x1 = Math.floor(p.x + r + WORLD_W/2 - e);
    const y0 = Math.floor(p.y - r + WORLD_H/2 + e), y1 = Math.floor(p.y + r + WORLD_H/2 - e);
    for (let y = y0; y <= y1; ++y)
    for (let x = x0; x <= x1; ++x)
        if (tileSolid(x, y)) return true;
    return false;
}

// tile <-> world helpers ------------------------------------------------------
const tileCenter = (tx, ty)=> vec2(tx - WORLD_W/2 + .5, ty - WORLD_H/2 + .5);
const tileType   = (tx, ty)=> tx < 0 || ty < 0 || tx >= WORLD_W || ty >= WORLD_H
                            ? TILE_WALL : worldTiles[ty*WORLD_W + tx];
const tileSolid  = (tx, ty)=> tileType(tx, ty) === TILE_WALL || tileType(tx, ty) === TILE_BLOCK;

/** a door's `dir` string as a facing vector */
function owDirVec(dir)
{
    return dir == 'up'    ? vec2(0, 1)
         : dir == 'down'  ? vec2(0, -1)
         : dir == 'left'  ? vec2(-1, 0)
         : dir == 'right' ? vec2(1, 0)
         : null;
}

// stable per-tile hash for scatter (tufts, etc)
function owHash(x, y, s)
{
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

///////////////////////////////////////////////////////////////////////////////
// backdrop — two parallax layers that always cover the screen.
// Colors come from owPal so a world switch can redraw them into the new sky.
///////////////////////////////////////////////////////////////////////////////

function makeBackdrop()
{
    owBackdrops.length = 0;

    // far: soft sky gradient + glow blobs (follows the camera fully in y)
    owBackdrops.push(new ParallaxLayer(vec2(0, 0), vec2(40, 26), vec2(.12, 1), -1e3,
        (context, size)=>
        {
            const P = owPal, w = size.x, h = size.y;
            const g = context.createLinearGradient(0, 0, 0, h);
            g.addColorStop(0,   P.bgTop.toString());
            g.addColorStop(.55, P.bgMid.toString());
            g.addColorStop(1,   P.bgBot.toString());
            context.fillStyle = g;
            context.fillRect(0, 0, w, h);

            // a few big soft glows, mirrored so the strip repeats without a seam
            const blobs = [[.18,.62,150,P.glowA,.10], [.62,.48,190,P.glowB,.12],
                           [.88,.70,130,P.glowB,.08], [.40,.78,160,P.glowA,.07]];
            context.globalCompositeOperation = 'lighter';
            for (const [bx, by, br, bc, ba] of blobs)
                for (const off of [0, w])
                {
                    const rg = context.createRadialGradient(bx*w+off, by*h, 0, bx*w+off, by*h, br);
                    const c = bc.copy().setAlpha(ba);
                    rg.addColorStop(0, c.toString());
                    rg.addColorStop(1, c.setAlpha(0).toString());
                    context.fillStyle = rg;
                    context.fillRect(bx*w+off-br, by*h-br, br*2, br*2);
                }
            context.globalCompositeOperation = 'source-over';

            // scattered stars (ZAG only — ZIG is daytime)
            if (P.starAlpha > .01)
            {
                const random = new RandomGenerator(DATA.world.seed);
                context.fillStyle = alpha(DATA.c.ink, .5*P.starAlpha).toString();
                for (let i = 0; i < 160; ++i)
                {
                    const x = random.float(0, w), y = random.float(0, h*.72), s = random.float(.6, 2.2);
                    context.fillRect(x, y, s, s);
                }
            }
        }, vec2(800, 520)));

    // near: a ridge + a faint grid, pinned to the horizon
    owBackdrops.push(new ParallaxLayer(vec2(0, -1), vec2(40, 26), vec2(.45, 1), -999,
        (context, size)=>
        {
            const P = owPal, w = size.x, h = size.y;

            // faint perspective grid on the ground half
            context.strokeStyle = alpha(P.gridColor, P.gridAlpha).toString();
            context.lineWidth = 1;
            for (let i = 0; i <= 12; ++i)
            {
                const y = h*.55 + (i*i) * h*.0022;
                context.beginPath(); context.moveTo(0, y); context.lineTo(w, y); context.stroke();
            }
            for (let i = 0; i <= 26; ++i)
            {
                const x = i * w/26;
                context.beginPath(); context.moveTo(x, h*.55); context.lineTo(x, h); context.stroke();
            }

            // the zigzag ridge itself — the theme, three times over
            const step = w/24;
            for (let layer = 0; layer < 3; ++layer)
            {
                const base = h*(.42 + layer*.085);
                const amp  = h*(.16 - layer*.04);
                const pts = [];
                for (let i = 0; i <= 48; ++i)
                    pts.push([i*step/2, base + (i % 2 ? amp : -amp) * (1 - layer*.15)]);
                context.strokeStyle = alpha(layer ? P.ridgeStrokeNear : P.ridgeStrokeFar,
                                            .5 - layer*.13).toString();
                context.lineWidth = 4 - layer;
                context.lineJoin = 'miter';
                context.beginPath();
                context.moveTo(pts[0][0], pts[0][1]);
                for (const p of pts) context.lineTo(p[0], p[1]);
                context.stroke();
                // fill under the ridge so it reads as land
                context.lineTo(w, h); context.lineTo(0, h); context.closePath();
                context.fillStyle = alpha(layer ? P.ridgeFillNear : P.ridgeFillFar,
                                          .10 - layer*.02).toString();
                context.fill();
            }
        }, vec2(800, 520)));
}

function makeAmbient()
{
    const P = owPal, W = DATA.world;
    for (const e of owAmbient)
        if (!e.destroyed) e.destroy();
    owAmbient.length = 0;
    if (!worldTiles || !WORLD_W) return;

    // slow additive sparks drifting up out of the ground
    owAmbient.push(new ParticleEmitter(vec2(0, 0), PI/2, vec2(WORLD_W-4, WORLD_H-4), 0, W.sparkRate,
        PI, undefined,
        P.sparkA, P.sparkB,                 // colorStartA / B
        alpha(P.sparkA, 0), alpha(P.sparkB, 0),   // colorEndA / B
        7, .13, .02,                        // life, size start, size end
        .006, .02, 1, 1, 0,                 // speed, angleSpeed, damping, angleDamping, gravity
        PI, .35, .35, false, true));

    // a brighter fountain of sparks right out of the portal (when there is one)
    if (owPortalActive)
        owAmbient.push(new ParticleEmitter(portalPos, PI/2, .8, 0, 26,
            .5, undefined,
            P.sparkA, P.sparkB,
            alpha(P.sparkA, 0), alpha(P.sparkB, 0),
            1.6, .22, .02,
            .05, .08, .98, 1, 0,
            .6, .25, .5, false, true));
}

///////////////////////////////////////////////////////////////////////////////
// tile rendering — only the tiles the camera can actually see
///////////////////////////////////////////////////////////////////////////////

function renderWorldTiles()
{
    const half = mainCanvasSize.scale(.5 / cameraScale);
    const tx0 = clamp(Math.floor(cameraPos.x - half.x + WORLD_W/2) - 1, 0, WORLD_W-1);
    const tx1 = clamp(Math.floor(cameraPos.x + half.x + WORLD_W/2) + 1, 0, WORLD_W-1);
    const ty0 = clamp(Math.floor(cameraPos.y - half.y + WORLD_H/2) - 1, 0, WORLD_H-1);
    const ty1 = clamp(Math.floor(cameraPos.y + half.y + WORLD_H/2) + 1, 0, WORLD_H-1);

    // ground first, then anything that stands up on it
    for (let ty = ty0; ty <= ty1; ++ty)
    for (let tx = tx0; tx <= tx1; ++tx)
        if (tileType(tx, ty) <= TILE_PATH) drawWorldTile(tx, ty);
    for (let ty = ty0; ty <= ty1; ++ty)
    for (let tx = tx0; tx <= tx1; ++tx)
        if (tileType(tx, ty) >  TILE_PATH) drawWorldTile(tx, ty);
}

// little grass detail: ZIG gets scribbled blades, ZAG gets neon crosshatch
function drawGrassDetail(tx, ty, p)
{
    const P = owPal;
    const zag = currentWorld == 'zag';
    const count = 2 + (owHash(tx, ty, 0) * 2 | 0);        // 2 or 3 tufts
    for (let i = 0; i < count; ++i)
    {
        const fx = (owHash(tx, ty, 1 + i) * .72 + .14) - .5;
        const fy = (owHash(tx, ty, 6 + i) * .62 + .19) - .5;
        const a = p.add(vec2(fx, fy));
        if (zag)
        {
            // magenta crosshatch tick
            const s = .05 + owHash(tx, ty, 9 + i) * .03;
            drawLine(a.add(vec2(-s, -s)), a.add(vec2(s, s)), .026, alpha(P.grassTuft, .9));
            drawLine(a.add(vec2(-s,  s)), a.add(vec2(s, -s)), .026, alpha(P.grassTuft, .7));
        }
        else
        {
            // a couple of dark blades, 2-3 px tall at hub zoom
            const h = .06 + owHash(tx, ty, 9 + i) * .035;
            drawLine(a, a.add(vec2(0, h)), .028, P.grassTuft);
            drawLine(a.add(vec2(.045, 0)), a.add(vec2(.05, h*.7)), .02, alpha(P.grassTuft, .8));
        }
    }
}

function drawWorldTile(tx, ty)
{
    const P = owPal, t = tileType(tx, ty), p = tileCenter(tx, ty);

    if (t == TILE_FLOOR)
    {
        const alt = ((tx*7 + ty*13) & 3) == 0;
        drawRect(p, vec2(1), alt ? P.grassAlt : P.grass);
        drawGrassDetail(tx, ty, p);
    }
    else if (t == TILE_PATH)
    {
        drawRect(p, vec2(1), P.path);
        // the zig-zag motif: a slash on every tile, flipped on its neighbour
        const up = ((tx + ty) & 1) == 0;
        const a = p.add(vec2(up ? -.42 : .42, -.42));
        const b = p.add(vec2(up ?  .42 : -.42, .42));
        drawLine(a, b, .13, alpha(P.pathSlash, .45));
        drawLine(a, b, .05, alpha(P.pathSlash, .85));
        // bright kerb on the long edges
        drawRect(p.add(vec2(0, .47)), vec2(1, .06), alpha(P.pathEdge, .8));
        drawRect(p.add(vec2(0, -.47)), vec2(1, .06), alpha(P.pathEdge, .8));
    }
    else if (t == TILE_WALL)
    {
        drawRect(p, vec2(1), P.wall);
        drawRect(p.add(vec2(0, .3)), vec2(1, .4), P.wallTop);
        // zig-zag border along the cap (the town's motif, stamped on every wall)
        const pts = [];
        for (let i = 0; i <= 4; ++i)
            pts.push(p.add(vec2(-.5 + i*.25, .45 + (i % 2 ? -.07 : .07))));
        drawLineList(pts, .05, alpha(P.wallEdge, .95));
        drawLineList(pts, .02, alpha(DATA.c.ink, .12));
        // ground shadow
        drawRect(p.add(vec2(0, -.49)), vec2(1, .05), alpha(P.shade, .55));
    }
    else // TILE_BLOCK
    {
        drawRect(p, vec2(1), P.block);
        drawRect(p.add(vec2(0, .32)), vec2(1, .36), P.blockTop);
        const pts = [];
        for (let i = 0; i <= 4; ++i)
            pts.push(p.add(vec2(-.5 + i*.25, .47 + (i % 2 ? -.07 : .07))));
        drawLineList(pts, .055, alpha(P.wallEdge, .95));
        drawRect(p.add(vec2(0, -.49)), vec2(1, .05), alpha(P.shade, .6));
        // a lit inner face so blocks read as solid, not flat
        drawRect(p.add(vec2(0, .1)), vec2(.7, .06), alpha(P.accent, .22));
    }
}

///////////////////////////////////////////////////////////////////////////////
// world objects
///////////////////////////////////////////////////////////////////////////////

class WorldFloor extends EngineObject
{
    constructor()
    {
        super(vec2(), vec2(WORLD_W, WORLD_H), undefined, 0, alpha(DATA.c.bg, 0), -100);
        this.mass = 0;
    }
    render() { renderWorldTiles(); }
}

class WorldDecor extends EngineObject
{
    constructor(d)
    {
        super(tileCenter(d.x, d.y), vec2(2, 3), undefined, 0, WHITE, 1);
        this.kind = d.kind;
        this.seed = rand(0, 6.28);
        this.mass = 0;
    }
    render()
    {
        const P = owPal, C = DATA.c, p = this.pos;
        if (this.kind == 'pylon')
        {
            const pulse = .6 + .4*sin(time*2 + this.seed);
            // shadow + post
            drawEllipse(p.add(vec2(0, -.42)), vec2(.9, .34), alpha(P.shade, .55));
            drawRect(p.add(vec2(0, -.05)), vec2(.3, .9), P.wallTop);
            drawRect(p.add(vec2(0, .42)), vec2(.5, .16), P.blockTop);
            // glowing head
            setAdditiveBlendMode(true);
            drawCircle(p.add(vec2(0, .55)), .55 + pulse*.15, alpha(P.accent, .16 + pulse*.12));
            setAdditiveBlendMode(false);
            drawCircle(p.add(vec2(0, .55)), .22, P.accent);
            drawCircle(p.add(vec2(0, .55)), .1, P.shade);
        }
        else if (this.kind == 'arch')
        {
            const pulse = .5 + .5*sin(time*1.6);
            const legs = [-1.6, 1.6];
            for (const lx of legs)
            {
                drawRect(p.add(vec2(lx, .4)), vec2(.5, 3.4), P.wallTop);
                drawRect(p.add(vec2(lx, 2.15)), vec2(.7, .18), alpha(P.accent, .8));
            }
            // the zig-zag bar across the top
            const pts = [];
            for (let i = 0; i <= 8; ++i)
                pts.push(p.add(vec2(-1.6 + i*.4, 2.1 + (i % 2 ? .45 : 0))));
            drawLineList(pts, .16, alpha(P.accent, .35 + pulse*.35));
            drawLineList(pts, .07, P.wallEdge);
            setAdditiveBlendMode(true);
            drawRect(p.add(vec2(0, 2.3)), vec2(4.4, 1.6), alpha(P.accent, .05 + pulse*.05));
            setAdditiveBlendMode(false);
            drawText('STAGE 01', p.add(vec2(0, 3.1)), .5, C.gold, .04, P.shade, 'center', DATA.ui.font);
        }
    }
}

class Portal extends EngineObject
{
    constructor(pos)
    {
        super(pos, vec2(3, 3), undefined, 0, WHITE, 5);
        this.phase = rand(0, 6.28);
        this.mass = 0;
    }
    render()
    {
        const C = DATA.c, P = owPal, p = this.pos, t = time + this.phase;
        const pulse = .5 + .5*sin(t*2.6);
        const near  = player && state == 'world'
            ? clamp(1 - p.subtract(player.pos).length() / 7, 0, 1) : 0;

        // ground pad
        drawEllipse(p.add(vec2(0, -.55)), vec2(3.4, 1.5), alpha(P.shade, .6));
        drawEllipse(p.add(vec2(0, -.55)), vec2(3.4, 1.5), alpha(P.bg, 0), 0,
            C.neon, alpha(C.neon, .35 + near*.4));

        // additive halo
        setAdditiveBlendMode(true);
        drawCircleGradient(p.add(vec2(0, .3)), 4.2 + pulse*.5, alpha(C.neon, .16 + near*.16), alpha(C.neon, 0));
        drawCircleGradient(p.add(vec2(0, .3)), 2.6, alpha(C.cyan, .18), alpha(C.cyan, 0));
        // vertical light shaft
        drawRect(p.add(vec2(0, 2.2)), vec2(.7 + pulse*.25, 4.4), alpha(C.neon, .12 + near*.1));
        setAdditiveBlendMode(false);

        // frame rings
        drawEllipse(p.add(vec2(0, .3)), vec2(2.9 + pulse*.12, 2.9 + pulse*.12), alpha(P.bg, 0), 0,
            C.cyan, alpha(C.cyan, .55 + near*.4));
        drawRegularPoly(p.add(vec2(0, .3)), vec2(2.5), 6, alpha(P.bg, 0), .08,
            alpha(C.neon, .8), t*.5);

        // the swirl inside
        drawCircle(p.add(vec2(0, .3)), 1.9, alpha(C.violet, .35 + pulse*.15));
        drawRegularPoly(p.add(vec2(0, .3)), vec2(1.55 + pulse*.1), 3, alpha(C.neon, .55), 0, 0, -t*1.4);
        drawRegularPoly(p.add(vec2(0, .3)), vec2(.95), 3, alpha(C.cyan, .7), 0, 0, t*2.1);
        drawCircle(p.add(vec2(0, .3)), .3 + pulse*.08, C.ink);

        // orbiting sparks
        for (let i = 0; i < 6; ++i)
        {
            const a = t*1.7 + i*PI*2/6;
            const q = p.add(vec2(cos(a), sin(a)*.62).scale(1.7 + pulse*.15)).add(vec2(0, .3));
            drawCircle(q, .16, i % 2 ? C.neonSoft : C.cyan);
        }

        drawText('STAGE 01', p.add(vec2(0, 2.6)), .55, C.ink, .05, P.bg, 'center', DATA.ui.font);
        drawText('zigzag etude', p.add(vec2(0, 2.05)), .32, C.cyan, 0, P.bg, 'center', DATA.ui.soft);
    }
}

///////////////////////////////////////////////////////////////////////////////
// doors — warp doors (A3: walk on / ENTER fades into the linked room), ZAG
// arena gates (held by ZZ.defeatedEnemies[lockedBy]) and plain flavor doors
///////////////////////////////////////////////////////////////////////////////

class WorldDoor extends EngineObject
{
    constructor(d)
    {
        super(tileCenter(d.x, d.y), vec2(1.7, 2.2), undefined, 0, WHITE, 6);
        this.def = d;
        this.tx = d.x | 0;
        this.ty = d.y | 0;
        this.enemyId = d.lockedBy || d.enemy || null;
        this.mass = 0;
        this.lockFlash = 0;
        this.openAnim = 0;
        this.cool = 0;
        this.inside = false;
        this.phase = rand(0, 6.28);
    }

    defeated()  { return !!(this.enemyId && ZZ.defeatedEnemies[this.enemyId]); }
    locked()    { return !!(this.enemyId && !ZZ.defeatedEnemies[this.enemyId]); }
    open()      { return !!this.def.open || !!this.def.to || this.defeated(); }
    links()     { return !!this.def.to && !!owRooms[this.def.to]; }
    member()    { return this.def.worlds.indexOf(currentWorld) >= 0; }
    alphaNow()  { return owMembershipAlpha(this.def.worlds); }

    update()
    {
        this.lockFlash = Math.max(0, this.lockFlash - timeDelta*2.5);
        this.openAnim  = Math.max(0, this.openAnim  - timeDelta*.7);
        this.cool      = Math.max(0, this.cool - timeDelta);
    }

    /** the player stepped onto this door tile — bump, warp, or nothing */
    onEnter()
    {
        if (this.locked())
        {
            if (this.cool > 0) return false;   // already bumped recently
            this.bump();
            return false;
        }
        if (this.def.to) return owBeginWarp(this);
        return false;
    }

    /** locked: red flash + "the enemy blocks your path" — no teleport */
    bump()
    {
        this.lockFlash = 1;
        this.cool = DATA.tuning.doorCooldown;
        if (typeof flash != 'undefined')
        {
            flash = Math.max(flash, .55);
            flashColor = DATA.c.bad.copy();
        }
        owDialogShow(this.def.enemyName || 'WARDEN', ['The enemy blocks your path!']);
        return false;
    }

    render()
    {
        const a = owMembershipAlpha(this.def.worlds);
        if (a <= .01) return;
        const P = owPal, p = this.pos, t = time + this.phase;
        const open = this.open();
        const pulse = .5 + .5*sin(t*3);
        const near = player ? clamp(1 - p.subtract(player.pos).length()/4.5, 0, 1) : 0;
        const doorCol = open ? P.doorOpen : P.door;

        // ground shadow
        drawEllipse(p.add(vec2(0, -.5)), vec2(1.3, .5), alpha(P.shade, .55*a));

        // the frame
        drawRect(p.add(vec2(0, .25)), vec2(1.15, 1.75), alpha(P.wall, a));
        drawRect(p.add(vec2(0, 1.02)), vec2(1.3, .3), alpha(P.wallTop, a));
        // zigzag trim on the frame cap
        const pts = [];
        for (let i = 0; i <= 4; ++i)
            pts.push(p.add(vec2(-.6 + i*.3, 1.16 + (i % 2 ? -.08 : .08))));
        drawLineList(pts, .05, alpha(P.wallEdge, .95*a));

        // the door slab
        const lock = this.lockFlash;
        const slab = open ? P.doorOpen : P.door;
        drawRect(p.add(vec2(0, .2)), vec2(.82, 1.35), alpha(slab, (.92 - .25*pulse)*a));
        drawRect(p.add(vec2(0, .2)), vec2(.6, 1.2), alpha(P.shade, (open ? .18 : .45)*a));
        // handle
        drawCircle(p.add(vec2(.24, .18)), .07, alpha(DATA.c.ink, .8*a));

        // proximity / unlock glow
        setAdditiveBlendMode(true);
        const glow = (near*.25 + (open ? .12 + pulse*.1 : 0) + this.openAnim*.5) * a;
        if (glow > .005)
            drawCircleGradient(p.add(vec2(0, .3)), 1.7 + pulse*.2 + this.openAnim,
                doorCol.withAlpha(glow), doorCol.withAlpha(0));
        setAdditiveBlendMode(false);

        // locked flash
        if (lock > .01)
        {
            drawRect(p.add(vec2(0, .25)), vec2(1.4, 1.9), alpha(DATA.c.bad, .55*lock*a));
            drawRect(p.add(vec2(0, .25)), vec2(1.6, 2.1), alpha(DATA.c.ink, .3*lock*a));
            drawText('LOCKED', p.add(vec2(0, .3)), .42 + lock*.1, DATA.c.ink,
                .06, DATA.c.bad, 'center', DATA.ui.font);
        }

        // unlock ring
        if (this.openAnim > .01)
            drawEllipse(p.add(vec2(0, .2)), vec2(1 + (1 - this.openAnim)*2.4, 1.4 + (1 - this.openAnim)*2),
                alpha(P.bg, 0), 0, .12*this.openAnim, P.doorOpen);

        // label when the player is close
        if (near > .05 && !lock)
        {
            const state_ = this.locked() ? 'LOCKED' : open ? 'OPEN' : 'SEALED';
            drawText(this.def.label || '', p.add(vec2(0, 1.7)), .34,
                alpha(open ? P.doorOpen : DATA.c.ink, (.6 + .4*near)*a),
                0, P.shade, 'center', DATA.ui.font);
            drawText(state_, p.add(vec2(0, 1.4)), .24,
                alpha(open ? P.doorOpen : DATA.c.bad, (.55 + .35*pulse)*a),
                0, P.shade, 'center', DATA.ui.font);
            if (open)
                drawText(this.links() ? '[ WALK IN ]' : '[ ENTER ]', p.add(vec2(0, -1.0)), .22,
                    alpha(DATA.c.ink, (.5 + .4*pulse)*a), 0, P.shade, 'center', DATA.ui.soft);
        }
    }
}

///////////////////////////////////////////////////////////////////////////////
// the guard standing next to a locked arena door — a procedural glitch beast
///////////////////////////////////////////////////////////////////////////////

class WorldGuard extends EngineObject
{
    constructor(door)
    {
        super(door.pos.add(vec2(1.25, .15)), vec2(1.2, 1.2), undefined, 0, WHITE, 7);
        this.door = door;
        this.mass = 0;
        this.phase = rand(0, 6.28);
        this.seed  = rand(0, 6.28);
    }

    update()
    {
        // drift home if the door moves (it does not, but stay tidy)
        const home = this.door.pos.add(vec2(1.25, .15));
        this.pos.x = lerp(this.pos.x, home.x, .1);
        this.pos.y = lerp(this.pos.y, home.y, .1);
    }

    render()
    {
        if (this.door.defeated()) return;
        owDrawGlitchBeast(this.pos, owMembershipAlpha(this.door.def.worlds),
            this.phase, this.seed);
    }
}

/** a free-standing glitch beast (room `enemies` entries from the A2 schema) */
class WorldFoe extends EngineObject
{
    constructor(e)
    {
        super(tileCenter(e.x, e.y), vec2(1.2, 1.2), undefined, 0, WHITE, 7);
        this.def = e;
        this.mass = 0;
        this.phase = rand(0, 6.28);
        this.seed  = rand(0, 6.28);
    }
    render()
    {
        const bob = sin(time*2.4 + this.phase)*.08;
        owDrawGlitchBeast(this.pos.add(vec2(0, bob)),
            owMembershipAlpha(this.def.worlds), this.phase, this.seed);
    }
}

/** shared procedural render for guards + room foes */
function owDrawGlitchBeast(p, a, phase, seed)
{
    if (a <= .01) return;
    const C = DATA.c, t = time + phase;
    const dv = player ? player.pos.subtract(p) : vec2();
    const look = dv.length() > .01 ? dv.normalize() : vec2();
    const at = (x, y)=> p.add(vec2(x, y));

    // hover shadow
    drawEllipse(at(0, -.55), vec2(.75, .28), alpha(owPal.shade, .5*a));

    // rotating spike crown
    setAdditiveBlendMode(true);
    drawCircle(at(0, .1), .8 + sin(t*4)*.06, alpha(C.violet, .16*a));
    setAdditiveBlendMode(false);
    for (let i = 0; i < 7; ++i)
    {
        const ang = t*.9 + i*PI*2/7;
        const q = at(cos(ang)*.42, .1 + sin(ang)*.42);
        drawRegularPoly(q, vec2(.24, .34), 3, alpha(C.magenta, .95*a), 0,
            alpha(DATA.c.bg, .7), ang + PI/2);
    }

    // body
    drawRegularPoly(at(0, .1), vec2(.78, .7), 9, alpha(C.violet, .98*a), .04,
        alpha(C.bg, .85*a), t*.4);
    drawRegularPoly(at(0, .1), vec2(.56, .5), 9, alpha(OW_GUARD_CORE, .9*a), 0, 0, -t*.3);

    // eyes that track the player
    for (const s of [-1, 1])
    {
        const ex = s*.16 + look.x*.06, ey = .18 + look.y*.05;
        drawEllipse(at(ex, ey), vec2(.15, .19), alpha(C.ink, .98*a));
        drawCircle(at(ex + look.x*.05, ey + look.y*.05), .07, alpha(C.bg, .98*a));
        drawCircle(at(ex + look.x*.07, ey + look.y*.07), .03, alpha(C.neon, .95*a));
    }
    // angry brow
    for (const s of [-1, 1])
        drawLine(at(s*.05, .36), at(s*.3, .3), .06, alpha(C.magenta, .95*a));

    // a jagged mouth of static
    const mouth = [];
    for (let i = 0; i <= 6; ++i)
        mouth.push(at(-.24 + i*.08, .02 + (i % 2 ? -.05 : .04)));
    drawLineList(mouth, .05, alpha(C.cyan, .9*a));
}

///////////////////////////////////////////////////////////////////////////////
// NPCs — the town cast, idle sprites from the Tiny Neighbours sheets
///////////////////////////////////////////////////////////////////////////////

class WorldNPC extends EngineObject
{
    constructor(d)
    {
        super(tileCenter(d.x, d.y), vec2(1, 1.3), undefined, 0, WHITE, 4);
        this.def = d;
        this.sheet = d.sheet;
        this.cell = d.cell === undefined ? 8 : d.cell;
        this.worlds = d.worlds;
        this.phase = rand(0, 6.28);
        this.mass = 0;
        this.prompt = 0;
    }

    alphaNow() { return owMembershipAlpha(this.worlds); }

    update()
    {
        const want = owNear && owNear.kind == 'npc' && owNear.obj === this ? 1 : 0;
        this.prompt = lerp(this.prompt, want, .25);
    }

    render()
    {
        const a = this.alphaNow();
        if (a <= .01) return;
        const P = owPal, p = this.pos, t = time + this.phase;
        const bob = sin(t*2.2)*.03;
        const at = (x, y)=> p.add(vec2(x, y + bob));

        // shadow
        drawEllipse(at(0, -.42), vec2(.72, .26), alpha(P.shade, .5*a));

        // sprite cell (row 1 col 0 = idle, facing the camera), else a stand-in
        const cell = this.cell;
        if (!owDrawCell(this.sheet, cell, at(0, .06), vec2(.78, .78),
                new Color(1, 1, 1, a)))
        {
            // procedural stand-in villager — one hue per NPC file
            const n = +String(this.sheet).replace(/\D+/g, '') || 1;
            const hue = OW_STANDIN_HUES[(n - 1) % OW_STANDIN_HUES.length];
            drawRegularPoly(at(0, -.08), vec2(.5, .55), 8, alpha(hue, .95*a), .05,
                alpha(P.shade, .9*a));
            drawCircle(at(0, .3), .3, alpha(OW_STANDIN_SKIN, .98*a));
            for (const s of [-1, 1])
                drawCircle(at(s*.1, .34), .05, alpha(DATA.c.bg, .95*a));
            drawRect(at(0, -.05), vec2(.34, .08), alpha(DATA.c.ink, .5*a));
        }

        // talk prompt
        if (this.prompt > .03 && state == 'world')
        {
            const pulse = .6 + .4*sin(t*5);
            const c = at(0, 1.12);
            drawRect(c, vec2(1.05, .4), alpha(P.shade, .88*this.prompt));
            drawRect(c, vec2(1.13, .48), alpha(P.accent, (.55 + .35*pulse)*this.prompt));
            drawRect(c, vec2(1.05, .4), alpha(P.shade, .9*this.prompt));
            drawText('ENTER', c, .24, alpha(P.accent, (.75 + .25*pulse)*this.prompt),
                0, P.shade, 'center', DATA.ui.font);
        }
    }
}

///////////////////////////////////////////////////////////////////////////////
// the player — procedural Teto with the spritesheet when it is available
///////////////////////////////////////////////////////////////////////////////

// frame map for assets/img/spritesheet.png (7 cols x 2 rows of 20x26)
const TETO_FRAMES = {
    down:  [0, 3, 12],   // idle, step A, step B
    up:    [4, 4, 11],
    left:  [2, 5, 6],
    right: [13, 9, 10],
};

class Player extends EngineObject
{
    constructor(pos)
    {
        super(pos, vec2(.9, .9), undefined, 0, WHITE, 20);
        this.mass = 0;         // movement is written straight into pos
        this.damping = 1;
        this.vel = vec2();     // units per second
        this.facing = vec2(1, 0);
        this.moveAmt = 0;
        this.step = 0;
        this.bob = rand(0, 6.28);
        this.trail = [];
        this.zigTarget = null;
        this.zigAxis = 0;      // 0 = walk x first, 1 = walk y first
        this.zigLeg = 0;
        this.zigBlocked = 0;
    }

    update()
    {
        if (state != 'world') return;
        const W = DATA.world, dt = timeDelta;

        // frozen while a dialog is on screen or the screen is fading through a door
        if (owWarp || (typeof Dialog != 'undefined' && Dialog.isOpen()))
        {
            this.vel = vec2();
            this.trail.length = 0;
            this.zigTarget = null;
            this.moveAmt = Math.max(0, this.moveAmt - .3);
            return;
        }

        // ---- input: arrows / WASD (S walks down, ArrowDown switches worlds) --
        let dir = vec2();
        if (keyIsDown('ArrowLeft')  || keyIsDown('KeyA')) dir.x -= 1;
        if (keyIsDown('ArrowRight') || keyIsDown('KeyD')) dir.x += 1;
        if (keyIsDown('ArrowUp')    || keyIsDown('KeyW')) dir.y += 1;
        if (keyIsDown('ArrowDown')  || keyIsDown('KeyS')) dir.y -= 1;

        if (dir.length())
        {
            dir = dir.normalize();
            this.zigTarget = null;
            this.trail.length = 0;
        }
        else
        {
            // ---- input: mouse / touch drives a visible zig-zag staircase ----
            if (mouseIsDown(0))
            {
                if (!this.zigTarget) { this.zigTarget = mousePos.copy(); this.zigLeg = 0; }
                else this.zigTarget = mousePos.copy();
            }
            dir = this.zigStep(dt);
        }

        // ---- accelerate / coast -------------------------------------------
        const goal = dir.scale(W.speed);
        const rate = dir.length() ? W.accel : W.friction;
        this.vel.x = moveToward(this.vel.x, goal.x, rate*dt);
        this.vel.y = moveToward(this.vel.y, goal.y, rate*dt);

        // ---- collide axis by axis so we slide along walls ------------------
        const r = W.radius;
        const nx = this.pos.x + this.vel.x*dt, ny = this.pos.y + this.vel.y*dt;
        if (!worldHits(vec2(nx, this.pos.y), r) && !owNpcBlocked(vec2(nx, this.pos.y), r))
            this.pos.x = nx; else this.vel.x = 0;
        if (!worldHits(vec2(this.pos.x, ny), r) && !owNpcBlocked(vec2(this.pos.x, ny), r))
            this.pos.y = ny; else this.vel.y = 0;

        // ---- animation state ------------------------------------------------
        const speed = this.vel.length();
        this.moveAmt = lerp(this.moveAmt, clamp(speed / W.speed), .18);
        this.step += speed*dt*3.2;
        if (this.facing.length() && dir.length())
            this.facing = this.facing.lerp(dir, .3).normalize();

        // ---- the portal (talk / doors get the interact key first) -----------
        if (owPortalActive)
        {
            const d = this.pos.subtract(portalPos).length();
            const talking = typeof Dialog != 'undefined' && Dialog.inputLocked();
            const busy = talking || !!owInteractableAt(this.pos);
            const press = keyWasPressed('Space') || keyWasPressed('Enter') || keyWasPressed('NumpadEnter');
            if (d < W.portalRange || (!busy && press) && d < W.portalPrompt)
                enterStage();
            else if (!busy && mouseWasPressed(0) && d < W.portalPrompt)
                enterStage();
        }
    }

    // one leg of the staircase: hold an axis until aligned with the cursor, then flip
    zigStep(dt)
    {
        const W = DATA.world;
        if (!this.zigTarget) return vec2();
        const d = this.zigTarget.subtract(this.pos);
        if (d.length() < .2) { this.zigTarget = null; return vec2(); }

        const ax = this.zigAxis ? 'y' : 'x';
        if (Math.abs(d[ax]) < .1)
        {
            // reached this corner — record it so the trail draws a real zig-zag
            if (this.zigLeg > W.zigLeg*.5)
            {
                this.trail.push(this.pos.copy());
                if (this.trail.length > 20) this.trail.shift();
            }
            this.zigAxis = 1 - this.zigAxis;
            this.zigLeg = 0;
            this.zigBlocked = 0;
        }
        else if (Math.abs(this.vel[ax]) < .01 && Math.abs(d[ax]) > .2)
        {
            // pressed against a wall on this axis — take the other one instead
            this.zigBlocked = (this.zigBlocked || 0) + dt;
            if (this.zigBlocked > .18)
            {
                this.zigAxis = 1 - this.zigAxis;
                this.zigLeg = 0;
                this.zigBlocked = 0;
            }
        }
        else
            this.zigBlocked = 0;
        this.zigLeg += W.speed*dt;

        const ax2 = this.zigAxis ? 'y' : 'x';
        return vec2(ax2 == 'x' ? Math.sign(d.x) : 0, ax2 == 'y' ? Math.sign(d.y) : 0);
    }

    render()
    {
        if (state != 'world') return;

        // the glowing zig-zag the mouse just drew
        if (this.trail.length > 1)
        {
            const pts = this.trail.concat([this.pos]);
            drawLineList(pts, .26, alpha(DATA.c.cyan, .18));
            drawLineList(pts, .1,  alpha(DATA.c.cyan, .55));
            for (const q of this.trail) drawCircle(q, .12, alpha(DATA.c.neonSoft, .4));
        }
        // a dashed lead line to the cursor target
        if (this.zigTarget)
        {
            const a = this.pos, b = this.zigTarget, n = 9;
            for (let i = 0; i < n; i += 2)
            {
                const p0 = a.lerp(b, i/n), p1 = a.lerp(b, (i+1)/n);
                drawLine(p0, p1, .05, alpha(DATA.c.neonSoft, .35));
            }
            drawEllipse(b, vec2(.55), alpha(DATA.c.bg, 0), 0, alpha(DATA.c.neon, .85));
        }

        // spritesheet Teto when available, procedural Teto otherwise
        const frame = owTetoFrame(this.facing, this.step, this.moveAmt);
        if (frame >= 0 && owCell('teto', frame))
        {
            const P = owPal;
            drawEllipse(this.pos.add(vec2(0, -.44)), vec2(.5, .19),
                alpha(P.shade, .5));
            const h = 1.06, w = h * 20/26;
            const bob = sin(time*3 + this.bob)*.04;
            if (!owDrawCell('teto', frame, this.pos.add(vec2(0, .09 + bob)), vec2(w, h)))
                drawTeto(this.pos, 1, this.step, this.facing.x, -this.vel.x*.035,
                    1 + this.moveAmt*.14, 1 - this.moveAmt*.14, this.moveAmt, this.bob);
        }
        else
            drawTeto(this.pos, 1, this.step, this.facing.x, -this.vel.x*.035,
                1 + this.moveAmt*.14, 1 - this.moveAmt*.14, this.moveAmt, this.bob);
    }
}

/** pick a Teto spritesheet frame for the current facing + stride */
function owTetoFrame(facing, step, moveAmt)
{
    if (typeof DATA.spriteInfo == 'undefined') return -1;
    const f = Math.abs(facing.x) >= Math.abs(facing.y)
        ? (facing.x < 0 ? 'left' : 'right')
        : (facing.y >= 0 ? 'down' : 'up');
    const m = TETO_FRAMES[f];
    if (moveAmt < .25) return m[0];
    return sin(step) >= 0 ? m[1] : m[2];
}

/** Draw the player character at a world position. Also used by the title screen. */
function drawTeto(pos, scale=1, step=0, facingX=1, lean=0, squashX=1, squashY=1, moveAmt=0, bobPhase=0)
{
    const C = DATA.c;
    const bob = sin(time*3 + bobPhase)*.05*scale;
    const sx = squashX*scale, sy = squashY*scale;
    const at = (x, y)=> pos.add(vec2(x*sx, y*sy + bob));
    const mirror = facingX < 0 ? -1 : 1;

    // ground shadow
    drawEllipse(pos.add(vec2(0, -.42*scale)), vec2(.95*scale, .3*scale), alpha(C.bg, .5));

    // feet — a little walk cycle
    const swing = sin(step)*.1*moveAmt;
    for (const s of [-1, 1])
        drawEllipse(at(s*.17, -.36 + swing*(s==mirror?1:0)*.4),
            vec2(.3*sx, .2*sy), C.magenta);

    // body
    drawRegularPoly(at(0, 0), vec2(.82*sx, .86*sy), 8, C.neon, .05, alpha(C.bg, .85), PI/8 + lean);
    drawRegularPoly(at(0, -.06), vec2(.7*sx, .68*sy), 8, alpha(C.magenta, .45), 0, 0, PI/8 + lean);
    // belly
    drawEllipse(at(0, -.08), vec2(.5*sx, .42*sy), C.neonSoft);
    // the T
    drawRect(at(0, .02), vec2(.36*sx, .08*sy), alpha(C.magenta, .9), lean);
    drawRect(at(0, -.08), vec2(.08*sx, .26*sy), alpha(C.magenta, .9), lean);

    // cheeks + eyes
    for (const s of [-1, 1])
    {
        drawEllipse(at(s*.26*mirror, .1), vec2(.16*sx, .1*sy), alpha(C.neonSoft, .8));
        drawCircle(at(s*.15*mirror, .18), .11*scale, C.bg);
        drawCircle(at(s*.15*mirror + .03*mirror, .21), .035*scale, C.ink);
    }

    // hair spikes — the silhouette that makes it Teto
    drawRegularPoly(at(.0, .42), vec2(.4*sx, .34*sy), 3, C.magenta, 0, 0, lean*.5);
    drawRegularPoly(at(-.22*mirror, .36), vec2(.3*sx, .24*sy), 3, C.magenta, 0, 0, -.5 + lean*.5);
    drawRegularPoly(at(.24*mirror, .34), vec2(.26*sx, .22*sy), 3, C.magenta, 0, 0, .55 + lean*.5);

    // a soft rim of light on the lit side
    setAdditiveBlendMode(true);
    drawCircleGradient(at(.12*mirror, .08), 1.1*scale, alpha(C.neon, .12), alpha(C.neon, 0));
    setAdditiveBlendMode(false);
}

///////////////////////////////////////////////////////////////////////////////
// proximity helpers (pure — safe to call from any update order)
///////////////////////////////////////////////////////////////////////////////

/** what can the player interact with at position p? 'npc' | 'door' | null */
function owInteractableAt(p)
{
    if (owWorldSwitching()) return null;
    let best = null, bd = 1e9;
    for (const n of owNpcs)
    {
        if (n.destroyed || n.alphaNow() < .5) continue;
        const d = p.subtract(n.pos).length();
        if (d < DATA.tuning.npcRange && d < bd) { bd = d; best = { kind:'npc', obj:n }; }
    }
    for (const dr of owDoors)
    {
        if (dr.destroyed || dr.alphaNow() < .5) continue;
        const d = p.subtract(dr.pos).length();
        if (d < DATA.tuning.doorRange && d < bd) { bd = d; best = { kind:'door', obj:dr }; }
    }
    return best;
}

/** stop the player from walking through townsfolk */
function owNpcBlocked(p, r)
{
    for (const n of owNpcs)
    {
        if (n.destroyed || n.alphaNow() < .5) continue;
        if (p.subtract(n.pos).length() < r + .34) return true;
    }
    return false;
}

///////////////////////////////////////////////////////////////////////////////
// room entry / exit — the heart of the multi-room world (A3)
///////////////////////////////////////////////////////////////////////////////

/** destroy every live room object (the player survives) */
function owClearRoomObjects()
{
    for (const arr of [owNpcs, owDoors, owEnemies, owAmbient, owBackdrops, owStatics])
    {
        for (const o of arr)
            if (o && !o.destroyed) o.destroy();
        arr.length = 0;
    }
    owNear = null;
}

/**
 * Enter a room from the registry: parse terrain, rebuild every object, place
 * the player. `spawn` is a tile [x,y] (falls back to the room's own spawn);
 * `facing` is a vec2 the player should look along after a warp.
 */
function owEnterRoom(id, spawn, facing)
{
    const room = owRooms[id];
    if (!room) return false;
    owRoomId = id;

    WORLD_W = room.size[0]; WORLD_H = room.size[1];
    worldTiles = owParseTerrain(room.terrain, WORLD_W, WORLD_H);

    owClearRoomObjects();
    for (const k in owTrigFlags) delete owTrigFlags[k];

    // settle the palette: a Down-switch never changes rooms, but warping into
    // a single-world room snaps the palette so the geometry always reads
    owSwitchT = 1;
    owSwitchFrom = owSwitchTo = owSwitchFromName = null;
    if (room.world == 'zig' || room.world == 'zag') currentWorld = room.world;
    owPal = DATA.pal[currentWorld];

    // statics: floor, decor, portal
    owStatics.push(new WorldFloor());
    worldDecor.length = 0;
    for (const d of room.decor)
    {
        worldDecor.push(d);
        owStatics.push(new WorldDecor(d));
    }
    owPortalActive = !!room.portal;
    portalPos = owPortalActive ? tileCenter(room.portal[0], room.portal[1]) : vec2(1e6, 1e6);
    if (owPortalActive) owStatics.push(new Portal(portalPos));

    // doors (+ a guard beside every still-locked one)
    for (const d of room.doors)
    {
        const door = new WorldDoor(d);
        owDoors.push(door);
        if (door.enemyId && !ZZ.defeatedEnemies[door.enemyId])
            owEnemies.push(new WorldGuard(door));
    }
    for (const n of room.npcs)
        owNpcs.push(new WorldNPC(n));
    for (const e of room.enemies)
        owEnemies.push(new WorldFoe(e));

    // the player — created on first entry, teleported on every warp after
    const st = spawn || room.spawn || [WORLD_W >> 1, WORLD_H >> 1];
    const pos = tileCenter(st[0]|0, st[1]|0);
    if (!player)
        player = new Player(pos.copy());
    else
    {
        player.pos = pos.copy();
        player.vel = vec2();
        player.trail.length = 0;
        player.zigTarget = null;
        if (facing && facing.length && facing.length() > .01)
            player.facing = facing.normalize().copy();
    }
    // never re-trigger a door the player is standing in when they arrive
    for (const dr of owDoors)
        dr.inside = player.pos.subtract(dr.pos).length() < DATA.tuning.doorRange;

    if (typeof cameraPos != 'undefined') cameraPos = player.pos.copy();
    if (typeof cameraScale != 'undefined')
        cameraScale = room.camScale || DATA.world.camScale;

    makeBackdrop();
    makeAmbient();
    return true;
}

function initWorld()
{
    owSyncZZ();
    owBootWorld();                       // WorldFormat world if valid, else default

    // settle any half-finished world switch before rebuilding
    owSwitchT = 1;
    owSwitchFrom = owSwitchTo = owSwitchFromName = null;
    owPal = DATA.pal[currentWorld];
    owWarp = null;

    if (typeof Dialog != 'undefined' && Dialog.isOpen()) Dialog.close();
    owEnterRoom(owRooms[owRoomId] ? owRoomId : owListRooms()[0], null, null);
    owLoadSprites();
}

///////////////////////////////////////////////////////////////////////////////
// door warps — 0.35s fade to black, swap rooms, fade back in (A3)
///////////////////////////////////////////////////////////////////////////////

let owWarp = null;   // { t, phase:'out'|'in', door } while a transition runs

function owWarpTime() { return (DATA.tuning && DATA.tuning.doorFade) || .35; }
function owWarping()  { return !!owWarp; }
/** 0..1 blackness of the door-warp fade, for owRender */
function owWarpFade() { return owWarp ? clamp(owWarp.phase == 'out'
    ? owWarp.t / owWarpTime() : 1 - owWarp.t / owWarpTime()) : 0; }

/** start fading through a warp door; returns false when it cannot run */
function owBeginWarp(dr)
{
    if (owWarp || !dr || dr.destroyed) return false;
    const target = dr.def.to;
    if (!target || !owRooms[target])
    {
        owDialogShow(dr.def.label || 'DOOR', ['It leads nowhere.']);
        return false;
    }
    if (typeof Dialog != 'undefined' && Dialog.isOpen()) Dialog.close();
    if (player) { player.vel = vec2(); player.zigTarget = null; }
    dr.inside = true;
    owWarp = { t: 0, phase: 'out', door: dr.def, from: owRoomId };
    return true;
}

/** advance the fade; the room swap happens at the black midpoint */
function owTickWarp(dt)
{
    if (!owWarp) return;
    owWarp.t += dt;
    if (owWarp.t < owWarpTime()) return;

    if (owWarp.phase == 'out')
    {
        const d = owWarp.door;
        const facing = owDirVec(d.dir) || (player && player.facing) || vec2(0, -1);
        owEnterRoom(d.to, [+d.tx || 0, +d.ty || 0], facing);
        owWarp.phase = 'in';
        owWarp.t = 0;
    }
    else
        owWarp = null;
}

///////////////////////////////////////////////////////////////////////////////
// triggers — A2 schema `triggers:[{x,y,w,h,dialog}]`, fired on walk-in
///////////////////////////////////////////////////////////////////////////////

function owTickTriggers()
{
    const room = owGetRoomDef();
    if (!room || !room.triggers.length || !player) return;
    const tx = Math.floor(player.pos.x + WORLD_W/2), ty = Math.floor(player.pos.y + WORLD_H/2);
    for (let i = 0; i < room.triggers.length; ++i)
    {
        const tr = room.triggers[i];
        if (owMembershipAlpha(tr.worlds) < .5) continue;
        const inside = tx >= tr.x && tx < tr.x + tr.w && ty >= tr.y && ty < tr.y + tr.h;
        const was = !!owTrigFlags[i];
        owTrigFlags[i] = inside;
        if (inside && !was && !owWorldSwitching())
        {
            const dlg = tr.dialog ? owDialogById(tr.dialog) : null;
            if (dlg) owDialogShow(dlg.name, dlg.pages);
        }
    }
}

///////////////////////////////////////////////////////////////////////////////
// owUpdate — called once per frame by the state machine
///////////////////////////////////////////////////////////////////////////////

let owUpdateFrame = -1;

/** keep the battle contract's defeat table present even if the lane swapped ZZ */
function owSyncZZ()
{
    if (!ZZ || typeof ZZ != 'object') ZZ = {};
    if (!ZZ.defeatedEnemies || typeof ZZ.defeatedEnemies != 'object')
        ZZ.defeatedEnemies = {};
}

/** dialog is optional: no-op cleanly when js/dialog.js has not loaded */
function owDialogShow(name, lines, opts)
{
    if (typeof Dialog == 'undefined' || !Dialog || typeof Dialog.show != 'function')
        return false;
    Dialog.show(name, lines, opts);
    return true;
}

/**
 * Hand an open ZAG gate to the battle lane: ZZ.startBattle(enemyId, def).
 * `def` is the door's definition object from the room registry (id, x, y,
 * to/tx/ty when it is also a warp, lockedBy/enemy, label, enemyName, worlds).
 * We never define ZZ.startBattle ourselves — the battle lane owns it.
 */
function owStartBattle(dr)
{
    const id = dr.def.lockedBy || dr.def.enemy || dr.enemyId;
    try
    {
        if (typeof window != 'undefined' && window.ZZ &&
            typeof window.ZZ.startBattle == 'function')
        { window.ZZ.startBattle(id, dr.def); return true; }
    }
    catch (e) {}
    if (typeof ZZ != 'undefined' && ZZ && typeof ZZ.startBattle == 'function')
    { ZZ.startBattle(id, dr.def); return true; }
    return false;
}

function owUpdate(dt)
{
    owSyncZZ();
    // never trust the caller: self-guard on state and on double calls
    if (typeof state == 'undefined' || state != 'world')
    {
        if (typeof Dialog != 'undefined' && Dialog.isOpen()) Dialog.close();
        return;
    }
    if (timeReal === owUpdateFrame) return;   // called twice this frame
    owUpdateFrame = timeReal;
    if (typeof dt != 'number' || dt < 0) dt = timeDelta;

    // adopt any raw key events forwarded by the state machine for this frame
    owPendingFrame = owPendingKeys;
    owPendingKeys = {};

    owTickPalette(dt);
    owCleanBursts();

    // dialog swallows input first
    if (typeof Dialog != 'undefined') Dialog.update(dt);
    const locked = typeof Dialog != 'undefined' && Dialog.inputLocked();

    // a door-warp fade owns the screen until it finishes
    if (owWarp) { owTickWarp(dt); return; }

    // ---- ZIG <-> ZAG on physical ArrowDown (palette only — same room) ------
    const room = owGetRoomDef();
    if (!locked && !owWorldSwitching() && owPressed('ArrowDown') && owArrowDownPhysical())
    {
        // rooms tagged zig/zag are single-world: the toggle politely refuses
        if (!room || room.world == 'both')
            owSetWorld(currentWorld == 'zig' ? 'zag' : 'zig');
        else if (typeof flash != 'undefined')
        {
            flash = Math.max(flash, .15);
            flashColor = DATA.c.dim.copy();
        }
    }

    if (locked) { owNear = null; return; }

    // ---- interact: talk / open doors ---------------------------------------
    const hit = player ? owInteractableAt(player.pos) : null;
    owNear = hit;
    if (hit)
    {
        const pressed = owPressed('Enter') || owPressed('NumpadEnter') || owPressed('Space');
        if (pressed)
        {
            if (hit.kind == 'npc')
            {
                const dlg = hit.obj.def.dialog ? owDialogById(hit.obj.def.dialog) : null;
                if (dlg) owDialogShow(dlg.name, dlg.pages,
                    { portrait: hit.obj.sheet, cell: hit.obj.cell });
                else
                    owDialogShow(hit.obj.def.name, hit.obj.def.lines,
                        { portrait: hit.obj.sheet, cell: hit.obj.cell });
            }
            else
                owActDoor(hit.obj);
        }
    }

    // ---- walking onto a door tile: bump when locked, warp when linked ------
    if (player)
        for (const dr of owDoors)
        {
            if (dr.destroyed || dr.alphaNow() < .5) continue;
            const d = player.pos.subtract(dr.pos).length();
            const inside = d < DATA.tuning.doorRange;
            if (inside && !dr.inside)
            {
                dr.inside = true;
                dr.onEnter();
                if (owWarp) break;              // the fade took over
            }
            else if (!inside)
                dr.inside = false;
        }

    // ---- walk-in triggers --------------------------------------------------
    if (!owWarp) owTickTriggers();
}

/** Enter was pressed next to a door */
function owActDoor(dr)
{
    if (dr.locked()) { dr.bump(); return; }
    if (dr.def.to)   { owBeginWarp(dr); return; }
    if (dr.def.open)
    {
        owDialogShow(dr.def.label, dr.def.flavor || ['It is closed.']);
        return;
    }
    // an arena gate with its enemy already beaten — hand off to the battle lane
    if (owStartBattle(dr)) return;
    owDialogShow(dr.def.label, ['The gate stands open. Something waits beyond.']);
}

///////////////////////////////////////////////////////////////////////////////
// owRender — called by the state machine; safe in any render pass.
// The dialog also draws itself from an engine-object layer, so its box always
// lands above the world and below the HUD no matter where this is called.
///////////////////////////////////////////////////////////////////////////////

function owRender()
{
    if (typeof Dialog != 'undefined' && Dialog.isOpen())
        Dialog.render();

    // door-warp fade (0.35s out to near-black, 0.35s back in)
    const fade = owWarpFade();
    if (fade > .002 && typeof mainCanvasSize != 'undefined')
        drawRect(mainCanvasSize.scale(.5), mainCanvasSize,
            alpha(DATA.c.bg, fade), 0, true, true);
}

///////////////////////////////////////////////////////////////////////////////
// battle contract
///////////////////////////////////////////////////////////////////////////////

/**
 * Called by the battle lane when a fight ends in victory:
 *   ZZ.onEnemyDefeated('warden_north')
 * The matching gate unlocks (green, glowing) and the guard bursts apart.
 */
ZZ.onEnemyDefeated = function (enemyId)
{
    if (!enemyId || ZZ.defeatedEnemies[enemyId]) return false;
    ZZ.defeatedEnemies[enemyId] = true;

    const door = owDoors.find(d => !d.destroyed && d.enemyId == enemyId);
    if (!door) return true;

    door.openAnim = 1;
    door.inside = false;
    if (typeof flash != 'undefined')
    {
        flash = Math.max(flash, .55);
        flashColor = owPal.doorOpen.copy();
    }

    // burst where the guard was standing
    const guard = owEnemies.find(e => !e.destroyed && e.door == door);
    if (guard)
    {
        const e = new ParticleEmitter(guard.pos.copy(), PI/2, 1, .35, 70, PI, undefined,
            DATA.c.neon, owPal.doorOpen, alpha(DATA.c.neon, 0), alpha(owPal.doorOpen, 0),
            .9, .2, .02, .08, .06, .9, 1, 0, PI, .4, .7, false, true);
        owTrackBurst(e);
        guard.destroy();
    }

    if (player && state == 'world' && player.pos.subtract(door.pos).length() < 5)
        owDialogShow('GATE', ['The enemy falls. The way is clear.']);
    return true;
};

// move a value toward a target by at most maxDelta
function moveToward(current, target, maxDelta)
{
    const d = target - current;
    return Math.abs(d) <= maxDelta ? target : current + Math.sign(d)*maxDelta;
}
