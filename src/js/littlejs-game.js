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
let health = 100;
let counts = [0, 0, 0, 0];
let flash = 0, flashColor, shake = 0, judgeLinePulse = 0;
let camDive = null;         // {t, dur, fromPos, fromScale, toPos, toScale}
let pendingState = null;
let muted = false;
let worldInputLockFrames = 0;

// ---- play-state ------------------------------------------------------------
let activeLane = 'bottom';              // 'bottom' (blue, left) | 'top' (orange, right)
let laneFlash = { top: 0, bottom: 0, center: 0 };   // per-column hit glow
let laneSwapPulse = 0;                  // little kick when DOWN swaps lanes
let songMeta = { title: '', artist: '' };
let playResult = null;                  // last-run summary for the results screen
let audioArmed = false, audioStarted = false, audioFailed = false;
let selectedSong = null, selectedStageLevel = null, stageNotice = '', stageEntering = false, stageAudioPrimed = false;
let fourLaneMode = false, playPaused = false, worldPaused = false, battlePaused = false, lastLanePressed = 0;
let activeJudgmentWindows = [0.060, 0.110, 0.160];
let noteConnections = null;
let gameProgress = { unlocked: 1, cleared: [], highScores: {}, defeatedEnemies: {} };
let battlePlayer = { hp: 100, maxHp: 100, weapons: [{ name: 'Rhythm Blade', power: 18 }], weaponIndex: 0,
    items: [{ name: 'Pocket Chorus', type: 'heal', amount: 28 }], score: 0, def: 0, accuracy: 0, combo: 0 };
const playInputQueue = [];
const playSimulation = { step: 1/240, accumulator: 0, measuredTPS: 0, tickCount: 0, sampleAt: 0, droppedTicks: 0 };

const FOUR_LANE_X = [-5.25, -1.75, 1.75, 5.25];
const FOUR_LANE_COLORS = ['#3ea6ff', '#62e6c5', '#ff9a2e', '#f07bdb'];

// tunables for the stage (kept here so data.js stays untouched)
const PLAY = {
    fallTime: 1.6,          // seconds a note takes from spawn to the hit line
    lineY: -5,              // hit line world y (near centre-bottom of the view)
    topY: 7,                // where notes spawn
    hitWindow: .15,         // outer judgment window; finer grades from DATA.judgments
    laneWidth: 4.8,         // width of one lane column
    countdown: 2.2,         // lead-in seconds before songTime hits 0
    colors: {
        top:      '#ff9a2e',   // orange neon (TOP lane)
        bottom:   '#3ea6ff',   // blue neon   (BOTTOM lane)
        center:   '#c8a6ff',   // CENTER notes — neutral, hittable from either lane
        miss:     '#ff4d5e',
    },
};

// lane column world-x: bottom on the left, top on the right, center between
const laneX = lane => Number.isInteger(lane) ? FOUR_LANE_X[Math.max(0, Math.min(3, lane))]
                    : lane == 'top' ? DATA.laneX[1]
                    : lane == 'bottom' ? DATA.laneX[0] : 0;

// theme-aware lane color (themes.js may override via ZZ.theme.laneTop/laneBottom)
function playLaneColor(lane)
{
    const th = typeof ZZ != 'undefined' && ZZ.theme || null;
    if (Number.isInteger(lane)) {
        const palette = th ? [th.tap, th.hold, th.drag, (th.particles || [])[3] || th.path] : null;
        return col(palette && palette[lane] || FOUR_LANE_COLORS[lane] || PLAY.colors.center);
    }
    if (lane == 'top')    return col(th && (th.laneTop || th.hold) || PLAY.colors.top);
    if (lane == 'bottom') return col(th && (th.laneBottom || th.tap) || PLAY.colors.bottom);
    return col(th && th.path || PLAY.colors.center);
}

// world y of a note whose chart time is t (scrolls top → bottom toward the line)
const noteY = t => lerp(PLAY.topY, PLAY.lineY,
    clamp(1 - (t - songTime) / PLAY.fallTime, 0, 1));

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
        worldPaused = false;
        initWorld();                        // fresh hub, spawn by the portal
        cameraPos = player.pos.copy();
        cameraScale = DATA.world.camScale;
    }
    else if (next == 'battle')
    {
        worldPaused = false;
        cameraPos = vec2();
        cameraScale = DATA.playCamScale;
    }
    else if (next == 'play')
    {
        startSong();
        const playScale = chart && chart.fourLane ? Math.min(DATA.playCamScale, mainCanvasSize.x / 15) : DATA.playCamScale;
        camDive = { t:0, dur:.45, fromPos: cameraPos.copy(), fromScale: cameraScale,
            toPos: vec2(), toScale: playScale };
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
async function enterStage()
{
    if (state != 'world' || stageEntering) return;
    stageEntering = true;
    audioUnlock();
    flash = 1;
    flashColor = DATA.c.ink;
    shake = .35;
    const list = typeof ZZ != 'undefined' && ZZ.Songs && ZZ.Songs.list || [];
    selectedSong = selectedSong || list.find(song => song.id > 0 && song.status != 'error') || null;
    selectedStageLevel = null;
    stageNotice = '';
    stageAudioPrimed = false;
    let audioStart = null, audioStartError = null;
    try {
        if (!selectedSong || selectedSong.id < 1) throw new Error('Choose a numbered stage first.');
        if (!window.LevelFormatV1) throw new Error('The stage file reader is missing.');
        if (!ZZ || !ZZ.Audio || typeof ZZ.Audio.load != 'function') throw new Error('The audio player did not load.');
        ZZ.Audio.unlock();
        const requestedPlayback = ZZ.Audio.load(selectedSong, () => {}, true);
        if (!requestedPlayback || !requestedPlayback.then) throw new Error('This browser cannot start the stage audio.');
        audioStart = requestedPlayback.then(() => true, error => { audioStartError = error; return false; });
        const stageId = selectedSong.id;
        const filename = 'stage' + stageId + '.level';
        const embeddedLevels = window.ZIGZAG_INLINE_ASSETS && window.ZIGZAG_INLINE_ASSETS.levels;
        let levelText;
        if (embeddedLevels) {
            levelText = embeddedLevels[filename];
            if (typeof levelText !== 'string') throw new Error(filename + ' is missing from the embedded game data. Rebuild index.html.');
        } else {
            const response = await fetch('levels/' + filename, { cache: 'no-store' });
            if (!response.ok) throw new Error(response.status === 404 ? filename + ' was not found.' : filename + ' returned HTTP ' + response.status + '.');
            levelText = await response.text();
        }
        const parsed = LevelFormatV1.parse(levelText);
        if (!parsed.valid) throw new Error(parsed.errors.join(' '));
        if (parsed.level.stage !== stageId) throw new Error(filename + ' contains stage ' + parsed.level.stage + '.');
        const associatedSong = list.find(song => song.file === parsed.level.song);
        if (!associatedSong) throw new Error('The stage names "' + parsed.level.song + '", which is not in the song list.');
        if (associatedSong.file !== selectedSong.file)
            throw new Error(filename + ' is linked to ' + associatedSong.file + ', but the selected stage uses ' + selectedSong.file + '.');
        selectedSong = associatedSong;
        selectedStageLevel = parsed.level;
        if (parsed.migrated) stageNotice = parsed.notice;
        const started = await audioStart;
        if (!started) throw audioStartError || new Error('The browser did not start the stage music.');
        stageAudioPrimed = !!(ZZ.Audio && ZZ.Audio.isPlaying());
        if (!stageAudioPrimed) throw new Error('The browser did not start the stage music. Try entering the portal again.');
    } catch (error) {
        if (ZZ && ZZ.Audio) ZZ.Audio.stop();
        stageAudioPrimed = false;
        stageEntering = false;
        const localFileHint = location.protocol === 'file:' && !window.ZIGZAG_INLINE_ASSETS ? ' Open the generated standalone index.html, or publish the whole project as a static site.' : '';
        if (ZZ.Menu && ZZ.Menu.showOverlay)
            ZZ.Menu.showOverlay('error', 'Could not start this stage: ' + error.message + localFileHint);
        return;
    }
    stageEntering = false;
    setState('play');
}

function cycleSelectedSong(direction)
{
    const list = typeof ZZ != 'undefined' && ZZ.Songs && ZZ.Songs.list || [];
    const songs = list.filter(song => song.id > 0 && song.status != 'error' && canStartStage(song.id));
    if (!songs.length) return;
    let index = songs.findIndex(song => selectedSong && song.file === selectedSong.file);
    if (index < 0) index = 0;
    index = (index + direction + songs.length) % songs.length;
    selectedSong = songs[index];
    selectedStageLevel = null;
    stageNotice = '';
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
    bindLevelCompletionDialogs();

    const save = readSaveData(SAVE_KEY, {}) || {};
    best = save.best || 0;
    const storedProgress = ZZ.Storage && ZZ.Storage.get('progress', null);
    if (storedProgress && typeof storedProgress == 'object')
        gameProgress = { unlocked: Math.max(1, storedProgress.unlocked | 0),
            cleared: Array.isArray(storedProgress.cleared) ? storedProgress.cleared.filter(Number.isInteger) : [],
            highScores: storedProgress.highScores && typeof storedProgress.highScores == 'object' ? storedProgress.highScores : {},
            defeatedEnemies: storedProgress.defeatedEnemies && typeof storedProgress.defeatedEnemies == 'object' ? storedProgress.defeatedEnemies : {} };
    ZZ.defeatedEnemies = Object.assign({}, gameProgress.defeatedEnemies);

    const songList = typeof ZZ != 'undefined' && ZZ.Songs && ZZ.Songs.list || [];
    selectedSong = songList.find(song => song.id > 0 && song.status != 'error') || null;
    if (window.ZIGZAG_EDITOR_MODE && typeof ZZ != 'undefined' && ZZ.LevelEditor) {
        fourLaneMode = true;
        if (ZZ.LevelEditor.onGameReady) ZZ.LevelEditor.onGameReady();
        transitionTo('play');
    } else {
        transitionTo('title');
        const autoPause = () => { if (state == 'play' && !playPaused) togglePlayPause(); };
        window.addEventListener('blur', autoPause);
        document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });
    }
}

function canStartStage(stage)
{
    const id = Number(stage);
    return Number.isInteger(id) && (id < 0 || id > 0 && id <= gameProgress.unlocked);
}

function saveGameProgress()
{
    if (ZZ.Storage) ZZ.Storage.set('progress', gameProgress);
}

function recordStageResult(result)
{
    const stage = selectedSong && selectedSong.id;
    if (!Number.isInteger(stage) || stage < 1) return;
    const current = gameProgress.highScores[stage] || { score: 0, grade: '—' };
    if (result.score > current.score)
        gameProgress.highScores[stage] = { score: result.score, grade: result.grade, accuracy: result.accuracy };
    const cleared = result.counts[0] + result.counts[1] + result.counts[2] > 0;
    if (!result.failed && cleared && !gameProgress.cleared.includes(stage)) gameProgress.cleared.push(stage);
    if (!result.failed && cleared) gameProgress.unlocked = Math.max(gameProgress.unlocked, stage + 1);
    saveGameProgress();
}

function bindLevelCompletionDialogs()
{
    const complete = document.getElementById('ov-level-complete');
    const download = document.getElementById('ov-stage-download');
    if (!complete || !download || complete.dataset.bound) return;
    complete.dataset.bound = '1';
    const close = () => { complete.classList.remove('on'); download.classList.remove('on'); };
    document.getElementById('level-complete-close').addEventListener('click', () => complete.classList.remove('on'));
    document.getElementById('level-download').addEventListener('click', () => {
        document.getElementById('game-download-stage').value = selectedStageLevel ? selectedStageLevel.stage : 1;
        complete.classList.remove('on');
        download.classList.add('on');
        updateGameDownloadPreview();
    });
    document.getElementById('game-download-stage').addEventListener('input', updateGameDownloadPreview);
    document.getElementById('game-download-cancel').addEventListener('click', () => download.classList.remove('on'));
    document.getElementById('game-download-confirm').addEventListener('click', downloadCompletedLevel);
    document.getElementById('level-copy').addEventListener('click', async () => {
        if (!selectedStageLevel || !window.LevelFormatV1) return;
        const json = LevelFormatV1.toJSON(selectedStageLevel);
        try {
            await navigator.clipboard.writeText(json);
            document.getElementById('level-complete-title').textContent = 'Copied complete level JSON';
        } catch (error) {
            const box = document.createElement('textarea'); box.value = json;
            box.style.position = 'fixed'; box.style.opacity = '0'; document.body.appendChild(box);
            box.select(); const copied = document.execCommand('copy'); box.remove();
            document.getElementById('level-complete-title').textContent = copied ? 'Copied complete level JSON' : 'Clipboard unavailable; try again from the editor';
        }
    });
}

function showLevelComplete()
{
    const dialog = document.getElementById('ov-level-complete');
    if (!dialog) return;
    const title = document.getElementById('level-complete-title');
    if (title) title.textContent = (selectedStageLevel.title || 'Level') + ' complete';
    dialog.classList.add('on');
}

function updateGameDownloadPreview()
{
    const input = document.getElementById('game-download-stage');
    const label = document.getElementById('game-download-preview');
    const error = document.getElementById('game-download-error');
    const stage = Number(input.value);
    error.textContent = '';
    if (!window.LevelFormatV1 || !Number.isInteger(stage) || stage < 1 || stage > 9999) {
        label.textContent = 'Enter a whole stage number from 1 to 9999.';
        return;
    }
    const mapped = LevelFormatV1.defaultSongForStage(stage, (window.ZIGZAG_SONGS || {}).files || []).song;
    const associated = selectedStageLevel && selectedStageLevel.stage === stage ? selectedStageLevel.song : null;
    label.textContent = LevelFormatV1.filenameForStage(stage) + ' · ' + (associated || (mapped ? mapped.file : 'No unique default song is available.'));
}

async function downloadCompletedLevel()
{
    const error = document.getElementById('game-download-error');
    try {
        if (!selectedStageLevel || !window.LevelFormatV1) throw new Error('The completed level data is not available.');
        const stage = Number(document.getElementById('game-download-stage').value);
        const name = LevelFormatV1.filenameForStage(stage);
        const level = JSON.parse(JSON.stringify(selectedStageLevel));
        const oldStage = level.stage;
        level.stage = stage;
        const mapped = LevelFormatV1.defaultSongForStage(stage, (window.ZIGZAG_SONGS || {}).files || []).song;
        if (stage !== oldStage || !level.song) {
            if (!mapped) throw new Error('No unique song matches stage ' + stage + '. Rename duplicate song IDs or choose a mapped stage.');
            level.song = mapped.file;
        }
        const validation = LevelFormatV1.validate(level);
        if (!validation.valid) throw new Error(validation.errors.join(' '));
        const content = LevelFormatV1.toJSON(level);
        const blob = new Blob([content], { type: 'application/json' });
        if (window.showSaveFilePicker) {
            const handle = await window.showSaveFilePicker({ suggestedName: name,
                types: [{ description: 'ZIGZAG level file', accept: { 'application/json': ['.level'] } }] });
            const writable = await handle.createWritable();
            await writable.write(blob); await writable.close();
        } else {
            const url = URL.createObjectURL(blob), link = document.createElement('a');
            link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1500);
        }
        document.getElementById('ov-stage-download').classList.remove('on');
        selectedStageLevel = level;
    } catch (exception) {
        if (exception.name === 'AbortError') { error.textContent = 'Download cancelled.'; return; }
        error.textContent = exception.message;
    }
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
        // The title menu is DOM-driven; menu controls call ZZ.Game.start().
        // Letting LittleJS treat any click as "start" made menu clicks leak
        // into the nearby overworld portal.
    }
    else if (state == 'world')
    {
        if (keyWasPressed('Escape')) { ZZ.Game.pause(); updateCamera(); return; }
        if (keyWasPressed('PageUp')) cycleSelectedSong(-1);
        if (keyWasPressed('PageDown')) cycleSelectedSong(1);
        // World state delegates ALL input/logic/rendering to overworld.js
        // owUpdate(dt): called each frame, handles its own input
        // owRender(): called each frame, handles its own rendering
        // owHandleKey(key, down): optional direct key events from engine
        if (!worldPaused && worldInputLockFrames > 0) {
            --worldInputLockFrames;
            if (typeof owRender == 'function') owRender();
        } else if (!worldPaused) {
            if (typeof owUpdate == 'function') owUpdate(timeDelta);
            if (typeof owRender == 'function') owRender();
            owPollWorldKeys();
        }
    }
    else if (state == 'play')
    {
        if (keyWasPressed('Escape') || keyWasPressed('KeyP') || keyWasPressed('Space')) togglePlayPause();
        if (!playPaused) playUpdate();
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
    else if (state == 'battle')
    {
        if (keyWasPressed('Escape') || keyWasPressed('KeyP')) { ZZ.Game.pause(); updateCamera(); return; }
        if (!battlePaused && ZZ.Battle) ZZ.Battle.update(timeDelta);
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
    else if (state == 'play')    hudPlay();
    else if (state == 'results') hudResults();
    else if (state == 'battle' && ZZ.Battle) ZZ.Battle.render();
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
    noteConnections = null;
    chart = buildPlayChart();
    fourLaneMode = !!chart.fourLane;
    const diffKey = ZZ.Settings && ZZ.Settings.get ? ZZ.Settings.get('difficulty') : 'normal';
    const diff = ZZ.Chart && ZZ.Chart.DIFFS[diffKey] || null;
    if (diff) {
        activeJudgmentWindows = diff.win.slice();
        PLAY.hitWindow = diff.win[2];
        // Keep long holds and drag paths on screen long enough to read.
        PLAY.fallTime = Math.max(2.25, diff.fall);
    } else {
        activeJudgmentWindows = DATA.judgments.slice(0, 3).map(j => j.window);
        PLAY.hitWindow = activeJudgmentWindows[2];
    }
    notes = chart.notes.map(n=> new PlayNote(n));
    if (chart.notes.length) noteConnections = new NoteConnections();

    activeLane = 'bottom';
    playPaused = false;
    score = 0; combo = 0; maxCombo = 0; hits = 0; health = 100;
    counts = [0, 0, 0, 0];
    playSimulation.accumulator = 0;
    playSimulation.tickCount = 0;
    playSimulation.sampleAt = performance.now();
    playSimulation.droppedTicks = 0;
    HUD.scoreShown = 0;
    songMeta = { title: chart.title, artist: chart.artist };
    playResult = null;
    laneFlash.top = laneFlash.bottom = laneFlash.center = 0;
    laneSwapPulse = 0;

    // audio through the friend system's HTMLAudioElement wrapper (file:// safe)
    audioArmed = false; audioStarted = false; audioFailed = false;
    if (!window.ZIGZAG_EDITOR_MODE && chart.song && typeof ZZ != 'undefined' && ZZ.Audio)
    {
        if (stageAudioPrimed && ZZ.Audio.currentSongFile() === chart.song.file) {
            audioArmed = true;
            audioStarted = true;
            stageAudioPrimed = false;
        } else {
            ZZ.Audio.unlock();
            ZZ.Audio.load(chart.song, err=>
            {
                audioArmed = !err && state == 'play';
                if (!err && chart && chart.song.duration) chart.length = Math.max(chart.length, chart.song.duration);
                if (err) audioFailed = true;
            });
        }
        ZZ.Audio.onEnded(()=> { if (state == 'play') endSong(); });
        if (chart.song && ZZ.Audio.duration()) chart.length = Math.max(chart.length, ZZ.Audio.duration());
    }

    songStart = time + (audioStarted ? 0 : PLAY.countdown);
    songTime = audioStarted ? ZZ.Audio.now() : -PLAY.countdown;
}

// Build playable notes only from the active stage file. The editor uses the
// same LevelFormatV1 converter, so preview and game share one note format.
function buildPlayChart()
{
    const Z = typeof ZZ != 'undefined' ? ZZ : null;
    const settingOffset = Z && Z.Settings && Z.Settings.get ? (Number(Z.Settings.get('offset')) || 0) / 1000 : 0;

    if (window.ZIGZAG_EDITOR_MODE && Z && Z.LevelEditor && Z.LevelFormatV1) {
        const level = Z.LevelEditor.getLevel();
        const editorChart = Z.LevelFormatV1.toChart(level);
        editorChart.song = Z.LevelEditor.getSongEntry();
        editorChart.length = Math.max(editorChart.length, editorChart.song && editorChart.song.duration || 0);
        return editorChart;
    }

    if (!selectedStageLevel || !Z || !Z.LevelFormatV1)
        throw new Error('The selected stage has no loaded .level data. Return to the hub and load the stage file first.');
    if (!selectedSong) throw new Error('The stage file has no associated song.');
    const levelChart = Z.LevelFormatV1.toChart(selectedStageLevel);
    levelChart.song = selectedSong;
    if (settingOffset) for (const note of levelChart.notes) {
        note.t += settingOffset;
        if (Number.isFinite(note.end)) note.end += settingOffset;
        if (Array.isArray(note.path)) note.path.forEach(point => point.t += settingOffset);
        if (Array.isArray(note.nodes)) note.nodes.forEach(point => point.t += settingOffset);
        if (Array.isArray(note.flicks)) note.flicks = note.flicks.map(t => t + settingOffset);
    }
    levelChart.length = Math.max(levelChart.length, selectedSong.duration || 0);
    return levelChart;
}

function refreshEditorChart()
{
    if (!window.ZIGZAG_EDITOR_MODE || !ZZ || !ZZ.LevelEditor) return;
    notes.forEach(note => note.destroy());
    if (noteConnections) noteConnections.destroy();
    chart = buildPlayChart();
    fourLaneMode = true;
    notes = chart.notes.map(note => new PlayNote(note));
    noteConnections = notes.length ? new NoteConnections() : null;
    if (ZZ.LevelEditor.getDuration) chart.length = Math.max(chart.length, ZZ.LevelEditor.getDuration() || 0);
}

window.ZIGZAG_EDITOR_REBUILD = refreshEditorChart;
window.ZIGZAG_EDITOR_SET_DURATION = duration => {
    if (chart && Number.isFinite(duration) && duration > 0) chart.length = Math.max(chart.length, duration);
};

// Rhythm input is collected at the engine frame boundary, then gameplay is
// advanced with a bounded 240 Hz accumulator. Audio remains the timing source.
function playUpdate()
{
    if (window.ZIGZAG_EDITOR_MODE && (!ZZ.LevelEditor || !ZZ.LevelEditor.isPlaying())) return;
    if (!playPaused) collectPlayInput();
    playSimulation.accumulator += Math.min(timeDelta, .05);
    let steps = 0;
    while (playSimulation.accumulator >= playSimulation.step && steps < 8) {
        playTick(playSimulation.step);
        playSimulation.accumulator -= playSimulation.step;
        playSimulation.tickCount++;
        steps++;
    }
    if (playSimulation.accumulator >= playSimulation.step) {
        playSimulation.droppedTicks += Math.floor(playSimulation.accumulator / playSimulation.step);
        playSimulation.accumulator = Math.min(playSimulation.accumulator, playSimulation.step * .99);
    }
    const now = performance.now();
    const elapsed = now - playSimulation.sampleAt;
    if (elapsed >= 1000) {
        playSimulation.measuredTPS = playSimulation.tickCount * 1000 / elapsed;
        playSimulation.tickCount = 0;
        playSimulation.sampleAt = now;
    }
}

function collectPlayInput()
{
    if (window.ZIGZAG_EDITOR_MODE && ZZ.LevelEditor && ZZ.LevelEditor.isRecording()) return;
    if (fourLaneMode) {
        ['KeyD', 'KeyF', 'KeyJ', 'KeyK'].forEach((code, lane) => {
            if (keyWasPressed(code)) playInputQueue.push({ type: 'lane', lane, source: 'key' });
        });
        if (mouseWasPressed(0)) playInputQueue.push({ type: 'lane', lane: laneFromWorldX(mousePos.x), source: 'pointer' });
    } else {
        if (keyWasPressed('ArrowDown')) playInputQueue.push({ type: 'swap' });
        if (keyWasPressed('ArrowLeft') || keyWasPressed('ArrowRight')) playInputQueue.push({ type: 'legacyHit' });
        if (keyWasPressed('ArrowUp')) playInputQueue.push({ type: 'flick' });
    }
}

function playTick(step)
{
    if (pendingState == 'results') return;
    if (window.ZIGZAG_EDITOR_MODE) {
        if (!ZZ.Audio || !ZZ.Audio.isPlaying()) {
            songTime = ZZ.Audio ? ZZ.Audio.now() : 0;
            return;
        }
        songTime = ZZ.Audio.now();
    } else {
        songClock();
    }
    if (window.ZIGZAG_EDITOR_MODE && ZZ.LevelEditor && ZZ.LevelEditor.isRecording()) {
        for (const n of notes) {
            n.pos.x = laneX(n.lane);
            n.pos.y = noteY(n.t);
        }
        return;
    }

    for (const event of playInputQueue.splice(0)) {
        if (event.type === 'swap') {
            activeLane = activeLane == 'bottom' ? 'top' : 'bottom';
            laneSwapPulse = 1;
            if (typeof ZZ != 'undefined' && ZZ.Audio) ZZ.Audio.sfx('tick');
        } else if (event.type === 'legacyHit') {
            tryStartHit();
        } else if (event.type === 'flick') {
            tryFlick();
        } else if (event.type === 'lane') {
            lastLanePressed = event.lane;
            tryStartCustomHit(event.lane);
        }
    }
    laneSwapPulse = Math.max(0, laneSwapPulse - step*3);
    for (const k in laneFlash) laneFlash[k] = Math.max(0, laneFlash[k] - step*4);
    for (const n of notes) {
        if (pendingState == 'results') break;
        n.tick(step);
    }
    if (chart && songTime > chart.length) endSong();
}

function togglePlayPause()
{
    if (window.ZIGZAG_EDITOR_MODE && typeof ZZ != 'undefined' && ZZ.LevelEditor) {
        ZZ.LevelEditor.togglePause();
        return;
    }
    if (playPaused) ZZ.Game.resume();
    else ZZ.Game.pause();
}

function laneFromWorldX(x)
{
    let best = 0, distance = Infinity;
    FOUR_LANE_X.forEach((center, lane) => {
        const d = Math.abs(x - center);
        if (d < distance) { distance = d; best = lane; }
    });
    return distance <= 1.8 ? best : -1;
}

window.ZIGZAG_SIMULATION_STATUS = () => ({ targetTPS: 240, measuredTPS: playSimulation.measuredTPS,
    droppedTicks: playSimulation.droppedTicks });

function laneHeld(lane)
{
    const codes = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];
    if (keyIsDown(codes[lane])) return true;
    return mouseIsDown(0) && laneFromWorldX(mousePos.x) === lane;
}

function currentHeldLane()
{
    if (mouseIsDown(0)) return laneFromWorldX(mousePos.x);
    const codes = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];
    if (Number.isInteger(lastLanePressed) && keyIsDown(codes[lastLanePressed])) return lastLanePressed;
    const lane = codes.findIndex(code => keyIsDown(code));
    return lane;
}

function tryStartCustomHit(lane)
{
    if (!Number.isInteger(lane) || lane < 0 || lane > 3) return;
    let target = null, bestDist = PLAY.hitWindow + 1e-4;
    for (const n of notes) {
        if (n.state != 'pending' || n.lane !== lane) continue;
        const d = Math.abs(n.t - songTime);
        if (d < bestDist) { bestDist = d; target = n; }
    }
    if (!target) return;
    if (target.type === 'tap') {
        target.state = 'done';
        judgeUnit(judgmentIndex(bestDist), target);
    } else {
        target.state = 'holding';
        judgeUnit(judgmentIndex(bestDist), target);
        if (target.type === 'drag') target.pathIndex = 1;
    }
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
    for (let i = 0; i < activeJudgmentWindows.length; ++i)
        if (dist <= activeJudgmentWindows[i]) return i;
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
            spawnBurst(note.pos.x, Math.max(note.pos.y, PLAY.lineY), playLaneColor(note.lane));
        }
        flash = Math.max(flash, q === 0 ? .35 : .2);
        shake = Math.max(shake, q === 0 ? .1 : .05);
        judgeLinePulse = 1;
    }
    else
    {
        combo = 0;
        if (!silent && !(ZZ.Settings && ZZ.Settings.get && ZZ.Settings.get('practice')))
            health = Math.max(0, health - 9);
        if (note)
        {
            note.missFlash = 1;
            laneFlash[note.lane] = Math.max(laneFlash[note.lane], .5);
            spawnBurst(note.pos.x, PLAY.lineY, col(PLAY.colors.miss));
        }
        flash = Math.max(flash, .25);
        shake = Math.max(shake, .12);
        if (!silent) hudJudge(j.name, DATA.c.judge[3]);
        if (health <= 0 && !window.ZIGZAG_EDITOR_MODE) endSong(true);
    }
}

function endSong(failed)
{
    if (state != 'play' || pendingState == 'results') return;
    if (typeof ZZ != 'undefined' && ZZ.Audio) ZZ.Audio.stop();
    if (window.ZIGZAG_EDITOR_MODE && typeof ZZ != 'undefined' && ZZ.LevelEditor) {
        ZZ.LevelEditor.onPlaybackComplete();
        return;
    }

    const judged = counts[0] + counts[1] + counts[2] + counts[3];
    const acc = judged ? (counts[0] + counts[1]*.75 + counts[2]*.4) / judged : 0;
    playResult = {
        title: songMeta.title, artist: songMeta.artist,
        score, maxCombo, counts: counts.slice(), accuracy: acc,
        grade: acc >= .95 ? 'S' : acc >= .9 ? 'A' : acc >= .8 ? 'B' : acc >= .7 ? 'C' : 'D',
        failed: !!failed,
    };

    recordStageResult(playResult);

    if (score > best)
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
        super(vec2(laneX(n.lane), PLAY.topY), vec2(2.2, 2.2), undefined, 0, WHITE, 10);
        this.t = n.t;
        this.lane = n.lane;                 // 'top' | 'bottom' | 'center'
        this.type = n.type;                 // 'tap' | 'hold'
        this.dur = n.dur || 0;
        this.path = (n.path || []).map(point => ({ t: point.t, lane: point.lane }));
        this.pathIndex = 1;
        this.lastHeldLane = null;
        this.flicks = (n.flicks || []).map(t=> ({ t, done: false }));
        this.state = 'pending';             // pending -> holding -> done | broken | missed
        this.hitFlash = 0;                  // white pop after a hit
        this.missFlash = 0;                 // red pop after a miss
        this.flickFlash = 0;                // extra glow when a flick connects
        this.mass = 0;
    }

    get endTime() { return this.t + this.dur; }

    tick(step)
    {
        this.hitFlash = Math.max(0, this.hitFlash - step*4);
        this.missFlash = Math.max(0, this.missFlash - step*3);
        this.flickFlash = Math.max(0, this.flickFlash - step*5);

        // scroll position — an active hold pins its head to the hit line
        let y = noteY(this.t);
        if (this.state == 'holding') y = Math.max(y, PLAY.lineY);
        this.pos.x = laneX(this.lane);
        this.pos.y = y;

        if (this.state == 'pending')
        {
            // slid past the window with no press => miss
            if (songTime > this.t + activeJudgmentWindows[2])
            {
                this.state = 'missed';
                judgeUnit(3, this);
            }
            return;
        }

        if (this.state == 'holding')
        {
            const held = fourLaneMode
                ? (this.type === 'drag' ? (mouseIsDown(0) || ['KeyD','KeyF','KeyJ','KeyK'].some(keyIsDown)) : laneHeld(this.lane))
                : keyIsDown('ArrowLeft') || keyIsDown('ArrowRight');

            if (this.type === 'drag')
            {
                const point = this.path[this.pathIndex];
                const dragWindow = Math.max(PLAY.hitWindow, .22);
                const pointerLane = mouseIsDown(0) ? laneFromWorldX(mousePos.x) : -1;
                const heldLane = pointerLane >= 0 ? pointerLane
                    : held ? currentHeldLane() : this.lastHeldLane;
                if (held && heldLane >= 0) this.lastHeldLane = heldLane;
                // Let the release frame satisfy its endpoint when the pointer
                // is on the right lane and within the drag timing window.
                if (point && Math.abs(point.t - songTime) <= dragWindow && heldLane === point.lane)
                {
                    this.pathIndex++;
                    judgeUnit(judgmentIndex(Math.abs(point.t - songTime)), this);
                    if (this.pathIndex >= this.path.length) this.state = 'done';
                    return;
                }
            }

            // A hold ends when its tail reaches the line. Complete it before
            // checking the release edge so letting go on the tail is valid.
            // Resolve skipped flicks separately so they remain visible misses.
            if (this.type !== 'drag' && songTime >= this.endTime - step)
            {
                for (const f of this.flicks)
                    if (!f.done) { f.done = true; judgeUnit(3, this); }
                this.state = 'done';
                judgeUnit(1, this);                         // held through the tail — GREAT
                return;
            }

            // Released before the tail — everything remaining counts as a miss.
            if (!held)
            {
                this.state = 'broken';
                judgeUnit(3, this, false);                  // the head gap — shown
                for (const f of this.flicks)
                    if (!f.done)
                    {
                        f.done = true;
                        judgeUnit(3, this, true);           // leftovers — count only
                    }
                if (this.type === 'drag') {
                    while (this.pathIndex < this.path.length) {
                        this.pathIndex++;
                        judgeUnit(3, this, true);
                    }
                }
                return;
            }

            if (this.type === 'drag') {
                const point = this.path[this.pathIndex];
                const dragWindow = Math.max(PLAY.hitWindow, .22);
                if (point && Math.abs(point.t - songTime) <= dragWindow && currentHeldLane() === point.lane) {
                    this.pathIndex++;
                    judgeUnit(judgmentIndex(Math.abs(point.t - songTime)), this);
                } else if (point && songTime > point.t + dragWindow) {
                    this.pathIndex++;
                    judgeUnit(3, this);
                }
                if (this.pathIndex >= this.path.length) this.state = 'done';
                return;
            }

            // flicks that slid by unanswered
            for (const f of this.flicks)
                if (!f.done && songTime > f.t + PLAY.hitWindow)
                {
                    f.done = true;
                    judgeUnit(3, this);                     // shown: teaches the UP timing
                }

        }
    }

    render()
    {
        if (state != 'play') return;
        const gone = this.state == 'done' || this.state == 'broken' || this.state == 'missed';
        if (gone && this.hitFlash <= .01 && this.missFlash <= .01) return;
        // Visibility begins when the head enters the screen. Using endTime here
        // hid long holds until after their heads had already been judged missed.
        if (this.state == 'pending' && this.t - songTime > PLAY.fallTime + .1) return;

        const C = DATA.c, x = this.pos.x;
        const mine = fourLaneMode || this.lane == 'center' || this.lane == activeLane;
        const base = playLaneColor(this.lane);
        const dim = base.scale(.25);                        // dark when the lane is off
        let c = mine ? base : dim;
        if (gone) c = dim.scale(.7);
        const w = this.type === 'drag' ? 2.65 : fourLaneMode ? 2.35 : 2.3;

        if (this.type === 'drag')
        {
            const path = this.path.length ? this.path : [{ t: this.t, lane: this.lane }, { t: this.endTime, lane: this.lane }];
            for (let i = 1; i < path.length; i++) {
                const a = vec2(laneX(path[i - 1].lane), noteY(path[i - 1].t));
                const b = vec2(laneX(path[i].lane), noteY(path[i].t));
                drawLine(a, b, .82, alpha(col('#fff27a'), .48));
                drawLine(a, b, .42, alpha(col('#fff27a'), mine ? 1 : .7));
                drawCircle(b, .38, alpha(col('#fff27a'), .98));
            }
            const head = vec2(laneX(this.lane), noteY(this.t));
            drawCircle(head, .78, alpha(base, .3));
            drawCircle(head, .53, alpha(col('#fff27a'), .95));
            drawCircle(head, .29, alpha(C.bg, .85));
            const tail = path[path.length - 1];
            drawRegularPoly(vec2(laneX(tail.lane), noteY(tail.t)), vec2(.65), 3,
                alpha(col('#fff27a'), .98), .1, alpha(base, .95), PI/2);
        }
        else if (this.type == 'tap')
        {
            const p = vec2(x, noteY(this.t));
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
            const yHead = this.state == 'holding' ? Math.max(noteY(this.t), PLAY.lineY)
                                                  : noteY(this.t);
            const yTail = noteY(this.endTime);
            // The tail is later, so it stays farther up the playfield than
            // the head. Keep the visible bar attached to the head as it moves
            // toward the judge line.
            const h = Math.max(.25, yTail - yHead);
            const mid = vec2(x, (yHead + yTail) * .5);

            // the bar
            const barA = (mine ? .68 : .28) + (this.state == 'holding' ? .2 : 0);
            drawRect(mid, vec2(1.72, h), alpha(c, barA));
            drawRect(mid, vec2(.78, h), alpha(C.ink, mine ? .3 : .12));

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
                const p = vec2(x, noteY(f.t));
                if (p.y > yTail + .3 || p.y < yHead - .3) continue;
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
                // held head pinned at the line, glowing brighter while held
                setAdditiveBlendMode(true);
                drawRect(vec2(x, PLAY.lineY), vec2(w + 1.2, 1.9), alpha(c, .14 + .06*sin(time*8)));
                setAdditiveBlendMode(false);
                drawRect(vec2(x, PLAY.lineY), vec2(w, 1.2), alpha(C.ink, .9));
                drawRect(vec2(x, PLAY.lineY), vec2(w*.7, .9), c);
            }
        }

        // hit = white flash, miss = red flash
        const p = vec2(x, this.type == 'hold' && this.state == 'holding'
            ? PLAY.lineY : noteY(this.t));
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

// purely decorative path between consecutive chart notes; it never enters
// input selection or scoring. World endpoints are recalculated from each note.
class NoteConnections extends EngineObject
{
    constructor() { super(vec2(), vec2(1), undefined, 0, WHITE, 5); this.mass = 0; }
    render()
    {
        if (state != 'play') return;
        for (let i = 1; i < notes.length; i++) {
            const previous = notes[i - 1], next = notes[i];
            const previousTime = previous.type === 'tap' ? previous.t : previous.endTime;
            const nextTime = next.type === 'tap' ? next.t : next.endTime;
            const previousLane = previous.type === 'drag' && previous.path.length ? previous.path[previous.path.length - 1].lane : previous.lane;
            const nextLane = next.type === 'drag' && next.path.length ? next.path[next.path.length - 1].lane : next.lane;
            const a = vec2(laneX(previousLane), noteY(previousTime) - .58);
            const b = vec2(laneX(nextLane), noteY(nextTime) - .58);
            if (a.y < PLAY.lineY - 1 || b.y > PLAY.topY + 1) continue;
            drawLine(a, b, .055, alpha(playLaneColor(nextLane), fourLaneMode ? .32 : .2));
        }
    }
}

///////////////////////////////////////////////////////////////////////////////
// the stage: backdrop, the two lane columns, the hit line, the countdown
///////////////////////////////////////////////////////////////////////////////

function renderStage()
{
    const C = DATA.c, S = mainCanvasSize, th = ZZ && ZZ.theme;
    const bgTop = col(th && th.bg && th.bg[0] || C.bgTop);
    const bgBot = col(th && th.bg && th.bg[1] || C.bgBot);
    const accent = col(th && th.ui && th.ui.accent || C.neon);
    const accent2 = col(th && th.ui && th.ui.accent2 || C.cyan);
    const ink = col(th && th.ui && th.ui.text || C.ink);
    const dim = col(th && th.ui && th.ui.dim || C.dim);
    const bg = col(th && th.ui && th.ui.bg || C.bg);

    // backdrop
    drawRectGradient(vec2(S.x/2, S.y/2), S, bgTop, bgBot, 0, true, true);

    const colH = PLAY.topY - PLAY.lineY + 5;
    const colMid = (PLAY.topY + PLAY.lineY) * .5;

    // Four-lane charts use the same stage surface in the editor and in play.
    // The older generated charts keep their established two-side + center rules.
    const stageLanes = fourLaneMode ? [0, 1, 2, 3] : ['bottom', 'top'];
    const laneWidth = fourLaneMode ? 3.45 : PLAY.laneWidth;
    for (const lane of stageLanes)
    {
        const x = laneX(lane), on = fourLaneMode || activeLane == lane;
        const base = playLaneColor(lane);
        const fl = laneFlash[lane] || 0;
        drawRect(vec2(x, colMid), vec2(laneWidth, colH), alpha(base, (on ? .085 : .03) + fl*.1));
        for (const side of [-1, 1])
            drawRect(vec2(x + side*laneWidth*.5, colMid), vec2(.07, colH), alpha(base, on ? .45 : .14));
        if (on) {
            setAdditiveBlendMode(true);
            drawRect(vec2(x, PLAY.lineY + 1.4), vec2(laneWidth, 3.4 + laneSwapPulse*.7),
                alpha(base, .06 + .035*sin(time*3) + fl*.22 + laneSwapPulse*.1));
            setAdditiveBlendMode(false);
        }
    }
    if (!fourLaneMode) drawRect(vec2(0, colMid), vec2(2.0, colH), alpha(playLaneColor('center'), .035));

    // ---- the hit line ------------------------------------------------------
    const p = judgeLinePulse, w = fourLaneMode ? 14.5 : 11.5;
    drawRect(vec2(0, PLAY.lineY), vec2(w, .5 + p*.25), alpha(accent, .1 + p*.2));
    drawRect(vec2(0, PLAY.lineY), vec2(w, .16), alpha(ink, .55 + p*.45));
    drawRect(vec2(0, PLAY.lineY), vec2(w, .05), ink);
    for (const s of [-1, 1])
        drawRegularPoly(vec2(s*(w/2 - .2), PLAY.lineY), vec2(.8 + p*.25), 4,
            alpha(accent2, .9), .07, ink, PI/4);

    // ---- key hints under the line -----------------------------------------
    if (fourLaneMode) {
        ['D','F','J','K'].forEach((key, lane) => {
            const base = playLaneColor(lane);
            drawText(String(lane + 1), vec2(laneX(lane), PLAY.lineY - 1.15), .4, alpha(base, .95), .03, alpha(bg, .85), 'center', DATA.ui.font);
            drawText(key, vec2(laneX(lane), PLAY.lineY - 1.8), .36, alpha(dim, .8), 0, 0, 'center', DATA.ui.soft);
        });
    } else {
        for (const lane of ['bottom', 'top']) {
            const on = activeLane == lane, base = playLaneColor(lane);
            drawText(lane == 'top' ? 'TOP' : 'BOT', vec2(laneX(lane), PLAY.lineY - 1.2), .5,
                alpha(base, on ? .95 : .4), .04, alpha(bg, .85), 'center', DATA.ui.font);
            drawText('L R', vec2(laneX(lane), PLAY.lineY - 1.9), .36, alpha(dim, on ? .8 : .35), 0, 0, 'center', DATA.ui.soft);
        }
        drawText('↓ SWAP', vec2(0, PLAY.lineY - 1.2), .42, alpha(ink, .5 + laneSwapPulse*.45), .03, alpha(bg, .85), 'center', DATA.ui.font);
        drawText('↑ FLICK', vec2(0, PLAY.lineY - 1.9), .32, alpha(dim, .65), 0, 0, 'center', DATA.ui.soft);
    }

    // song title chip while the chart warms up
    if (songMeta.title && songTime < 2.6)
        drawText(songMeta.title, vec2(0, 3.4), .85,
            alpha(ink, clamp(1.1 - Math.max(0, songTime)*.35)), .05, alpha(bg, .8),
            'center', DATA.ui.font);

    if (stageNotice && songTime < .1)
        drawText(stageNotice, vec2(0, PLAY.topY - .6), .34, alpha(C.gold, .95), .02, alpha(C.bg, .85), 'center', DATA.ui.soft);

    if (playPaused)
        drawText('PAUSED  ·  SPACE TO RESUME', vec2(0, 1.2), 1, alpha(ink, .95), .06, alpha(bg, .85), 'center', DATA.ui.font);

    // countdown before the chart starts
    if (!audioStarted && songTime < 1.1)
    {
        const k = Math.ceil(-songTime + .2);
        const label = k > 0 ? String(Math.min(k, Math.ceil(PLAY.countdown))) : 'GO!';
        const pop = 1 - mod(-songTime + .2, 1);
        drawText(label, vec2(0, 1.2), 1.6 + pop*.6, alpha(C.ink, .9), .1, C.bg,
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

const gameHost = document.getElementById('s-game') || document.body;
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, [], gameHost);

// The original DOM menu survived the LittleJS rewrite but its game controller
// had become a no-op. Bridge the visible menu and pause controls into this
// state machine so every entry point reaches the same playable game.
(function installGameBridge() {
    const Z = window.ZZ = window.ZZ || {};
    const setRunSettings = diff => {
        if (Z.Settings) {
            if (diff) Z.Settings.set('difficulty', diff);
        }
    };
    const enterWorldFromMenu = song => {
        if (song) selectedSong = song;
        selectedStageLevel = null;
        playPaused = worldPaused = battlePaused = false;
        pendingState = null;
        if (state != 'world') transitionTo('world');
        // The menu's click can still be visible to LittleJS during this frame.
        // Keep it from activating the nearby portal as the hub opens.
        worldInputLockFrames = 30;
        if (typeof owLockPortalPointerUntilRelease == 'function') owLockPortalPointerUntilRelease();
        if (Z.Menu && Z.Menu.showOverlay) Z.Menu.showOverlay('play');
    };
    Z.Game = {
        get state() {
            if (playPaused || worldPaused || battlePaused) return 'paused';
            if (state == 'play') return 'playing';
            return state;
        },
        get song() { return selectedSong; },
        get diff() { return Z.Settings ? Z.Settings.get('difficulty') : 'normal'; },
        get score() { return score; },
        get combo() { return combo; },
        get maxCombo() { return maxCombo; },
        get counts() { return counts; },
        get failed() { return !!(playResult && playResult.failed); },
        get newBest() { return !!(playResult && playResult.score >= best); },
        get best() { return best; },
        init() {}, resize() {},
        start(song, diff) { setRunSettings(diff); enterWorldFromMenu(song); },
        startStage(song, diff) { setRunSettings(diff); enterWorldFromMenu(song); },
        restart() { enterWorldFromMenu(selectedSong); },
        stopLoop() {}, loop() {},
        togglePause() { this.state == 'paused' ? this.resume() : this.pause(); },
        pause() {
            if (state == 'play') { playPaused = true; if (ZZ.Audio) ZZ.Audio.pause(); }
            else if (state == 'world') worldPaused = true;
            else if (state == 'battle') battlePaused = true;
            else return;
            if (Z.Menu && Z.Menu.showOverlay) Z.Menu.showOverlay('pause', 'Move: arrows / WASD · Stage: Page Up / Page Down');
        },
        resume() {
            if (state == 'play') { playPaused = false; if (audioStarted && ZZ.Audio) ZZ.Audio.play().catch(()=> {}); }
            worldPaused = battlePaused = false;
            if (Z.Menu && Z.Menu.showOverlay) Z.Menu.showOverlay('play');
        },
        quit() {
            playPaused = worldPaused = battlePaused = false;
            if (ZZ.Audio) ZZ.Audio.stop();
            if (ZZ.Battle) ZZ.Battle.stop();
            if (state != 'title') transitionTo('title');
        },
        grade(acc) { return acc >= .95 ? 'S' : acc >= .9 ? 'A' : acc >= .8 ? 'B' : acc >= .7 ? 'C' : 'D'; },
        accuracy() { const total = counts.reduce((a, b) => a + b, 0); return total ? (counts[0] + counts[1]*.75 + counts[2]*.4) / total : 0; },
        highScore(id) { return gameProgress.highScores[id] || null; },
        canStartStage,
        getProgress() { return gameProgress; },
        resetProgress() {
            gameProgress = { unlocked: 1, cleared: [], highScores: {}, defeatedEnemies: {} };
            ZZ.defeatedEnemies = {};
            best = 0;
            saveGameProgress();
            writeSaveData(SAVE_KEY, { best: 0, lastRun: null });
            return true;
        },
    };

    ZZ.startBattle = function (enemyId, door) {
        if (state != 'world' || !ZZ.Battle || ZZ.Battle.isActive()) return false;
        const roster = {
            warden_west: { name: 'WEST WARDEN', hp: 70, attacks: [{ name: 'GLITCH SWIPE', power: 8 }], drops: [{ name: 'Pocket Chorus', type: 'heal', amount: 28 }] },
            warden_east: { name: 'EAST WARDEN', hp: 92, attacks: [{ name: 'STATIC BOLT', power: 10 }], drops: [{ name: 'Pocket Chorus', type: 'heal', amount: 28 }] },
            warden_north: { name: 'NORTH WARDEN', hp: 120, attacks: [{ name: 'ZIGZAG CRASH', power: 12 }], drops: [{ name: 'Pocket Chorus', type: 'heal', amount: 28 }, { name: 'Pocket Chorus', type: 'heal', amount: 28 }] },
        };
        const enemy = roster[enemyId] || { name: door && door.label || 'WARDEN', hp: 70, attacks: [{ name: 'STRIKE', power: 8 }] };
        battlePlayer.score = score;
        battlePlayer.accuracy = Z.Game.accuracy() * 100;
        battlePlayer.combo = maxCombo;
        battlePaused = false;
        ZZ.Battle.start(enemy, battlePlayer, result => {
            if (result.won) {
                ZZ.defeatedEnemies[enemyId] = true;
                gameProgress.defeatedEnemies[enemyId] = true;
                saveGameProgress();
                if (Array.isArray(result.newItems)) battlePlayer.items.push(...result.newItems);
            } else {
                battlePlayer.hp = Math.max(50, battlePlayer.maxHp);
            }
            ZZ.Battle.stop();
            setState('world');
        }, { performance: { score: battlePlayer.score, accuracy: battlePlayer.accuracy, combo: battlePlayer.combo },
            onSectionStart: () => ZZ.Battle.openMenu() });
        setState('battle');
        return true;
    };
})();
