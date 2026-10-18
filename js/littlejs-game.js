///////////////////////////////////////////////////////////////////////////////
// ZIGZAG SYNTH — main.js
// Engine init, the title → world → play → results state machine, and the
// rhythm core (which is functionally the same as the original template).
///////////////////////////////////////////////////////////////////////////////

let state = 'title';
let chart, notes = [];
let songTime = 0, songStart = 0;
let score = 0, combo = 0, maxCombo = 0, best = 0, hits = 0;
let counts = [0, 0, 0, 0];
let flash = 0, flashColor, shake = 0, judgeLinePulse = 0;
let camDive = null;         // {t, dur, fromPos, fromScale, toPos, toScale}
let pendingState = null;
let muted = false;

///////////////////////////////////////////////////////////////////////////////
// state machine
///////////////////////////////////////////////////////////////////////////////

// queue a transition; it is applied in gameUpdatePost so no object is ever
// destroyed in the middle of its own update
function setState(next) { pendingState = next; }

function transitionTo(next)
{
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
    else if (state == 'play')
    {
        tapInput();
        noteUpdate();
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
// rhythm core — chart runner + judgment
///////////////////////////////////////////////////////////////////////////////

function startSong()
{
    chart = makeChart();
    notes = chart.notes.map(n=> new Note(n));
    songStart = time + 1.2;
    songTime = -1.2;
    score = 0; combo = 0; maxCombo = 0; hits = 0;
    counts = [0, 0, 0, 0];
    HUD.scoreShown = 0;
}

function noteUpdate()
{
    if (state !== 'play' || !chart) return;
    songTime = time - songStart;

    for (const n of notes)
    {
        const t = clamp(1 - (n.time - songTime) / DATA.fallTime, 0, 1.2);
        const y = lerp(DATA.topY, DATA.lineY, t);
        const x = DATA.laneX[n.side];
        n.drawPos = vec2(x, y);
        if (!n.judged && n.time < songTime - DATA.judgments[2].window)
        {
            n.judged = true;
            counts[3]++;
            combo = 0;
            flash = Math.max(flash, .25);
            shake = Math.max(shake, .12);
            hudJudge(DATA.judgments[3].name, DATA.c.judge[3]);
        }
        if (!n.drawn && t > 0 && t < 1)
        {
            n.drawn = true;
            spawnBurst(x, y, DATA.c.lane[n.side]);
        }
    }

    if (songTime > chart.length) endSong();
}

function tapInput()
{
    if (keyWasPressed('Space') || keyWasPressed('Enter') || keyWasPressed('NumpadEnter') ||
        mouseWasPressed(0) || mouseWasPressed(2))
        tap();
}

function tap()
{
    if (state !== 'play' || !chart) return;

    let bestNote = null, bestDist = 1;
    for (const n of notes)
        if (!n.judged)
        {
            const dist = Math.abs(n.time - songTime);
            if (dist < bestDist) { bestDist = dist; bestNote = n; }
        }
    if (!bestNote) return;

    bestNote.judged = true;
    let i = DATA.judgments.length - 1;
    for (let j = 0; j < DATA.judgments.length - 1; j++)
        if (bestDist <= DATA.judgments[j].window) { i = j; break; }

    const j = DATA.judgments[i];
    score += j.score + combo * DATA.comboBonus;
    combo++;
    if (combo > maxCombo) maxCombo = combo;

    if (j.name == 'MISS')
        combo = 0;
    else
    {
        hits++;
        synthNote(DATA.penta[hits % 5]);
        spawnBurst(bestNote.drawPos.x, bestNote.drawPos.y, DATA.c.lane[bestNote.side]);
    }

    counts[i]++;
    flash = Math.max(flash, i === 0 ? .35 : .2);
    shake = Math.max(shake, i === 0 ? .1 : .05);
    judgeLinePulse = 1;
    hudJudge(j.name, DATA.c.judge[i]);
    if (combo > 1) hudCombo();
}

function endSong()
{
    if (state !== 'play') return;
    if (score > best)
    {
        best = score;
        writeSaveData(SAVE_KEY, { best });
    }
    setState('results');
}

///////////////////////////////////////////////////////////////////////////////
// the stage: backdrop, lanes, the zig-zag that ties the chart together
///////////////////////////////////////////////////////////////////////////////

function renderStage()
{
    const C = DATA.c, S = mainCanvasSize;

    // backdrop
    drawRectGradient(vec2(S.x/2, S.y/2), S, C.bgTop, C.bgBot, 0, true, true);

    // lane columns
    for (let s = 0; s < 2; ++s)
    {
        const x = DATA.laneX[s], c = C.lane[s];
        drawRect(vec2(x, 1), vec2(5.4, DATA.topY - DATA.lineY + 5), alpha(c, .06));
        drawLine(vec2(x, DATA.topY + 3), vec2(x, DATA.lineY - 2), .05, alpha(c, .2));
    }

    // the literal zig-zag: the next notes, chained
    const upcoming = [];
    for (const n of notes)
        if (!n.judged && n.drawPos && upcoming.length < 8) upcoming.push(n);
    if (upcoming.length > 1)
    {
        const pts = upcoming.map(n=> n.drawPos);
        drawLineList(pts, .16, alpha(C.neon, .14));
        drawLineList(pts, .06, alpha(C.ink, .3));
        for (const n of upcoming) drawCircle(n.drawPos, .1, alpha(C.ink, .5));
    }

    // judge line
    const p = judgeLinePulse, w = 11.5;
    drawRect(vec2(0, DATA.lineY), vec2(w, .5 + p*.25), alpha(C.neon, .1 + p*.2));
    drawRect(vec2(0, DATA.lineY), vec2(w, .16), alpha(C.ink, .55 + p*.45));
    drawRect(vec2(0, DATA.lineY), vec2(w, .05), C.ink);
    for (const s of [-1, 1])
        drawRegularPoly(vec2(s*(w/2 - .2), DATA.lineY), vec2(.8 + p*.25), 4,
            alpha(C.neon, .9), .07, C.ink, PI/4);

    // countdown before the chart starts
    if (songTime < 1.1)
    {
        const k = Math.ceil(-songTime + .2);
        const label = k > 0 ? String(Math.min(k, 3)) : 'GO!';
        const pop = 1 - mod(-songTime + .2, 1);
        drawText(label, vec2(0, 1.2), 1.6 + pop*.6, alpha(C.ink, .9), .1, C.bg);
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

class Note extends EngineObject
{
    constructor(n)
    {
        super(vec2(DATA.laneX[n.side], DATA.topY), vec2(2.4, 2.4), undefined, 0, WHITE, 0);
        this.time = n.time;
        this.side = n.side;
        this.drawn = false;
        this.judged = false;
        this.drawPos = vec2();
        this.mass = 0;
    }

    render()
    {
        if (state !== 'play' || !this.drawPos) return;
        const C = DATA.c, c = C.lane[this.side], p = this.drawPos;
        const hot = clamp(1 - Math.abs(songTime - this.time)*3, 0, 1);

        setAdditiveBlendMode(true);
        drawRect(p, vec2(3.4, 1.9), alpha(c, .1 + hot*.14));
        setAdditiveBlendMode(false);

        drawRegularPoly(p, vec2(2.3, 1.15), 6, alpha(c, .95), .08, alpha(C.bg, .9));
        drawRect(p.add(vec2(0, .34)), vec2(2.0, .14), alpha(C.ink, .75));
        drawRect(p.add(vec2(0, -.34)), vec2(2.0, .14), alpha(C.ink, .25));
        drawRect(p, vec2(.2, 1.15), alpha(C.ink, .95));

        if (hot > .01)
        {
            setAdditiveBlendMode(true);
            drawCircle(p, .5 + hot*.5, alpha(C.ink, .12*hot));
            setAdditiveBlendMode(false);
        }
    }
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
