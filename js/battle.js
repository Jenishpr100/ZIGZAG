///////////////////////////////////////////////////////////////////////////////
// ZIGZAG SYNTH — battle.js
// Bravely-flavoured command battles that punctuate the rhythm sections.
// Self-contained: this file owns nothing but window.Battle. It never touches
// the DOM, never grabs the canvas 2D context, and only calls LittleJS APIs
// (drawRect / drawLine / drawPoly / drawCircle / drawTextScreen / keyWasPressed
// / keyIsDown / EngineObject) at runtime.
//
// ---------------------------------------------------------------------------
// PUBLIC API  (window.Battle)
// ---------------------------------------------------------------------------
//   Battle.start(enemyConfig, playerState, onBattleEnd, opts?)
//     enemyConfig : { name, hp, maxHp, attacks:[{name,power}|str|num],
//                     sprite:'path', drops:[item] }
//     playerState : { hp, maxHp, weapons:[{name,power}|str|num], weaponIndex,
//                     items:[item], score, def, accuracy, combo }
//                   (Battle writes hp/items/score back onto this object)
//     onBattleEnd : ({ won, playerHp, newItems }) => void   — fired once
//     opts        : { onSectionStart, performance:{score,accuracy,combo,def} }
//
//   Battle.update(dt)            — call every frame while isActive()
//   Battle.render()              — call every frame while isActive()
//   Battle.isActive()            — true from start() until onBattleEnd fires
//   Battle.pickCommand(cmd)      — 'ATTACK'|'DEFEND'|'DEFAULT'|'BRAVE'|
//                                  'USE_ITEM'|'SPECATTACK'  (only in MENU_SELECT)
//
//   extras for the play / results states:
//   Battle.getState()            — 'IDLE'|'MENU_SELECT'|'ITEM_SELECT'|
//                                  'SPEC_CHART'|'EXECUTE_COMMAND'|'ENEMY_TURN'|
//                                  'SECTION_BREAK'|'SECTION_PLAY'|
//                                  'BATTLE_WON'|'BATTLE_LOST'
//   Battle.openMenu()            — SECTION_PLAY -> MENU_SELECT (section ended)
//   Battle.isSpecChart()         — true while a spec chart should be playing
//   Battle.resolveSpec(acc)      — 0..1 or 0..100 accuracy of the spec chart
//                                  (>=70% => x3 damage, else normal attack)
//   Battle.setPerformance({score, accuracy, combo, def})
//   Battle.getEnemy() / Battle.getPlayer() / Battle.getCommands()
//   Battle.stop()                — hard cancel, no onBattleEnd callback
//
// ---------------------------------------------------------------------------
// INTEGRATION FLOW (how the play state should drive it)
// ---------------------------------------------------------------------------
//   start()  ─► MENU_SELECT  (player picks a command with arrows + Enter,
//                             or the caller may pickCommand() itself)
//        SPECATTACK ─► SPEC_CHART ── play the harder chart ──► resolveSpec()
//                             │
//                             ▼
//                     EXECUTE_COMMAND  (attack anim, damage numbers float)
//                             ▼
//                       ENEMY_TURN     (enemy hits back, DEF applies)
//                             ▼
//                       SECTION_BREAK  (short pause)
//                             ▼
//                       SECTION_PLAY   (onSectionStart callback; run the next
//                                       rhythm section — battle only draws a
//                                       slim enemy HP chip)
//                             ▼
//                       openMenu() ─► MENU_SELECT   … repeat
//
//   enemy HP <= 0 → BATTLE_WON, player HP <= 0 → BATTLE_LOST, then onBattleEnd.
//
// ---------------------------------------------------------------------------
// MECHANICS (locked)
//   atkBonus    = floor(score / 10000)
//   defBonus    = floor(accuracyPercent / 10)
//   critChance  = min(30, 5 + floor(combo / 20))   — crits deal x2
//   ATTACK      = weapon power + atkBonus
//   DEFEND      = -35% damage this turn, +5 DEF this turn only
//   DEFAULT     = damage cut of max(25%, accuracy*0.25%) this turn,
//                 +5 DEF that persists until the next command
//   BRAVE       = 2*weapon power + atkBonus, but take +50% damage this turn
//   USE_ITEM    = item sub-menu; the item resolves, enemy still attacks
//   SPECATTACK  = spec chart result decides: >=70% → 3x base, else 1x base
//   damage taken = max(1, round(raw*(1-reduction) - totalDef*0.5))
//                 totalDef = playerState.def + defBonus + turn/persist DEF
///////////////////////////////////////////////////////////////////////////////
(function () {
'use strict';

///////////////////////////////////////////////////////////////////////////////
// constants
///////////////////////////////////////////////////////////////////////////////

const COMMANDS = ['ATTACK', 'DEFEND', 'DEFAULT', 'BRAVE', 'USE_ITEM', 'ZIGZAG'];

const DESC = {
    ATTACK:     'Basic strike — weapon power + score bonus',
    DEFEND:     'Guard this turn — less damage, +5 DEF (this turn)',
    DEFAULT:    'Bank defense — 25%+ damage cut, +5 DEF until next command',
    BRAVE:      'High risk — x2 attack, but take +50% damage this turn',
    USE_ITEM:   'Use one item from your bag',
    ZIGZAG:     'Drag through the five lights. A clean trace earns x3 damage',
};

// phase lengths, seconds
const T = {
    exec: 1.15, execHit: 0.40,     // player command anim / damage lands
    enemy: 1.50, enemyHit: 0.80,   // enemy telegraph / hit lands
    brk: 0.70,                     // pause before the next rhythm section
    banner: 1.40,                  // win/lose banner before onBattleEnd
};

// fallback palette — used until js/data.js has resolved (DATA.colors)
const FALLBACK = {
    bg:'#0b0616', panel:'#140a26', neon:'#ff2e88', neonSoft:'#ff8fc4',
    cyan:'#2ff3ff', violet:'#7a3cff', ink:'#fff0fb', dim:'#9b83bd',
    gold:'#ffd76a', good:'#7cff9b', bad:'#ff4d7d',
};

// EngineObject only exists once littlejs.min.js has run; fall back to a stub
// so this file can be loaded in any order without throwing at parse time.
const EngineBase = typeof EngineObject != 'undefined' ? EngineObject : class {};

///////////////////////////////////////////////////////////////////////////////
// tiny math / color helpers (self-contained — no reliance on hud.js/data.js)
///////////////////////////////////////////////////////////////////////////////

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const clampN = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const lerpN = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);

let PAL = null;     // resolved colour objects, rebuilt on every start()

function pal()
{
    if (PAL) return PAL;
    const src = typeof DATA != 'undefined' && DATA.colors ? DATA.colors : {};
    const th = typeof ZZ != 'undefined' && ZZ.theme || null;
    const themed = th ? {
        bg: th.ui && th.ui.bg,
        neon: th.ui && th.ui.accent,
        neonSoft: th.hold,
        cyan: th.ui && th.ui.accent2,
        violet: th.drag,
        ink: th.ui && th.ui.text,
        dim: th.ui && th.ui.dim,
        gold: th.drag,
    } : {};
    const hex = k => themed[k] || src[k] || FALLBACK[k] || '#ffffff';
    const mk = k =>
    {
        try { return new Color().setHex(hex(k)); }
        catch (_) { return null; }
    };
    PAL = {};
    for (const k in FALLBACK) PAL[k] = mk(k);
    return PAL;
}

// tinted copy of a colour (never mutates the shared palette colour)
function A(c, a)
{
    if (!c) return c;
    try { return c.withAlpha ? c.withAlpha(a) : c; }
    catch (_) { return c; }
}

function fontOf(soft)
{
    if (typeof DATA != 'undefined' && DATA.ui)
        return soft ? DATA.ui.soft : DATA.ui.font;
    return soft ? 'Verdana, sans-serif' : 'Arial Black, Arial, sans-serif';
}

function screenSize() { return typeof mainCanvasSize != 'undefined' && mainCanvasSize ? mainCanvasSize : null; }

///////////////////////////////////////////////////////////////////////////////
// battle state
///////////////////////////////////////////////////////////////////////////////

const B = {
    state: 'IDLE',

    enemy: null,                // { name, maxHp, attacks, sprite, drops }
    player: null,               // caller's playerState (mutated in place)
    onEnd: null, onSection: null,

    hp: 100, maxHp: 100,        // player
    eHp: 100, eMaxHp: 100,      // enemy
    score: 0, def: 0,
    accuracy: 0, combo: 0,      // accuracy is 0..100 percent

    weapons: [], weaponIndex: 0,
    items: [], itemCursor: 0,

    cursor: 0, navHold: 0,

    defTurn: 0, defPersist: 0, reduction: 0,
    newItems: [],

    intent: null, intentIndex: 0,

    phase: 0, hitDone: false, ended: false,
    lastCommand: '',
    pendingDmg: 0, pendingLabel: '', pendingCrit: false, specSuccess: false,
    zigzag: null,

    menuAnim: 0,                // menu slide-in 0..1
    toast: '', toastLife: 0,
    enemyFlash: 0, playerFlash: 0,
    enemyOx: 0, enemyOy: 0,     // sprite offset (screen px)

    t: 0, section: 0,
    texIndex: undefined,
};

///////////////////////////////////////////////////////////////////////////////
// normalization helpers (players/enemies/items can be loose shapes)
///////////////////////////////////////////////////////////////////////////////

function normalizeAttacks(list)
{
    const out = [];
    if (Array.isArray(list))
        for (const a of list)
        {
            if (typeof a == 'number') out.push({ name: 'STRIKE', power: Math.max(1, a) });
            else if (typeof a == 'string') out.push({ name: a.toUpperCase(), power: 8 });
            else if (a && typeof a == 'object')
                out.push({
                    name: String(a.name || a.label || 'STRIKE').toUpperCase(),
                    power: Math.max(1, a.power || a.damage || a.dmg || a.atk || 8),
                });
        }
    if (!out.length) out.push({ name: 'STRIKE', power: 8 });
    return out;
}

function normalizeWeapons(list)
{
    const one = w =>
    {
        if (typeof w == 'number') return { name: 'WEAPON', power: Math.max(1, w) };
        if (typeof w == 'string') return { name: w.toUpperCase(), power: 5 };
        if (w && typeof w == 'object')
            return {
                name: String(w.name || w.label || 'WEAPON').toUpperCase(),
                power: Math.max(1, w.power || w.atk || w.dmg || w.damage || 5),
            };
        return null;
    };
    const out = [];
    if (Array.isArray(list)) { for (const w of list) { const n = one(w); if (n) out.push(n); } }
    else if (list) { const n = one(list); if (n) out.push(n); }
    if (!out.length) out.push({ name: 'FISTS', power: 4 });
    return out;
}

// accuracy may be a 0..1 fraction or a 0..100 percent — normalise to percent
function normAcc(a)
{
    a = Number(a);
    if (!isFinite(a)) return 0;
    return clampN(a > 1 ? a : a * 100, 0, 100);
}

function itemType(it)
{
    const raw = typeof it == 'string' ? 'heal'
        : String((it && (it.type || it.effect || it.kind)) || 'heal').toLowerCase();
    if (raw == 'hp' || raw == 'potion' || raw.indexOf('heal') >= 0) return 'heal';
    if (raw.indexOf('def') >= 0 || raw.indexOf('buff') >= 0 || raw.indexOf('guard') >= 0) return 'def';
    if (raw.indexOf('atk') >= 0 || raw.indexOf('attack') >= 0 ||
        raw.indexOf('dmg') >= 0 || raw.indexOf('damage') >= 0) return 'attack';
    return 'heal';
}

function itemAmount(it, type)
{
    if (typeof it == 'number') return Math.max(1, it);
    if (typeof it == 'string') return type == 'attack' ? 15 : type == 'def' ? 5 : 30;
    if (it && typeof it == 'object')
    {
        const v = it.amount || it.power || it.value || it.heal || it.qty;
        if (v) return Math.max(1, v);
    }
    return type == 'attack' ? 15 : type == 'def' ? 5 : 30;
}

function itemName(it)
{
    if (typeof it == 'string') return it.toUpperCase();
    if (typeof it == 'number') return 'ITEM';
    return String((it && (it.name || it.label)) || 'ITEM').toUpperCase();
}

///////////////////////////////////////////////////////////////////////////////
// stat conversions
///////////////////////////////////////////////////////////////////////////////

function weapon() { return B.weapons[B.weaponIndex] || B.weapons[0] || { name: 'FISTS', power: 4 }; }
function atkBonus() { return Math.floor(B.score / 10000); }
function defBonus() { return Math.floor(B.accuracy / 10); }
function critChance() { return Math.min(30, 5 + Math.floor(B.combo / 20)); }
function baseAttack() { return weapon().power + atkBonus(); }

function damageToEnemy(amount)
{
    if (amount <= 0) return 0;
    B.pendingCrit = Math.random() * 100 < critChance();
    return Math.max(1, Math.round(amount * (B.pendingCrit ? 2 : 1)));
}

///////////////////////////////////////////////////////////////////////////////
// lifecycle
///////////////////////////////////////////////////////////////////////////////

function loadSprite(path)
{
    B.texIndex = undefined;
    if (!path || typeof loadTexture != 'function') return;
    const key = 'battle_' + String(path).replace(/\W+/g, '_').slice(-40);
    try
    {
        const r = loadTexture(key, path);
        if (r && typeof r.then == 'function')
            r.then(i => { if (B.enemy && B.enemy.sprite == path) B.texIndex = i; }).catch(() => {});
        else if (typeof r == 'number') B.texIndex = r;
    }
    catch (_) { /* procedural avatar stays */ }
}

function start(enemyConfig, playerState, onBattleEnd, opts)
{
    opts = opts || {};
    const e = enemyConfig || {};
    PAL = null;                             // re-resolve palette (DATA may have loaded)

    B.enemy = {
        name: String(e.name || 'ENEMY').toUpperCase(),
        maxHp: Math.max(1, e.maxHp || e.hp || 60),
        attacks: normalizeAttacks(e.attacks),
        sprite: e.sprite || '',
        drops: e.drops || [],
    };
    B.eMaxHp = B.enemy.maxHp;
    B.eHp = clampN(e.hp == null ? B.eMaxHp : e.hp, 0, B.eMaxHp);

    const p = playerState || {};
    B.player = p;
    B.maxHp = Math.max(1, p.maxHp || 100);
    B.hp = clampN(p.hp == null ? B.maxHp : p.hp, 0, B.maxHp);
    B.weapons = normalizeWeapons(p.weapons);
    B.weaponIndex = clampN(p.weaponIndex | 0, 0, B.weapons.length - 1);
    B.items = Array.isArray(p.items) ? p.items.slice() : [];
    B.itemCursor = 0;
    B.score = Math.max(0, p.score | 0);
    B.def = Math.max(0, p.def | 0);
    B.accuracy = p.accuracy == null ? 0 : normAcc(p.accuracy);
    B.combo = Math.max(0, p.combo | 0);
    if (opts.performance) setPerformance(opts.performance);

    B.state = 'MENU_SELECT';
    B.phase = 0; B.menuAnim = 0; B.cursor = 0; B.navHold = 0;
    B.defTurn = 0; B.defPersist = 0; B.reduction = 0;
    B.newItems = [];
    B.section = 0; B.ended = false; B.t = 0;
    B.hitDone = false; B.pendingDmg = 0; B.pendingLabel = ''; B.pendingCrit = false;
    B.toast = ''; B.toastLife = 0;
    B.zigzag = null;
    B.enemyFlash = 0; B.playerFlash = 0; B.enemyOx = 0; B.enemyOy = 0;
    B.intentIndex = 0; B.intent = rollIntent();
    B.onEnd = typeof onBattleEnd == 'function' ? onBattleEnd : null;
    B.onSection = typeof opts.onSectionStart == 'function' ? opts.onSectionStart : null;
    loadSprite(B.enemy.sprite);
    syncPlayer();
}

function stop()
{
    B.state = 'IDLE';
    B.onEnd = null; B.onSection = null;
    B.enemy = null; B.player = null;
    B.items = []; B.newItems = [];
    B.zigzag = null;
    B.toastLife = 0;
}

function syncPlayer()
{
    if (!B.player) return;
    B.player.hp = Math.max(0, Math.round(B.hp));
    B.player.items = B.items;
    B.player.score = B.score;
}

function setPerformance(perf)
{
    if (!perf) return;
    if (perf.score != null) B.score = Math.max(0, perf.score | 0);
    if (perf.accuracy != null) B.accuracy = normAcc(perf.accuracy);
    if (perf.combo != null) B.combo = Math.max(0, perf.combo | 0);
    if (perf.def != null) B.def = Math.max(0, perf.def | 0);
    syncPlayer();
}

function rollIntent()
{
    if (!B.enemy) return null;
    const a = B.enemy.attacks;
    B.intent = a[B.intentIndex++ % a.length] || null;
    return B.intent;
}

///////////////////////////////////////////////////////////////////////////////
// commands
///////////////////////////////////////////////////////////////////////////////

function isActive() { return B.state != 'IDLE'; }
function getState() { return B.state; }
function isSpecChart() { return B.state == 'SPEC_CHART'; }

function pickCommand(cmd)
{
    if (B.state != 'MENU_SELECT') return false;
    cmd = String(cmd || '').toUpperCase();
    if (cmd == 'USE_ITEM') { openItems(); return true; }
    if (COMMANDS.indexOf(cmd) < 0) return false;
    if (cmd == 'SPECATTACK') { beginSpec(); return true; }
    if (cmd == 'ZIGZAG') { beginZigzag(); return true; }
    execute(cmd);
    return true;
}

function beginZigzag()
{
    B.state = 'ZIGZAG_TRACE';
    B.phase = 0;
    B.zigzag = { started: false, index: 0, quality: 0, time: 0, previous: null };
    toast('TRACE THE ZIGZAG WITH YOUR MOUSE', 1.4);
}

function zigzagPoints(S)
{
    const midY = S.y * .56, rise = Math.min(48, S.y * .07), left = S.x * .2, step = S.x * .15;
    return [0,1,2,3,4].map(i => vec2(left + step * i, midY + (i % 2 ? -rise : rise)));
}

function pointerScreenPos(S)
{
    if (typeof mousePos == 'undefined' || typeof cameraScale != 'number') return null;
    const cp = typeof cameraPos != 'undefined' && cameraPos ? cameraPos : vec2();
    return vec2(S.x * .5 + (mousePos.x - cp.x) * cameraScale,
        S.y * .5 - (mousePos.y - cp.y) * cameraScale);
}

function segmentDistance(p, a, b)
{
    const dx = b.x - a.x, dy = b.y - a.y, denom = dx * dx + dy * dy;
    const t = denom ? clampN(((p.x - a.x) * dx + (p.y - a.y) * dy) / denom, 0, 1) : 0;
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function updateZigzag(dt)
{
    const z = B.zigzag, S = screenSize();
    if (!z || !S) return;
    z.time += dt;
    const points = zigzagPoints(S), pointer = pointerScreenPos(S), radius = Math.max(34, Math.min(52, S.x * .065));
    if (pointer && mouseIsDown(0))
    {
        if (!z.started && mouseWasPressed(0) && Math.hypot(pointer.x - points[0].x, pointer.y - points[0].y) <= radius * 1.45)
        {
            z.started = true;
            z.index = 1;
            z.quality = clampN(1 - Math.hypot(pointer.x - points[0].x, pointer.y - points[0].y) / (radius * 1.45), .55, 1);
            z.previous = pointer;
        }
        else if (z.started && z.previous)
        {
            while (z.index < points.length && segmentDistance(points[z.index], z.previous, pointer) <= radius)
            {
                const d = Math.hypot(points[z.index].x - pointer.x, points[z.index].y - pointer.y);
                z.quality += clampN(1 - d / (radius * 1.8), .45, 1);
                z.index++;
            }
            z.previous = pointer;
        }
    }
    if (z.index >= points.length) { finishZigzag(); return; }
    if (backPressed()) { B.zigzag = null; B.state = 'MENU_SELECT'; B.menuAnim = 1; return; }
    if (z.time >= 5) finishZigzag();
}

function finishZigzag()
{
    const z = B.zigzag;
    if (!z) return;
    const accuracy = z.quality / 5 * 100;
    B.specSuccess = accuracy >= 70;
    toast(B.specSuccess ? 'CLEAN ZIGZAG — ' + Math.round(accuracy) + '%' : 'ZIGZAG MISSED — ' + Math.round(accuracy) + '%', 1.3);
    B.zigzag = null;
    execute('ZIGZAG');
}

// SPECATTACK resolves from the player's most recent rhythm accuracy. This keeps
// the signature move usable from the integrated battle screen without leaving
// the player stuck in a chart-waiting state.
function beginSpec()
{
    B.specSuccess = B.accuracy >= 70;
    toast(B.specSuccess ? 'RHYTHM BURST!' : 'BUILD YOUR ACCURACY!', 1);
    execute('SPECATTACK');
}

function openMenu()
{
    if (B.state != 'SECTION_PLAY') return false;
    B.state = 'MENU_SELECT';
    B.phase = 0; B.menuAnim = 0; B.navHold = 0;
    B.cursor = clampN(B.cursor, 0, COMMANDS.length - 1);
    rollIntent();
    return true;
}

function openItems()
{
    B.state = 'ITEM_SELECT';
    B.itemCursor = clampN(B.itemCursor, 0, Math.max(0, B.items.length - 1));
    B.menuAnim = 1;
}

function execute(cmd)
{
    // per-command reset: transient DEF dies, DEFAULT's persistent DEF dies too
    B.defTurn = 0; B.defPersist = 0; B.reduction = 0;
    B.lastCommand = cmd;
    B.phase = 0; B.hitDone = false;
    B.pendingDmg = 0; B.pendingLabel = cmd; B.pendingCrit = false;

    if (cmd == 'ATTACK')
        B.pendingDmg = damageToEnemy(baseAttack());
    else if (cmd == 'DEFEND')
    {
        B.reduction = 0.35;
        B.defTurn = 5;
    }
    else if (cmd == 'DEFAULT')
    {
        // guaranteed >=25%, scales with performance (100% acc -> 50% cut)
        B.reduction = clampN(Math.max(0.25, B.accuracy * 0.0025), 0.25, 0.6);
        B.defPersist = 5;
    }
    else if (cmd == 'BRAVE')
    {
        B.reduction = -0.5;                              // take +50% damage
        B.pendingDmg = damageToEnemy(weapon().power * 2 + atkBonus());
    }
    else if (cmd == 'SPECATTACK' || cmd == 'ZIGZAG')
    {
        // A clean mouse trace earns the signature triple strike.
        B.pendingDmg = damageToEnemy(baseAttack() * (B.specSuccess ? 3 : 1));
        B.pendingLabel = B.specSuccess ? 'ZIGZAG SLASH!!' : 'ZIGZAG SLASH';
    }
    // USE_ITEM: the item already resolved in useItem(); enemy still counters

    B.state = 'EXECUTE_COMMAND';
}

function resolveSpec(accuracy)
{
    if (B.state != 'SPEC_CHART') return false;
    const a = normAcc(accuracy);
    B.specSuccess = a >= 70;
    toast(B.specSuccess
        ? 'SPEC CHART CLEARED — ' + Math.round(a) + '%'
        : 'SPEC CHART FAILED — ' + Math.round(a) + '%', 1.2);
    execute('SPECATTACK');
    return true;
}

function useItem(i)
{
    const it = B.items[i];
    if (it == null) return;
    B.items.splice(i, 1);
    if (B.player) B.player.items = B.items;
    B.itemCursor = clampN(B.itemCursor, 0, Math.max(0, B.items.length - 1));
    applyItem(it);
    execute('USE_ITEM');
}

function applyItem(it)
{
    const type = itemType(it);
    const amount = itemAmount(it, type);
    if (type == 'heal')
    {
        const healed = Math.min(B.maxHp - B.hp, amount);
        B.hp += healed;
        spawnDamage(playerScreenPos(), '+' + Math.round(healed), pal().good, 1);
        toast(itemName(it) + ' — ' + Math.round(healed) + ' HP', 1);
    }
    else if (type == 'def')
    {
        B.def += amount;
        toast(itemName(it) + ' — DEF +' + amount, 1);
    }
    else // attack: direct damage, resolves with the player-attack animation
    {
        B.pendingDmg = damageToEnemy(amount);
        B.pendingLabel = itemName(it);
        toast(itemName(it) + '!', 1);
    }
    syncPlayer();
}

function toast(msg, life) { B.toast = msg; B.toastLife = life == null ? 1 : life; }

///////////////////////////////////////////////////////////////////////////////
// turn resolution
///////////////////////////////////////////////////////////////////////////////

function win()
{
    B.state = 'BATTLE_WON';
    B.phase = 0;
    B.newItems = Array.isArray(B.enemy.drops) ? B.enemy.drops.slice() : [];
    toast('VICTORY!', T.banner);
    syncPlayer();
}

function lose()
{
    B.state = 'BATTLE_LOST';
    B.phase = 0;
    B.newItems = [];
    toast('DEFEATED...', T.banner);
    syncPlayer();
}

function finishBattle(won)
{
    const cb = B.onEnd;
    B.state = 'IDLE';
    B.onEnd = null; B.onSection = null;
    syncPlayer();
    if (cb)
        cb({ won: !!won, playerHp: Math.max(0, Math.round(B.hp)), newItems: B.newItems.slice() });
}

///////////////////////////////////////////////////////////////////////////////
// input
///////////////////////////////////////////////////////////////////////////////

const keyDown = k => typeof keyIsDown == 'function' && keyIsDown(k);
const keyPressed = k => typeof keyWasPressed == 'function' && keyWasPressed(k);
const confirmPressed = () => keyPressed('Enter') || keyPressed('NumpadEnter') || keyPressed('Space');
const backPressed = () => keyPressed('Escape') || keyPressed('Backspace');

// arrow navigation over a cols x rows grid, with hold-to-repeat
function navAxis(dt, cols, rows, idx)
{
    let col = idx % cols, row = Math.floor(idx / cols), moved = false;
    if (keyPressed('ArrowLeft'))  { col = (col + cols - 1) % cols; moved = true; }
    if (keyPressed('ArrowRight')) { col = (col + 1) % cols; moved = true; }
    if (keyPressed('ArrowUp'))    { row = (row + rows - 1) % rows; moved = true; }
    if (keyPressed('ArrowDown'))  { row = (row + 1) % rows; moved = true; }

    if (!moved)
    {
        const held = keyDown('ArrowLeft') || keyDown('ArrowRight') ||
            keyDown('ArrowUp') || keyDown('ArrowDown');
        if (!held) B.navHold = 0.34;
        else if ((B.navHold -= dt) <= 0)
        {
            B.navHold = 0.12; moved = true;
            if (keyDown('ArrowLeft'))  col = (col + cols - 1) % cols;
            if (keyDown('ArrowRight')) col = (col + 1) % cols;
            if (keyDown('ArrowUp'))    row = (row + rows - 1) % rows;
            if (keyDown('ArrowDown'))  row = (row + 1) % rows;
        }
    }
    return moved ? row * cols + col : idx;
}

function menuInput(dt)
{
    B.cursor = navAxis(dt, 2, 3, clampN(B.cursor, 0, COMMANDS.length - 1));
    if (!confirmPressed()) return;
    pickCommand(COMMANDS[B.cursor]);    // SPECATTACK routes into beginSpec()
}

function itemInput(dt)
{
    B.itemCursor = navAxis(dt, 1, Math.max(1, B.items.length), B.itemCursor);
    if (backPressed()) { B.state = 'MENU_SELECT'; B.menuAnim = 1; return; }
    if (confirmPressed()) useItem(B.itemCursor);
}

///////////////////////////////////////////////////////////////////////////////
// per-frame update
///////////////////////////////////////////////////////////////////////////////

function update(dt)
{
    dt = typeof dt == 'number' && dt > 0 ? dt
        : typeof timeDelta == 'number' && timeDelta > 0 ? timeDelta : 1 / 60;
    if (B.state == 'IDLE') return;

    B.t += dt;
    B.toastLife = Math.max(0, B.toastLife - dt);
    B.enemyFlash = Math.max(0, B.enemyFlash - dt * 4);
    B.playerFlash = Math.max(0, B.playerFlash - dt * 4);
    B.enemyOx = lerpN(B.enemyOx, 0, Math.min(1, dt * 9));
    B.enemyOy = lerpN(B.enemyOy, 0, Math.min(1, dt * 9));

    switch (B.state)
    {
    case 'MENU_SELECT':
        B.menuAnim = Math.min(1, B.menuAnim + dt * 5);
        menuInput(dt);
        break;

    case 'ITEM_SELECT':
        B.menuAnim = Math.min(1, B.menuAnim + dt * 5);
        itemInput(dt);
        break;

    case 'SPEC_CHART':
        break;                                  // waiting on resolveSpec()

    case 'ZIGZAG_TRACE':
        updateZigzag(dt);
        break;

    case 'EXECUTE_COMMAND':
        phaseExec(dt);
        break;

    case 'ENEMY_TURN':
        phaseEnemy(dt);
        break;

    case 'SECTION_BREAK':
        phaseBreak(dt);
        break;

    case 'BATTLE_WON':
        B.phase += dt;
        B.menuAnim = Math.max(0, B.menuAnim - dt * 4);
        if (!B.ended && (confirmPressed() || (typeof mouseWasPressed == 'function' && mouseWasPressed(0))))
        { B.ended = true; finishBattle(true); }
        break;

    case 'BATTLE_LOST':
        B.phase += dt;
        B.menuAnim = Math.max(0, B.menuAnim - dt * 4);
        if (B.phase >= T.banner && !B.ended)
        { B.ended = true; finishBattle(false); }
        break;

    default:
        break;                                  // SECTION_PLAY: nothing to do
    }
}

function phaseExec(dt)
{
    B.phase += dt;
    if (!B.hitDone && B.phase >= T.execHit)
    {
        B.hitDone = true;
        if (B.pendingDmg > 0)
        {
            B.eHp = Math.max(0, B.eHp - B.pendingDmg);
            B.enemyFlash = 1;
            B.enemyOy = -26;                    // recoil upward
            spawnDamage(enemyScreenPos(),
                '-' + B.pendingDmg + (B.pendingCrit ? '!' : ''),
                B.pendingCrit ? pal().gold : pal().ink, B.pendingCrit ? 1.35 : 1);
            if (B.pendingCrit) toast('CRIT!', 0.7);
        }
    }
    if (B.phase >= T.exec)
    {
        if (B.eHp <= 0) { win(); return; }
        B.state = 'ENEMY_TURN';
        B.phase = 0; B.hitDone = false;
    }
}

function phaseEnemy(dt)
{
    B.phase += dt;
    if (B.phase < T.enemyHit)
    {
        // lean in toward the player while telegraphing
        const k = Math.sin(Math.min(1, B.phase / T.enemyHit) * Math.PI);
        B.enemyOy = 22 * k;
    }
    if (!B.hitDone && B.phase >= T.enemyHit)
    {
        B.hitDone = true;
        const raw = B.intent ? B.intent.power : 8;
        const totalDef = B.def + defBonus() + B.defTurn + B.defPersist;
        const taken = Math.max(1, Math.round(raw * (1 - B.reduction) - totalDef * 0.5));
        B.hp = Math.max(0, B.hp - taken);
        B.playerFlash = 1;
        spawnDamage(playerScreenPos(), '-' + taken, pal().bad, 1);
        toast((B.intent ? B.intent.name : 'ATTACK') + '!', 0.9);
        syncPlayer();
    }
    if (B.phase >= T.enemy)
    {
        if (B.hp <= 0) { lose(); return; }
        B.state = 'SECTION_BREAK';
        B.phase = 0;
    }
}

function phaseBreak(dt)
{
    B.phase += dt;
    B.menuAnim = Math.max(0, B.menuAnim - dt * 4);
    if (B.phase >= T.brk)
    {
        B.state = 'SECTION_PLAY';
        B.section++;
        if (B.onSection) B.onSection({ section: B.section, spec: false });
    }
}

///////////////////////////////////////////////////////////////////////////////
// floating damage numbers (EngineObject so the engine ticks/renders them)
///////////////////////////////////////////////////////////////////////////////

class FloatText extends EngineBase
{
    constructor(pos, text, color, scale)
    {
        super(vec2(), vec2(1), undefined, 0, typeof WHITE != 'undefined' ? WHITE : undefined, 50);
        this.p = pos && pos.copy ? pos.copy() : vec2(pos ? pos.x : 0, pos ? pos.y : 0);
        this.str = String(text);
        this.tint = color;
        this.scale = scale || 1;
        this.life = 0;
        this.mass = 0;                          // never falls out of the world
    }

    update()
    {
        const dt = typeof timeDelta == 'number' && timeDelta > 0 ? timeDelta : 1 / 60;
        this.life += dt / 1.05;
        if (this.life >= 1) this.destroy();
    }

    render()
    {
        if (typeof drawTextScreen != 'function') return;
        const a = clamp01(1 - Math.max(0, this.life - 0.55) / 0.45);
        const y = this.p.y - smooth(clamp01(this.life)) * 54;
        const pop = this.life < 0.15 ? 1 + (0.15 - this.life) * 3 : 1;
        const size = 30 * this.scale * pop;
        const P = pal();
        drawTextScreen(this.str, vec2(this.p.x, y), size, A(this.tint, a),
            4, A(P.bg, a * 0.85), 'center', fontOf(), '1px');
    }
}

function spawnDamage(pos, text, color, scale)
{
    try { return new FloatText(pos, text, color, scale); }
    catch (_) { return null; }
}

///////////////////////////////////////////////////////////////////////////////
// screen-space draw helpers (same conventions as hud.js)
///////////////////////////////////////////////////////////////////////////////

function textScreen(str, x, y, size, color, align, font, lineWidth, lineColor, spacing)
{
    if (typeof drawTextScreen != 'function') return;
    const P = pal();
    drawTextScreen(String(str), vec2(x, y), size, color,
        lineWidth || 0, lineColor || A(P.bg, 0.9),
        align || 'center', font || fontOf(), spacing || '', undefined, 0, undefined);
}

// chamfered neon panel — cut corners, dark glass, hot top edge
function panel(x, y, w, h, edge, cut)
{
    cut = cut == null ? Math.min(16, h * 0.28) : cut;
    const P = pal();
    const pts = [
        vec2(x + cut, y), vec2(x + w - cut, y), vec2(x + w, y + cut),
        vec2(x + w, y + h - cut), vec2(x + w - cut, y + h), vec2(x + cut, y + h),
        vec2(x, y + h - cut), vec2(x, y + cut),
    ];
    drawPoly(pts, A(P.panel, 0.9), 0, A(edge, 0.5), vec2(), 0, true, true);
    drawPoly(pts, A(P.bg, 0), 0, edge, vec2(), 0, true, true);
    drawLine(vec2(x + cut, y + 1), vec2(x + w - cut * 0.4, y + 1), 2, A(edge, 0.9), vec2(), 0, true, true);
    drawLine(vec2(x + 1, y + cut), vec2(x + 1, y + h - cut), 2, A(edge, 0.35), vec2(), 0, true, true);
}

function bar(x, y, w, h, v, fill)
{
    const P = pal();
    drawRect(vec2(x + w / 2, y + h / 2), vec2(w, h), A(P.bg, 0.8), 0, true, true);
    const f = clamp01(v) * w;
    if (f > 1)
    {
        drawRect(vec2(x + f / 2, y + h / 2), vec2(f, h), fill, 0, true, true);
        drawRect(vec2(x + f - 1.5, y + h / 2), vec2(3, h), A(P.ink, 0.9), 0, true, true);
    }
}

// zig-zag rule — the game's signature motif
function zigRule(x0, x1, y, steps, amp, width, color)
{
    const pts = [], dx = (x1 - x0) / steps;
    for (let i = 0; i <= steps; ++i)
        pts.push(vec2(x0 + i * dx, y + (i % 2 ? amp : -amp)));
    drawLineList(pts, width, color, false, vec2(), 0, true, true);
}

function polyPoints(center, radius, sides, angle)
{
    const pts = [];
    for (let i = 0; i < sides; ++i)
    {
        const a = angle + i * Math.PI * 2 / sides;
        pts.push(vec2(center.x + Math.cos(a) * radius, center.y + Math.sin(a) * radius));
    }
    return pts;
}

const enemyScreenPos = () => { const S = screenSize(); return vec2(S ? S.x / 2 : 0, (S ? S.y : 0) * 0.34); };
const playerScreenPos = () => { const S = screenSize(); return vec2((S ? S.x : 0) * 0.24, (S ? S.y : 0) * 0.62); };

///////////////////////////////////////////////////////////////////////////////
// rendering
///////////////////////////////////////////////////////////////////////////////

function render()
{
    if (B.state == 'IDLE' || !B.enemy) return;
    const S = screenSize();
    if (!S) return;
    const P = pal();

    // during the rhythm section itself only the slim enemy chip is drawn so
    // the play field stays readable
    if (B.state == 'SECTION_PLAY') { renderChip(S, P); return; }

    // dim the field behind the battle
    drawRect(vec2(S.x / 2, S.y / 2), S, A(P.bg, 0.62), 0, true, true);

    renderHeader(S, P);
    drawEnemy(S, P);

    // rule between combatants
    zigRule(-40, S.x + 40, S.y * 0.56, Math.max(12, Math.round(S.x / 44)), 6, 3, A(P.neon, 0.5));

    renderPlayerRow(S, P);

    if (B.state == 'MENU_SELECT') renderMenu(S, P);
    else if (B.state == 'ITEM_SELECT') renderItems(S, P);
    else if (B.state == 'SPEC_CHART') renderSpecBanner(S, P);
    else if (B.state == 'ZIGZAG_TRACE') renderZigzag(S, P);
    else if (B.state == 'EXECUTE_COMMAND') renderCommandFlash(S, P);
    else if (B.state == 'ENEMY_TURN') renderEnemyTurn(S, P);
    else if (B.state == 'BATTLE_WON' || B.state == 'BATTLE_LOST') renderBanner(S, P);

    renderToast(S, P);

    // red edge flash when the player is hit
    if (B.playerFlash > 0.01)
    {
        const a = A(P.bad, 0.35 * B.playerFlash), t = 14;
        drawRect(vec2(S.x / 2, t / 2), vec2(S.x, t), a, 0, true, true);
        drawRect(vec2(S.x / 2, S.y - t / 2), vec2(S.x, t), a, 0, true, true);
        drawRect(vec2(t / 2, S.y / 2), vec2(t, S.y), a, 0, true, true);
        drawRect(vec2(S.x - t / 2, S.y / 2), vec2(t, S.y), a, 0, true, true);
    }
}

function renderChip(S, P)
{
    const w = Math.min(260, S.x * 0.36), x = S.x - w - 16, y = 14;
    panel(x, y, w, 40, A(P.neon, 0.4), 12);
    textScreen(B.enemy.name, x + 14, y + 18, 12, A(P.dim, 0.95), 'left', fontOf(), 0, undefined, '1px');
    bar(x + 14, y + 24, w - 28, 8, B.eHp / B.eMaxHp, hpColor(B.eHp / B.eMaxHp));
}

function renderHeader(S, P)
{
    const x = 20, y = 16, w = S.x - 40;
    panel(x, y, w, 58, A(P.neon, 0.5), 16);

    textScreen(B.enemy.name, x + 20, y + 26, clampN(S.x * 0.028, 14, 24), P.ink,
        'left', fontOf(), 0, undefined, '2px');
    textScreen(Math.ceil(B.eHp) + ' / ' + B.eMaxHp, x + w - 20, y + 26, 15,
        A(P.dim, 0.95), 'right', fontOf());

    const ratio = B.eHp / B.eMaxHp;
    bar(x + 20, y + 38, w - 40, 12, ratio, hpColor(ratio));
}

function hpColor(ratio)
{
    const P = pal();
    return ratio > 0.5 ? P.good : ratio > 0.25 ? P.gold : P.bad;
}

function drawEnemy(S, P)
{
    const pos = enemyScreenPos();
    const bob = Math.sin(B.t * 2.2) * 6;
    const center = vec2(pos.x + B.enemyOx, pos.y + B.enemyOy + bob);
    const r = Math.max(34, Math.min(S.x, S.y) * 0.13);

    // aura
    if (typeof drawCircle == 'function')
    {
        drawCircle(center, r * 1.4, A(P.neon, 0.07 + B.enemyFlash * 0.25), 0,
            A(P.neon, 0), true, true);
        drawCircle(center, r * 1.15, A(P.cyan, 0.05), 0, A(P.cyan, 0.35), true, true);
    }

    // optional sprite texture (loaded via loadTexture when a path was given)
    const ti = B.texIndex != null && typeof textureInfos != 'undefined' &&
        typeof TileInfo != 'undefined' ? textureInfos[B.texIndex] : null;
    if (ti && ti.size && ti.size.x)
    {
        const flash = B.enemyFlash > 0.01 && typeof Color != 'undefined'
            ? new Color(1, 1, 1, 1) : undefined;
        try
        {
            drawTile(center, vec2(r * 2, r * 2), new TileInfo(vec2(), ti.size, ti),
                flash || WHITE, 0, false, undefined, true, true);
            return;
        }
        catch (_) { /* fall through to the procedural avatar */ }
    }

    // procedural neon avatar: hexagon body + glowing eyes + zig mouth
    const pts = polyPoints(center, r, 6, B.t * 0.25 + Math.PI / 6);
    drawPoly(pts, A(P.panel, 0.95), 0, B.enemyFlash > 0.01 ? P.ink : P.neon, vec2(), 0, true, true);
    drawPoly(polyPoints(center, r * 0.86, 6, B.t * 0.25 + Math.PI / 6),
        A(P.bg, 0.6), 0, A(P.cyan, 0.45), vec2(), 0, true, true);

    if (typeof drawCircle == 'function')
    {
        const eyeY = center.y - r * 0.12, eyeR = Math.max(3, r * 0.11);
        const angry = B.state == 'ENEMY_TURN' ? Math.sin(B.t * 22) * 1.5 : 0;
        drawCircle(vec2(center.x - r * 0.28, eyeY + angry), eyeR, A(P.cyan, 0.95), 0, A(P.bg, 0.8), true, true);
        drawCircle(vec2(center.x + r * 0.28, eyeY - angry), eyeR, A(P.cyan, 0.95), 0, A(P.bg, 0.8), true, true);
    }

    // zig mouth
    const my = center.y + r * 0.34, mw = r * 0.7, pts2 = [];
    for (let i = 0; i <= 4; ++i)
        pts2.push(vec2(center.x - mw / 2 + mw * i / 4, my + (i % 2 ? 4 : -4)));
    drawLineList(pts2, 2.5, A(P.neonSoft, 0.85), false, vec2(), 0, true, true);

    // name plate under the enemy
    textScreen(B.enemy.name, center.x, center.y + r + 26, clampN(S.x * 0.024, 12, 18),
        A(P.ink, 0.8), 'center', fontOf(), 0, undefined, '3px');
}

function renderPlayerRow(S, P)
{
    const y = S.y * 0.60, x = 20;
    const labelW = Math.min(S.x * 0.46, 340);

    textScreen('YOUR HP', x, y - 14, 12, A(P.dim, 0.95), 'left', fontOf(), 0, undefined, '1px');
    bar(x, y, labelW, 14, B.hp / B.maxHp, hpColor(B.hp / B.maxHp));
    textScreen(Math.ceil(B.hp) + ' / ' + B.maxHp, x + labelW + 12, y + 12, 16, P.ink,
        'left', fontOf());

    // score + derived stats on the right
    textScreen(String(Math.round(B.score)).padStart(6, '0'), S.x - 20, y + 2, 22, P.ink,
        'right', fontOf(), 0, undefined, '1px');
    textScreen('SCORE', S.x - 20, y - 14, 11, A(P.dim, 0.95), 'right', fontOf());
    textScreen('ATK +' + atkBonus() + '   DEF +' + (B.def + defBonus()) +
        '   CRIT ' + critChance() + '%', S.x - 20, y + 22, 12, A(P.cyan, 0.9),
        'right', fontOf());
}

function renderMenu(S, P)
{
    const slide = (1 - smooth(B.menuAnim)) * (S.y * 0.3);
    const x = 20, w = S.x - 40;
    const rows = Math.ceil(COMMANDS.length / 2);
    const h = Math.max(210, S.y * 0.34);
    const y = S.y - h - 18 + slide;

    panel(x, y, w, h, A(P.cyan, 0.45), 18);

    const pad = 14;
    const cw = (w - pad * 3) / 2, ch = (h - pad * (rows + 1)) / rows;
    const pulse = 0.5 + 0.5 * Math.sin(B.t * 5);

    for (let i = 0; i < COMMANDS.length; ++i)
    {
        const col = i % 2, row = Math.floor(i / 2);
        const bx = x + pad + col * (cw + pad), by = y + pad + row * (ch + pad);
        const sel = i == B.cursor;
        const edge = sel ? P.cyan : A(P.dim, 0.3);

        drawRect(vec2(bx + cw / 2, by + ch / 2), vec2(cw, ch),
            sel ? A(P.neon, 0.18 + pulse * 0.1) : A(P.bg, 0.45), 0, true, true);
        drawRect(vec2(bx + cw / 2, by + ch / 2), vec2(cw, ch),
            A(sel ? P.neon : P.panel, 0), 0, true, true);
        panel(bx, by, cw, ch, edge, 10);

        if (sel)
            textScreen('>', bx + 12, by + ch / 2 + 6, 20, P.cyan, 'left', fontOf());

        const disabled = COMMANDS[i] == 'USE_ITEM' && !B.items.length;
        textScreen(COMMANDS[i], bx + cw / 2 + (sel ? 8 : 0), by + ch / 2 + 6,
            clampN(cw * 0.13, 13, 20), disabled ? A(P.dim, 0.4) : (sel ? P.ink : A(P.dim, 0.95)),
            'center', fontOf(), 0, undefined, '1px');
    }

    // description strip for the highlighted command
    textScreen(DESC[COMMANDS[B.cursor]] || '', x + w / 2, y + h + 16,
        clampN(S.x * 0.02, 11, 15), A(P.neonSoft, 0.9), 'center', fontOf(true));
}

function renderItems(S, P)
{
    const slide = (1 - smooth(B.menuAnim)) * (S.y * 0.3);
    const x = 20, w = S.x - 40;
    const rows = Math.max(1, B.items.length);
    const h = Math.max(120, Math.min(S.y * 0.42, 60 + rows * 30 + 50));
    const y = S.y - h - 18 + slide;

    panel(x, y, w, h, A(P.gold, 0.5), 16);
    textScreen('ITEMS', x + 18, y + 24, 14, A(P.gold, 0.95), 'left', fontOf(), 0, undefined, '2px');

    if (!B.items.length)
    {
        textScreen('NO ITEMS — ESC TO GO BACK', x + w / 2, y + h / 2 + 8,
            clampN(S.x * 0.026, 13, 20), A(P.dim, 0.9), 'center', fontOf());
        return;
    }

    const rowH = 30, listY = y + 38;
    for (let i = 0; i < B.items.length; ++i)
    {
        const it = B.items[i], ry = listY + i * rowH, sel = i == B.itemCursor;
        if (sel)
            drawRect(vec2(x + w / 2, ry + rowH / 2 - 4), vec2(w - 36, rowH - 4),
                A(P.neon, 0.2), 0, true, true);
        const type = itemType(it), amt = itemAmount(it, type);
        const label = itemName(it) + (type == 'heal' ? '  +' + amt + ' HP'
            : type == 'def' ? '  DEF +' + amt : '  ' + amt + ' DMG');
        textScreen((sel ? '> ' : '  ') + label, x + 22, ry + rowH / 2 + 2, 16,
            sel ? P.ink : A(P.dim, 0.95), 'left', fontOf());
    }
    textScreen('ENTER use   ·   ESC back', x + w / 2, y + h - 14, 12,
        A(P.dim, 0.8), 'center', fontOf(true));
}

function renderSpecBanner(S, P)
{
    const pulse = 0.5 + 0.5 * Math.sin(B.t * 4);
    const y = S.y * 0.52;
    panel(S.x / 2 - Math.min(S.x * 0.42, 300), y - 34,
        Math.min(S.x * 0.84, 600), 68, A(P.violet, 0.5 + pulse * 0.4), 18);
    textScreen('SPEC CHART', S.x / 2, y - 4, clampN(S.x * 0.05, 22, 40), P.ink,
        'center', fontOf(), 6, A(P.bg, 0.85), '4px');
    textScreen('land 70%+ accuracy for x3 damage', S.x / 2, y + 22, 13,
        A(P.cyan, 0.9), 'center', fontOf(true));
}

function renderZigzag(S, P)
{
    const z = B.zigzag || { index: 0, started: false };
    const points = zigzagPoints(S), radius = Math.max(34, Math.min(52, S.x * .065));
    const w = Math.min(S.x * .9, 660), x = (S.x - w) / 2, y = S.y * .56;
    panel(x, y - 92, w, 184, A(P.violet, .8), 18);
    textScreen('TRACE THE ZIGZAG', S.x / 2, y - 62, clampN(S.x * .045, 19, 34), P.ink,
        'center', fontOf(), 5, A(P.bg, .9), '2px');
    textScreen(z.started ? 'KEEP HOLDING AND FOLLOW THE LIGHTS' : 'PRESS AND DRAG FROM THE LEFT LIGHT',
        S.x / 2, y - 38, clampN(S.x * .02, 11, 15), A(P.cyan, .95), 'center', fontOf(true));
    for (let i = 0; i < points.length - 1; i++)
        drawLine(points[i], points[i + 1], 6, A(i < z.index ? P.good : P.neon, .8), vec2(), 0, true, true);
    for (let i = 0; i < points.length; i++)
    {
        const active = i === z.index || (!z.started && i === 0);
        drawCircle(points[i], radius * .43, A(active ? P.gold : (i < z.index ? P.good : P.bg), .95),
            0, 4, A(active ? P.ink : P.cyan, .95), true, true);
        textScreen(String(i + 1), points[i].x, points[i].y + 6, 18, P.bg, 'center', fontOf());
    }
    textScreen('5 seconds · trace all five lights for a triple attack', S.x / 2, y + 70,
        clampN(S.x * .018, 10, 14), A(P.dim, .95), 'center', fontOf(true));
}

function renderCommandFlash(S, P)
{
    const a = clamp01(1.4 - B.phase / T.exec);
    const pop = 1 + Math.max(0, 0.25 - B.phase) * 1.6;
    textScreen(B.pendingLabel || B.lastCommand, S.x / 2, S.y * 0.52,
        clampN(S.x * 0.06 * pop, 26, 56), A(P.ink, a),
        'center', fontOf(), 7, A(P.bg, a * 0.85), '3px');
    if (B.lastCommand == 'DEFEND' || B.lastCommand == 'DEFAULT')
        textScreen(B.lastCommand == 'DEFAULT' ? 'GUARDING — DEFENSE BANKED' : 'GUARDING',
            S.x / 2, S.y * 0.52 + 26, 14, A(P.cyan, a), 'center', fontOf(true));
}

function renderEnemyTurn(S, P)
{
    const a = clamp01(1.6 - B.phase / T.enemy);
    const name = B.intent ? B.intent.name : 'ATTACK';
    const power = B.intent ? B.intent.power : 8;
    textScreen('ENEMY USES ' + name + '!', S.x / 2, S.y * 0.50,
        clampN(S.x * 0.045, 20, 40), A(P.bad, a),
        'center', fontOf(), 6, A(P.bg, a * 0.85), '2px');
    textScreen('POWER ' + power +
        (B.reduction > 0 ? '   ·   GUARDED' : B.reduction < 0 ? '   ·   EXPOSED!' : ''),
        S.x / 2, S.y * 0.50 + 26, 14, A(P.gold, a * 0.95), 'center', fontOf(true));
}

function renderBanner(S, P)
{
    const won = B.state == 'BATTLE_WON';
    const k = clamp01(B.phase / 0.35);
    textScreen(won ? 'VICTORY!' : 'DEFEATED', S.x / 2, S.y * 0.46,
        clampN(S.x * 0.09 * (0.6 + 0.4 * k), 30, 80), won ? P.gold : P.bad,
        'center', fontOf(), 8, A(P.bg, 0.9), '4px');
    textScreen(won
        ? (B.newItems.length ? 'LOOT: ' + B.newItems.map(itemName).join(' · ') : 'THE PATH CLEARS')
        : 'THE ZIGZAG GOES ON...', S.x / 2, S.y * 0.46 + 34, clampN(S.x * 0.026, 12, 20),
        A(P.ink, 0.85), 'center', fontOf(true));
    if (won)
    {
        const gx = S.x / 2, gateY = S.y * .66, gateW = Math.min(76, S.x * .2), gateH = 82;
        const left = gx - gateW / 2, right = gx + gateW / 2;
        const top = gateY - gateH / 2, bottom = gateY + gateH / 2;
        drawRect(vec2(gx, gateY), vec2(gateW - 14, gateH - 12), A(P.violet, .58), 0, true, true);
        drawLine(vec2(left, bottom), vec2(left, top + 12), 6, A(P.good, .95), vec2(), 0, true, true);
        drawLine(vec2(right, bottom), vec2(right, top + 12), 6, A(P.good, .95), vec2(), 0, true, true);
        const roof = [vec2(left, top + 12), vec2(gx - gateW*.24, top + 2), vec2(gx - gateW*.08, top + 12),
            vec2(gx + gateW*.08, top + 2), vec2(gx + gateW*.24, top + 12), vec2(right, top + 12)];
        drawLineList(roof, 6, A(P.good, .95), false, vec2(), 0, true, true);
        drawLine(vec2(left, bottom), vec2(right, bottom), 5, A(P.good, .9), vec2(), 0, true, true);

        const gy = S.y * .82, gw = Math.min(250, S.x * .78), gh = 58;
        panel((S.x - gw) / 2, gy - gh / 2, gw, gh, A(P.good, .8), 12);
        textScreen('EXIT GATE OPEN', S.x / 2, gy - 4, clampN(S.x * .03, 15, 22), P.good,
            'center', fontOf(), 3, A(P.bg, .9), '1px');
        textScreen('[ ENTER OR CLICK TO EXIT ]', S.x / 2, gy + 18, clampN(S.x * .018, 10, 14), P.ink,
            'center', fontOf(true));
    }
}

function renderToast(S, P)
{
    if (B.toastLife <= 0 || !B.toast) return;
    const a = clamp01(B.toastLife * 2);
    const pop = 1 + Math.max(0, 0.12 - (1 - B.toastLife)) * 1.5;
    textScreen(B.toast, S.x / 2, S.y * 0.66, clampN(S.x * 0.034 * pop, 16, 30),
        A(P.gold, a), 'center', fontOf(), 5, A(P.bg, a * 0.85), '2px');
}

///////////////////////////////////////////////////////////////////////////////
// public surface
///////////////////////////////////////////////////////////////////////////////

window.Battle = {
    COMMANDS: COMMANDS.slice(),
    start, update, render, isActive, pickCommand,
    // extras for the play / results states
    getState, openMenu, isSpecChart, resolveSpec, setPerformance, stop,
    getEnemy: () => B.enemy ? { name: B.enemy.name, hp: B.eHp, maxHp: B.eMaxHp } : null,
    getPlayer: () => ({ hp: B.hp, maxHp: B.maxHp, items: B.items.slice() }),
    getCommands: () => COMMANDS.slice(),
    getCommandDesc: cmd => DESC[String(cmd || '').toUpperCase()] || '',
    getIntent: () => B.intent,
    getStats: () => ({
        atk: baseAttack(), atkBonus: atkBonus(),
        def: B.def + defBonus() + B.defTurn + B.defPersist,
        critChance: critChance(),
    }),
};
window.ZZ = window.ZZ || {};
window.ZZ.Battle = window.Battle;

})();
