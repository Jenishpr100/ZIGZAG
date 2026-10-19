///////////////////////////////////////////////////////////////////////////////
// MuZiC Switch — hud.js
// The two gameplay HUDs (overworld hub + rhythm field) and the one panel the
// OG DOM menu does not have: the E inventory drawer.
// There is deliberately NO title screen, NO results screen and NO pause menu
// here — index.html + js/menu.js own every menu. All of this is drawn in screen
// space (origin top-left, y grows downward).
///////////////////////////////////////////////////////////////////////////////

const HUD = {
    t: 0,
    comboPop: 0,
    judgePop: 0,
    judgeText: '',
    judgeColor: null,
    scoreShown: 0,

    // ---- the E inventory drawer --------------------------------------------
    overlay: null,          // null | 'inventory'
    overlayT: 0,            // seconds since the drawer opened (entrance anim)
    overlayMsg: '',         // transient footer message
    overlayMsgT: 0,
    overlayLatch: false,    // swallow the key that opened/closed the drawer
    lastUpdateFrame: -1,    // frame de-dup so updateOverlays() is idempotent
    mask: null,             // movement keys saved+zeroed for this frame
    maskTick: -1,           // HUD.tick the mask was taken on (staleness check)
    tick: 0,                // frames seen, for the mask staleness check
    postHooked: false,      // engine plugin registered (restores the mask)
};

// expose on window too — littlejs-game.js / overworld.js call HUD.* directly
if (typeof window != 'undefined') window.HUD = HUD;

function hudInit()
{
    HUD.t = 0; HUD.comboPop = 0; HUD.judgePop = 0;
    HUD.judgeText = ''; HUD.judgeColor = DATA.c.ink;
    HUD.scoreShown = 0;
    HUD.overlay = null; HUD.overlayT = 0;
    HUD.overlayMsg = ''; HUD.overlayMsgT = 0; HUD.overlayLatch = false;
    HUD.lastUpdateFrame = -1; HUD.mask = null; HUD.maskTick = -1;
    hudHookPostUpdate();
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
    // the locked control scheme (Q quit / E inventory) — handled here so it works
    // with no extra wiring in littlejs-game.js; updateOverlays() is frame-
    // idempotent so an explicit call there too is harmless.
    HUD.updateOverlays(timeDelta);
    if (HUD.overlay) HUD.overlayT += timeDelta;
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
    // mainContext is absent in headless — degrade to plain centred text
    const ctx = typeof mainContext != 'undefined' ? mainContext : null;
    if (ctx) ctx.letterSpacing = spacing + 'px';
    uiText(text, cx, y, size, color,
        Object.assign({ align:'center', font: DATA.ui.font, style:'900' }, o));
    if (ctx) ctx.letterSpacing = '0px';
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

    // ---- logo chip, top left ------------------------------------------------
    uiPanel(16, 14, 208, 54, alpha(C.neon, .45), 14);
    uiText('MuZiC', 34, 32, 20, C.ink, { font: DATA.ui.font, style:'900' });
    uiText('SWITCH', 34, 52, 12, C.cyan, { font: DATA.ui.font, style:'900' });
    uiZig([vec2(150, 26), vec2(162, 38), vec2(174, 26), vec2(186, 38), vec2(198, 26)],
        2.5, alpha(C.neon, .8));

    // ---- world badge, beside the logo chip ----------------------------------
    const badgeW = 118, badgeX = 236, pulseB = .5 + .5*sin(HUD.t*2.2);
    uiPanel(badgeX, 14, badgeW, 54, alpha(accent, .4 + pulseB*.3), 14);
    uiText('WORLD', badgeX + 16, 30, 10, alpha(C.dim, .9), { font: DATA.ui.font });
    uiText(zag ? 'ZAG' : 'ZIG', badgeX + badgeW - 16, 44, 26, accent,
        { align:'right', font: DATA.ui.font, style:'900',
          lineWidth: 3, lineColor: alpha(C.bg, .8) });

    // ---- player status chip (HP bar + level), under the logo ----------------
    hudStatusChip();

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

    // ---- best, top right ----------------------------------------------------
    const bw = 172;
    uiPanel(S.x - bw - 16, 14, bw, 54, alpha(C.gold, .4), 14);
    uiText('BEST', S.x - bw - 16 + 18, 32, 12, alpha(C.dim, .9), { font: DATA.ui.font });
    uiText(String(best).padStart(6, '0'), S.x - 34, 50, 22, C.gold,
        { align:'right', font: DATA.ui.font, style:'900' });

    // ---- room name, under the top strip -------------------------------------
    const roomName = (typeof owGetRoomName == 'function' ? owGetRoomName() : '');
    if (roomName)
        uiText(roomName.toUpperCase(), S.x/2, 86, 13, alpha(C.dim, .75),
            { align:'center', font: DATA.ui.font });

    // ---- control hints, bottom left (hidden while a dialog or the drawer is up)
    if (!talking && !HUD.overlay)
    {
        const hy = S.y - 112;
        uiText('Move', 24, hy, 14, alpha(C.dim, .85), { font: DATA.ui.soft });
        uiText('WASD / ARROWS', 176, hy, 14, C.ink, { font: DATA.ui.font, style:'900' });
        uiText('Switch world', 24, hy + 18, 14, alpha(C.dim, .85), { font: DATA.ui.soft });
        uiText('↓', 176, hy + 18, 14, accent, { font: DATA.ui.font, style:'900' });
        uiText('Inventory', 24, hy + 36, 14, alpha(C.dim, .85), { font: DATA.ui.soft });
        uiText('E', 176, hy + 36, 14, C.gold, { font: DATA.ui.font, style:'900' });
        uiText('Main menu', 24, hy + 54, 14, alpha(C.dim, .85), { font: DATA.ui.soft });
        uiText('Q', 176, hy + 54, 14, C.bad, { font: DATA.ui.font, style:'900' });
        uiText('Interact', 24, hy + 72, 14, alpha(C.dim, .85), { font: DATA.ui.soft });
        uiText('ENTER', 176, hy + 72, 14, C.cyan, { font: DATA.ui.font, style:'900' });
        uiText('Talk', 24, hy + 90, 14, alpha(C.dim, .85), { font: DATA.ui.soft });
        uiText('SPACE', 176, hy + 90, 14, C.neonSoft, { font: DATA.ui.font, style:'900' });
    }

    // ---- the portal prompt --------------------------------------------------
    const portalOn = typeof owPortalActive == 'undefined' ? true : owPortalActive;
    if (player && !talking && !HUD.overlay && portalOn)
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
    HUD.renderOverlay();       // E inventory drawer — on top of the HUD
}

///////////////////////////////////////////////////////////////////////////////
// PLAY FIELD
///////////////////////////////////////////////////////////////////////////////

function hudPlay()
{
    const S = mainCanvasSize, C = DATA.c;

    // ---- score, top left ----------------------------------------------------
    const pw = Math.min(250, S.x*.3), px = 18, py = 16;
    uiPanel(px, py, pw, 74, alpha(C.cyan, .4), 16);
    uiText('SCORE', px + 20, py + 22, 13, alpha(C.dim, .95), { font: DATA.ui.font });
    uiText(String(Math.round(HUD.scoreShown)).padStart(6, '0'), px + pw - 18, py + 48, 30,
        C.ink, { align:'right', font: DATA.ui.font, style:'900' });

    // ---- progress, top centre -----------------------------------------------
    const bw = Math.min(S.x*.36, 420), bx = S.x/2 - bw/2;
    const total = chart ? clamp(songTime / chart.length) : 0;
    uiText('ZIGZAG ETUDE', S.x/2, 26, 13, alpha(C.dim, .9),
        { align:'center', font: DATA.ui.font });
    uiBar(bx, 40, bw, 10, total, C.neon, alpha(C.bg, .7));
    for (let i = 1; i < 8; ++i)
        drawRect(vec2(bx + bw*i/8, 45), vec2(1.5, 10), alpha(C.bg, .8), 0, true, true);

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
    // the locked arrow-key model: L/R hold+tap, ↑ flick, ↓ lane swap
    uiText('←→ HOLD + TAP  ·  ↑ FLICK  ·  ↓ SWAP LANE  ·  ZIGZAG!',
        S.x/2, S.y - 22, 13, alpha(C.dim, .6),
        { align:'center', font: DATA.ui.soft });

    // ---- player vitals (HP bar + level), tucked under the score chip ---------
    hudPlayVitals();

    uiFlash();
    HUD.renderOverlay();       // E inventory drawer — on top of the HUD
}

/** the compact HP/level chip for the rhythm field (world uses hudStatusChip) */
function hudPlayVitals()
{
    const C = DATA.c, ps = hudSyncPlayerState();
    const frac = ps.maxHp > 0 ? ps.hp / ps.maxHp : 0;
    const w = Math.min(210, mainCanvasSize.x*.26), h = 48, x = 18;
    const y = 100;

    uiPanel(x, y, w, h, alpha(C.cyan, .35), 14);
    uiText('HP', x + 14, y + 18, 11, alpha(C.dim, .95), { font: DATA.ui.font });
    uiBar(x + 36, y + 9, w - 92, 12, frac, hudHPColor(frac), alpha(C.bg, .75));
    uiText(Math.ceil(ps.hp) + '/' + ps.maxHp, x + w - 14, y + 19, 12,
        frac > .22 ? C.ink : C.bad, { align:'right', font: DATA.ui.font, style:'900' });
    uiText('Lv. ' + ps.level, x + 14, y + 38, 13, C.gold,
        { font: DATA.ui.font, style:'900' });
    uiText('Q MENU', x + w - 14, y + 38, 11, alpha(C.dim, .8),
        { align:'right', font: DATA.ui.font, style:'900' });
}

///////////////////////////////////////////////////////////////////////////////
// PLAYER STATE — the single source of truth the HUD, the inventory and
// battle.js all agree on (window.playerState is seeded in data.js)
///////////////////////////////////////////////////////////////////////////////

/** window.playerState, created on demand so hud.js works even if data.js is stale */
function hudPlayerState()
{
    if (typeof window != 'undefined' && !window.playerState)
        window.playerState = { hp: 100, maxHp: 100, level: 1, exp: 0 };
    return (typeof window != 'undefined' && window.playerState)
        || { hp: 100, maxHp: 100, level: 1, exp: 0 };
}

/** mirror the live battle hp onto playerState (top-level `let` in littlejs-game.js) */
function hudSyncPlayerState()
{
    const ps = hudPlayerState();
    try
    {
        if (typeof battlePlayer != 'undefined' && battlePlayer)
        {
            ps.hp = battlePlayer.hp;
            ps.maxHp = battlePlayer.maxHp || ps.maxHp;
        }
    }
    catch (e) {}          // battlePlayer not evaluated yet (TDZ) — ignore
    if (!(ps.maxHp > 0)) ps.maxHp = 100;
    ps.hp = Math.max(0, Math.min(ps.maxHp, ps.hp || 0));
    if (!ps.level) ps.level = 1;
    return ps;
}

/** starter inventory from DATA.playerInventory, normalised for drawing */
function hudInventory()
{
    const inv = (typeof DATA != 'undefined' && DATA.playerInventory) || null;
    const weapons = inv && inv.weapons && inv.weapons.length ? inv.weapons
        : [{ name: 'ZIGZAG FISTS', atk: 6 }];
    const items = inv && inv.items && inv.items.length ? inv.items
        : [{ name: 'POTION', qty: 1, desc: 'Restores 30 HP.' }];
    return { weapons, items };
}

const hudHPColor = (frac)=> frac > .5 ? DATA.c.good : (frac > .22 ? DATA.c.ok : DATA.c.bad);

///////////////////////////////////////////////////////////////////////////////
// WORLD / PLAY STATUS CHIP  (BUG 7 — HP bar + level in the overworld)
///////////////////////////////////////////////////////////////////////////////

/** the small status chip under the logo: HP bar, Lv, equipped weapon */
function hudStatusChip()
{
    const C = DATA.c, ps = hudSyncPlayerState();
    const accent = (typeof owPal != 'undefined' && owPal && owPal.accent) || C.neon;
    const x = 16, y = 76, w = 208, h = 54;
    const hpFrac = ps.maxHp > 0 ? ps.hp / ps.maxHp : 0;

    uiPanel(x, y, w, h, alpha(accent, .38), 14);
    uiText('HP', x + 16, y + 20, 11, alpha(C.dim, .95), { font: DATA.ui.font });
    uiBar(x + 40, y + 11, w - 92, 13, hpFrac, hudHPColor(hpFrac), alpha(C.bg, .75));
    uiText(Math.ceil(ps.hp) + '/' + ps.maxHp, x + w - 16, y + 21, 12,
        hpFrac > .22 ? C.ink : C.bad, { align:'right', font: DATA.ui.font, style:'900' });

    uiText('Lv. ' + ps.level, x + 16, y + 42, 14, C.gold,
        { font: DATA.ui.font, style:'900' });
    const wp = hudInventory().weapons[0];
    if (wp)
        uiText(wp.name + '  ATK ' + (wp.atk === undefined ? wp.power : wp.atk),
            x + w - 16, y + 41, 11, alpha(C.ink, .6),
            { align:'right', font: DATA.ui.soft });
}

// E inventory drawer, Q quit   (BUGS 5 + 8)
//
// Everything is self-contained in hud.js so littlejs-game.js / overworld.js
// never need to change. The drawer is drawn from hudWorld()/hudPlay() (both
// already called by gameRenderPost) and the keys are polled from hudUpdate()
// (already called by gameUpdate). There is NO pause menu here: the OG DOM menu
// (index.html + js/menu.js) owns pause, settings and the title.
/////////////////////////////////////////////////////////////////////////////

function hudDialogBusy()
{
    return typeof Dialog != 'undefined' && Dialog && (Dialog.isOpen() || Dialog.latch);
}

function hudState()
{
    return typeof state != 'undefined' ? state : '';
}

/** is the HUD drawer on screen right now? */
HUD.overlayOpen = function () { return HUD.overlay !== null; };

/** E — toggle the inventory drawer */
HUD.showInventory = function (byKey)
{
    if (!hudOverlaysAllowed()) return false;
    if (HUD.overlay == 'inventory') { HUD.hideOverlays(byKey); return false; }
    HUD.overlay = 'inventory'; HUD.overlayT = 0;
    HUD.overlayLatch = byKey || 'KeyE';
    return true;
};

/** the drawer only exists where the locked scheme allows it: no dialog up, and
 *  never in 'idle' — there the DOM menu owns the screen. */
function hudOverlaysAllowed()
{
    if (hudDialogBusy()) return false;
    const s = hudState();
    return s == 'world' || s == 'play';
}

/** close the drawer. `byKey` latches the closing key so the very same physical
 *  press can never immediately reopen the drawer. */
HUD.hideOverlays = function (byKey)
{
    if (!HUD.overlay) return false;
    HUD.overlay = null; HUD.overlayT = 0;
    HUD.overlayLatch = byKey || false;
    return true;
};

/** Q — hand the screen back to the OG DOM menu (there is no canvas title screen
 *  left to go to). No-op if the engine file is not loaded. */
HUD.quitToTitle = function (screen)
{
    const s = hudState();
    if (s != 'world' && s != 'play') return false;
    HUD.hideOverlays();
    if (typeof zzLaneRelease == 'function') zzLaneRelease(screen || 'menu');
    return true;
};

HUD.flash = function (msg, secs)
{
    HUD.overlayMsg = String(msg || '');
    HUD.overlayMsgT = secs === undefined ? 2.2 : secs;
};

/**
 * Per-frame overlay input. Q hands the screen back to the DOM menu, E opens
 * the inventory drawer, Esc closes it. Safe to call more than once per frame —
 * only the first call acts. Whatever the outcome, the movement keys get masked
 * for the rest of the frame so gameplay code can't steal an input the drawer
 * owns.
 */
HUD.updateOverlays = function (dt)
{
    HUD.tick++;
    // undo last frame's mask BEFORE reading anything
    HUD.restoreMovement();

    if (typeof timeReal != 'undefined')
    {
        if (HUD.lastUpdateFrame === timeReal)
        {
            // LittleJS's fixed-step loop can run gameUpdate twice for one
            // timeReal; the second pass only re-applies the mask
            hudMaskMovement();
            return false;
        }
        HUD.lastUpdateFrame = timeReal;
    }
    if (typeof dt != 'number' || dt < 0) dt = typeof timeDelta != 'undefined' ? timeDelta : 1/60;
    try { return hudOverlayKeys(dt); }
    finally { hudMaskMovement(); }
};

function hudOverlayKeys(dt)
{
    HUD.overlayMsgT = Math.max(0, HUD.overlayMsgT - dt);
    if (!HUD.overlayMsgT) HUD.overlayMsg = '';

    // the key that opened/closed the panel stays latched until it is released,
    // so one physical press can never toggle a panel twice
    if (HUD.overlayLatch)
    {
        const code = HUD.overlayLatch;
        const stillDown = typeof keyIsDown == 'function' && keyIsDown(code);
        if (!stillDown) HUD.overlayLatch = false;
        return true;
    }

    const s = hudState();
    const talking = hudDialogBusy();
    const hit = k => typeof keyWasPressed == 'function' && keyWasPressed(k);

    // ---- Q: hand the screen back to the OG DOM menu -------------------------
    if (!talking && hit('KeyQ') && (s == 'world' || s == 'play'))
    {
        HUD.quitToTitle();
        return true;
    }

    if (talking) return false;

    // ---- E: inventory drawer / ESC: close it -------------------------------
    if (hit('KeyE')) { HUD.showInventory('KeyE'); return true; }
    if (hit('Escape'))
    {
        // ESC with nothing open is the DOM menu's business (its own keydown
        // handler brings the player back to the main menu)
        if (HUD.overlay) { HUD.hideOverlays('Escape'); return true; }
    }

    // an open drawer swallows the rest of the frame's keys
    return HUD.overlay !== null;
};

///////////////////////////////////////////////////////////////////////////////
// input masking — an open drawer owns the movement keys
//
// LittleJS does not rasterise draw calls immediately (they go into the WebGL
// batch and are flushed in the render pass), and engineObjectsUpdate() — what
// runs Player.update() and PlayNote.tick() — happens AFTER gameUpdate(). So
// while the drawer is open we save the movement keys and zero them for the rest
// of the frame; the save is undone at the top of the NEXT frame's
// updateOverlays(). That keeps the mask live across gameUpdate,
// gameUpdatePost and engineObjectsUpdate, without ever touching the engine's
// own edge-bit bookkeeping (inputUpdatePost does its `&= 1` regardless).
///////////////////////////////////////////////////////////////////////////////

const HUD_MASK_KEYS = ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',
                       'KeyW','KeyA','KeyS','KeyD'];

/** undo the previous frame's mask — call FIRST, before any key is read */
HUD.restoreMovement = function ()
{
    const save = HUD.mask;
    if (!save) return;
    HUD.mask = null;
    // only ever restore a mask that is one frame old: LittleJS clears all
    // input when the canvas loses focus, and resurrecting a stale hold would
    // leave the player walking into a wall on their own
    if (HUD.maskTick >= 0 && HUD.tick - HUD.maskTick > 2) return;
    const d = (typeof inputData != 'undefined' && inputData) ? inputData[0] : null;
    if (d) for (const k in save) d[k] = save[k];
};

/** apply the mask for the rest of this frame — call LAST */
function hudMaskMovement()
{
    HUD.restoreMovement();
    if (!HUD.overlay) return;
    const d = (typeof inputData != 'undefined' && inputData) ? inputData[0] : null;
    if (!d) return;
    const save = {};
    for (const k of HUD_MASK_KEYS)
        if (d[k]) { save[k] = d[k] & 1; d[k] = 0; }   // keep the HOLD bit only
    if (Object.keys(save).length) { HUD.mask = save; HUD.maskTick = HUD.tick; }
}

/**
 * LittleJS plugin hook. Plugin `update` runs after gameUpdate() but still
 * before engineObjectsUpdate(), so parking the player here means the walk that
 * follows this frame starts from a dead stop. Optional: without it the drawer
 * still opens and closes, it just eases to a halt instead of snapping.
 */
function hudHookPostUpdate()
{
    if (HUD.postHooked) return;
    if (typeof engineAddPlugin != 'function') return;
    try
    {
        engineAddPlugin(function ()
        {
            if (!HUD.overlay) return;
            try { if (typeof player != 'undefined' && player) player.vel = vec2(); }
            catch (e) {}
        });
        HUD.postHooked = true;
    }
    catch (e) {}
}

// drawer rendering — called at the end of hudWorld()/hudPlay()
/////////////////////////////////////////////////////////////////////////////

/** The inventory drawer. Deliberately NOT a full-screen modal: it is a small
 *  panel tucked into the bottom-left corner, sitting level with the HUD chips,
 *  with no scrim over the field — every full-screen menu belongs to the OG DOM
 *  menu now. */
HUD.renderOverlay = function ()
{
    if (!HUD.overlay) return false;
    const p = clamp(HUD.overlayT / .18);
    const ease = 1 - Math.pow(1 - p, 3);
    if (HUD.overlay == 'inventory') hudDrawInventory(ease);
    return true;
};

function hudSectionLabel(x, y, text, color, w)
{
    uiText(text, x, y, 11, alpha(color, .95), { font: DATA.ui.font, style:'900' });
    uiZigRule(x + 66, x + (w || 92), y + 4, 6, 3, 1.5, alpha(color, .4));
}

// ---- inventory drawer ------------------------------------------------------

function hudDrawInventory(ease)
{
    const S = mainCanvasSize, C = DATA.c;
    const ps  = hudSyncPlayerState();
    const inv = hudInventory();
    const weapons = inv.weapons.slice(0, 4);
    const items   = inv.items.slice(0, 5);
    const frac = ps.maxHp > 0 ? ps.hp / ps.maxHp : 0;

    const w = Math.min(S.x - 32, 340), pad = 18, rowH = 21;
    const h = 158 + rowH * (weapons.length + items.length);
    const x = 16 - (1 - ease) * 20, y = S.y - h - 16;      // slides in from the left
    const right = x + w - pad;

    uiPanel(x, y, w, h, alpha(C.cyan, .4 + .35*ease), 18);
    drawRect(vec2(x + 2, y + h*.5), vec2(3, h - 24), alpha(C.cyan, .8), 0, true, true);

    // ---- header -------------------------------------------------------------
    uiSpaced('INVENTORY', x + pad, y + 26, 15, C.ink, 3,
        { font: DATA.ui.font, style:'900', lineWidth: 3, lineColor: alpha(C.bg, .8) });
    uiText('[E]', right, y + 25, 11, alpha(C.cyan, .8),
        { align:'right', font: DATA.ui.font, style:'900' });
    uiZigRule(x + pad, right, y + 38, 10, 3, 1.5, alpha(C.cyan, .45));

    // ---- stats --------------------------------------------------------------
    let cy = y + 50;
    uiText('LV', x + pad, cy, 12, alpha(C.dim, .95), { font: DATA.ui.font });
    uiText(String(ps.level), x + pad + 32, cy + 1, 14, C.gold,
        { font: DATA.ui.font, style:'900' });
    uiText('BEST', x + pad + 92, cy, 12, alpha(C.dim, .95), { font: DATA.ui.font });
    uiText(String(best || 0).padStart(6, '0'), right, cy + 1, 14, C.gold,
        { align:'right', font: DATA.ui.font, style:'900' });
    cy += 20;
    uiText('HP', x + pad, cy, 12, alpha(C.dim, .95), { font: DATA.ui.font });
    uiBar(x + pad + 32, cy - 3, w - pad*2 - 100, 11, frac, hudHPColor(frac), alpha(C.bg, .75));
    uiText(Math.ceil(ps.hp) + '/' + ps.maxHp, right, cy, 12, frac > .22 ? C.ink : C.bad,
        { align:'right', font: DATA.ui.font, style:'900' });
    cy += 24;

    // ---- weapons ------------------------------------------------------------
    hudSectionLabel(x + pad, cy, 'WEAPONS', C.neon);
    cy += 16;
    if (!weapons.length)
        uiText('—', x + pad, cy, 13, alpha(C.dim, .8), { font: DATA.ui.soft });
    for (const wp of weapons)
    {
        const atk = wp.atk === undefined ? wp.power : wp.atk;
        uiText(String(wp.name).toUpperCase(), x + pad, cy, 13, C.ink,
            { font: DATA.ui.font, style:'900' });
        uiText('ATK ' + atk, right, cy, 13, C.neonSoft,
            { align:'right', font: DATA.ui.font, style:'900' });
        cy += rowH;
    }
    cy += 8;

    // ---- items --------------------------------------------------------------
    hudSectionLabel(x + pad, cy, 'ITEMS', C.gold);
    cy += 16;
    if (!items.length)
        uiText('—', x + pad, cy, 13, alpha(C.dim, .8), { font: DATA.ui.soft });
    for (const it of items)
    {
        const qty = it.qty === undefined ? 1 : it.qty;
        uiText(String(it.name).toUpperCase(), x + pad, cy, 13, C.ink,
            { font: DATA.ui.font, style:'900' });
        uiText('\u00d7' + qty, right, cy, 13, C.gold,
            { align:'right', font: DATA.ui.font, style:'900' });
        cy += rowH;
    }

    // ---- footer -------------------------------------------------------------
    const pulse = .5 + .5*sin(HUD.t*3.4);
    uiText('E  or  ESC  \u2014  CLOSE', x + w/2, y + h - 14,
        11, alpha(C.ink, .3 + pulse*.4),
        { align:'center', font: DATA.ui.font, style:'900' });
    if (HUD.overlayMsgT > 0)
        uiText(HUD.overlayMsg, x + w/2, y + h - 30,
            11, alpha(C.gold, .5 + .5*Math.sin(HUD.t*8)*Math.min(1, HUD.overlayMsgT)),
            { align:'center', font: DATA.ui.font, style:'900' });
}
