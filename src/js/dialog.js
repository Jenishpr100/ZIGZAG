///////////////////////////////////////////////////////////////////////////////
// ZIGZAG SYNTH — dialog.js
// A typewriter dialog box for the overworld, with optional branching choices.
//
//   Dialog.show(name, lines, opts)     open a conversation
//                                      opts: {portrait, cell, options:[…]}
//   Dialog.show({name, pages, options}) object form — same thing
//   Dialog.isOpen()          true while a box is on screen
//   Dialog.inputLocked()     true while open, or while the key that closed it
//                            is still physically held (stops instant re-open)
//   Dialog.update(dt)        called by owUpdate — types, advances, closes
//   Dialog.render()          draws the box in screen space, once per frame
//   Dialog.close()           force it shut
//   Dialog.current()         plain snapshot of the state (tests / console)
//
// BRANCHING (`options` of the `muzic-switch-world` schema):
//   A dialog may carry `options: [{text, goto}]` — 1..6 choices shown after the
//   last page instead of closing. Up/Down move the selection, Space (or a
//   number key) confirm.
//     goto: null    → the box closes right away.
//     goto: "<id>"  → straight into that dialog's pages (and its own options).
//   A dialog WITHOUT options behaves exactly as before: linear pages, then close.
//
//   Targets resolve through Dialog.lookup(id) if the host installs one, then
//   Dialog.table, then the live world (owWorldData / WorldFormat.getWorld()).
//   A goto that resolves to nothing closes the box — it never throws.
//
//   The chosen option's own text is NOT echoed as an extra line: it is on screen
//   while you pick it, so the jump reads as one continuous conversation.
//
// Everything is drawn with LittleJS draw calls (screen space), never DOM.
//
// WHY THE ENGINE-OBJECT LAYER MATTERS (the "dialog never shows" bug):
// overworld.js calls Dialog.render() from owRender(), which littlejs-game.js
// invokes inside gameUpdate() — i.e. during the UPDATE phase. LittleJS does
// not rasterise draw calls immediately (they go into the WebGL batch and are
// only flushed in gameRenderPass), so a box drawn from the update phase is
// flushed BEFORE the world tiles and the HUD of that same frame and is simply
// painted over. The DialogLayer below sits at a very high renderOrder and is
// invoked from inside the render pass, where the box really lands on top.
// Dialog.render() therefore refuses to draw unless it was called from that
// layer (Dialog.inRenderPass) — the owRender() call becomes a no-op instead of
// a box that vanishes.
//
// Set ZZ.dialogTrace = true (or add ?dialog to the URL) for a console trace.
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
    options: [],        // [{text, goto|null}] — choices shown after the last page
    sel:     0,         // highlighted option index (only meaningful while choosing)
    choosing:false,     // true while the choice list is up
    wrapCache:null,     // {page, lines} — word-wrapped lines of current page
    lastUpdateFrame: -1,
    lastRenderFrame: -1,
    layer:   null,
    inRenderPass: false,// true only inside DialogLayer.render()

    /* goto resolution — the host MAY set either of these; otherwise Dialog falls
       back to the live world table (see dlgLookup). */
    table:   null,      // { dialogId: {name, pages, options} }
    lookup:  null,      // optional lookup(id) -> dialog entry | null
};

/** opt-in console tracing: ZZ.dialogTrace = true, or ?dialog in the URL */
Dialog.trace = function (msg)
{
    let on = false;
    try
    {
        if (typeof ZZ != 'undefined' && ZZ && ZZ.dialogTrace) on = true;
        if (!on && typeof location != 'undefined' && location.search &&
            /[?&]dialog\b/.test(location.search)) on = true;
    }
    catch (e) {}
    if (on && typeof console != 'undefined') console.log('[Dialog]', msg);
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
    return dlgHeld('Space') || dlgHeld('Escape');
}

///////////////////////////////////////////////////////////////////////////////
// lifecycle
///////////////////////////////////////////////////////////////////////////////

// ---- normalization + goto resolution ---------------------------------------

/** ['a','b'] | 'a' → ['a','b'] (empty/garbage → ['…']) */
function dlgLines(lines)
{
    const p = Array.isArray(lines) ? lines.filter(l => typeof l == 'string' && l.length)
                                  : (typeof lines == 'string' && lines ? [lines] : []);
    return p.length ? p : ['…'];
}

/** [{text, goto}] → [{text:String, goto:String|null}]; junk entries are dropped */
function dlgOptions(options)
{
    if (!Array.isArray(options)) return [];
    const out = [];
    for (let i = 0; i < options.length && out.length < 6; ++i)
    {
        const o = options[i];
        if (!o || typeof o != 'object') continue;
        const text = typeof o.text == 'string' ? o.text : '';
        if (!text.length) continue;
        const goto = typeof o.goto == 'string' && o.goto.length ? o.goto : null;
        out.push({ text, goto });
    }
    return out;
}

/** resolve a goto id to a dialog entry, or null (unknown) — never throws */
function dlgLookup(id)
{
    if (!id) return null;
    try { if (typeof Dialog.lookup == 'function') { const d = Dialog.lookup(id); if (d) return d; } } catch (e) {}
    try { if (Dialog.table && typeof Dialog.table == 'object' && Dialog.table[id]) return Dialog.table[id]; } catch (e) {}

    let world = null;
    try { if (typeof owWorldData != 'undefined' && owWorldData) world = owWorldData; } catch (e) {}
    if (!world) { try { if (typeof window != 'undefined' && window.owWorldData) world = window.owWorldData; } catch (e) {}
    }
    if (!world)
    {
        try {
            const WF = (typeof window != 'undefined' && window.WorldFormat) ||
                       (typeof WorldFormat != 'undefined' ? WorldFormat : null);
            if (WF && typeof WF.getWorld == 'function') world = WF.getWorld();
        } catch (e) {}
    }
    return (world && world.dialogs && world.dialogs[id]) || null;
}

/** the one place the box state is (re)set. `def`: {name, pages, options,
 *  portrait, cell}. Shared by show() and by a goto jump, so a branch is one
 *  continuous conversation on one Dialog instance — no close/open flicker. */
function dlgStart(def)
{
    def = def || {};
    Dialog.name      = String(def.name || '');
    Dialog.pages     = dlgLines(def.pages);
    Dialog.options   = dlgOptions(def.options);
    Dialog.page      = 0;
    Dialog.chars     = 0;
    Dialog.t         = 0;
    Dialog.sel       = 0;
    Dialog.choosing  = false;
    Dialog.portrait  = def.portrait || null;
    Dialog.cell      = def.cell === undefined ? 8 : def.cell;
    Dialog.wrapCache = null;
    Dialog.open      = true;
    Dialog.lastRenderFrame = -1;   // force a redraw on the very next render pass

    // if a key is already down (the Space that opened this), latch so the same
    // press can never also advance a page or pick a choice
    if (dlgAdvanceHeld()) Dialog.latch = true;

    // a high renderOrder object so the box always draws over the world
    Dialog.ensureLayer();
    return true;
}

/** open (or re-open) a conversation. Two forms, both always supported:
 *      Dialog.show(name, lines, {portrait, cell, options})
 *      Dialog.show({name, pages, options, portrait, cell}) */
Dialog.show = function (a, b, c)
{
    if (a && typeof a == 'object' && !Array.isArray(a))          // object form
    {
        Dialog.trace('show {"' + a.name + '"} (' +
            (Array.isArray(a.pages) ? a.pages.length : 1) + ' page(s)' +
            (Array.isArray(a.options) && a.options.length ? ', ' + a.options.length + ' option(s)' : '') + ')');
        return dlgStart(a);
    }

    let opts = c;
    if (Array.isArray(opts)) opts = { options: opts };           // show(name, pages, [options])
    else opts = opts || {};
    Dialog.trace('show "' + a + '" (' + (Array.isArray(b) ? b.length : 1) + ' page(s)' +
        (Array.isArray(opts.options) && opts.options.length ? ', ' + opts.options.length + ' option(s)' : '') + ')');
    return dlgStart({ name: a, pages: b, options: opts.options, portrait: opts.portrait, cell: opts.cell });
};

Dialog.close = function ()
{
    if (!Dialog.open) return false;
    Dialog.open = false;
    Dialog.choosing = false;
    Dialog.wrapCache = null;
    if (dlgAdvanceHeld()) Dialog.latch = true;   // don't re-open on this press
    if (Dialog.layer && !Dialog.layer.destroyed) Dialog.layer.destroy();
    Dialog.layer = null;
    return true;
};

Dialog.isOpen    = function () { return Dialog.open; };
Dialog.inputLocked = function ()
{
    // also true while the E inventory drawer is up: overworld.js already polls
    // this, so the overworld freezes (no walking, no door triggers, no world
    // swap) without overworld.js needing a single edit.
    // NOTE: the choice list is part of the open dialog, so this is already true
    // while choosing — up/down can never leak through to the overworld.
    return Dialog.open || Dialog.latch ||
        (typeof HUD != 'undefined' && HUD && typeof HUD.overlayOpen == 'function' &&
         HUD.overlayOpen());
};
Dialog.pageCount = function () { return Dialog.pages.length; };

// ---- branching options ----------------------------------------------------

/** raise the choice list — called when the last page finishes typing */
Dialog.beginChoice = function ()
{
    if (!Dialog.open || !Dialog.options.length) return false;
    if (Dialog.choosing) return false;
    Dialog.choosing = true;
    Dialog.sel = 0;
    Dialog.trace('choose: ' + Dialog.options.length + ' option(s)');
    return true;
};

Dialog.optionCount   = function () { return Dialog.options.length; };
Dialog.selectedIndex = function () { return Dialog.options.length ? Dialog.sel : -1; };
Dialog.selectedOption= function ()
{
    return Dialog.options.length ? Dialog.options[Math.min(Dialog.sel, Dialog.options.length - 1)] : null;
};

/** pick option `i`: a null goto closes, a goto jumps into that dialog, an
 *  unresolvable goto closes (safe degradation — it never throws) */
Dialog.pickOption = function (i)
{
    if (!Dialog.open || !Dialog.choosing || !Dialog.options.length) return false;
    const opt = Dialog.options[i];
    if (!opt) return false;
    Dialog.sel = i;

    if (!opt.goto)
    {
        Dialog.trace('pick "' + opt.text + '" → close');
        Dialog.close();
        return true;
    }

    const target = dlgLookup(opt.goto);
    if (!target)
    {
        Dialog.trace('pick "' + opt.text + '" → missing dialog "' + opt.goto + '", closing');
        Dialog.close();
        return false;
    }
    Dialog.trace('pick "' + opt.text + '" → goto "' + opt.goto + '"');
    // same instance, same box: no close/open flicker; portrait carries over
    dlgStart({
        name: target.name || Dialog.name,
        pages: target.pages,
        options: target.options,
        portrait: target.portrait !== undefined ? target.portrait : Dialog.portrait,
        cell: target.cell === undefined ? Dialog.cell : target.cell,
    });
    return true;
};

/** a plain snapshot of the state — tests, console, savegames */
Dialog.current = function ()
{
    const sel = Dialog.selectedOption();
    return {
        open: Dialog.open,
        name: Dialog.name,
        pages: Dialog.pages.slice(),
        page: Dialog.page,
        pageCount: Dialog.pages.length,
        chars: Math.floor(Dialog.chars),
        typing: Dialog.chars < (Dialog.pages[Dialog.page] || '').length,
        options: Dialog.options.map(o => ({ text: o.text, goto: o.goto })),
        choosing: Dialog.choosing,
        selected: Dialog.choosing ? Dialog.sel : -1,
        selectedText: sel ? sel.text : '',
        portrait: Dialog.portrait,
        cell: Dialog.cell,
        locked: Dialog.inputLocked(),
    };
};

/** (re)create the render-layer object if a state change destroyed it */
Dialog.ensureLayer = function ()
{
    if (!Dialog.layer || Dialog.layer.destroyed)
        Dialog.layer = new DialogLayer();
    return Dialog.layer;
};

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

    // self-heal: a state change (engineObjectsDestroy) can drop the layer
    if (!Dialog.layer || Dialog.layer.destroyed) Dialog.ensureLayer();

    Dialog.t += dt;

    const page = Dialog.pages[Dialog.page] || '';
    const typing = Dialog.chars < page.length;
    if (typing)
    {
        const cps = (typeof DATA != 'undefined' && DATA.tuning && DATA.tuning.dialogCps) || 30;
        Dialog.chars = Math.min(page.length, Dialog.chars + dt * cps);
    }

    if (Dialog.latch) return;   // swallow the press that opened/closed us

    // Escape always backs out (from the choice list too)
    if (dlgPressed('Escape'))
    {
        Dialog.close();
        return;
    }

    if (Dialog.choosing) { Dialog.updateChoiceList(); return; }

    const advance = dlgPressed('Space');

    // last page done and the dialog branches → raise the choice list instead of
    // closing (it appears the moment the typewriter finishes, no extra press)
    if (!typing && Dialog.options.length && Dialog.page >= Dialog.pages.length - 1)
    {
        Dialog.beginChoice();
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
    else if (Dialog.options.length)
        Dialog.beginChoice();               // branches instead of hanging up
    else
        Dialog.close();                      // 3rd press: done talking
};

/** up/down + confirm, once the choice list is up */
Dialog.updateChoiceList = function ()
{
    const n = Dialog.options.length;
    if (!n) { Dialog.choosing = false; return false; }

    let step = 0;
    if (dlgPressed('ArrowUp')   || dlgPressed('KeyW')) step--;
    if (dlgPressed('ArrowDown') || dlgPressed('KeyS')) step++;
    if (step)
    {
        Dialog.sel = (Dialog.sel + step + n) % n;     // wraps around
        return true;
    }

    // number keys jump straight to a choice (1..6)
    for (let i = 0; i < Math.min(n, 6); ++i)
    {
        if (dlgPressed('Digit' + (i + 1)) || dlgPressed('Numpad' + (i + 1)))
        {
            if (Dialog.sel != i) { Dialog.sel = i; return true; }
        }
    }

    if (dlgPressed('Space'))
        return Dialog.pickOption(Dialog.sel);
    return false;
};

///////////////////////////////////////////////////////////////////////////////
// layout — screen space, box lives in the bottom third
///////////////////////////////////////////////////////////////////////////////

/** the box, anchored to the bottom of the screen. `extraH` grows it upward so
 *  the branching choice list has room without moving the box off screen. */
function dlgBox(extraH)
{
    const S = typeof mainCanvasSize != 'undefined' ? mainCanvasSize : vec2(960, 540);
    const w = Math.min(S.x - 40, 900);
    const base = clamp(S.y * .30, 130, 210);
    const h = extraH > 0 ? Math.min(S.y * .78, base + extraH) : base;
    const x = (S.x - w) / 2;
    const y = S.y - h - Math.max(18, S.y * .045);
    return { S, x, y, w, h };
}

/** per-row metrics of the choice list (shared by layout + the box height) */
function dlgChoiceMetrics(S)
{
    const size = clamp(S.x * .020, 12, 18);
    return { size, row: size + 9, num: 26, gap: 30 };
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
// render — DialogLayer is the ONLY place allowed to draw
///////////////////////////////////////////////////////////////////////////////

Dialog.render = function ()
{
    if (!Dialog.open) return false;
    if (!Dialog.inRenderPass) return false;      // update-phase call: skip it
    return Dialog.renderOnce();
};

/** unconditional draw, for a manual gameRenderPost() hook */
Dialog.renderFromPost = function ()
{
    if (!Dialog.open) return false;
    Dialog.lastRenderFrame = -1;                 // beat the per-frame de-dupe
    return Dialog.renderOnce();
};

/** the real draw, at most once per frame */
Dialog.renderOnce = function ()
{
    if (typeof timeReal != 'undefined')
    {
        if (Dialog.lastRenderFrame === timeReal) return false;
        Dialog.lastRenderFrame = timeReal;
    }
    Dialog.ensureLayer();
    Dialog.trace('render "' + Dialog.name + '" p' + (Dialog.page + 1) + '/' +
        Dialog.pages.length);
    Dialog.renderBox();
    return true;
};

Dialog.renderBox = function ()
{
    if (typeof mainCanvasSize == 'undefined') return;
    const C = typeof DATA != 'undefined' ? DATA.c : {};
    const accent = (typeof owPal != 'undefined' && owPal && owPal.accent) || C.neon || WHITE;
    const soft = (typeof DATA != 'undefined' ? DATA.ui.soft : fontDefault);

    const cm = dlgChoiceMetrics(mainCanvasSize);
    const showChoices = Dialog.choosing && Dialog.options.length;
    const { S, x, y, w, h } = dlgBox(showChoices ? Dialog.options.length * cm.row + cm.gap : 0);

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
    const nOpts = showChoices ? Dialog.options.length : 0;
    const blockTop = py + h - nOpts * cm.row - 14;      // top of the choice block
    const ruleY = blockTop - 15;
    const bodyBottom = showChoices ? ruleY - 22 : py + h - 22;   // never collide
    const bodySize = clamp(S.x * .021, 13, 19);
    const full = Dialog.pages[Dialog.page] || '';
    if (!Dialog.wrapCache || Dialog.wrapCache.page !== Dialog.page ||
        Dialog.wrapCache.maxW !== maxW || Dialog.wrapCache.size !== bodySize)
    {
        Dialog.wrapCache = {
            page: Dialog.page, maxW, size: bodySize,
            lines: dlgWrap(full, bodySize, soft, maxW),
        };
    }
    const lines = Dialog.wrapCache.lines;
    let left = Math.floor(Dialog.chars);
    for (let i = 0; i < lines.length && left > 0; ++i)
    {
        const ly = top + 30 + i * (bodySize + 8);
        if (ly + bodySize > bodyBottom) break;         // the choice list owns the rest
        const take = Math.min(left, lines[i].length);
        const visible = lines[i].slice(0, take);
        left -= lines[i].length + 1;           // account for the line break
        if (visible && typeof uiText == 'function')
            uiText(visible, tx0, ly, bodySize, C.ink || WHITE, { font: soft });
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
        if (complete && !showChoices)
        {
            const pulse = .45 + .55 * sin(Dialog.t * 5);
            uiText('▼ SPACE', tx1, py + h - 16, 13, alpha(C.ink || WHITE, .35 + pulse * .6),
                { align: 'right', font: DATA.ui.font, style: '900' });
        }
    }

    // ---- branching choices ----------------------------------------------------
    // drawn last so the list (and its highlight) sits on top of the panel edge
    if (showChoices)
    {
        if (typeof uiZigRule == 'function')
            uiZigRule(tx0, Math.min(tx1 - 150, tx1), ruleY + 4, 8, 2, 2, alpha(accent, .3));
        if (typeof uiText == 'function')
        {
            const pulse = .45 + .55 * sin(Dialog.t * 5);
            uiText('▲▼ MOVE · SPACE PICK', tx1, ruleY - 4, 11,
                alpha(C.dim || WHITE, .30 + pulse * .45), { align: 'right', font: soft });
        }

        const lx = tx0 - 14, rw = tx1 - lx;
        for (let i = 0; i < nOpts; ++i)
        {
            const ry = blockTop + i * cm.row, on = i === Dialog.sel;
            if (on)
            {
                drawRect(vec2((lx + tx1) / 2, ry + cm.row / 2), vec2(rw, cm.row - 2),
                    alpha(accent, .17), 0, false, true);
                drawRect(vec2((lx + tx1) / 2, ry + cm.row / 2), vec2(rw, cm.row - 2),
                    alpha(accent, .45), 1, false, true);
                drawRect(vec2(lx + 2, ry + cm.row / 2), vec2(3, cm.row - 6), accent, 0, false, true);
            }
            uiText((i + 1) + '.', tx0, ry + 3, cm.size,
                on ? accent : alpha(C.dim || WHITE, .55), { font: soft });
            uiText(Dialog.options[i].text, tx0 + cm.num, ry + 3, cm.size,
                on ? accent : alpha(C.dim || WHITE, .82),
                { font: soft, maxWidth: tx1 - tx0 - cm.num });
        }
    }
};

///////////////////////////////////////////////////////////////////////////////
// the engine-object layer that guarantees draw order
//
// renderOrder 1e9+50 puts this last in the render pass — after every world
// object and after every additive particle — so the box is always topmost.
///////////////////////////////////////////////////////////////////////////////

class DialogLayer extends EngineObject
{
    constructor()
    {
        super(vec2(), vec2(1), undefined, 0, WHITE, DIALOG_LAYER_ORDER);
        this.persistent = true;      // survive engineObjectsDestroy between states
        this.mass = 0;
    }
    render()
    {
        // flag the render pass so Dialog.render() can tell it apart from the
        // gameUpdate()-time call in overworld's owRender()
        Dialog.inRenderPass = true;
        try { Dialog.render(); }
        finally { Dialog.inRenderPass = false; }
    }
}

// console access for debugging: ZZ.dialog, ZZ.dialogTrace = true
if (typeof window != 'undefined')
{
    window.Dialog = Dialog;
    if (typeof ZZ != 'undefined' && ZZ) ZZ.dialog = Dialog;
}
