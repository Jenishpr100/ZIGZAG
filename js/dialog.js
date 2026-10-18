///////////////////////////////////////////////////////////////////////////////
// ZIGZAG SYNTH — dialog.js
// A typewriter dialog box for the overworld.
//
//   Dialog.show(name, lines, {portrait:'npc3', cell:8})   open a conversation
//   Dialog.isOpen()          true while a box is on screen
//   Dialog.inputLocked()     true while open, or while the key that closed it
//                            is still physically held (stops instant re-open)
//   Dialog.update(dt)        called by owUpdate — types, advances, closes
//   Dialog.render()          draws the box in screen space, once per frame
//   Dialog.close()           force it shut
//
// Everything is drawn with LittleJS draw calls (screen space), never DOM.
// A tiny EngineObject (DialogLayer) sits at a very high renderOrder so the
// box lands above the world and its additive particles even if owRender()
// is called from anywhere in the frame.
///////////////////////////////////////////////////////////////////////////////

const DIALOG_LAYER_ORDER = 1e9 + 50;   // beats ParticleEmitter's 1e9

const Dialog = {
    open:    false,
    name:    '',
    pages:   [],        // one string per page
    page:    0,
    chars:   0,         // typewriter position on the current page
    t: 0,               // seconds since the box opened (entrance + blink)
    latch:   false,     // advance key still held from the last close/open
    portrait:null,      // spritesheet key ('npc1'…'npc5', 'teto') or null
    cell:    0,         // spritesheet frame for the portrait
    wrapCache:null,     // {page, lines} — word-wrapped lines of current page
    lastUpdateFrame: -1,
    lastRenderFrame: -1,
    layer:   null,
};

///////////////////////////////////////////////////////////////////////////////
// input helpers
///////////////////////////////////////////////////////////////////////////////

function dlgPressed(code)
{
    if (typeof owPressed == 'function') return owPressed(code);
    return typeof keyWasPressed == 'function' && keyWasPressed(code);
}

function dlgHeld(code)
{
    if (typeof keyIsDown == 'function' && typeof inputData != 'undefined' && keyIsDown(code))
        return true;
    return typeof inputKeysHeld != 'undefined' && !!inputKeysHeld.has && inputKeysHeld.has(code);
}

function dlgAdvanceHeld()
{
    return dlgHeld('Enter') || dlgHeld('NumpadEnter') || dlgHeld('Space') || dlgHeld('Escape');
}

///////////////////////////////////////////////////////////////////////////////
// lifecycle
///////////////////////////////////////////////////////////////////////////////

/** open (or re-open) a conversation. `lines` may be a string or an array of
 *  page strings; opts: {portrait, cell} */
Dialog.show = function (name, lines, opts)
{
    opts = opts || {};
    Dialog.name = String(name || '');
    Dialog.pages = Array.isArray(lines) ? lines.filter(l => typeof l == 'string' && l.length)
                                        : (typeof lines == 'string' && lines ? [lines] : ['…']);
    if (!Dialog.pages.length) Dialog.pages = ['…'];
    Dialog.page = 0;
    Dialog.chars = 0;
    Dialog.t = 0;
    Dialog.portrait = opts.portrait || null;
    Dialog.cell = opts.cell === undefined ? 8 : opts.cell;
    Dialog.wrapCache = null;
    Dialog.open = true;

    // if a key is already down (the Enter that opened this), latch so the
    // same press can never also advance a page
    if (dlgAdvanceHeld()) Dialog.latch = true;

    // a high renderOrder object so the box always draws over the world
    if (!Dialog.layer || Dialog.layer.destroyed)
        Dialog.layer = new DialogLayer();
    return true;
};

Dialog.close = function ()
{
    if (!Dialog.open) return false;
    Dialog.open = false;
    Dialog.wrapCache = null;
    if (dlgAdvanceHeld()) Dialog.latch = true;   // don't re-open on this press
    if (Dialog.layer && !Dialog.layer.destroyed) Dialog.layer.destroy();
    Dialog.layer = null;
    return true;
};

Dialog.isOpen    = function () { return Dialog.open; };
Dialog.inputLocked = function () { return Dialog.open || Dialog.latch; };
Dialog.pageCount = function () { return Dialog.pages.length; };

/** the visible page as plain text (already-typed portion when typing) */
Dialog.text = function ()
{
    const full = Dialog.pages[Dialog.page] || '';
    return full.slice(0, Math.floor(Dialog.chars));
};

///////////////////////////////////////////////////////////////////////////////
// update — called once per frame from owUpdate
///////////////////////////////////////////////////////////////////////////////

Dialog.update = function (dt)
{
    if (typeof timeReal != 'undefined')
    {
        if (Dialog.lastUpdateFrame === timeReal) return;   // already ran this frame
        Dialog.lastUpdateFrame = timeReal;
    }
    if (typeof dt != 'number' || dt < 0) dt = typeof timeDelta != 'undefined' ? timeDelta : 1/60;

    // a key held over from open/close keeps control locked until release
    if (Dialog.latch && !dlgAdvanceHeld()) Dialog.latch = false;
    if (!Dialog.open) return;

    Dialog.t += dt;

    const page = Dialog.pages[Dialog.page] || '';
    const typing = Dialog.chars < page.length;
    if (typing)
    {
        const cps = (typeof DATA != 'undefined' && DATA.tuning && DATA.tuning.dialogCps) || 30;
        Dialog.chars = Math.min(page.length, Dialog.chars + dt * cps);
    }

    if (Dialog.latch) return;   // swallow the press that opened/closed us

    const advance = dlgPressed('Enter') || dlgPressed('NumpadEnter') || dlgPressed('Space');
    if (dlgPressed('Escape'))
    {
        Dialog.close();
        return;
    }
    if (!advance) return;

    if (typing)
    {
        Dialog.chars = page.length;          // 1st press: skip the typewriter
        Dialog.wrapCache = null;
    }
    else if (Dialog.page < Dialog.pages.length - 1)
    {
        Dialog.page++;                       // 2nd press: next page
        Dialog.chars = 0;
        Dialog.wrapCache = null;
    }
    else
        Dialog.close();                      // 3rd press: done talking
};

///////////////////////////////////////////////////////////////////////////////
// layout — screen space, box lives in the bottom third
///////////////////////////////////////////////////////////////////////////////

function dlgBox()
{
    const S = typeof mainCanvasSize != 'undefined' ? mainCanvasSize : vec2(960, 540);
    const w = Math.min(S.x - 40, 900);
    const h = clamp(S.y * .30, 130, 210);
    const x = (S.x - w) / 2;
    const y = S.y - h - Math.max(18, S.y * .045);
    return { S, x, y, w, h };
}

/** word-wrap `text` to `maxW` px using the real canvas metrics when we can */
function dlgWrap(text, size, font, maxW)
{
    const words = String(text).split(/\s+/).filter(w => w.length);
    if (!words.length) return [''];

    const measure = typeof mainContext != 'undefined' && mainContext && mainContext.measureText
        ? (s => {
            const prev = mainContext.font;
            mainContext.font = '900 ' + size + 'px ' + font;
            const w = mainContext.measureText(s).width;
            mainContext.font = prev;
            return w;
          })
        : (s => s.length * size * .52);      // rough fallback for headless

    const lines = [];
    let cur = words[0];
    for (let i = 1; i < words.length; ++i)
    {
        const trial = cur + ' ' + words[i];
        if (measure(trial) > maxW) { lines.push(cur); cur = words[i]; }
        else cur = trial;
    }
    lines.push(cur);
    return lines;
}

///////////////////////////////////////////////////////////////////////////////
// render — called from DialogLayer (and safe to call again; deduped per frame)
///////////////////////////////////////////////////////////////////////////////

Dialog.render = function ()
{
    if (!Dialog.open) return;
    if (typeof timeReal != 'undefined')
    {
        if (Dialog.lastRenderFrame === timeReal) return;   // only once per frame
        Dialog.lastRenderFrame = timeReal;
    }
    Dialog.renderBox();
};

Dialog.renderBox = function ()
{
    if (typeof mainCanvasSize == 'undefined') return;
    const C = typeof DATA != 'undefined' ? DATA.c : {};
    const accent = (typeof owPal != 'undefined' && owPal && owPal.accent) || C.neon || WHITE;
    const { S, x, y, w, h } = dlgBox();

    // entrance: slide up + fade over ~0.2s
    const p = clamp(Dialog.t / .2);
    const ease = 1 - (1 - p) * (1 - p) * (1 - p);
    const oy = (1 - ease) * 26;

    // soft scrim so the text always reads over the world
    drawRectGradient(vec2(S.x / 2, S.y * .82), vec2(S.x, S.y * .40),
        alpha(C.bg || BLACK, 0), alpha(C.bg || BLACK, .55), 0, false, true);

    // the panel (uiPanel from hud.js when present)
    const py = y + oy;
    if (typeof uiPanel == 'function')
        uiPanel(x, py, w, h, alpha(accent, .35 + .35 * ease), 20);
    else
    {
        drawRect(vec2(x + w / 2, py + h / 2), vec2(w, h), alpha(C.panel || BLACK, .86),
            0, false, true);
        drawRect(vec2(x + w / 2, py + h / 2), vec2(w, h), alpha(C.bg || BLACK, 0),
            0, false, true);
    }
    // clip contents into the chamfered interior
    const inset = 18;
    const tx0 = x + inset + (Dialog.portrait ? 74 : 0);
    const tx1 = x + w - inset;
    const maxW = tx1 - tx0;
    const top = py + 34;

    // ---- name plate ---------------------------------------------------------
    if (Dialog.name && typeof uiText == 'function')
    {
        uiText(Dialog.name.toUpperCase(), x + inset, top, 15, accent,
            { font: DATA.ui.font, style: '900' });
        if (typeof uiZigRule == 'function')
            uiZigRule(x + inset, Math.min(x + inset + 150, tx1), top + 12,
                8, 3, 2, alpha(accent, .55));
    }

    // ---- body: typewriter over the wrapped full page ------------------------
    const bodySize = clamp(S.x * .021, 13, 19);
    const full = Dialog.pages[Dialog.page] || '';
    if (!Dialog.wrapCache || Dialog.wrapCache.page !== Dialog.page ||
        Dialog.wrapCache.maxW !== maxW || Dialog.wrapCache.size !== bodySize)
    {
        Dialog.wrapCache = {
            page: Dialog.page, maxW, size: bodySize,
            lines: dlgWrap(full, bodySize, (typeof DATA != 'undefined' ? DATA.ui.soft : fontDefault), maxW),
        };
    }
    const lines = Dialog.wrapCache.lines;
    let left = Math.floor(Dialog.chars);
    const soft = (typeof DATA != 'undefined' ? DATA.ui.soft : fontDefault);
    for (let i = 0; i < lines.length && left > 0; ++i)
    {
        const take = Math.min(left, lines[i].length);
        const visible = lines[i].slice(0, take);
        left -= lines[i].length + 1;           // account for the line break
        if (visible && typeof uiText == 'function')
            uiText(visible, tx0, top + 30 + i * (bodySize + 8), bodySize,
                C.ink || WHITE, { font: soft });
    }

    // ---- portrait -----------------------------------------------------------
    if (Dialog.portrait && typeof owCell == 'function')
    {
        const ti = owCell(Dialog.portrait, Dialog.cell);
        if (ti)
        {
            const sz = 72;
            const px = x + inset + (sz - 12) / 2, pyp = py + h - sz / 2 - 8;
            drawRect(vec2(px, pyp), vec2(sz + 10, sz + 10), alpha(C.bg || BLACK, .55),
                0, false, true);
            drawTile(vec2(px, pyp), vec2(sz * 20 / 26, sz), ti, WHITE, 0, false, false, true);
            drawRect(vec2(px, pyp), vec2(sz + 10, sz + 10), alpha(accent, .35),
                0, false, true);
        }
    }

    // ---- page counter + prompt ---------------------------------------------
    const complete = Dialog.chars >= full.length;
    if (typeof uiText == 'function')
    {
        if (Dialog.pages.length > 1)
            uiText((Dialog.page + 1) + '/' + Dialog.pages.length, tx1, top, 12,
                alpha(C.dim || WHITE, .7), { align: 'right', font: soft });
        if (complete)
        {
            const pulse = .45 + .55 * sin(Dialog.t * 5);
            uiText('▼ ENTER', tx1, py + h - 16, 13, alpha(C.ink || WHITE, .35 + pulse * .6),
                { align: 'right', font: DATA.ui.font, style: '900' });
        }
    }
};

///////////////////////////////////////////////////////////////////////////////
// the engine-object layer that guarantees draw order
///////////////////////////////////////////////////////////////////////////////

class DialogLayer extends EngineObject
{
    constructor()
    {
        super(vec2(), vec2(1), undefined, 0, WHITE, DIALOG_LAYER_ORDER);
        this.persistent = true;      // survive engineObjectsDestroy between states
    }
    render()
    {
        Dialog.render();
    }
}
