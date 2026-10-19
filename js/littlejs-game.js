///////////////////////////////////////////////////////////////////////////////
// ZIGZAG SYNTH — littlejs-game.js
// Engine init, the title → world → play → results state machine, and the
// rhythm gameplay (LittleJS port — the old DOM rhythm core lives on as stubs
// in js/gameplay.js / js/input.js).
//
// PLAY INPUT MODEL (locked):
//   LEFT / RIGHT  press+hold to start & sustain HOLD notes; tap to hit TAPs
//   UP            flick: tap during a HOLD's flick window (the ↑ on the bar)
//   DOWN          swap the active lane between BOTTOM (blue, left) and
//                 TOP (orange, right); CENTER notes can be hit from either
///////////////////////////////////////////////////////////////////////////////

let state = 'title';
let chart = null, notes = [];
let songTime = 0, songStart = 0;
let score = 0, combo = 0, maxCombo = 0, best = 0, hits = 0;
let counts = [0, 0, 0, 0];
let flash = 0, flashColor, shake = 0, judgeLinePulse = 0;
let camDive = null;         // {t, dur, fromPos, fromScale, toPos, toScale}
let pendingState = null;
let muted = false;

// ---- play-state ------------------------------------------------------------
let activeLane = 'bottom';              // 'bottom' (blue, lower band) | 'top' (orange, upper band)
let laneFlash = { top: 0, bottom: 0, center: 0 };   // per-band hit glow
let laneSwapPulse = 0;                  // little kick when DOWN swaps lanes
let songMeta = { title: '', artist: '' };
let playResult = null;                  // last-run summary for the results screen
let audioArmed = false, audioStarted = false, audioFailed = false;

// ---- battle mode (see js/battle.js) ----------------------------------------
// Entered only via window.ZZ.startBattle(enemyId, def) (called by overworld.js
// at an arena gate). While battleMode is true the play state alternates
// between frozen command-menu phases (Battle drives itself) and rhythm
// "sections" that slice the song into segments.
//
// SECTION TIMING: one section = 8 bars = 32 beats of the chart's bpm,
// clamped to [12, 30] s. A section past the chart's end runs at most 8 s
// (a silent drum-break) so the fight can always conclude.
//
// SPEC CHART (MVP): SPECATTACK plays the next section's notes as a detached
// bonus burst — lanes mirrored (top<->bottom) with an off-beat double tap on
// the opposite lane inserted after each tap — on a synthetic clock while the
// audio stays paused. Judgments feed the normal score/combo; the burst's
// accuracy is handed to Battle.resolveSpec(). The real section is untouched.
//
// LOSS: onBattleEnd(lost) -> results screen with the run's rhythm stats
// (hudResults shows STAGE MISS); the player's HP is restored for the next
// fight. WIN: ZZ.onEnemyDefeated(enemyId) unlocks the gate, then results.
let battleMode = false;
let battleEnemyId = null, battleEnemyConfig = null;
let battlePlayer = null;                    // persistent across fights this session
let battleSectionLen = 20, battleSectionIndex = 0;
let battleSectionStart = 0, battleSectionEnd = 0;
let battleSpecActive = false, battleSpecEnd = 0;
let battleSpecCounts = null;                // counts[] snapshot before a spec burst
let battleNormalNotes = null;               // the untouched chart notes during spec

// the three ZAG gate wardens (overworld.js passes {enemy, label, enemyName...})
const WARDENS = {
    warden_north: { name: 'NORTH WARDEN', hp: 130, sprite: '',
        attacks: [{ name: 'FROST RING', power: 10 }, { name: 'POLAR SLAM', power: 14 }],
        drops: ['ICE SIGIL'] },
    warden_west:  { name: 'WEST WARDEN',  hp: 120, sprite: '',
        attacks: [{ name: 'GUST KICK', power: 9 }, { name: 'TEMPEST', power: 13 },
                  { name: 'TAILWIND', power: 7 }],
        drops: ['STORM CORE'] },
    warden_east:  { name: 'EAST WARDEN',  hp: 150, sprite: '',
        attacks: [{ name: 'EMBER CLAW', power: 12 }, { name: 'SOLAR FLARE', power: 16 }],
        drops: ['SUN SHARD'] },
};

// tunables for the stage (kept here so data.js stays untouched)
const PLAY = {
    fallTime: 1.6,          // seconds a note takes from spawn to its hit line
    fallSpan: 6.5,          // world units a note drops from spawn down to its band line
    bandHeight: 2.2,        // height of one lane band (the bands stack, they don't sit side by side)
    bandWidth: 11.5,        // width of the play field the bands span
    hitWindow: .15,         // outer judgment window; finer grades from DATA.judgments
    countdown: 2.2,         // lead-in seconds before songTime hits 0
    colors: {
        top:      '#ff9a2e',   // orange neon (TOP lane)
        bottom:   '#3ea6ff',   // blue neon   (BOTTOM lane)
        center:   '#c8a6ff',   // CENTER notes — neutral, hittable from either lane
        miss:     '#ff4d5e',
    },
};

// the two lanes are stacked VERTICALLY: TOP rides the upper band of the play
// field, BOTTOM the lower band, and CENTER sits between them. DATA.laneY is
// [bottom, top]; a missing entry falls back to these defaults.
const LANE_Y = DATA.laneY || [-2.5, 2.5];
const laneY = lane => lane == 'top' ? LANE_Y[1]
                    : lane == 'bottom' ? LANE_Y[0] : 0;

// theme-aware lane color (themes.js may override via ZZ.theme.laneTop/laneBottom)
function playLaneColor(lane)
{
    const th = typeof ZZ != 'undefined' && ZZ.theme || null;
    if (lane == 'top')    return col(th && th.laneTop    || PLAY.colors.top);
    if (lane == 'bottom') return col(th && th.laneBottom || PLAY.colors.bottom);
    return col(PLAY.colors.center);
}

// world y of a note in `lane` whose chart time is t: it falls from above its
// band, down through the band, and crosses that band's horizontal hit line
// at laneY(lane) exactly on the beat
const noteY = (t, lane) => laneY(lane) + PLAY.fallSpan *
    clamp((t - songTime) / PLAY.fallTime, -0.3, 1);

const r3 = x => Math.round(x * 1000) / 1000;

///////////////////////////////////////////////////////////////////////////////
// state machine
///////////////////////////////////////////////////////////////////////////////

// queue a transition; it is applied in gameUpdatePost so no object is ever
// destroyed in the middle of its own update
function setState(next) { pendingState = next; }

function transitionTo(next)
{
    // make sure the song audio never outlives the play state
    if (state == 'play' && next != 'play' && typeof ZZ != 'undefined' && ZZ.Audio)
        ZZ.Audio.stop();

    // leaving play by any path other than a live battle tears the fight down
    // (the onBattleEnd path already cleared battleMode before queuing results)
    if (next != 'play' && battleMode)
    {
        battleMode = false;
        battleSpecActive = false;
        battleNormalNotes = null;
        if (typeof Battle != 'undefined' && Battle.isActive()) Battle.stop();
    }

    engineObjectsDestroy();
    state = next;
    player = null;
    camDive = null;

    if (next == 'title')
    {
        cameraPos = vec2();
        cameraScale = DATA.playCamScale;
    }
    else if (next == 'world')
    {
        initWorld();                        // fresh hub, spawn by the portal
        cameraPos = player.pos.copy();
        cameraScale = DATA.world.camScale;
    }
    else if (next == 'play')
    {
        // entering play any way other than ZZ.startBattle must not inherit a
        // stale battle from a previous run (ZZ.startBattle arms battleMode
        // before queueing this transition)
        if (!battleMode && typeof Battle != 'undefined' && Battle.isActive())
            Battle.stop();
        startSong();
        camDive = { t:0, dur:.45, fromPos: cameraPos.copy(), fromScale: cameraScale,
            toPos: vec2(), toScale: DATA.playCamScale };
    }
    else if (next == 'results')
    {
        // keep the hub glowing behind the panel, and glide back to the player
        const fromPos = cameraPos.copy(), fromScale = cameraScale;
        initWorld();
        camDive = { t:0, dur:.55, fromPos, fromScale,
            toPos: player.pos.copy(), toScale: DATA.world.camScale };
    }
}

// called by the portal (see overworld.js)
function enterStage()
{
    if (state != 'world') return;
    audioUnlock();
    flash = 1;
    flashColor = DATA.c.ink;
    shake = .35;
    setState('play');
}

///////////////////////////////////////////////////////////////////////////////
// engine callbacks
///////////////////////////////////////////////////////////////////////////////

function gameInit()
{
    canvasClearColor = DATA.c.bg.copy();
    showSplashScreen = false;
    touchGamepadEnable = false;         // the hub uses tap-to-move instead
    setFontDefault(DATA.ui.soft);
    setSoundVolume(DATA.volume);        // the synth is the whole soundtrack
    flashColor = DATA.c.ink;
    hudInit();

    const save = readSaveData(SAVE_KEY, {}) || {};
    best = save.best || 0;

    transitionTo('title');
}

function gameUpdate()
{
    hudUpdate();

    flash = Math.max(0, flash - timeDelta*2.6);
    shake = Math.max(0, shake - timeDelta*3.2);
    judgeLinePulse = Math.max(0, judgeLinePulse - timeDelta*7);

    // global hotkeys
    if (keyWasPressed('KeyM'))
    {
        muted = !muted;
        setSoundVolume(muted ? 0 : DATA.volume);
    }

    if (state == 'title')
    {
        if (keyWasPressed('Space') || keyWasPressed('Enter') || keyWasPressed('NumpadEnter') ||
            mouseWasPressed(0))
        {
            audioUnlock();
            flash = .8; flashColor = DATA.c.neon;
            setState('world');
        }
    }
    else if (state == 'world')
    {
        // World state delegates ALL input/logic/rendering to overworld.js
        // owUpdate(dt): called each frame, handles its own input
        // owRender(): called each frame, handles its own rendering
        // owHandleKey(key, down): optional direct key events from engine
        if (typeof owUpdate == 'function') owUpdate(timeDelta);
        if (typeof owRender == 'function') owRender();
        owPollWorldKeys();
    }
    else if (state == 'play')
    {
        playUpdate();
    }
    else if (state == 'results')
    {
        if (keyWasPressed('Space') || keyWasPressed('Enter') || keyWasPressed('NumpadEnter') ||
            mouseWasPressed(0))
        {
            flash = .6; flashColor = DATA.c.cyan;
            setState('world');
        }
    }

    updateCamera();
}

// optional key-event bridge for overworld.js: forwards edge transitions of the
// common keys to owHandleKey(key, down) when overworld.js defines it.
// Inert today — overworld objects poll keyIsDown/keyWasPressed themselves.
const owKeyPrev = {};
function owPollWorldKeys()
{
    if (typeof owHandleKey != 'function') return;
    for (const k of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',
                     'Space','Enter','KeyW','KeyA','KeyS','KeyD'])
    {
        const down = keyIsDown(k);
        if (down != (owKeyPrev[k] || false))
        {
            owKeyPrev[k] = down;
            owHandleKey(k, down);
        }
    }
}

function gameUpdatePost()
{
    if (pendingState)
    {
        const next = pendingState;
        pendingState = null;
        transitionTo(next);
    }
}

function gameRender()
{
    if (state == 'play') renderStage();
}

function gameRenderPost()
{
    if      (state == 'title')   hudTitle();
    else if (state == 'world')   hudWorld();
    else if (state == 'play')
    {
        hudPlay();
        // battle UI lands on top of the HUD while a fight is running
        // (during SECTION_PLAY Battle only draws its slim enemy-HP chip)
        if (battleMode && typeof Battle != 'undefined' && Battle.isActive())
            Battle.render();
    }
    else if (state == 'results') hudResults();
}

///////////////////////////////////////////////////////////////////////////////
// camera
///////////////////////////////////////////////////////////////////////////////

function updateCamera()
{
    const W = DATA.world;

    if (camDive)
    {
        camDive.t += timeDelta / camDive.dur;
        const k = clamp(camDive.t), e = k*k*(3 - 2*k);      // smoothstep
        cameraPos = camDive.fromPos.lerp(camDive.toPos, e);
        cameraScale = lerp(camDive.fromScale, camDive.toScale, e);
        if (camDive.t >= 1) camDive = null;
    }
    else if (state == 'world' && player)
    {
        // soft follow with a look-ahead in the direction of travel, and a
        // whisper of zoom-out the faster you move
        const lead = player.vel.scale(W.camLead / W.speed);
        cameraPos = cameraPos.lerp(player.pos.add(lead), W.camLerp);
        cameraScale = lerp(cameraScale, W.camScale - player.vel.length()*.16, .06);
        cameraPos = clampCamera(cameraPos);
    }
    else if (state == 'play')
    {
        cameraPos = vec2();
        cameraScale = DATA.playCamScale;
    }

    if (shake > .001)
        cameraPos = cameraPos.add(vec2(rand(-1, 1), rand(-1, 1)).scale(shake));
}

// keep the view inside the hub (or centred when the window is bigger than it)
function clampCamera(p)
{
    const half = mainCanvasSize.scale(.5 / cameraScale);
    const axis = (v, size, halfSize)=> size <= halfSize*2 ? 0
        : clamp(v, -size/2 + halfSize, size/2 - halfSize);
    return vec2(axis(p.x, WORLD_W, half.x), axis(p.y, WORLD_H, half.y));
}

///////////////////////////////////////////////////////////////////////////////
// rhythm core — chart building + the play state
//
// Chart JSON schema (v0):
//   { format:'zigzag-level', version:0, title, artist, author, audio,
//     bpm, offsetMs, difficulty, notes:[{t, lane, type, dur?, flicks?}], length }
//   lane: 'top' | 'bottom' | 'center'   type: 'tap' | 'hold'
//   t / flicks[] / dur are seconds from audio start (offset already applied)
///////////////////////////////////////////////////////////////////////////////

function startSong()
{
    chart = buildPlayChart();
    notes = chart.notes.map(n=> new PlayNote(n));

    activeLane = 'bottom';
    score = 0; combo = 0; maxCombo = 0; hits = 0;
    counts = [0, 0, 0, 0];
    HUD.scoreShown = 0;
    songMeta = { title: chart.title, artist: chart.artist };
    playResult = null;
    laneFlash.top = laneFlash.bottom = laneFlash.center = 0;
    laneSwapPulse = 0;

    // audio through the friend system's HTMLAudioElement wrapper (file:// safe)
    audioArmed = false; audioStarted = false; audioFailed = false;
    if (chart.song && typeof ZZ != 'undefined' && ZZ.Audio)
    {
        ZZ.Audio.unlock();
        ZZ.Audio.load(chart.song, err=>
        {
            audioArmed = !err && state == 'play';
            if (err) audioFailed = true;
        });
        ZZ.Audio.onEnded(()=> { if (state == 'play') endSong(); });
    }

    songStart = time + PLAY.countdown;
    songTime = -PLAY.countdown;

    // battle runs arm the fight here — the menu appears immediately over the
    // countdown and the song clock only starts on the first SECTION_PLAY
    if (battleMode) battleBeginRun();
}

// pick a song from ZZ.Songs, generate a friend chart and map it into the v0
// two-lane schema; falls back to a built-in demo chart when nothing is loaded
function buildPlayChart()
{
    const Z = typeof ZZ != 'undefined' ? ZZ : null;
    const songs = Z && Z.Songs && Z.Songs.list || [];
    const song = songs.find(s=> s.status != 'error') || null;
    const bpm = song ? song.bpm : DATA.bpm;
    const offset = song ? song.offset || 0 : 0;

    let raw = null;
    if (song && Z.Chart && song.duration > 2)
    {
        const diff = Z.Settings && Z.Settings.get ? Z.Settings.get('difficulty') : 'normal';
        raw = Z.Chart.generate({ songId: song.id, bpm, duration: song.duration,
            difficulty: Z.Chart.DIFFS[diff] ? diff : 'normal',
            seed: (Z.Settings && Z.Settings.get ? Z.Settings.get('seed') : '') || 'zigzag',
            offset });
    }

    const mapped = (raw ? raw.notes.map(mapFriendNote) : makeDemoChart(bpm, offset).notes)
        .filter(Boolean).sort((a, b)=> a.t - b.t);
    const last = mapped[mapped.length - 1];
    const length = last ? last.t + (last.dur || 0) + 1.5 : 24;

    return {
        format: 'zigzag-level', version: 0,
        title:  song ? song.name  : 'Zigzag Etude',
        artist: song ? 'ID ' + song.id : 'demo chart',
        author: 'auto',
        audio:  song ? song.url : '',
        bpm, offsetMs: offset * 1000,
        difficulty: 'NORMAL',
        notes: mapped, length,
        song,   // live ZZ.Songs entry (null => silent demo on the game clock)
    };
}

// friend 4-lane chart note -> v0 note:
//   lane 0/2 => bottom, lane 1/3 => top (the zigzag alternates sides)
//   hold     => hold with a flick break in the middle when it's long
//   drag     => CENTER hold; each node past the first becomes an UP flick
function mapFriendNote(n)
{
    const lane = n.lane % 2 ? 'top' : 'bottom';
    if (n.type == 'hold')
    {
        const dur = Math.max(.2, n.end - n.t);
        return { t: r3(n.t), lane, type: 'hold', dur: r3(dur),
            flicks: dur >= 1.4 ? [r3(n.t + dur*.5)] : [] };
    }
    if (n.type == 'drag')
    {
        const flicks = (n.nodes || []).slice(1).map(nd=> r3(nd.t));
        return { t: r3(n.t), lane: 'center', type: 'hold',
            dur: r3(Math.max(.2, n.end - n.t)), flicks };
    }
    return { t: r3(n.t), lane, type: 'tap' };
}

// built-in fallback chart (no usable song/generator): a short zigzag etude
// with a couple of holds + flicks so every mechanic shows up
function makeDemoChart(bpm, offset)
{
    const beat = 60 / bpm, notes = [];
    let t = Math.max(offset, 0) + Math.ceil(2.0 / beat) * beat;
    for (let i = 0; i < 40; ++i, t += beat*.5)
    {
        const lane = i % 4 == 3 ? 'center' : i % 2 ? 'top' : 'bottom';
        if (i > 3 && i % 10 == 6)
        {
            const dur = beat*2;
            notes.push({ t: r3(t), lane, type: 'hold', dur: r3(dur),
                flicks: [r3(t + dur*.5)] });
            t += dur;
        }
        else
            notes.push({ t: r3(t), lane, type: 'tap' });
    }
    return { notes };
}

// per-frame play logic: lane swap, song clock, input, note bookkeeping
function playUpdate()
{
    // the battle lane owns the whole play update while a fight is running
    if (battleMode) { battlePlayUpdate(); return; }

    // ---- lane swap (DOWN) --------------------------------------------------
    if (keyWasPressed('ArrowDown'))
    {
        activeLane = activeLane == 'bottom' ? 'top' : 'bottom';
        laneSwapPulse = 1;
        if (typeof ZZ != 'undefined' && ZZ.Audio) ZZ.Audio.sfx('tick');
    }
    laneSwapPulse = Math.max(0, laneSwapPulse - timeDelta*3);

    songClock();
    for (const k in laneFlash) laneFlash[k] = Math.max(0, laneFlash[k] - timeDelta*4);

    // ---- taps & hold starts (LEFT / RIGHT) ---------------------------------
    if (keyWasPressed('ArrowLeft') || keyWasPressed('ArrowRight'))
        tryStartHit();

    // ---- flicks (UP) during an active hold ---------------------------------
    if (keyWasPressed('ArrowUp'))
        tryFlick();

    // ---- per-note bookkeeping (scroll, misses, hold progress) --------------
    for (const n of notes) n.tick();

    if (songTime > chart.length) endSong();
}

// drive songTime: friend's audio element when ready, else the game clock
function songClock()
{
    if (!audioStarted)
    {
        songTime = time - songStart;
        if (songTime >= 0 && audioArmed && !audioFailed)
        {
            audioStarted = true;
            const p = ZZ.Audio.play();
            if (p && p.catch)
                p.catch(()=> {                 // autoplay blocked — run silent
                    audioFailed = true; audioStarted = false;
                    songStart = time; songTime = 0;
                });
        }
        else if (songTime > .6 && chart.song && !audioArmed)
            audioFailed = true;                // audio never became ready — stay on the clock
    }
    else if (!audioFailed)
        songTime = ZZ.Audio.now();
}

// a fresh LEFT/RIGHT press: hit the nearest pending TAP, or start a HOLD
function tryStartHit()
{
    let target = null, bestDist = PLAY.hitWindow + 1e-4;
    for (const n of notes)
    {
        if (n.state != 'pending') continue;
        if (n.lane != 'center' && n.lane != activeLane) continue;
        const d = Math.abs(n.t - songTime);
        if (d < bestDist) { bestDist = d; target = n; }
    }
    if (!target) return;

    if (target.type == 'tap')
    {
        target.state = 'done';
        judgeUnit(judgmentIndex(bestDist), target);
    }
    else
    {
        target.state = 'holding';           // head judged now, tail over the next dur seconds
        judgeUnit(judgmentIndex(bestDist), target);
    }
}

// an UP press: satisfy the nearest pending flick on any active hold
function tryFlick()
{
    for (const n of notes)
        if (n.state == 'holding')
            for (const f of n.flicks)
                if (!f.done && Math.abs(f.t - songTime) <= PLAY.hitWindow)
                {
                    f.done = true;
                    n.flickFlash = 1;
                    judgeUnit(0, n);        // flicks are PERFECT-tier on the beat
                    return;
                }
}

// timing distance -> judgment index into DATA.judgments (0 perfect .. 2 good)
function judgmentIndex(dist)
{
    for (let i = 0; i < DATA.judgments.length - 1; ++i)
        if (dist <= DATA.judgments[i].window) return i;
    return DATA.judgments.length - 2;
}

// shared judge: score, combo, HUD pops, bursts. q = 3 is MISS.
// silent = count only (used for the leftover units of a broken hold)
function judgeUnit(q, note, silent)
{
    const j = DATA.judgments[q];
    counts[q]++;

    if (q < DATA.judgments.length - 1)
    {
        score += j.score + combo * DATA.comboBonus;
        combo++;
        if (combo > maxCombo) maxCombo = combo;
        hits++;
        if (!silent)
        {
            synthNote(DATA.penta[hits % 5]);
            hudJudge(j.name, DATA.c.judge[q]);
            if (combo > 1) hudCombo();
        }
        if (note)
        {
            note.hitFlash = 1;
            laneFlash[note.lane] = 1;
            spawnBurst(note.pos.x, note.pos.y, playLaneColor(note.lane));
        }
        flash = Math.max(flash, q === 0 ? .35 : .2);
        shake = Math.max(shake, q === 0 ? .1 : .05);
        judgeLinePulse = 1;
    }
    else
    {
        combo = 0;
        if (note)
        {
            note.missFlash = 1;
            laneFlash[note.lane] = Math.max(laneFlash[note.lane], .5);
            spawnBurst(note.pos.x, laneY(note.lane), col(PLAY.colors.miss));
        }
        flash = Math.max(flash, .25);
        shake = Math.max(shake, .12);
        if (!silent) hudJudge(j.name, DATA.c.judge[3]);
    }
}

function endSong()
{
    if (state != 'play') return;

    // a battle run never ends on its own: an exhausted / ended song just
    // closes the current rhythm section early — the fight decides the exit
    if (battleMode)
    {
        if (typeof Battle != 'undefined' && Battle.getState() == 'SECTION_PLAY')
            battleSectionEnds();
        return;
    }

    if (typeof ZZ != 'undefined' && ZZ.Audio) ZZ.Audio.stop();

    const acc = runAccuracy();
    playResult = {
        title: songMeta.title, artist: songMeta.artist,
        score, maxCombo, counts: counts.slice(), accuracy: acc,
        grade: acc >= .95 ? 'S' : acc >= .9 ? 'A' : acc >= .8 ? 'B' : acc >= .7 ? 'C' : 'D',
    };

    if (score > best)
    {
        best = score;
        writeSaveData(SAVE_KEY, { best, lastRun: playResult });
    }
    setState('results');
}

// weighted accuracy of the run so far, 0..1 (perfect=1, great=.75, good=.4)
function runAccuracy()
{
    const judged = counts[0] + counts[1] + counts[2] + counts[3];
    return judged ? (counts[0] + counts[1]*.75 + counts[2]*.4) / judged : 0;
}

///////////////////////////////////////////////////////////////////////////////
// battle integration — window.ZZ.startBattle + the battle-mode play flow
//
// Full loop (see the battle-mode note at the top of this file):
//   ZZ.startBattle -> setState('play') -> startSong -> Battle.start
//   (menu over the countdown) -> command -> enemy turn -> SECTION_PLAY
//   (rhythm segment, clock runs) -> section end -> openMenu -> repeat
//   SPECATTACK -> detached spec burst -> resolveSpec -> command phases
//   onBattleEnd: win -> ZZ.onEnemyDefeated + results; loss -> results
///////////////////////////////////////////////////////////////////////////////

// called by overworld.js at an arena gate: (enemyId, doorDef) where doorDef
// is { tile, worlds, enemy, label, enemyName }
if (typeof ZZ == 'undefined') window.ZZ = {};
window.ZZ.startBattle = function (enemyId, def)
{
    // guard double-starts: one fight at a time, world state only
    if (state != 'world') return false;
    if (battleMode || (typeof Battle != 'undefined' && Battle.isActive())) return false;

    const base = WARDENS[enemyId] || WARDENS.warden_north;
    def = def || {};
    battleEnemyId = WARDENS[enemyId] ? enemyId : 'warden_north';
    battleEnemyConfig = {
        name: def.enemyName || def.label || base.name,   // display info from the door
        hp: base.hp, maxHp: base.hp,
        attacks: base.attacks,
        sprite: def.sprite || base.sprite || '',
        drops: base.drops,
    };

    battleMode = true;
    audioUnlock();
    flash = 1; flashColor = DATA.c.ink;
    shake = .35;
    setState('play');
    return true;
};

// OG DOM menu <-> engine handoff: menu.js calls these when the player picks
// Play (or navigates back out), toggling body.zz-lane so the DOM screens step
// aside for the LittleJS canvas.
window.ZZ.LaneMenuPlay = function () {
    audioUnlock();
    flash = 1;
    flashColor = DATA.c.ink;
    setState('play');
    return true;
};
window.ZZ.LaneMenuExit = function () {
    audioUnlock();
    flash = .6;
    flashColor = DATA.c.cyan;
    setState('title');
};

// the playerState object Battle mutates in place (hp / items / score written
// back); persists across fights within the session, re-seeded from a shared
// inventory if another lane provides ZZ.inventory
function battlePlayerState()
{
    if (battlePlayer) return battlePlayer;
    const inv = typeof ZZ != 'undefined' && ZZ.inventory || null;
    battlePlayer = {
        hp: 100, maxHp: 100,
        weapons: (inv && inv.weapons) || [{ name: 'ZIGZAG FISTS', power: 6 }],
        weaponIndex: 0,
        items: (inv && inv.items) ? inv.items.slice() : ['POTION'],
        def: 0,
    };
    return battlePlayer;
}

// called from startSong(): size the sections and open the fight
function battleBeginRun()
{
    if (typeof Battle == 'undefined') { battleMode = false; return; }
    const p = battlePlayerState();
    const bpm = chart.bpm || DATA.bpm;
    battleSectionLen = clamp(32 * 60 / bpm, 12, 30);   // 8 bars = 32 beats
    battleSectionIndex = 0;
    battleSectionStart = 0;
    battleSectionEnd = battleSectionLen;
    battleSpecActive = false;
    battleNormalNotes = null;

    Battle.start(battleEnemyConfig, p, battleOnEnd, {
        onSectionStart: battleOnSectionStart,
        performance: { score, accuracy: runAccuracy(), combo },
    });
}

// per-frame driver — replaces playUpdate entirely while battleMode is true
function battlePlayUpdate()
{
    if (typeof Battle == 'undefined' || !Battle.isActive())
    {
        // the fight vanished under us (hot-reload / hard stop) — wrap up
        battleMode = false;
        endSong();
        return;
    }

    // live rhythm performance feeds the battle's score/DEF bonuses
    // (def items buff B.def inside battle.js; we don't stomp it here)
    Battle.setPerformance({ score, accuracy: runAccuracy(), combo });
    Battle.update(timeDelta);

    // spec burst: the harder detached chart is the only thing ticking
    if (Battle.isSpecChart()) { battleSpecUpdate(); return; }

    // normal rhythm section: run the song clock + note input/bookkeeping
    if (Battle.getState() == 'SECTION_PLAY')
    {
        battleClock(timeDelta);

        // lane swap (DOWN)
        if (keyWasPressed('ArrowDown'))
        {
            activeLane = activeLane == 'bottom' ? 'top' : 'bottom';
            laneSwapPulse = 1;
            if (typeof ZZ != 'undefined' && ZZ.Audio) ZZ.Audio.sfx('tick');
        }
        laneSwapPulse = Math.max(0, laneSwapPulse - timeDelta*3);

        // taps / hold starts / flicks
        if (keyWasPressed('ArrowLeft') || keyWasPressed('ArrowRight')) tryStartHit();
        if (keyWasPressed('ArrowUp')) tryFlick();

        for (const k in laneFlash) laneFlash[k] = Math.max(0, laneFlash[k] - timeDelta*4);
        for (const n of notes) n.tick();

        if (songTime >= battleSectionEnd) battleSectionEnds();
        return;
    }

    // MENU_SELECT / ITEM_SELECT / EXECUTE_COMMAND / ENEMY_TURN / SECTION_BREAK /
    // BATTLE_WON / BATTLE_LOST: song clock and notes stay frozen, the field
    // remains visible behind Battle's own overlay
}

// battle-mode song clock: audio-driven when playing, accumulated while the
// audio is paused (menus) or absent (silent run)
function battleClock(dt)
{
    if (audioStarted && !audioFailed && typeof ZZ != 'undefined' && ZZ.Audio)
        songTime = ZZ.Audio.now();
    else
    {
        songTime += dt;
        if (songTime >= 0 && audioArmed && !audioFailed && typeof ZZ != 'undefined' && ZZ.Audio)
        {
            audioStarted = true;
            const p = ZZ.Audio.play();
            if (p && p.catch)
                p.catch(()=> { audioFailed = true; audioStarted = false; });
        }
    }
}

// a rhythm section ran out (its time is up, or the song/audio ended):
// pause the audio and hand control back to the battle menu
function battleSectionEnds()
{
    if (audioStarted && !audioFailed && typeof ZZ != 'undefined' && ZZ.Audio)
        ZZ.Audio.pause();
    battleSectionIndex++;
    battleSectionStart = battleSectionEnd;
    // sections past the chart's end are short silent drum-breaks (<= 8 s)
    const len = battleSectionStart >= chart.length - .1
        ? Math.min(battleSectionLen, 8) : battleSectionLen;
    battleSectionEnd = battleSectionStart + len;
    Battle.openMenu();
}

// Battle's onSectionStart — drives our clock / chart per the battle phase
function battleOnSectionStart(info)
{
    if (info && info.spec) { battleStartSpec(); return; }

    // (re)start the next normal rhythm section at the frozen song position
    battleSpecActive = false;
    if (audioStarted && !audioFailed && typeof ZZ != 'undefined' && ZZ.Audio)
    {
        // resume the paused track exactly where the section was cut
        ZZ.Audio.seek(Math.max(0, battleSectionStart));
        const pr = ZZ.Audio.play();
        if (pr && pr.catch) pr.catch(()=> { audioFailed = true; });
    }
    else
        songTime = battleSectionStart;      // silent run: snap the clock
}

// SPECATTACK: play the next section's notes as a harder detached burst —
// mirrored lanes + an off-beat double tap after every tap — on a synthetic
// clock while the audio stays paused. The real section is left untouched.
function battleStartSpec()
{
    const t0 = battleSectionStart, t1 = t0 + battleSectionLen;
    const beat = 60 / (chart.bpm || DATA.bpm);
    const spec = [];
    for (const n of chart.notes)
    {
        if (n.t < t0 - 1e-4 || n.t >= t1) continue;
        const lane = n.lane == 'top' ? 'bottom' : n.lane == 'bottom' ? 'top' : 'center';
        spec.push({ t: r3(n.t), lane, type: n.type, dur: n.dur, flicks: n.flicks });
        if (n.type == 'tap')       // off-beat double on the opposite lane
            spec.push({ t: r3(n.t + beat*.5),
                lane: n.lane == 'center' ? 'center' : lane, type: 'tap' });
    }
    spec.sort((a, b)=> a.t - b.t);

    battleNormalNotes = notes;               // stash the untouched chart notes
    battleSpecCounts = counts.slice();
    notes = spec.map(n=> { const p = new PlayNote(n); p.isSpec = true; return p; });
    battleSpecActive = true;
    battleSpecEnd = spec.length
        ? spec.reduce((m, n)=> Math.max(m, n.t + (n.dur || 0)), 0) + PLAY.hitWindow + .25
        : t0 + PLAY.hitWindow + .25;
    songTime = t0 - 1.2;                     // synthetic lead-in on the game clock
}

// per-frame spec burst: detached silent clock, same input model as play
function battleSpecUpdate()
{
    songTime += timeDelta;
    laneSwapPulse = Math.max(0, laneSwapPulse - timeDelta*3);
    for (const k in laneFlash) laneFlash[k] = Math.max(0, laneFlash[k] - timeDelta*4);

    if (keyWasPressed('ArrowDown'))
    {
        activeLane = activeLane == 'bottom' ? 'top' : 'bottom';
        laneSwapPulse = 1;
    }
    if (keyWasPressed('ArrowLeft') || keyWasPressed('ArrowRight')) tryStartHit();
    if (keyWasPressed('ArrowUp')) tryFlick();
    for (const n of notes) n.tick();

    if (songTime >= battleSpecEnd && Battle.isSpecChart())
    {
        // every spec note has resolved — hand the burst's accuracy over
        const d = [0, 0, 0, 0];
        for (let i = 0; i < 4; ++i) d[i] = counts[i] - battleSpecCounts[i];
        const judged = d[0] + d[1] + d[2] + d[3];
        const acc = judged ? (d[0] + d[1]*.75 + d[2]*.4) / judged : 0;

        for (const n of notes) n.destroy();
        notes = battleNormalNotes || [];
        battleNormalNotes = null;
        battleSpecActive = false;
        songTime = battleSectionStart;       // back to the real song position
        Battle.resolveSpec(acc);             // >=70% => x3 damage (battle.js)
    }
}

// Battle's onBattleEnd — fired once, from the win/lose banner
function battleOnEnd(result)
{
    const won = !!(result && result.won);
    if (battlePlayer)
    {
        battlePlayer.hp = Math.max(1, result && result.playerHp || battlePlayer.hp);
        if (won && result && result.newItems && result.newItems.length)
            battlePlayer.items = battlePlayer.items.concat(result.newItems);
        if (!won) battlePlayer.hp = battlePlayer.maxHp;    // respawn for the next fight
    }
    if (typeof ZZ != 'undefined' && ZZ.Audio) ZZ.Audio.stop();

    const id = battleEnemyId;
    battleEnemyId = null; battleEnemyConfig = null;
    battleMode = false;
    battleSpecActive = false;
    battleNormalNotes = null;

    if (won && typeof ZZ != 'undefined' && typeof ZZ.onEnemyDefeated == 'function')
        ZZ.onEnemyDefeated(id);             // unlocks the gate (overworld.js)

    finishBattleRun(won);
}

// win or lose, the run's rhythm stats land on the results screen
function finishBattleRun(won)
{
    const acc = runAccuracy();
    playResult = {
        title: songMeta.title, artist: songMeta.artist,
        score, maxCombo, counts: counts.slice(), accuracy: acc,
        grade: !won ? 'F'
            : acc >= .95 ? 'S' : acc >= .9 ? 'A' : acc >= .8 ? 'B' : acc >= .7 ? 'C' : 'D',
        battle: true, won,
    };
    if (won && score > best)
    {
        best = score;
        writeSaveData(SAVE_KEY, { best, lastRun: playResult });
    }
    setState('results');
}

///////////////////////////////////////////////////////////////////////////////
// the play note — a tap tile or an elongated hold bar with flick arrows
///////////////////////////////////////////////////////////////////////////////

class PlayNote extends EngineObject
{
    constructor(n)
    {
        super(vec2(0, laneY(n.lane) + PLAY.fallSpan), vec2(2.2, 2.2), undefined, 0, WHITE, 10);
        this.t = n.t;
        this.lane = n.lane;                 // 'top' | 'bottom' | 'center'
        this.type = n.type;                 // 'tap' | 'hold'
        this.dur = n.dur || 0;
        this.flicks = (n.flicks || []).map(t=> ({ t, done: false }));
        this.state = 'pending';             // pending -> holding -> done | broken | missed
        this.isSpec = !!n.spec;             // spec-burst note (battle mode)
        this.hitFlash = 0;                  // white pop after a hit
        this.missFlash = 0;                 // red pop after a miss
        this.flickFlash = 0;                // extra glow when a flick connects
        this.mass = 0;
    }

    get endTime() { return this.t + this.dur; }

    tick()
    {
        this.hitFlash = Math.max(0, this.hitFlash - timeDelta*4);
        this.missFlash = Math.max(0, this.missFlash - timeDelta*3);
        this.flickFlash = Math.max(0, this.flickFlash - timeDelta*5);

        // scroll position — an active hold pins its head to its band's hit line
        let y = noteY(this.t, this.lane);
        if (this.state == 'holding') y = Math.max(y, laneY(this.lane));
        this.pos.x = 0;
        this.pos.y = y;

        if (this.state == 'pending')
        {
            // slid past the window with no press => miss
            if (songTime > this.t + DATA.judgments[DATA.judgments.length - 2].window)
            {
                this.state = 'missed';
                judgeUnit(3, this);
            }
            return;
        }

        if (this.state == 'holding')
        {
            // released early — everything left on the note counts as a miss
            if (!keyIsDown('ArrowLeft') && !keyIsDown('ArrowRight'))
            {
                this.state = 'broken';
                judgeUnit(3, this, false);                  // the head gap — shown
                for (const f of this.flicks)
                    if (!f.done)
                    {
                        f.done = true;
                        judgeUnit(3, this, true);           // leftovers — count only
                    }
                return;
            }

            // flicks that slid by unanswered
            for (const f of this.flicks)
                if (!f.done && songTime > f.t + PLAY.hitWindow)
                {
                    f.done = true;
                    judgeUnit(3, this);                     // shown: teaches the UP timing
                }

            if (songTime >= this.endTime)
            {
                this.state = 'done';
                judgeUnit(1, this);                         // held to the end — GREAT
            }
        }
    }

    render()
    {
        if (state != 'play') return;
        // during a spec burst only the spec notes draw; during normal battle
        // sections the (destroyed) spec notes are gone and these stay visible
        if (battleSpecActive && !this.isSpec) return;
        const gone = this.state == 'done' || this.state == 'broken' || this.state == 'missed';
        if (gone && this.hitFlash <= .01 && this.missFlash <= .01) return;
        if (this.state == 'pending' && this.t + this.dur - songTime > PLAY.fallTime + .1) return;

        const C = DATA.c, x = this.pos.x, hitY = laneY(this.lane);
        const mine = this.lane == 'center' || this.lane == activeLane;
        const base = playLaneColor(this.lane);
        const dim = base.scale(.25);                        // dark when the lane is off
        let c = mine ? base : dim;
        if (gone) c = dim.scale(.7);
        const w = 2.3;

        if (this.type == 'tap')
        {
            const p = vec2(x, noteY(this.t, this.lane));
            const hot = clamp(1 - Math.abs(songTime - this.t)*2.2, 0, 1);

            setAdditiveBlendMode(true);
            drawRect(p, vec2(w + 1.4, 1.9), alpha(c, .07 + hot*.13));
            setAdditiveBlendMode(false);

            drawRect(p, vec2(w, 1.2), c);
            drawRect(p.add(vec2(0, .34)), vec2(w*.86, .12), alpha(C.ink, .55));
            drawRect(p.add(vec2(0, -.34)), vec2(w*.86, .08), alpha(C.bg, .6));
            drawRect(p, vec2(.16, 1.2), alpha(C.bg, .7));

            if (hot > .01)
            {
                setAdditiveBlendMode(true);
                drawCircle(p, .45 + hot*.45, alpha(C.ink, .1*hot));
                setAdditiveBlendMode(false);
            }
        }
        else // hold: an elongated bar + head cap + ↑ flick arrows
        {
            const yHead = this.state == 'holding' ? Math.max(noteY(this.t, this.lane), hitY)
                                                  : noteY(this.t, this.lane);
            const yTail = noteY(this.endTime, this.lane);
            const h = Math.max(.25, yHead - yTail);
            const mid = vec2(x, (yHead + yTail) * .5);

            // the bar
            const barA = (mine ? .42 : .14) + (this.state == 'holding' ? .25 : 0);
            drawRect(mid, vec2(1.15, h), alpha(c, barA));
            drawRect(mid, vec2(.42, h), alpha(c, Math.min(1, barA + .3)));

            // hold-active glow along the bar
            if (this.state == 'holding')
            {
                setAdditiveBlendMode(true);
                drawRect(mid, vec2(1.9, h), alpha(c, .1 + .05*sin(time*9)));
                setAdditiveBlendMode(false);
            }

            // tail cap
            drawRect(vec2(x, yTail), vec2(2.0, .5), c);
            drawRect(vec2(x, yTail), vec2(.5, .5), alpha(C.bg, .5));

            // flick arrows (↑) riding the bar
            for (const f of this.flicks)
            {
                if (f.done) continue;
                const p = vec2(x, noteY(f.t, this.lane));
                if (p.y > yHead + .3 || p.y < yTail - .3) continue;
                const hot = clamp(1 - Math.abs(songTime - f.t)*2.2, 0, 1);
                if (hot > .01)
                {
                    setAdditiveBlendMode(true);
                    drawCircle(p, .5 + hot*.5, alpha(C.ink, .12*hot));
                    setAdditiveBlendMode(false);
                }
                drawRegularPoly(p.add(vec2(0, .16)), vec2(.5 + hot*.1), 3,
                    alpha(C.ink, .95), .04, alpha(C.bg, .8), PI/2);
                drawRect(p.add(vec2(0, -.16)), vec2(.13, .34), alpha(C.ink, .9));
            }

            // head
            if (this.state != 'holding')
            {
                drawRect(vec2(x, yHead), vec2(w, 1.2), c);
                drawRect(vec2(x, yHead + .34), vec2(w*.86, .12), alpha(C.ink, .55));
                drawRect(vec2(x, yHead - .34), vec2(w*.86, .08), alpha(C.bg, .6));
            }
            else
            {
                // held head pinned at the band line, glowing brighter while held
                setAdditiveBlendMode(true);
                drawRect(vec2(x, hitY), vec2(w + 1.2, 1.9), alpha(c, .14 + .06*sin(time*8)));
                setAdditiveBlendMode(false);
                drawRect(vec2(x, hitY), vec2(w, 1.2), alpha(C.ink, .9));
                drawRect(vec2(x, hitY), vec2(w*.7, .9), c);
            }
        }

        // hit = white flash, miss = red flash
        const p = vec2(x, this.type == 'hold' && this.state == 'holding'
            ? hitY : noteY(this.t, this.lane));
        if (this.hitFlash > .01)
        {
            setAdditiveBlendMode(true);
            drawRect(p, vec2(w + .8, 1.7), alpha(col('#ffffff'), this.hitFlash*.75));
            setAdditiveBlendMode(false);
        }
        if (this.missFlash > .01)
        {
            setAdditiveBlendMode(true);
            drawRect(p, vec2(w + .8, 1.7), alpha(col(PLAY.colors.miss), this.missFlash*.6));
            setAdditiveBlendMode(false);
        }
        if (this.flickFlash > .01)
        {
            setAdditiveBlendMode(true);
            drawCircle(p, .6 + this.flickFlash*.5, alpha(C.ink, .2*this.flickFlash));
            setAdditiveBlendMode(false);
        }
    }
}

///////////////////////////////////////////////////////////////////////////////
// the stage: backdrop, the two stacked lane bands, the per-band hit lines,
// the countdown
///////////////////////////////////////////////////////////////////////////////

function renderStage()
{
    const C = DATA.c, S = mainCanvasSize;

    // backdrop
    drawRectGradient(vec2(S.x/2, S.y/2), S, C.bgTop, C.bgBot, 0, true, true);

    const bandW = PLAY.bandWidth, bandH = PLAY.bandHeight;

    // ---- lane bands: bright when active, dark when not ---------------------
    for (const lane of ['bottom', 'top'])
    {
        const y = laneY(lane), on = activeLane == lane;
        const base = playLaneColor(lane);
        const fl = laneFlash[lane];

        // the band bed — a horizontal strip across the whole play field
        drawRect(vec2(0, y), vec2(bandW, bandH),
            alpha(base, (on ? .085 : .03) + fl*.1));

        // edge rails along the top and bottom of the band
        for (const s of [-1, 1])
            drawRect(vec2(0, y + s*bandH*.5), vec2(bandW, .07),
                alpha(base, on ? .45 : .14));

        // active-band glow sitting on the band's hit line
        if (on)
        {
            setAdditiveBlendMode(true);
            drawRect(vec2(0, y), vec2(bandW, bandH*1.35 + laneSwapPulse*.7),
                alpha(base, .06 + .035*sin(time*3) + fl*.22 + laneSwapPulse*.1));
            setAdditiveBlendMode(false);
        }
    }

    // faint centre band (CENTER notes live here; either lane can hit them)
    drawRect(vec2(0, laneY('center')), vec2(bandW, bandH*.72),
        alpha(playLaneColor('center'), .035));

    // ---- the hit lines: one horizontal line per band -----------------------
    const p = judgeLinePulse;
    for (const lane of ['bottom', 'center', 'top'])
    {
        const y = laneY(lane);
        const lc = playLaneColor(lane);
        const k = lane == 'center' ? .45 : (activeLane == lane ? 1 : .55);
        drawRect(vec2(0, y), vec2(bandW, .5 + p*.25), alpha(C.neon, .1*k + p*.2));
        drawRect(vec2(0, y), vec2(bandW, .16), alpha(C.ink, .5 + p*.45*k));
        drawRect(vec2(0, y), vec2(bandW, .05), alpha(lc, k));
        for (const s of [-1, 1])
            drawRegularPoly(vec2(s*(bandW/2 - .2), y), vec2(.8 + p*.25), 4,
                alpha(C.neon, .9*k), .07, C.ink, PI/4);
    }

    // ---- key hints, tucked into the left of each band -----------------------
    for (const lane of ['bottom', 'top'])
    {
        const y = laneY(lane), on = activeLane == lane, base = playLaneColor(lane);
        drawText(lane == 'top' ? 'TOP' : 'BOT', vec2(-bandW*.5 + 1.1, y + .12),
            .5, alpha(base, on ? .95 : .4), .04, alpha(C.bg, .85), 'left', DATA.ui.font);
        drawText('L R', vec2(-bandW*.5 + 1.1, y - .64), .36,
            alpha(C.dim, on ? .8 : .35), 0, 0, 'left', DATA.ui.soft);
    }
    drawText('↓ SWAP', vec2(bandW*.5 - 1.1, laneY('center') + .12), .42,
        alpha(C.ink, .5 + laneSwapPulse*.45), .03, alpha(C.bg, .85), 'right', DATA.ui.font);
    drawText('↑ FLICK', vec2(bandW*.5 - 1.1, laneY('center') - .62), .32,
        alpha(C.dim, .65), 0, 0, 'right', DATA.ui.soft);

    // song title chip while the chart warms up
    if (songMeta.title && songTime < 2.6)
        drawText(songMeta.title, vec2(0, 7.2), .85,
            alpha(C.ink, clamp(1.1 - Math.max(0, songTime)*.35)), .05, alpha(C.bg, .8),
            'center', DATA.ui.font);

    // countdown before the chart starts
    if (songTime < 1.1)
    {
        const k = Math.ceil(-songTime + .2);
        const label = k > 0 ? String(Math.min(k, Math.ceil(PLAY.countdown))) : 'GO!';
        const pop = 1 - mod(-songTime + .2, 1);
        drawText(label, vec2(0, 4.7), 1.6 + pop*.6, alpha(C.ink, .9), .1, C.bg,
            'center', DATA.ui.font);
    }
}

// a hit splash: particles plus an expanding ring
function spawnBurst(x, y, color)
{
    new ParticleEmitter(vec2(x, y), 0, .3, .4, 40, PI, undefined,
        color, DATA.c.ink, alpha(color, 0), alpha(DATA.c.ink, 0),
        .5, .16, .03, .05, .04, .9, 1, 0, PI, .3, .5, false, true);
    new HitRing(vec2(x, y), color);
}

class HitRing extends EngineObject
{
    constructor(pos, color)
    {
        super(pos, vec2(4), undefined, 0, WHITE, 30);
        this.ringColor = color;
        this.life = 0;
        this.mass = 0;
    }
    update()
    {
        this.life += timeDelta / .38;
        if (this.life >= 1) this.destroy();
    }
    render()
    {
        const a = 1 - this.life, s = 1.4 + this.life*4.2;
        drawEllipse(this.pos, vec2(s, s*.62), alpha(this.ringColor, 0), 0, .18*a, alpha(this.ringColor, a));
        drawEllipse(this.pos, vec2(s*.68, s*.44), alpha(this.ringColor, 0), 0, .1*a, alpha(DATA.c.ink, a*.7));
    }
}

///////////////////////////////////////////////////////////////////////////////
// boot
///////////////////////////////////////////////////////////////////////////////

engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost);
