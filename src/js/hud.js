///////////////////////////////////////////////////////////////////////////////
// ZIGZAG SYNTH — hud.js
// Every overlay the player reads: title, hub, play field and results.
// All of it is drawn in screen space (origin top-left, y grows downward).
///////////////////////////////////////////////////////////////////////////////

const HUD = {
    t: 0,
    comboPop: 0,
    judgePop: 0,
    judgeText: '',
    judgeColor: null,
    scoreShown: 0,
};

function hudInit()
{
    HUD.t = 0; HUD.comboPop = 0; HUD.judgePop = 0;
    HUD.judgeText = ''; HUD.judgeColor = DATA.c.ink;
    HUD.scoreShown = 0;
}

// called from the rhythm judge so the HUD can pop
function hudJudge(name, color)
{
    HUD.judgeText = name;
    HUD.judgeColor = color;
    HUD.judgePop = 1;
}
function hudCombo() { HUD.comboPop = 1; }

function hudUpdate()
{
    HUD.t += timeDelta;
    HUD.comboPop = Math.max(0, HUD.comboPop - timeDelta*3.2);
    HUD.judgePop  = Math.max(0, HUD.judgePop  - timeDelta*2.4);
    HUD.scoreShown = lerp(HUD.scoreShown, score, .18);
}

///////////////////////////////////////////////////////////////////////////////
// primitives
///////////////////////////////////////////////////////////////////////////////

function uiText(text, x, y, size, color, o)
{
    o = o || {};
    drawTextScreen(text, vec2(x, y), size, color,
        o.lineWidth || 0, o.lineColor || DATA.c.bg,
        o.align || 'left', o.font || DATA.ui.soft, o.style || 'bold',
        o.maxWidth, o.angle || 0);
}

// letter-spaced text, centred on cx (canvas letterSpacing where supported)
function uiSpaced(text, cx, y, size, color, spacing, o)
{
    o = o || {};
    mainContext.letterSpacing = spacing + 'px';
    uiText(text, cx, y, size, color,
        Object.assign({ align:'center', font: DATA.ui.font, style:'900' }, o));
    mainContext.letterSpacing = '0px';
}

// an angled neon panel — cut corners, dark glass, a bright edge
function uiPanel(x, y, w, h, edge, cut)
{
    cut = cut === undefined ? Math.min(18, h*.28) : cut;
    const C = DATA.c;
    const pts = [
        vec2(x+cut, y), vec2(x+w-cut, y), vec2(x+w, y+cut),
        vec2(x+w, y+h-cut), vec2(x+w-cut, y+h), vec2(x+cut, y+h),
        vec2(x, y+h-cut), vec2(x, y+cut),
    ];
    drawPoly(pts, alpha(C.panel, .86), 0, alpha(edge, .5), vec2(), 0, true, true);
    drawPoly(pts, alpha(C.bg, 0), 2, edge, vec2(), 0, true, true);
    // a hot accent stroke along the top-left chamfer
    drawLine(vec2(x+cut, y+1), vec2(x+w-cut*.4, y+1), 2, alpha(edge, .9), vec2(), 0, true, true);
    drawLine(vec2(x+1, y+cut), vec2(x+1, y+h-cut), 2, alpha(edge, .35), vec2(), 0, true, true);
}

function uiBar(x, y, w, h, value, fill, back)
{
    drawRect(vec2(x + w/2, y + h/2), vec2(w, h), back, 0, true, true);
    const f = clamp(value) * w;
    if (f > 1)
    {
        drawRect(vec2(x + f/2, y + h/2), vec2(f, h), fill, 0, true, true);
        drawRect(vec2(x + f - 1, y + h/2), vec2(3, h), DATA.c.ink, 0, true, true);
    }
}

function uiZig(points, width, color)
{
    drawLineList(points, width, color, false, vec2(), 0, true, true);
}

// a stepped zig-zag polyline across a horizontal span — used as a rule/motif
function uiZigRule(x0, x1, y, steps, amp, width, color)
{
    const pts = [], dx = (x1 - x0) / steps;
    for (let i = 0; i <= steps; ++i)
        pts.push(vec2(x0 + i*dx, y + (i % 2 ? amp : -amp)));
    uiZig(pts, width, color);
}

// full screen fade / flash
function uiFlash()
{
    if (flash > .01)
        drawRect(vec2(mainCanvasSize.x/2, mainCanvasSize.y/2), mainCanvasSize,
            flashColor.copy().setAlpha(flash*.75), 0, true, true);
}

function uiVignette(strength)
{
    const S = mainCanvasSize, C = DATA.c, g = strength === undefined ? .55 : strength;
    const bars = [
        [vec2(S.x/2, S.y*.09), vec2(S.x, S.y*.18), alpha(C.bg, g), alpha(C.bg, 0)],
        [vec2(S.x/2, S.y*.93), vec2(S.x, S.y*.14), alpha(C.bg, 0), alpha(C.bg, g)],
    ];
    for (const [p, s, a, b] of bars)
        drawRectGradient(p, s, a, b, 0, true, true);
}

///////////////////////////////////////////////////////////////////////////////
// TITLE
///////////////////////////////////////////////////////////////////////////////

function hudTitle()
{
    const S = mainCanvasSize, C = DATA.c, cx = S.x/2;
    const titleSize = clamp(S.x*.115, 44, 116);

    // sky
    drawRectGradient(vec2(S.x/2, S.y/2), S, C.bgTop, C.bgBot, 0, true, true);

    // drifting zig-zag bands behind everything
    for (let i = 0; i < 6; ++i)
    {
        const dir = i % 2 ? 1 : -1;
        const y = S.y*(i + .7)/7 + sin(HUD.t*.5 + i*1.7)*22;
        const step = 110 + i*22, amp = 10 + i*5;
        const pts = [], off = mod(HUD.t*26*dir, step*2) - step*2;
        for (let x = off; x < S.x + step*2; x += step)
        {
            pts.push(vec2(x, y));
            pts.push(vec2(x + step/2, y + (i % 2 ? amp : -amp)));
        }
        uiZig(pts, 1 + i*.5, alpha(i % 2 ? C.neon : C.cyan, .10 + i*.025));
    }
    uiVignette(.6);

    // ---- logo ---------------------------------------------------------------
    const logoY = S.y*.30;
    const word = 'MuZiC', opts = { align:'center', font: DATA.ui.font, style:'900' };
    const jitter = sin(HUD.t*8)*.6;
    uiSpaced(word, cx - 6, logoY + 6, titleSize, alpha(C.cyan, .55), titleSize*.045, opts);
    uiSpaced(word, cx + 6, logoY - 4, titleSize, alpha(C.neon, .6), titleSize*.045, opts);
    uiSpaced(word, cx + jitter, logoY, titleSize, C.ink, titleSize*.045,
        Object.assign({ lineWidth: titleSize*.16, lineColor: C.bg }, opts));

    // the rule under the logo is itself a zig-zag
    const ruleW = Math.min(S.x*.62, titleSize*4.6);
    uiZigRule(cx - ruleW/2, cx + ruleW/2, logoY + titleSize*.78,
        14, titleSize*.07, 4, alpha(C.neon, .55));
    uiZigRule(cx - ruleW/2, cx + ruleW/2, logoY + titleSize*.78,
        14, titleSize*.07, 1.5, C.cyan);

    uiSpaced('SWITCH', cx, logoY + titleSize*1.16, titleSize*.30, C.cyan,
        titleSize*.16, { align:'center', font: DATA.ui.font, style:'900',
            lineWidth: titleSize*.05, lineColor: C.bg });
    uiText('PRESS THE ZIGZAG  ·  LITTLEJS JAM 3', cx, logoY + titleSize*1.52,
        clamp(titleSize*.15, 11, 17), alpha(C.dim, .95),
        { align:'center', font: DATA.ui.soft });

    // ---- the character ------------------------------------------------------
    if (S.x > 720)
        drawTetoScreen(vec2(S.x*.13, S.y*.315), clamp(S.x*.15, 96, 190));
    else
        drawTetoScreen(vec2(cx, S.y*.075), clamp(S.x*.13, 70, 130));

    // ---- start prompt -------------------------------------------------------
    // short viewports tuck everything upward so panels never collide
    const snug = S.y < 440;
    const promptY = snug ? S.y*.52 : S.y*.615;
    const pulse = .55 + .45*sin(HUD.t*3.4);
    const wide = Math.min(S.x*.72, 560);
    uiPanel(cx - wide/2, promptY - 30, wide, 60, alpha(C.neon, .5 + pulse*.4), 20);
    uiText('PRESS  ENTER   /   TAP  TO  START', cx, promptY, clamp(S.x*.026, 15, 26),
        alpha(C.ink, .55 + pulse*.45),
        { align:'center', font: DATA.ui.font, style:'900' });

    // chevrons that nudge downward
    for (let i = 0; !snug && i < 2; ++i)
    {
        const yy = promptY + 46 + i*13 + mod(HUD.t*30, 13);
        const a = alpha(C.cyan, .7 - i*.3);
        uiZig([vec2(cx - 10, yy), vec2(cx, yy + 7), vec2(cx + 10, yy)], 3, a);
    }

    // ---- controls -----------------------------------------------------------
    const ch = snug ? 66 : 92;
    const cy2 = snug ? S.y - ch/2 - 46 : S.y*.80, cw = Math.min(S.x*.9, 660);
    uiPanel(cx - cw/2, cy2 - ch/2, cw, ch, alpha(C.cyan, .35), 16);
    if (S.x < 560)
    {
        uiText('WALK  ·  ARROWS / WASD', cx, cy2 - 16, 12, C.ink, { align:'center', font: DATA.ui.font });
        uiText('DRAW A ZIGZAG  ·  HOLD / DRAG', cx, cy2 + 2, 11, C.neonSoft, { align:'center', font: DATA.ui.font });
        uiText('ENTER STAGE  ·  SPACE', cx, cy2 + 20, 12, C.cyan, { align:'center', font: DATA.ui.font });
    }
    else
    {
        const row = snug ? [-14, 4, 22] : [-18, 6, 30];
        uiText('WALK', cx - cw/2 + 26, cy2 + row[0], 14, alpha(C.dim, .9), { font: DATA.ui.soft });
        uiText('ARROWS  /  WASD', cx + cw/2 - 26, cy2 + row[0], 16, C.ink,
            { align:'right', font: DATA.ui.font });
        uiText('DRAW A ZIGZAG', cx - cw/2 + 26, cy2 + row[1], 14, alpha(C.dim, .9), { font: DATA.ui.soft });
        uiText('HOLD / DRAG THE MOUSE', cx + cw/2 - 26, cy2 + row[1], 16, C.neonSoft,
            { align:'right', font: DATA.ui.font });
        uiText('ENTER THE STAGE', cx - cw/2 + 26, cy2 + row[2], 14, alpha(C.dim, .9), { font: DATA.ui.soft });
        uiText('WALK IN  ·  SPACE', cx + cw/2 - 26, cy2 + row[2], 16, C.cyan,
            { align:'right', font: DATA.ui.font });
    }

    // ---- best ---------------------------------------------------------------
    if (best > 0)
        uiText('BEST  ' + String(best).padStart(6, '0'), cx, S.y*.955, 17,
            alpha(C.gold, .9), { align:'center', font: DATA.ui.font });
}

// the same character on the title card: park the camera math and borrow drawTeto
function drawTetoScreen(pos, sizePx)
{
    const scale = sizePx / (.9 * cameraScale);
    drawTeto(screenToWorld(pos), scale, HUD.t*3, 1, sin(HUD.t*.8)*.07,
        1 + sin(HUD.t*2.6)*.04, 1 - sin(HUD.t*2.6)*.04, 0, 0);
}

///////////////////////////////////////////////////////////////////////////////
// WORLD HUB
///////////////////////////////////////////////////////////////////////////////

function hudWorld()
{
    const S = mainCanvasSize, C = DATA.c;
    const talking = typeof Dialog != 'undefined' && Dialog.isOpen();
    const world = (typeof owGetWorld == 'function' ? owGetWorld()
        : (typeof currentWorld != 'undefined' ? currentWorld : 'zig'));
    const zag = world == 'zag';
    const accent = (typeof owPal != 'undefined' && owPal && owPal.accent)
        || (zag ? C.neon : C.cyan);

    uiVignette(.5);

    const compact = S.x < 620;
    const pulseB = .5 + .5*sin(HUD.t*2.2);

    if (compact) {
        // Three small chips stay in a single row on phones.
        const x0 = 12, gap = 6;
        const logoW = Math.min(106, S.x*.34), logoH = 46;
        const badgeW = Math.min(68, S.x*.22), badgeX = x0 + logoW + gap;
        uiPanel(x0, 12, logoW, logoH, alpha(C.neon, .45), 12);
        uiText('MUZIC', x0 + 9, 29, 15, C.ink, { font: DATA.ui.font, style:'900' });
        uiText('SWITCH', x0 + 9, 45, 9, C.cyan, { font: DATA.ui.font, style:'900' });

        uiPanel(badgeX, 12, badgeW, logoH, alpha(accent, .4 + pulseB*.3), 12);
        uiText('WORLD', badgeX + badgeW/2, 25, 8, alpha(C.dim, .9), { align:'center', font: DATA.ui.font });
        uiText(zag ? 'ZAG' : 'ZIG', badgeX + badgeW/2, 43, 17, accent,
            { align:'center', font: DATA.ui.font, style:'900', lineWidth: 2, lineColor: alpha(C.bg, .8) });

        if (selectedSong) {
            uiPanel(12, 66, S.x - 24, 48, alpha(accent, .38), 12);
            uiText('NEXT STAGE  ' + selectedSong.id, 22, 82, 9, alpha(C.dim, .95), { font: DATA.ui.font });
            uiText('BEST ' + String(best).padStart(6, '0'), S.x - 22, 82, 9, C.gold,
                { align:'right', font: DATA.ui.font, style:'900' });
            uiText(selectedSong.name, 22, 101, 13, C.ink,
                { font: DATA.ui.font, style:'900', maxWidth: S.x - 46 });
        }
    } else {
        // ---- logo chip, top left --------------------------------------------
        uiPanel(16, 14, 208, 54, alpha(C.neon, .45), 14);
        uiText('MUZIC', 34, 32, 20, C.ink, { font: DATA.ui.font, style:'900' });
        uiText('SWITCH', 34, 52, 12, C.cyan, { font: DATA.ui.font, style:'900' });
        uiZig([vec2(150, 26), vec2(162, 38), vec2(174, 26), vec2(186, 38), vec2(198, 26)],
            2.5, alpha(C.neon, .8));

        // ---- world badge, beside the logo chip ------------------------------
        const badgeW = 118, badgeX = 236;
        uiPanel(badgeX, 14, badgeW, 54, alpha(accent, .4 + pulseB*.3), 14);
        uiText('WORLD', badgeX + 16, 30, 10, alpha(C.dim, .9), { font: DATA.ui.font });
        uiText(zag ? 'ZAG' : 'ZIG', badgeX + badgeW - 16, 44, 26, accent,
            { align:'right', font: DATA.ui.font, style:'900',
              lineWidth: 3, lineColor: alpha(C.bg, .8) });

        if (selectedSong) {
            const sw = Math.min(340, S.x*.42), sx = S.x - sw - 16;
            uiPanel(sx, 14, sw, 54, alpha(accent, .38), 14);
            uiText('NEXT STAGE  ' + selectedSong.id, sx + 16, 31, 11, alpha(C.dim, .95), { font: DATA.ui.font });
            uiText(selectedSong.name, sx + 16, 51, 16, C.ink, { font: DATA.ui.font, style:'900', maxWidth: sw - 32 });
            uiText('PAGE UP / DOWN TO SELECT', sx + sw - 2, 79, 10, alpha(C.dim, .72), { align:'right', font: DATA.ui.soft });
        }

        // ---- best, top right or below the stage chip ------------------------
        const bw = 172, bestY = selectedSong ? 80 : 14;
        uiPanel(S.x - bw - 16, bestY, bw, 54, alpha(C.gold, .4), 14);
        uiText('BEST', S.x - bw - 16 + 18, bestY + 18, 12, alpha(C.dim, .9), { font: DATA.ui.font });
        uiText(String(best).padStart(6, '0'), S.x - 34, bestY + 36, 22, C.gold,
            { align:'right', font: DATA.ui.font, style:'900' });
    }

    // ---- world-shift banner -------------------------------------------------
    if (typeof owWorldSwitching == 'function' && owWorldSwitching())
    {
        const from = (typeof owSwitchFromName != 'undefined' && owSwitchFromName || 'zig').toUpperCase();
        const a = .55 + .45*sin(HUD.t*10);
        uiSpaced(from + '  →  ' + (zag ? 'ZAG' : 'ZIG'), S.x/2, S.y*.18,
            clamp(S.x*.045, 22, 46), alpha(accent, a), 5,
            { align:'center', font: DATA.ui.font, style:'900',
              lineWidth: 6, lineColor: alpha(C.bg, .85) });
        uiText('SHIFTING WORLDS', S.x/2, S.y*.18 + clamp(S.x*.035, 16, 34),
            13, alpha(C.ink, .7), { align:'center', font: DATA.ui.soft });
    }

    // ---- control hints, bottom left (hidden while a dialog is up) -----------
    if (!talking)
    {
        if (compact) {
            const hy = S.y - 54, fs = 10;
            uiText('MOVE  WASD / ARROWS', 12, hy, fs, C.ink, { font: DATA.ui.font, style:'800', maxWidth:S.x*.58 });
            uiText('SWITCH  DOWN', S.x - 12, hy, fs, accent, { align:'right', font: DATA.ui.font, style:'800', maxWidth:S.x*.38 });
            uiText('INTERACT  ENTER', 12, hy + 20, fs, C.cyan, { font: DATA.ui.font, style:'800', maxWidth:S.x*.48 });
            uiText('PAUSE  ESC', S.x - 12, hy + 20, fs, alpha(C.ink,.9), { align:'right', font: DATA.ui.font, style:'800', maxWidth:S.x*.38 });
        } else {
            const hy = S.y - 72;
            uiText('Move', 24, hy, 14, alpha(C.dim, .85), { font: DATA.ui.soft });
            uiText('WASD / ARROWS', 168, hy, 14, C.ink, { font: DATA.ui.font, style:'900' });
            uiText('Switch world', 24, hy + 20, 14, alpha(C.dim, .85), { font: DATA.ui.soft });
            uiText('DOWN', 168, hy + 20, 14, accent, { font: DATA.ui.font, style:'900' });
            uiText('Interact', 24, hy + 40, 14, alpha(C.dim, .85), { font: DATA.ui.soft });
            uiText('ENTER', 168, hy + 40, 14, C.cyan, { font: DATA.ui.font, style:'900' });
            uiText('Menu', 24, hy + 60, 14, alpha(C.dim, .85), { font: DATA.ui.soft });
            uiText('ESC', 168, hy + 60, 14, alpha(C.ink, .9), { font: DATA.ui.font, style:'900' });
        }
    }

    // ---- the portal prompt --------------------------------------------------
    if (player && !talking)
    {
        const d = player.pos.subtract(portalPos).length();
        if (d < DATA.world.portalPrompt)
        {
            const pulse = .55 + .45*sin(HUD.t*4);
            const w = Math.min(S.x*.7, 520), y = S.y*.74;
            uiPanel(S.x/2 - w/2, y - 28, w, 56, alpha(C.neon, .55 + pulse*.4), 18);
            uiText('PRESS  SPACE   /   TAP  TO  ENTER', S.x/2, y,
                clamp(S.x*.026, 14, 25), alpha(C.ink, .6 + pulse*.4),
                { align:'center', font: DATA.ui.font, style:'900' });
            uiText('or just walk in', S.x/2, y + 40, 13, alpha(C.cyan, .8),
                { align:'center', font: DATA.ui.soft });
        }
    }

    uiFlash();
}

///////////////////////////////////////////////////////////////////////////////
// PLAY FIELD
///////////////////////////////////////////////////////////////////////////////

function hudPlay()
{
    const S = mainCanvasSize, C = DATA.c;
    const compact = S.x < 600;

    // ---- score, top left ----------------------------------------------------
    const pw = compact ? Math.min(160, S.x*.47) : Math.min(250, S.x*.3), px = compact ? 12 : 18, py = compact ? 12 : 16;
    uiPanel(px, py, pw, compact ? 62 : 74, alpha(C.cyan, .4), 16);
    uiText('SCORE', px + 12, py + 18, compact ? 10 : 13, alpha(C.dim, .95), { font: DATA.ui.font });
    uiText(String(Math.round(HUD.scoreShown)).padStart(6, '0'), px + pw - 12, py + 43, compact ? 22 : 30,
        C.ink, { align:'right', font: DATA.ui.font, style:'900' });

    // ---- progress, top centre -----------------------------------------------
    const bw = compact ? Math.min(S.x*.74, 420) : Math.min(S.x*.36, 420), bx = S.x/2 - bw/2;
    const total = chart ? clamp(songTime / chart.length) : 0;
    uiText(chart && chart.title || 'DEMO PULSE', S.x/2, compact ? 101 : 26, compact ? 12 : 13, alpha(C.dim, .9),
        { align:'center', font: DATA.ui.font });
    const progressY = compact ? 118 : 40;
    uiBar(bx, progressY, bw, 10, total, C.neon, alpha(C.bg, .7));
    for (let i = 1; i < 8; ++i)
        drawRect(vec2(bx + bw*i/8, progressY + 5), vec2(1.5, 10), alpha(C.bg, .8), 0, true, true);

    // ---- health --------------------------------------------------------------
    const hpW = compact ? Math.min(S.x*.72, 280) : Math.min(S.x*.22, 220), hpX = S.x/2 - hpW/2;
    const hpY = compact ? 80 : 70;
    uiText('HP  ' + Math.ceil(health), S.x/2, hpY - 5, compact ? 11 : 12,
        health <= 25 ? C.bad : alpha(C.dim, .95), { align:'center', font: DATA.ui.font });
    uiBar(hpX, hpY + 6, hpW, 8, health / 100, health <= 25 ? C.bad : C.cyan, alpha(C.bg, .7));

    // ---- combo, top right ---------------------------------------------------
    const cp = 1 + HUD.comboPop*.55;
    if (combo > 1)
    {
        uiText('COMBO', S.x - 26, 30, 13, alpha(C.dim, .95),
            { align:'right', font: DATA.ui.font });
        uiText(String(combo), S.x - 22, 62, 42*cp, HUD.comboPop > .02 ? C.gold : C.ink,
            { align:'right', font: DATA.ui.font, style:'900',
              lineWidth: 5, lineColor: alpha(C.bg, .8) });
    }

    // ---- judgment -----------------------------------------------------------
    if (HUD.judgePop > .01)
    {
        const p = HUD.judgePop, sc = 1 + (1-p)*.0 + Math.sin(p*Math.PI)*.35;
        uiSpaced(HUD.judgeText, S.x/2, S.y*.30, clamp(S.x*.052, 26, 56)*sc,
            alpha(HUD.judgeColor, Math.min(1, p*2)), 4,
            { align:'center', font: DATA.ui.font, style:'900',
              lineWidth: 7, lineColor: alpha(C.bg, .85) });
    }

    // ---- hint ---------------------------------------------------------------
    uiText(fourLaneMode ? 'FOUR LANES   ·   D F J K   ·   MOUSE / TOUCH' : 'TAP NEAR THE LINE   ·   SPACE / ENTER', S.x/2, S.y - 22, 13,
        alpha(C.dim, .6), { align:'center', font: DATA.ui.soft });

    if (stageNotice)
        uiText(stageNotice, S.x/2, compact ? 145 : 96, 12, alpha(C.gold, .9), { align:'center', font: DATA.ui.soft, maxWidth: S.x*.85 });
    if (window.ZIGZAG_EDITOR_MODE && typeof playSimulation != 'undefined')
        uiText('SIM ' + Math.round(playSimulation.measuredTPS) + ' / 240 TPS', S.x - 20, 96, 11,
            alpha(C.cyan, .86), { align:'right', font: DATA.ui.font });

    uiFlash();
}

///////////////////////////////////////////////////////////////////////////////
// RESULTS
///////////////////////////////////////////////////////////////////////////////

function hudResults()
{
    const S = mainCanvasSize, C = DATA.c;
    const w = Math.min(S.x*.88, 640), h = Math.min(S.y - 20, clamp(S.y*.88, 330, 560));
    const x = S.x/2 - w/2, y = S.y/2 - h/2;
    const k = h/560;                       // vertical squeeze on short screens

    // dim the field behind
    drawRect(vec2(S.x/2, S.y/2), S, alpha(C.bg, .72), 0, true, true);
    uiZigRule(-40, S.x + 40, y - 26, 26, 7, 3, alpha(C.neon, .5));

    uiPanel(x, y, w, h, alpha(C.neon, .55), 26);

    const cleared = !(playResult && playResult.failed) && score > 0 && (counts[0] + counts[1]) > 0;
    uiSpaced(cleared ? 'STAGE CLEAR' : 'STAGE MISS', S.x/2, y + 50*k,
        clamp(w*.115, 24, 46), cleared ? C.gold : C.bad, 4,
        { align:'center', font: DATA.ui.font, style:'900',
          lineWidth: 6, lineColor: alpha(C.bg, .85) });

    // big score
    uiText(String(score).padStart(6, '0'), S.x/2, y + 116*k, clamp(w*.15, 38, 72), C.ink,
        { align:'center', font: DATA.ui.font, style:'900',
          lineWidth: 7, lineColor: alpha(C.bg, .8) });
    uiText('SCORE', S.x/2, y + 152*k, 13, alpha(C.dim, .9),
        { align:'center', font: DATA.ui.font });

    // stat rows
    const rowX = x + 46, rowW = w - 92, step = 34*k;
    let ry = y + 196*k;
    uiRow(rowX, ry, rowW, 'MAX COMBO', String(maxCombo), C.cyan, false, k); ry += step;
    const names = ['PERFECT', 'GREAT', 'GOOD', 'MISS'];
    for (let i = 0; i < 4; ++i)
    {
        uiRow(rowX, ry, rowW, names[i], String(counts[i]), DATA.c.judge[i], false, k);
        ry += step;
    }

    // best
    ry += 8*k;
    const isBest = score >= best && score > 0;
    drawRect(vec2(S.x/2, ry + 4), vec2(rowW, 32*k), alpha(isBest ? C.gold : C.cyan, .12), 0, true, true);
    uiText('BEST', rowX, ry, Math.max(11, 15*k), alpha(C.dim, .95), { font: DATA.ui.font });
    uiText(String(best).padStart(6, '0'), rowX + rowW, ry + 2*k, Math.max(16, 24*k), C.gold,
        { align:'right', font: DATA.ui.font, style:'900' });
    if (isBest)
        uiText('NEW BEST!', rowX + rowW, ry + 25*k, Math.max(10, 12*k), C.gold,
            { align:'right', font: DATA.ui.font, style:'900' });

    // prompt
    const pulse = .55 + .45*sin(HUD.t*3.4);
    uiText('PRESS  SPACE   /   TAP  TO  RETURN', S.x/2, y + h - 30,
        clamp(w*.042, 13, 20), alpha(C.ink, .5 + pulse*.5),
        { align:'center', font: DATA.ui.font, style:'900' });

    uiFlash();
}

function uiRow(x, y, w, label, value, color, big, k=1)
{
    const C = DATA.c;
    uiText(label, x, y, (big ? 22 : 18)*k, alpha(C.dim, .95), { font: DATA.ui.font });
    uiText(value, x + w, y + (big ? 3 : 2)*k, (big ? 30 : 22)*k, color,
        { align:'right', font: DATA.ui.font, style:'900' });
    drawLine(vec2(x, y + 15*k), vec2(x + w, y + 15*k), 1, alpha(C.cyan, .14), vec2(), 0, true, true);
}
