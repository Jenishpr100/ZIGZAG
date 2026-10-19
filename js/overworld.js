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
let owPortalObj = null;                  // the live Portal static (rendered in ZAG only)
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
// foot anchoring — how high a sprite cell's boots sit above its own box
//
// A spritesheet cell is a BOX; the character inside it is smaller than the box.
// Measured with PIL over assets/img/spritesheet.png (all 14 frames) and
// assets/Tiny Neighbours Vol1/NPC_*.png (all 104 cells of every sheet):
//
//   teto : 20x26 cells — art occupies rows 3..22, so 3 fully transparent rows
//          sit under the boots (plus 1 column of padding at each side).
//   npc  : 16x16 cells — the boots reach row 15, 0 transparent rows below.
//
// Drawing a cell CENTRED on a position therefore parks the visible feet
// padBottom * scale above the ground — exactly the "floating" the playtester
// reported. owSpriteFootY() anchors the visible FEET on the shadow instead.
///////////////////////////////////////////////////////////////////////////////

const OW_SPRITE_FOOT_PAD = { teto: 3, npc: 0 };   // transparent rows under the art

/** draw-centre Y for a cell of world height `h` whose boots land on `footY` */
function owSpriteFootY(footY, h, cellPx, padPx)
{
    return footY + h/2 - padPx*h/cellPx;
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
    // the stage gate belongs to ZAG — flip it in place on a world switch
    owSyncPortal();

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
// pixel tileset — 16x16 tiles, authored here and baked into a texture
//
// The whole overworld is drawn from these tiles, never from smooth quads.
// Each tile is either a hand-drawn 16x16 grid of palette-slot characters
// (`f` + `r`; row 0 of `r` is the TOP of the tile = screen-up) or grown by a
// seeded generator for organic ground. They are painted once into an
// offscreen canvas, uploaded as a pixelated TextureInfo and drawn with
// drawTile() so nearest-neighbour sampling keeps every texel crisp.
//
// ZIG and ZAG each get their own baked sheet out of DATA.pal.zig / .zag, and
// a world switch cross-fades between the two sheets.
///////////////////////////////////////////////////////////////////////////////

const OW_TILE_PX = 16, OW_TILE_COLS = 8;

const OW_TILE_SLOT = {
    '.': null,       // transparent
    'G': 'tGrass',  'g': 'tGrassLo',  'h': 'tGrassHi',
    'F': 'tPetal',  'y': 'tPollen',
    'S': 'tSoil',   's': 'tSoilLo',
    'P': 'tPath',   'p': 'tPathHi',   'q': 'tPathLo',
    'B': 'tBrick',  'b': 'tBrickLo',  'c': 'tBrickHi',
    'R': 'tRoof',   'r': 'tRoofLo',   'e': 'tRoofHi',
    'W': 'tWall',   'w': 'tWallLo',
    'D': 'tGlass',
    'O': 'tWood',   'o': 'tWoodLo',
    'L': 'tLeaf',   'l': 'tLeafLo',   'm': 'tLeafHi',
    'T': 'tTrunk',
    'N': 'tRock',   'n': 'tRockLo',
    'U': 'tWater',  'u': 'tWaterHi',
    'A': 'tNeon',   'a': 'tNeon2',
    'X': 'tInk',
    'V': 'tFloor',  'v': 'tFloorLo',
    'C': 'tCloth',  'i': 'tClothLo',
};

// ---------------------------------------------------------------------------
// the hand-drawn art. `f` fills every row not listed in `r`; `mirror` clones
// another tile sideways (the pitch, walls and boards are symmetric enough
// that drawing both halves by hand is wasted bytes).
// ---------------------------------------------------------------------------
const OW_TILE_ART = {

    // ---- ground structure --------------------------------------------------
    brick: { f:'B', r:[
        'bbbbbbbbbbbbbbbb',
        'BBBBBBBBBBBBBBBB',
        'BBBbBBBbBBBbBBb',
        'BBBbBBBbBBBbBBb',
        'bbbBBbBBbBBbBBB',
        'bbbBBbBBbBBbBBB',
        'BBBBbBBBBBbBBBb',
        'BBBBbBBBBBbBBBb',
        'BBBBbBBBBBbBBBb',
        'bbbbbbbbbbbbbbbb',
        'BbBBbBBbBBbBBBb',
        'BbBBbBBbBBbBBBb',
        'BBBbBBBBBbBBbBB',
        'BBBbBBBBBbBBbBB',
        'bbbBBbBBbBBbBBBB',
        'bbbBBbBBbBBbBBBB'] },

    brickCap: { f:'B', r:[
        'cccccccccccccccc',
        'cCCCCCCCCCCCCCCC',
        'bbbbbbbbbbbbbbbb',
        'BBBbBBBbBBBbBBb',
        'BBBbBBBbBBBbBBb',
        'bbbBBbBBbBBbBBB',
        'bbbBBbBBbBBbBBB',
        'BBBBbBBBBBbBBBb',
        'BBBBbBBBBBbBBBb',
        'BBBBbBBBBBbBBBb',
        'bbbbbbbbbbbbbbbb',
        'BbBBbBBbBBbBBBb',
        'BbBBbBBbBBbBBBb',
        'BBBbBBBBBbBBbBB',
        'BBBbBBBBBbBBbBB',
        'bbbBBbBBbBBbBBBB'] },

    crate: { f:'O', r:[
        'oooooooooooooooo',
        'OVVVVVVVVVVVVVVO',
        'OVVVVVVVVVVVVVVO',
        'OvvvvvvvvvvvvvvO',
        'OVVVVOVVVVOVVVVO',
        'OVVVVOVVVVOVVVVO',
        'OVVVVVVVVVVVVVVO',
        'OVVVVOVVVVOVVVVO',
        'OVVVVOVVVVOVVVVO',
        'OVVVVVVVVVVVVVVO',
        'OVVVVOVVVVOVVVVO',
        'OVVVVOVVVVOVVVVO',
        'OVVVVVVVVVVVVVVO',
        'OvvvvvvvvvvvvvvO',
        'OVVVVVVVVVVVVVVO',
        'oooooooooooooooo'] },

    // ---- the hip roof: ridge cap on top, fascia along the eave --------------
    roofC: { f:'R', r:[
        'RRRRRRRRRRRRRRRR',
        'RRRRRRRRRRRRRRRR',
        'rrrrrrrrrrrrrrrr',
        'ReRRRRRReRRRRRRe',
        'RRRRRRRRRRRRRRRR',
        'RRRRRRRRRRRRRRRR',
        'rrrrrrrrrrrrrrrr',
        'ReRRRRRReRRRRRRe',
        'RRRRRRRRRRRRRRRR',
        'RRRRRRRRRRRRRRRR',
        'rrrrrrrrrrrrrrrr',
        'ReRRRRRReRRRRRRe',
        'RRRRRRRRRRRRRRRR',
        'RRRRRRRRRRRRRRRR',
        'rrrrrrrrrrrrrrrr',
        'ReRRRRRReRRRRRRe'] },

    roofL: { f:'R', r:[
        'rrrrrrrrrrrrrrrr',
        'rrrrrrrrrrrrrrrr',
        'rrrrrrrrrrrrrrrr',
        'eeeeeeeeeeeeeeee',
        'RRRRRRRRRRRRRRRR',
        '.....RRRRRRRRRRR',
        '..RRRRRRRRRRRRRR',
        'RRRRRRRRRRRRRRRR',
        'RRRRRRRRRRRRRRRR',
        'rRRRRRRRRRRRRRRR',
        'RRRRRRRRRRRRRRRR',
        'RRRRRRRRRRRRRRRR',
        'rRRRRRRRRRRRRRRR',
        'RRRRRRRRRRRRRRRR',
        'rrrrrrrrrrrrrrrr',
        'ReRRRRRReRRRRRRe'] },

    roofR: { mirror:'roofL' },

    roof2C: { f:'R', r:[
        'RRRRRRRRRRRRRRRR',
        'ReRRRRRReRRRRRRe',
        'RRRRRRRRRRRRRRRR',
        'rrrrrrrrrrrrrrrr',
        'ReRRRRRReRRRRRRe',
        'RRRRRRRRRRRRRRRR',
        'RRRRRRRRRRRRRRRR',
        'rrrrrrrrrrrrrrrr',
        'ReRRRRRReRRRRRRe',
        'RRRRRRRRRRRRRRRR',
        'rrrrrrrrrrrrrrrr',
        'oooooooooooooooo',
        'wwwwwwwwwwwwwwww',
        'rrrrrrrrrrrrrrrr',
        'XXXXXXXXXXXXXXXX',
        '................'] },

    roof2L: { mirror:'roof2C', f:'R' },

    // ---- house facade ------------------------------------------------------
    hwall: { f:'W', r:[
        'wwwwwwwwwwwwwwww',
        'wWWWWWWWWWWWWWWw',
        'WWWWWWWWWWWWWWWW',
        'WWWWWWWWWWWWWWWW',
        'wWWWWWWWWWWWWwWW',
        'WWWWWWWWWWWWWWWW',
        'wwwwwwwwwwwwwwww',
        'WWWWWWWWWWWWWWWW',
        'WWWWWWWWWWWWWWWW',
        'wWWwWWWWWWWWWWWW',
        'WWWWWWWWWWWWWWWW',
        'wwwwwwwwwwwwwwww',
        'WWWWWWWWWWWWWWWW',
        'WWWWWWWWWWWWWWWW',
        'wWWWWWWWWWWWWWWw',
        'wwwwwwwwwwwwwwww'] },

    hwallWin: { f:'W', r:[
        'wwwwwwwwwwwwwwww',
        'wWWWWWWWWWWWWWWw',
        'WWWWWWWWWWWWWWWW',
        'WWWWWWWWWWWWWWWW',
        'WWWWooooooooWWWW',
        'WWWWoDDDDDDdoWWW',
        'WWWWoDDDoDDDoWWW',
        'WWWWoDDDDDDdoWWW',
        'WWWWoDDDoDDDoWWW',
        'WWWWoDDDDDDdoWWW',
        'WWWWooooooooWWWW',
        'WWWWWWWWWWWWWWWW',
        'wwwwwwwwwwwwwwww',
        'WWWWWWWWWWWWWWWW',
        'WWWWWWWWWWWWWWWW',
        'wwwwwwwwwwwwwwww'] },

    hwallWinR: { mirror:'hwallWin' },

    // the door tile: a doorway set into the wall, with a stone sill
    doorBot: { f:'W', r:[
        'wwwwwwwwwwwwwwww',
        'wWWWWWWWWWWWWWWw',
        'WWWWWWWWWWWWWWWW',
        'WWWWooooooooWWWW',
        'WWWWoOOOOOOOoWWW',
        'WWWWoOOOOOOOOoWW',
        'WWWWoOoooooOOoWW',
        'WWWWoOoooooOOoWW',
        'WWWWoOoooyOOoWW',
        'WWWWoOooooOOoWW',
        'WWWWoOOOOOOOoWWW',
        'WWWWoOOOOOOOoWWW',
        'WWWWooooooooWWWW',
        'WWWWWWWWWWWWWWWW',
        'wwwwwwwwwwwwwwww',
        'XXXXXXXXXXXXXXXX'] },

    awning: { f:'C', r:[
        'CCCCCCCCCCCCCCCC',
        'CWWWCWWWCWWWCWWW',
        'CWWWCWWWCWWWCWWW',
        'CCCCCCCCCCCCCCCC',
        'CWWWCWWWCWWWCWWW',
        'CWWWCWWWCWWWCWWW',
        'CCCCCCCCCCCCCCCC',
        'CWWWCWWWCWWWCWWW',
        'CWWWCWWWCWWWCWWW',
        'CCCCCCCCCCCCCCCC',
        'CWWWCWWWCWWWCWWW',
        'CWWWCWWWCWWWCWWW',
        'CCCCCCCCCCCCCCCC',
        'CWWWCWWWCWWWCWWW',
        'CCCCCCCCCCCCCCCC',
        '.i.i.i.i.i.i.i.i.'] },

    signboard: { f:'O', r:[
        'oooooooooooooooo',
        'oOOOOOOOOOOOOOo',
        'oOOOOOOOOOOOOOo',
        'oOyyyyOOOOyyyyOo',
        'oOOOOOOOOOOOOOo',
        'oOOOOOOOOOOOOOo',
        'oOyyyyOOOOyyyyOo',
        'oOOOOOOOOOOOOOo',
        'oooooooooooooooo',
        '................',
        '................',
        '................',
        '................',
        '................',
        '................',
        '................'] },

    neonBand: { f:'X', r:[
        'XXXXXXXXXXXXXXXX',
        'XXXXXXXXXXXXXXXX',
        'XXXXXXXXXXXXXXXX',
        'wwwwwwwwwwwwwwww',
        'aaaaaaaaaaaaaaaa',
        'AAAAAAAAAAAAAAAA',
        'aaaaaaaaaaaaaaaa',
        'wwwwwwwwwwwwwwww',
        'XXXXXXXXXXXXXXXX',
        'XXXXXXXXXXXXXXXX',
        'XXXXwwwwwwwwXXXX',
        'XXXXXXXXXXXXXXXX',
        'XXXXXXXXXXXXXXXX',
        'XXXXXXXXXXXXXXXX',
        'XXXXXXXXXXXXXXXX',
        'XXXXXXXXXXXXXXXX'] },

    counter: { f:'W', r:[
        'XXXXXXXXXXXXXXXX',
        'OOOOOOOOOOOOOOOO',
        'OOOOOOOOOOOOOOOO',
        'oooooooooooooooo',
        'WWWWWWWWWWWWWWWW',
        'WWWWWWWWWWWWWWWW',
        'WwwwwwwwwwwwwwwW',
        'WwwwwwwwwwwwwwwW',
        'WwwwwwwwwwwwwwwW',
        'WwwwwwwwwwwwwwwW',
        'WwwwwwwwwwwwwwwW',
        'WwwwwwwwwwwwwwwW',
        'WwwwwwwwwwwwwwwW',
        'WwwwwwwwwwwwwwwW',
        'WWWWWWWWWWWWWWWW',
        'XXXXXXXXXXXXXXXX'] },

    // ---- trees / rocks / street furniture ----------------------------------
    treeT: { f:'L', r:[
        '................',
        '.....LLLLLL.....',
        '...LLLLLLLLLL...',
        '..LLmLLLLLLmLL..',
        '.LLmLLLLLLLLmLL.',
        '.LLLLLLmLLLLLLLL',
        'LLLLLLLLLLLLLLLL',
        'LLLLLLLLLLLLLLLL',
        'LLLLLLLLLLLLLLLL',
        'LLLLLLLLLLLLLLLL',
        'LLLLLLLLLLLLLLLL',
        'lllLLLLLLLLLLlll',
        'llllllLLLLllllll',
        'llllllllllllllll',
        '..llllllllllll..',
        '....llllllll....'] },

    treeM: { f:'L', r:[
        'LLLLLLLLLLLLLLLL',
        'LLmLLLLLLLLLLmLL',
        'LLmLLLLLLLLLLmLL',
        'LLLLLLLLLLLLLLLL',
        'LlLLLLLLLLLLLLlL',
        'LLLLLLLLLLLLLLLL',
        'LLLLLLLLLLLLLLLL',
        'llLLLLLLLLLLLLll',
        'llLLmLLLLLLmLLll',
        'lllLLLLLLLLLLlll',
        'llllLLLLLLLLllll',
        'llllllLLLLllllll',
        'llllllllllllllll',
        '..llllllllllll..',
        '....llllllll....',
        '................'] },

    treeB: { f:'l', r:[
        'llllllllllllllll',
        'lllTTTTTTTTTTlll',
        'llTTTTTTTTTTTTll',
        'llTTTTTTTTTTTTll',
        'llTTTTTTTTTTTTll',
        'llTTTTTTTTTTTTll',
        'llTTTTTTTTTTTTll',
        'llTTTTTTTTTTTTll',
        'lllTTTTTTTTTTlll',
        '..llTTTTTTTTll..',
        '....lTTTTTTl....',
        '.....lTTTTl.....',
        '.....lTTTTl.....',
        '.....lTTTTl.....',
        '....lTTTTTTl....',
        '...llllllllll...'] },

    bush: { f:'L', r:[
        '................',
        '................',
        '................',
        '.....LLLLLL.....',
        '...LLLLLLLLLL...',
        '..LLmLLLLLLmLL..',
        '.LLmLLLLLLLLmLL.',
        '.LLLLLLmLLLLLLLL',
        'LLLLLLLLLLLLLLLL',
        'LLLLLLLLLLLLLLLL',
        'lllLLLLLLLLLLlll',
        'llllllLLLLllllll',
        'llllllllllllllll',
        '..llllllllllll..',
        '................',
        '................'] },

    stone: { f:'N', r:[
        '................',
        '................',
        '................',
        '.....NNNNN......',
        '...NNNNNNNNNN...',
        '..NNNNcNNNNNNN..',
        '..NNNcNNNNNNNN..',
        '.NNNNNcNNNNNNNN.',
        '.NNNNNNNNcNNNNN.',
        '.NNNNNNNNNNNNNN.',
        '.NNNNNNNNNNNNNN.',
        '..NNNNNNNNNNNN..',
        '..nNNNNNNNNNNn..',
        '...nnnnnnnnnn...',
        '....nnnnnnnn....',
        '................'] },

    fenceP: { f:'O', r:[
        '.......OO.......',
        '......OOOO......',
        '.....OOOOOO.....',
        '.....OOOOOO.....',
        '.....OOOOOO.....',
        '.....OOOOOO.....',
        '.....OOOOOO.....',
        '.....OOOOOO.....',
        '.....OOOOOO.....',
        '.....OOOOOO.....',
        '.....OOOOOO.....',
        '.....OOOOOO.....',
        '.....OOOOOO.....',
        '.....OOOOOO.....',
        '.....OOOOOO.....',
        '.....OOOOOO.....'] },

    fenceRail: { f:'O', r:[
        '................',
        '................',
        '................',
        'OOOOOOOOOOOOOOOO',
        'OOOOOOOOOOOOOOOO',
        'OOOOOOOOOOOOOOOO',
        '................',
        '................',
        '................',
        'OOOOOOOOOOOOOOOO',
        'OOOOOOOOOOOOOOOO',
        'OOOOOOOOOOOOOOOO',
        '................',
        '................',
        '................',
        '................'] },

    signB: { f:'O', r:[
        '................',
        '.oooooooooooooo.',
        '.oOOOOOOOOOOOOo.',
        '.oOyOOOyOOOyOOo.',
        '.oOOOOOOOOOOOOo.',
        '.oOyOOOyOOOyOOo.',
        '.oOOOOOOOOOOOOo.',
        '.oooooooooooooo.',
        '................',
        '................',
        '................',
        '................',
        '................',
        '................',
        '................',
        '................'] },

    signP: { mirror:'fenceP' },

    lampP: { f:'O', r:[
        '................',
        '................',
        '................',
        '................',
        '.......OO.......',
        '......OOOO......',
        '......OOOO......',
        '......OOOO......',
        '......OOOO......',
        '......OOOO......',
        '......OOOO......',
        '......OOOO......',
        '......OOOO......',
        '......OwwO......',
        '.....OOOOOO.....',
        '....OOOOOOOO....'] },

    lampH: { f:'O', r:[
        '..oooooooooooo..',
        '.oOOOOOOOOOOOOo.',
        '.oOwwwwwwwwwwOo.',
        '.owAAAAAAAAAAwo.',
        '.owAWWWWWWWWAwo.',
        '.owAWWWWWWWWAwo.',
        '.owAWWWWWWWWAwo.',
        '.owAWWWWWWWWAwo.',
        '.owAWWWWWWWWAwo.',
        '.owAWWWWWWWWAwo.',
        '.oowAAAAAAAAwoo.',
        '.oOOOOOOOOOOOOo.',
        '..oooooooooooo..',
        '................',
        '................',
        '................'] },

    // ---- rusted iron gate (flavour doors, ZIG) -----------------------------
    ironP: { f:'N', r:[
        'NNNNNNNNNNNNNNNN',
        'NNccccccccccccNN',
        'NcNNNNNNNNNNNNcN',
        'NcNNNNNNNNNNNNcN',
        'NcNNNNNNNNNNNNcN',
        'NcNNNNNNNNNNNNcN',
        'NcNNNNNNNNNNNNcN',
        'NcNNNNNNNNNNNNcN',
        'NcNNNNNNNNNNNNcN',
        'NcNNNNNNNNNNNNcN',
        'NcNNNNNNNNNNNNcN',
        'NcNNNNNNNNNNNNcN',
        'NcNNNNNNNNNNNNcN',
        'NcNNNNNNNNNNNNcN',
        'NNNNNNNNNNNNNNNN',
        'NNNNNNNNNNNNNNNN'] },

    ironBar: { f:'O', r:[
        '................',
        '.OO..OO..OO..OO.',
        '.OO..OO..OO..OO.',
        '.OO..OO..OO..OO.',
        '.OO..OO..OO..OO.',
        '.OO..OO..OO..OO.',
        '.OOOOOOOOOOOOOO.',
        '.oooooooooooooo.',
        '.OOOOOOOOOOOOOO.',
        '.OO..OO..OO..OO.',
        '.OO..OO..OO..OO.',
        '.OO..OO..OO..OO.',
        '.OO..OO..OO..OO.',
        '.OO..OO..OO..OO.',
        '.OO..OO..OO..OO.',
        '................'] },

    ironFoot: { f:'N', r:[
        'XXXXXXXXXXXXXXXX',
        'NNNNNNNNNNNNNNNN',
        'NNNNNNNNNNNNNNNN',
        'NnnnnnnnnnnnnnnN',
        'NnnnnnnnnnnnnnnN',
        'NNNNNNNNNNNNNNNN',
        'NNNNNNNNNNNNNNNN',
        '.OO..OO..OO..OO.',
        '.OO..OO..OO..OO.',
        '.OO..OO..OO..OO.',
        '.OO..OO..OO..OO.',
        '.OO..OO..OO..OO.',
        '.OO..OO..OO..OO.',
        '.OO..OO..OO..OO.',
        '.OO..OO..OO..OO.',
        '................'] },

    // ---- neon portal gate (flavour doors, ZAG) -----------------------------
    neonP: { f:'X', r:[
        'XXXXXXXXXXXXXXXX',
        'XXaaaaaaaaaaaaXX',
        'XaAAAAAAAAAAAAaX',
        'XaAAAAAAAAAAAAaX',
        'XaAAAAAAAAAAAAaX',
        'XaAAAAAAAAAAAAaX',
        'XaAAAAAAAAAAAAaX',
        'XaAAAAAAAAAAAAaX',
        'XaAAAAAAAAAAAAaX',
        'XaAAAAAAAAAAAAaX',
        'XaAAAAAAAAAAAAaX',
        'XaAAAAAAAAAAAAaX',
        'XaAAAAAAAAAAAAaX',
        'XaAAAAAAAAAAAAaX',
        'XXXXXXXXXXXXXXXX',
        'XXXXXXXXXXXXXXXX'] },

    neonBar: { f:'A', r:[
        '................',
        '.XX..XX..XX..XX.',
        '.AA..AA..AA..AA.',
        '.AA..AA..AA..AA.',
        '.AA..AA..AA..AA.',
        '.AA..AA..AA..AA.',
        '.XXXXXXXXXXXXXXXX',
        '.aaaaaaaaaaaaaa.',
        '.XXXXXXXXXXXXXXXX',
        '.AA..AA..AA..AA.',
        '.AA..AA..AA..AA.',
        '.AA..AA..AA..AA.',
        '.AA..AA..AA..AA.',
        '.AA..AA..AA..AA.',
        '.AA..AA..AA..AA.',
        '................'] },

    neonFoot: { f:'X', r:[
        'XXXXXXXXXXXXXXXX',
        'XXXXXXXXXXXXXXXX',
        'XwwwwwwwwwwwwwwX',
        'XwaaaaaaaaaaaawX',
        'XwaAAAAAAAAAAawX',
        'XwwwwwwwwwwwwwwX',
        'XXXXXXXXXXXXXXXX',
        '.XX..XX..XX..XX.',
        '.AA..AA..AA..AA.',
        '.AA..AA..AA..AA.',
        '.AA..AA..AA..AA.',
        '.AA..AA..AA..AA.',
        '.AA..AA..AA..AA.',
        '.AA..AA..AA..AA.',
        '.AA..AA..AA..AA.',
        '................'] },

    // ---- water -------------------------------------------------------------
    water: { f:'U', r:[
        'UUUUUUUUUUUUUUUU',
        'UUUUUUUUUUUUUUUU',
        'uUUUUUUUUUUUUUUu',
        'UUUUUuUUUUUuUUUU',
        'UUUUUUUUUUUUUUUU',
        'UUUUUUUUUUUUUUUU',
        'UuUUUUUuUUUUUUuU',
        'UUUUUUUUUUUUUUUU',
        'UUUUUuUUUUUuUUUU',
        'UUUUUUUUUUUUUUUU',
        'UUUUUUUUUUUUUUUU',
        'uUUUUUUUUUUUUUUu',
        'UUUUUuUUUUUuUUUU',
        'UUUUUUUUUUUUUUUU',
        'UUUUUUUUUUUUUUUU',
        'uUuUUUUUuUUUUUUu'] },
};

// ---------------------------------------------------------------------------
// grown tiles — organic ground reads better scattered than hand-placed, and a
// seeded generator keeps every bake byte-identical so nothing shimmers.
//   gen(px, rnd, accent)  px(x, y, slotChar) paints one texel
// ---------------------------------------------------------------------------
const OW_TILE_GEN = {

    /** base turf: speckle plus a few two-texel blades */
    grass: (px, rnd) =>
    {
        const P = OW_TILE_PX;
        for (let y = 0; y < P; ++y)
        for (let x = 0; x < P; ++x)
            px(x, y, rnd.float() < .17 ? 'g' : 'G');
        for (let i = 0, n = 3 + (rnd.float(0, 3)|0); i < n; ++i)
        {
            const x = rnd.float(0, P)|0, y = rnd.float(3, 15)|0;
            px(x, y, 'g'); px(x, y > 0 ? y-1 : 1, 'g');
        }
        for (let i = 0, n = 2 + (rnd.float(0, 3)|0); i < n; ++i)
            px(rnd.float(0, P)|0, rnd.float(0, P)|0, 'h');
    },

    /** turf with a fat tuft of blades */
    tuft: (px, rnd) =>
    {
        OW_TILE_GEN.grass(px, rnd);
        const P = OW_TILE_PX, bx = 3 + (rnd.float(0, 8)|0), by = 9 + (rnd.float(0, 4)|0);
        for (let i = -2; i <= 2; ++i)
        {
            const h = 3 + (i & 1);
            for (let k = 0; k < h; ++k)
                px(bx + i*2, by - k, k == h-1 ? 'h' : 'g');
        }
    },

    /** turf with a five-petal flower; `accent` is the petal colour slot */
    flower: (px, rnd, accent) =>
    {
        OW_TILE_GEN.grass(px, rnd);
        const P = OW_TILE_PX;
        const bx = 4 + (rnd.float(0, 7)|0), by = 6 + (rnd.float(0, 6)|0);
        px(bx, by, 'y'); px(bx-2, by, accent); px(bx+2, by, accent);
        px(bx, by-2, accent); px(bx, by+2, accent);
        px(bx-1, by-1, 'l'); px(bx+1, by+1, 'g');
    },

    /** turf with a couple of pebbles */
    pebble: (px, rnd) =>
    {
        OW_TILE_GEN.grass(px, rnd);
        for (let i = 0; i < 3; ++i)
        {
            const x = 1 + (rnd.float(0, 13)|0), y = 2 + (rnd.float(0, 12)|0);
            px(x, y, 'n'); px(x+1, y, 'N'); px(x, y+1, 'N');
            if (rnd.float() < .5) px(x+1, y+1, 'n');
        }
    },

    /** packed-earth road with scattered stones */
    cobble: (px, rnd) =>
    {
        const P = OW_TILE_PX;
        for (let y = 0; y < P; ++y)
        for (let x = 0; x < P; ++x)
            px(x, y, ((x + y*2) % 5 == 0 || (x*3 + y) % 7 == 0) ? 'q' : 'P');
        for (let i = 0; i < 7; ++i)
        {
            const x = rnd.float(0, P)|0, y = rnd.float(0, P-1)|0;
            px(x, y, 'p'); if (rnd.float() < .6) px(x+1, y, 'p');
            px(x, y+1, 'q');
        }
        for (let i = 0; i < 3; ++i)
            px(rnd.float(0, P)|0, rnd.float(0, P)|0, 's');
    },

    /** indoor boards: planks, seams and a little grain */
    floor: (px, rnd) =>
    {
        const P = OW_TILE_PX;
        for (let y = 0; y < P; ++y)
        {
            const plank = (y/4)|0, off = plank % 2 ? 7 : 0;
            for (let x = 0; x < P; ++x)
                px(x, y, (y % 4 == 0 || (x + off) % 7 == 0) ? 'v' : 'V');
        }
        for (let i = 0; i < 5; ++i)
            px(rnd.float(0, P)|0, 1 + (rnd.float(0, 13)|0), 'v');
    },

    /** shop carpet: a woven chequer with a piped border */
    carpet: (px) =>
    {
        const P = OW_TILE_PX;
        for (let y = 0; y < P; ++y)
        for (let x = 0; x < P; ++x)
            px(x, y, ((x>>2) + (y>>2)) % 2 ? 'C' : 'i');
        for (let i = 0; i < P; ++i)
        { px(i, 0, 'y'); px(i, P-1, 'y'); px(0, i, 'y'); px(P-1, i, 'y'); }
    },
};

// the grown tile instances, keyed the same way as the hand-drawn ones
const OW_TILE_GROWN = {
    grassA:  { fn:'grass',  accent:'h' },
    grassB:  { fn:'grass',  accent:'h' },
    grassC:  { fn:'grass',  accent:'h' },
    grassTuft:{fn:'tuft',   accent:'h' },
    flowerA: { fn:'flower', accent:'F' },
    flowerB: { fn:'flower', accent:'y' },
    grassPebble:{fn:'pebble', accent:'h' },
    cobble:  { fn:'cobble', accent:'p' },
    floorA:  { fn:'floor',  accent:'v' },
    floorB:  { fn:'floor',  accent:'v' },
    carpet:  { fn:'carpet', accent:'y' },
};

///////////////////////////////////////////////////////////////////////////////
// baking — one canvas + TextureInfo per world, built once at startup
///////////////////////////////////////////////////////////////////////////////

let owTileSheets = null;                 // { zig:{tex,cells}, zag:{tex,cells} }
let owTileTried = false;
let owTileSlots = {};                   // char -> Color, swapped while baking
let owRoomIndoor = false;                // the live room wants boards, not turf

/** every tile name in the sheet, in bake order */
function owTileNames()
{
    const n = Object.keys(OW_TILE_ART);
    for (const k in OW_TILE_GROWN) n.push(k);
    for (let m = 0; m < 16; ++m) n.push('kerb' + m);
    return n;
}

/** resolve the OW_TILE_SLOT chars against one world palette */
function owTileSlotsFor(world)
{
    const P = DATA.pal[world] || {}, out = {};
    for (const ch in OW_TILE_SLOT)
    {
        const key = OW_TILE_SLOT[ch];
        if (key && P[key]) out[ch] = P[key];
    }
    return out;
}

/**
 * Paint one tile into `data` at tile slot `i` of a sheet `W` texels wide.
 * `slots` is the resolved char -> Color table for the world being baked.
 */
function owPaintTile(data, W, i, name, slots, names)
{
    const P = OW_TILE_PX, ox = (i % OW_TILE_COLS)*P, oy = ((i / OW_TILE_COLS)|0)*P;
    const at = (x, y, ch) =>
    {
        const C = slots[ch];
        if (!C || x < 0 || y < 0 || x >= P || y >= P) return;
        const k = ((oy+y)*W + ox + x)*4;
        data[k]   = C.r*255;
        data[k+1] = C.g*255;
        data[k+2] = C.b*255;
        data[k+3] = (C.a === undefined ? 1 : C.a)*255;
    };

    // path kerb overlays: bit 1 = north/up, 2 = east, 4 = south, 8 = west
    if (name.indexOf('kerb') === 0)
    {
        const open = +name.slice(4), band = 3;
        for (let i2 = 0; i2 < band; ++i2)
        {
            for (let x = 0; x < P; ++x)
                if (open & 1) at(x, i2, (x == 0 || i2 == 0) ? 's' : 'q');
            for (let x = 0; x < P; ++x)
                if (open & 4) at(x, P-1-i2, (x == P-1 || i2 == 0) ? 's' : 'q');
            for (let y = 0; y < P; ++y)
                if (open & 8) at(i2, y, (y == 0 || i2 == 0) ? 's' : 'q');
            for (let y = 0; y < P; ++y)
                if (open & 2) at(P-1-i2, y, (y == P-1 || i2 == 0) ? 's' : 'q');
        }
        return;
    }

    const grown = OW_TILE_GROWN[name];
    if (grown)
    {
        // each variant gets its own seed, so grass A/B/C never repeat
        OW_TILE_GEN[grown.fn](at, new RandomGenerator(0x51ED + i*7919 + names.length), grown.accent);
        return;
    }

    const src = OW_TILE_ART[name];
    if (!src) return;
    const mirrored = !!src.mirror;
    const def = mirrored ? OW_TILE_ART[src.mirror] : src;
    if (def.gen) { def.gen(at, new RandomGenerator(0x51ED + i*7919), src.accent); return; }

    for (let y = 0; y < P; ++y)
    {
        let row = def.r[y];
        if (row === undefined) row = def.f.repeat(P);
        if (mirrored) row = row.split('').reverse().join('');
        for (let x = 0; x < P; ++x)
            at(x, y, row[x] === undefined ? def.f : row[x]);
    }
}

/** bake one world palette into a pixelated tilesheet (null if no canvas) */
function owBakeTileSheet(world)
{
    if (typeof document == 'undefined' || typeof TextureInfo == 'undefined') return null;
    const names = owTileNames();
    const W = OW_TILE_COLS*OW_TILE_PX;
    const H = Math.ceil(names.length / OW_TILE_COLS)*OW_TILE_PX;
    const slots = owTileSlotsFor(world);

    let cv = null, ctx = null;
    try
    {
        cv = document.createElement('canvas');
        if (!cv || !cv.getContext) return null;
        cv.width = W; cv.height = H;
        ctx = cv.getContext('2d');
        if (!ctx) return null;
    }
    catch (e) { return null; }

    const data = new Uint8ClampedArray(W*H*4);
    for (let i = 0; i < names.length; ++i)
        owPaintTile(data, W, i, names[i], slots, names);

    try
    {
        const img = ctx.createImageData ? ctx.createImageData(W, H) : null;
        if (img) { img.data.set(data); ctx.putImageData(img, 0, 0); }
        else
        {
            // no putImageData on this host — paint the sheet texel by texel
            ctx.fillStyle = '#000';
            for (let y = 0; y < H; ++y)
            for (let x = 0; x < W; ++x)
            {
                const k = (y*W + x)*4;
                if (data[k+3] < 8) continue;
                ctx.fillStyle = 'rgb(' + data[k] + ',' + data[k+1] + ',' + data[k+2] + ')';
                ctx.fillRect(x, y, 1, 1);
            }
        }
    }
    catch (e) { return null; }

    let tex = null;
    try { tex = new TextureInfo(cv, true, false, true); } catch (e) { tex = null; }
    if (!tex || !tex.size.x) return null;

    const cells = {};
    for (let i = 0; i < names.length; ++i)
        cells[names[i]] = tile(i, vec2(OW_TILE_PX, OW_TILE_PX), tex);
    return { tex, cells };
}

/** bake both worlds once — never throws, the flat fallback covers no-canvas hosts */
function owEnsureTiles()
{
    if (owTileSheets || owTileTried) return owTileSheets;
    owTileTried = true;
    const sheets = {};
    for (const world of ['zig', 'zag'])
    {
        try { sheets[world] = owBakeTileSheet(world); }
        catch (e) { sheets[world] = null; }
    }
    owTileSheets = sheets.zig && sheets.zag ? sheets : null;
    return owTileSheets;
}

/** the TileInfo for a named tile in a world (defaults to the live one) */
function owTileCell(name, world)
{
    const S = owTileSheets;
    if (!S) return null;
    const s = S[world || currentWorld];
    return s ? s.cells[name] || null : null;
}

/**
 * Draw one named tile at a world position. During a world switch the outgoing
 * sheet goes down first and the incoming one over it at owSwitchT, so the two
 * palettes dissolve into each other exactly like the rest of the world.
 */
function owDrawTileAt(name, pos, a, mirror)
{
    if (!owTileSheets) return false;
    let drew = false;
    const from = owSwitchFromName, blending = from && owSwitchT < 1 && from != currentWorld;
    if (blending)
    {
        const c = owTileCell(name, from);
        if (c) { drawTile(pos, vec2(1), c, WHITE); drew = true; }
    }
    const c = owTileCell(name, currentWorld);
    if (c)
    {
        drawTile(pos, vec2(1), c,
            a == null ? (blending ? alpha(WHITE, owSwitchT) : WHITE) : alpha(WHITE, a),
            0, mirror);
        drew = true;
    }
    return drew;
}

/** draw a named tile onto a map cell */
function owDrawMapTile(name, tx, ty, a, mirror)
{
    return owDrawTileAt(name, tileCenter(tx, ty), a, mirror);
}

///////////////////////////////////////////////////////////////////////////////
// buildings + street props, drawn from the same tiles as the ground
//
// A building grid is listed BOTTOM row first. Row 0 sits on the door's own
// tile and the middle column is the door's column, so a house always straddles
// the wall line with its roof standing over the tile the player walks onto.
// Nothing is drawn on the tile above row 0 in the door column, so the doorway
// itself stays clear.
// ---------------------------------------------------------------------------

const OW_BUILDINGS = {
    // a plain home: a lit window either side of the door under a hip roof
    home: [
        ['hwallWin', 'doorBot',  'hwallWinR'],
        ['hwall',    'hwall',    'hwall'],
        ['roofL',    'roofC',    'roofR'],
        ['roof2L',   'roof2C',   'roof2R'],
    ],
    // a shop: striped awning over the door, a painted board along the ridge
    shop: [
        ['hwallWin', 'doorBot',  'hwallWinR'],
        ['awning',   'awning',   'awning'],
        ['roofL',    'roofC',    'roofR'],
        ['signboard','signboard','signboard'],
    ],
    // a venue: twice as wide, lit by a neon band under a long pitch
    hall: [
        ['hwall',    'hwallWin', 'doorBot',  'hwallWinR', 'hwall'],
        ['neonBand', 'neonBand', 'neonBand', 'neonBand',  'neonBand'],
        ['roofL',    'roofC',    'roofC',    'roofC',     'roofR'],
        ['roof2L',   'roof2C',   'roof2C',   'roof2C',    'roof2R'],
    ],
    // flavour doors that lead nowhere: rusted iron in ZIG, a neon arch in ZAG
    irongate: [
        ['ironFoot', 'ironBar', 'ironFoot'],
        ['ironP',    'ironBar', 'ironP'],
        ['ironP',    'ironBar', 'ironP'],
        ['ironP',    'ironBar', 'ironP'],
    ],
    neongate: [
        ['neonFoot', 'neonBar', 'neonFoot'],
        ['neonP',    'neonBar', 'neonP'],
        ['neonP',    'neonBar', 'neonP'],
        ['neonP',    'neonBar', 'neonP'],
    ],
};

// street props, offsets in tiles from the decor anchor (+y = up on screen)
const OW_DECOR_ART = {
    pylon: [['lampH', 0, 1], ['lampP', 0, 0]],
    tree:  [['treeT', 0, 2], ['treeM', 0, 1], ['treeB', 0, 0]],
    bush:  [['bush', 0, 0]],
    rock:  [['stone', 0, 0]],
    sign:  [['signB', 0, 1], ['signP', 0, 0]],
    fence: [['fenceP', 0, 0], ['fenceRail', -1, 0], ['fenceRail', 1, 0]],
    arch:  [['neonP', -1.5, 0], ['neonP', 1.5, 0],
            ['neonBar', -1, 1], ['neonBar', 0, 1], ['neonBar', 1, 1]],
};

/** which building (if any) belongs on this door — null for plain interior exits */
function owBuildingFor(dr)
{
    const dir = dr.def.dir;
    // a door that opens south or sideways is the inside face of the building on
    // the far side of the map: you walk out of it, so it gets no house
    if (dir == 'down' || dir == 'left' || dir == 'right') return null;
    if (!dr.links() || dr.locked())
        return currentWorld == 'zag' ? 'neongate' : 'irongate';
    const to = owRooms[dr.def.to] || {};
    const tag = (String(dr.def.to) + ' ' + String(to.name || '')).toLowerCase();
    if (/shop|store|mart|merchant|clerk|mira/.test(tag)) return 'shop';
    if (/arena|stage|hall|venue|battle|pit|cave|dungeon|gate|neon/.test(tag)) return 'hall';
    return 'home';
}

/** draw the building that houses this door; the door tile stays walkable */
function owDrawBuilding(dr, a)
{
    const grid = OW_BUILDINGS[owBuildingFor(dr)];
    if (!grid) return false;
    const col = (grid[0].length - 1) >> 1;
    for (let r = 0; r < grid.length; ++r)
        for (let c = 0; c < grid[r].length; ++c)
            if (grid[r][c]) owDrawTileAt(grid[r][c], dr.pos.add(vec2(c - col, r)), a);
    return true;
}

/** draw a decor prop (lamp, tree, bush, rock, sign, fence, arch) from tiles */
function owDrawDecor(kind, p, a)
{
    const list = OW_DECOR_ART[kind];
    if (!list) return false;
    for (let i = 0; i < list.length; ++i)
        owDrawTileAt(list[i][0], p.add(vec2(list[i][1], list[i][2])), a);
    return true;
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
//
// Everything here is one drawTile() of a baked 16x16 texel set. Which tile a
// cell gets is decided by owHash(x, y, salt), so the scatter looks hand
// placed but never changes between frames.
//     +y is UP on screen, so the "cap" edge of a wall is the +y neighbour.
// ---------------------------------------------------------------------------

/** is the map cell solid? (off-map counts as solid: the room has a wall ring) */
function owCellSolid(tx, ty)
{
    return tx < 0 || ty < 0 || tx >= WORLD_W || ty >= WORLD_H ||
           tileType(tx, ty) > TILE_PATH;
}

/** the turf / boards a walkable cell wears, picked once from its hash */
function owGroundTile(tx, ty)
{
    if (owRoomIndoor) return owHash(tx, ty, 4) < .5 ? 'floorA' : 'floorB';
    const h = owHash(tx, ty, 0);
    if (h < .46) return 'grassA';
    if (h < .70) return 'grassB';
    if (h < .86) return 'grassC';
    const d = owHash(tx, ty, 1);
    return d < .40 ? 'grassTuft' : d < .74 ? 'flowerA' : 'grassPebble';
}

/** 4-bit mask of a road tile's road neighbours: 1 north, 2 east, 4 south, 8 west */
function owPathMask(tx, ty)
{
    const isPath = (x, y)=> tileType(x, y) == TILE_PATH;
    return (isPath(tx, ty+1) ? 1 : 0) | (isPath(tx+1, ty) ? 2 : 0) |
           (isPath(tx, ty-1) ? 4 : 0) | (isPath(tx-1, ty) ? 8 : 0);
}

function renderWorldTiles()
{
    owEnsureTiles();
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

function drawWorldTile(tx, ty)
{
    const t = tileType(tx, ty);
    const flip = owHash(tx, ty, 7) < .5;

    if (t == TILE_FLOOR)
    {
        if (!owDrawMapTile(owGroundTile(tx, ty), tx, ty)) owFlatTile(tx, ty, t);
    }
    else if (t == TILE_PATH)
    {
        if (!owDrawMapTile(owRoomIndoor ? 'carpet' : 'cobble', tx, ty))
        { owFlatTile(tx, ty, t); return; }
        // a kerb wherever the road does NOT continue — the edge of the path
        const open = 15 & ~owPathMask(tx, ty);
        if (open) owDrawMapTile('kerb' + open, tx, ty);
    }
    else if (t == TILE_WALL)
    {
        // the lit ledge rides the top (+y) edge, where the sky meets the stone
        const cap = !owCellSolid(tx, ty+1);
        if (!owDrawMapTile(cap ? 'brickCap' : 'brick', tx, ty, null, flip))
            owFlatTile(tx, ty, t);
    }
    else    // TILE_BLOCK
    {
        if (!owDrawMapTile('crate', tx, ty, null, flip)) owFlatTile(tx, ty, t);
    }
}

/** flat stand-in, used only when the host cannot bake a tilesheet */
function owFlatTile(tx, ty, t)
{
    const P = owPal;
    if (t == TILE_PATH)       drawRect(tileCenter(tx, ty), vec2(1), P.path);
    else if (t == TILE_WALL)  drawRect(tileCenter(tx, ty), vec2(1), P.wall);
    else if (t == TILE_BLOCK) drawRect(tileCenter(tx, ty), vec2(1), P.block);
    else                      drawRect(tileCenter(tx, ty), vec2(1), P.grass);
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

// A decor prop is a little stack of baked tiles standing on its anchor tile.
// Trees, bushes, rocks, fences, signposts and lamp posts all come out of the
// same 16x16 sheet as the ground, so the whole map is one pixel language.
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
        const pulse = .5 + .5*sin(time*1.8 + this.seed);

        if (this.kind == 'arch')
        {
            // the stage arch over the arena door — neon posts, neon lintel
            if (!owDrawDecor('arch', p, 1))
            {
                for (const lx of [-1.5, 1.5])
                    drawRect(p.add(vec2(lx, .5)), vec2(.6, 3.4), P.wallTop);
            }
            setAdditiveBlendMode(true);
            drawRect(p.add(vec2(0, 1.6)), vec2(4.4, 2.4), alpha(P.accent, .05 + pulse*.06));
            setAdditiveBlendMode(false);
            drawText('STAGE 01', p.add(vec2(0, 3.1)), .5, C.gold, .04, P.shade, 'center', DATA.ui.font);
            return;
        }

        if (this.kind == 'pylon')
        {
            // lamp post: the tiles carry the post, the halo is the only glow
            if (owDrawDecor('pylon', p, 1)) return;
            drawEllipse(p.add(vec2(0, -.42)), vec2(.9, .34), alpha(P.shade, .55));
            drawRect(p.add(vec2(0, -.05)), vec2(.3, .9), P.wallTop);
            drawCircle(p.add(vec2(0, .55)), .22, P.accent);
            return;
        }

        if (OW_DECOR_ART[this.kind])
        {
            // a soft contact shadow under anything that stands on the ground
            if (this.kind != 'fence')
                drawEllipse(p.add(vec2(0, -.44)), vec2(.55, .2), alpha(P.shade, .4));
            owDrawDecor(this.kind, p, 1);
            return;
        }

        // unknown decor kind from an authored world — keep the old lamp-post read
        drawEllipse(p.add(vec2(0, -.42)), vec2(.9, .34), alpha(P.shade, .55));
        drawRect(p.add(vec2(0, -.05)), vec2(.3, .9), P.wallTop);
        drawRect(p.add(vec2(0, .42)), vec2(.5, .16), P.blockTop);
        setAdditiveBlendMode(true);
        drawCircle(p.add(vec2(0, .55)), .55 + pulse*.15, alpha(P.accent, .16 + pulse*.12));
        setAdditiveBlendMode(false);
        drawCircle(p.add(vec2(0, .55)), .22, P.accent);
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
        if (!owPortalActive) return;      // the gate only opens in the ZAG world
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

        // the building the door is set into — walls, pitch, a shop awning or
        // a gate. It stands behind and above the door tile, never across it.
        const housed = owDrawBuilding(this, a);

        if (!housed)
        {
            // a free-standing frame: the inside face of a building on the far
            // side of the map, so you walk OUT through it
            drawRect(p.add(vec2(0, .25)), vec2(1.15, 1.75), alpha(P.wall, a));
            drawRect(p.add(vec2(0, 1.02)), vec2(1.3, .3), alpha(P.wallTop, a));
            const pts = [];
            for (let i = 0; i <= 4; ++i)
                pts.push(p.add(vec2(-.6 + i*.3, 1.16 + (i % 2 ? -.08 : .08))));
            drawLineList(pts, .05, alpha(P.wallEdge, .95*a));
        }

        // the doorway itself — the only art that ever sits over the door tile
        const lock = this.lockFlash;
        if (housed)
        {
            // the tiles already drew the door; tint the panel toward its state
            // so an open door reads green and a locked one reads shut
            drawRect(p.add(vec2(0, -.02)), vec2(.44, .62),
                alpha(doorCol, (.16 + .12*pulse)*a));
            drawRect(p.add(vec2(0, -.02)), vec2(.30, .52),
                alpha(P.shade, (open ? .12 : .34)*a));
        }
        else
        {
            drawRect(p.add(vec2(0, .2)), vec2(.82, 1.35), alpha(doorCol, (.92 - .25*pulse)*a));
            drawRect(p.add(vec2(0, .2)), vec2(.6, 1.2), alpha(P.shade, (open ? .18 : .45)*a));
        }
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
    }

    update()
    {
        if (state != 'world') return;
        const W = DATA.world, dt = timeDelta;

        // frozen while a dialog is on screen or the screen is fading through a door
        if (owWarp || (typeof Dialog != 'undefined' && Dialog.isOpen()))
        {
            this.vel = vec2();
            this.moveAmt = Math.max(0, this.moveAmt - .3);
            return;
        }

        // ---- input: WASD only ----------------------------------------------
        // the arrow keys belong to menus and to the DOWN world switch, so they
        // never drive the player (LittleJS mirrors WASD onto them — hence the
        // physical-key check in owArrowDownPhysical)
        let dir = vec2();
        if (keyIsDown('KeyA')) dir.x -= 1;
        if (keyIsDown('KeyD')) dir.x += 1;
        if (keyIsDown('KeyW')) dir.y += 1;
        if (keyIsDown('KeyS')) dir.y -= 1;
        if (dir.length()) dir = dir.normalize();

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
        // the portal only exists in the ZAG (play) world — in ZIG it is inert
        if (owPortalActive)
        {
            const d = this.pos.subtract(portalPos).length();
            const talking = typeof Dialog != 'undefined' && Dialog.inputLocked();
            const busy = talking || !!owInteractableAt(this.pos);
            const press = keyWasPressed('Space') || keyWasPressed('Enter') || keyWasPressed('NumpadEnter');
            if (d < W.portalRange || (!busy && press) && d < W.portalPrompt)
                enterStage();
        }
    }

    render()
    {
        if (state != 'world') return;

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
    owPortalObj = null;
    owPortalActive = false;
    owNear = null;
}

///////////////////////////////////////////////////////////////////////////////
// the stage portal — ZAG (play) world only
//
// A room may declare a `portal` tile, but that gate only opens in ZAG: standing
// on it in the ZIG (real) world does nothing. owSyncPortal() rebuilds the tile
// position from the live room and re-evaluates the live world, so a DOWN switch
// inside a world:'both' room flips the portal in place.
///////////////////////////////////////////////////////////////////////////////

function owSyncPortal()
{
    const room = owRooms[owRoomId];
    const has = !!(room && room.portal);

    if (has)
    {
        portalPos = tileCenter(room.portal[0], room.portal[1]);
        if (!owPortalObj || owPortalObj.destroyed)
        {
            owPortalObj = new Portal(portalPos);
            owStatics.push(owPortalObj);
        }
        else
            owPortalObj.pos = portalPos.copy();
    }
    else
    {
        owPortalObj = null;
        portalPos = vec2(1e6, 1e6);
    }

    owPortalActive = has && currentWorld == 'zag';
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
    // the stage portal belongs to ZAG only — the ZIG mirror of the room is
    // inert, so owPortalActive follows the live world, not just the room
    owSyncPortal();

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
    if (player) player.vel = vec2();
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
