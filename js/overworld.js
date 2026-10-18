///////////////////////////////////////////////////////////////////////////////
// ZIGZAG SYNTH — overworld.js
// The neon hub: a procedural zigzag tile map, the player, and the stage portal.
///////////////////////////////////////////////////////////////////////////////

const TILE_FLOOR = 0, TILE_PATH = 1, TILE_WALL = 2, TILE_BLOCK = 3;

let worldTiles, WORLD_W = 0, WORLD_H = 0;
let worldBuilt = false;
let portalPos = vec2(), worldSpawn = vec2();
let player = null;
const worldDecor = [];

// tile <-> world helpers ------------------------------------------------------
const tileCenter = (tx, ty)=> vec2(tx - WORLD_W/2 + .5, ty - WORLD_H/2 + .5);
const tileType   = (tx, ty)=> tx < 0 || ty < 0 || tx >= WORLD_W || ty >= WORLD_H
                            ? TILE_WALL : worldTiles[ty*WORLD_W + tx];
const tileSolid  = (tx, ty)=> tileType(tx, ty) === TILE_WALL || tileType(tx, ty) === TILE_BLOCK;

///////////////////////////////////////////////////////////////////////////////
// map generation
///////////////////////////////////////////////////////////////////////////////

function buildWorld()
{
    const W = DATA.world.w, H = DATA.world.h;
    WORLD_W = W; WORLD_H = H;
    const t = worldTiles = new Uint8Array(W*H);
    worldDecor.length = 0;

    const fill = (x0, y0, x1, y1, v)=>
    {
        for (let y = y0; y <= y1; ++y)
        for (let x = x0; x <= x1; ++x)
            if (x >= 0 && y >= 0 && x < W && y < H)
                t[y*W + x] = v;
    };

    // base floor, then a solid ring of wall around the whole hub
    fill(0, 0, W-1, H-1, TILE_FLOOR);
    fill(0, 0, W-1, 0,     TILE_WALL);
    fill(0, H-1, W-1, H-1, TILE_WALL);
    fill(0, 0, 0, H-1,     TILE_WALL);
    fill(W-1, 0, W-1, H-1, TILE_WALL);

    // -- the zigzag road: a plaza, then three switchbacks climbing north ------
    fill(7, 3, 15, 9,  TILE_PATH);   // portal plaza
    fill(7, 9, 8, 15,  TILE_PATH);   // north
    fill(7, 15, 31, 16, TILE_PATH);  // east
    fill(30, 16, 31, 21, TILE_PATH); // north
    fill(10, 20, 31, 21, TILE_PATH); // west
    fill(10, 21, 11, 25, TILE_PATH); // north
    fill(10, 24, 32, 25, TILE_PATH); // east
    fill(30, 22, 34, 26, TILE_PATH); // viewing deck at the end of the road

    // -- neon-trimmed obstacle blocks, all clear of the road -----------------
    const blocks = [
        [18,5,20,7], [24,4,26,6], [30,7,33,9], [3,6,5,8],
        [3,12,5,14], [18,11,20,13], [25,12,27,14], [36,12,37,18],
        [3,18,5,19], [20,17,22,18],
        [3,23,5,26], [16,22,19,23], [16,27,20,28], [24,27,27,28],
        [12,1,14,2], [21,1,23,2], [34,2,36,3], [35,21,37,24],
    ];
    for (const b of blocks)
        fill(b[0], b[1], b[2], b[3], TILE_BLOCK);

    // -- decoration ----------------------------------------------------------
    const pylons = [[6,10], [9,14], [32,17], [9,22], [36,27], [16,8], [23,6], [5,20], [28,14]];
    for (const p of pylons)
        worldDecor.push({ kind:'pylon', pos: tileCenter(p[0], p[1]), seed: rand(0, 6.28) });
    // a stage arch over the end of the road
    worldDecor.push({ kind:'arch', pos: tileCenter(33, 24), seed: 0 });

    portalPos  = tileCenter(11, 6);
    worldSpawn = tileCenter(11, 3);   // portal-adjacent start point
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

///////////////////////////////////////////////////////////////////////////////
// backdrop — two parallax layers that always cover the screen
///////////////////////////////////////////////////////////////////////////////

function makeBackdrop()
{
    // far: soft gradient sky + glow blobs (follows the camera fully in y)
    new ParallaxLayer(vec2(0, 0), vec2(40, 26), vec2(.12, 1), -1e3,
        (context, size)=>
        {
            const C = DATA.c, w = size.x, h = size.y;
            const g = context.createLinearGradient(0, 0, 0, h);
            g.addColorStop(0,   C.bgTop.toString());
            g.addColorStop(.55, C.bgMid.toString());
            g.addColorStop(1,   C.bgBot.toString());
            context.fillStyle = g;
            context.fillRect(0, 0, w, h);

            // a few big soft glows, mirrored so the strip repeats without a seam
            const blobs = [[.18,.62,150,C.neon,.10], [.62,.48,190,C.violet,.12],
                           [.88,.70,130,C.cyan,.08], [.40,.78,160,C.neon,.07]];
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

            // scattered stars
            const random = new RandomGenerator(DATA.world.seed);
            context.fillStyle = alpha(C.ink, .5).toString();
            for (let i = 0; i < 160; ++i)
            {
                const x = random.float(0, w), y = random.float(0, h*.72), s = random.float(.6, 2.2);
                context.fillRect(x, y, s, s);
            }
        }, vec2(800, 520));

    // near: a neon zigzag ridge + a faint grid, pinned to the horizon
    new ParallaxLayer(vec2(0, -1), vec2(40, 26), vec2(.45, 1), -999,
        (context, size)=>
        {
            const C = DATA.c, w = size.x, h = size.y;

            // faint perspective grid on the ground half
            context.strokeStyle = alpha(C.violet, .22).toString();
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
                context.strokeStyle = alpha(layer ? C.magenta : C.cyan, .5 - layer*.13).toString();
                context.lineWidth = 4 - layer;
                context.lineJoin = 'miter';
                context.beginPath();
                context.moveTo(pts[0][0], pts[0][1]);
                for (const p of pts) context.lineTo(p[0], p[1]);
                context.stroke();
                // fill under the ridge so it reads as land
                context.lineTo(w, h); context.lineTo(0, h); context.closePath();
                context.fillStyle = alpha(layer ? C.magenta : C.violet, .10 - layer*.02).toString();
                context.fill();
            }
        }, vec2(800, 520));
}

function makeAmbient()
{
    const C = DATA.c, W = DATA.world;
    // slow additive sparks drifting up out of the ground
    new ParticleEmitter(vec2(0, 0), PI/2, vec2(WORLD_W-4, WORLD_H-4), 0, W.sparkRate,
        PI, undefined,
        C.cyan, C.neon,           // colorStartA / B
        alpha(C.violet, 0), alpha(C.magenta, 0),   // colorEndA / B
        7, .13, .02,               // life, size start, size end
        .006, .02, 1, 1, 0,        // speed (units/frame), angleSpeed, damping, angleDamping, gravity
        PI, .35, .35, false, true);

    // a brighter fountain of sparks right out of the portal
    new ParticleEmitter(portalPos, PI/2, .8, 0, 26,
        .5, undefined,
        C.neonSoft, C.cyan,
        alpha(C.neon, 0), alpha(C.cyan, 0),
        1.6, .22, .02,
        .05, .08, .98, 1, 0,
        .6, .25, .5, false, true);
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

function drawWorldTile(tx, ty)
{
    const C = DATA.c, t = tileType(tx, ty), p = tileCenter(tx, ty);

    if (t == TILE_FLOOR)
    {
        const alt = ((tx*7 + ty*13) & 3) == 0;
        drawRect(p, vec2(1), alt ? C.floorAlt : C.floor);
        drawRect(p.add(vec2(0, .47)), vec2(1, .05), C.floorEdge);
    }
    else if (t == TILE_PATH)
    {
        drawRect(p, vec2(1), C.path);
        // the zig-zag motif: a slash on every tile, flipped on its neighbour
        const up = ((tx + ty) & 1) == 0;
        const a = p.add(vec2(up ? -.42 : .42, -.42));
        const b = p.add(vec2(up ?  .42 : -.42, .42));
        drawLine(a, b, .13, alpha(C.neon, .45));
        drawLine(a, b, .05, alpha(C.neonSoft, .85));
        // bright kerb on the long edges
        drawRect(p.add(vec2(0, .47)), vec2(1, .06), alpha(C.pathEdge, .8));
        drawRect(p.add(vec2(0, -.47)), vec2(1, .06), alpha(C.pathEdge, .8));
    }
    else if (t == TILE_WALL)
    {
        drawRect(p, vec2(1), C.wall);
        drawRect(p.add(vec2(0, .3)), vec2(1, .4), C.wallTop);
        drawRect(p.add(vec2(0, .5)), vec2(1, .05), alpha(C.cyan, .5));
        drawRect(p.add(vec2(0, -.5)), vec2(1, .05), alpha(C.cyan, .18));
    }
    else // TILE_BLOCK
    {
        drawRect(p, vec2(1), C.block);
        drawRect(p.add(vec2(0, .32)), vec2(1, .36), C.blockTop);
        drawRect(p.add(vec2(0, .5)), vec2(1, .06), alpha(C.neon, .8));
        drawRect(p.add(vec2(0, -.5)), vec2(1, .06), alpha(C.neon, .3));
        // a lit inner face so blocks read as solid, not flat
        drawRect(p.add(vec2(0, .1)), vec2(.7, .06), alpha(C.cyan, .25));
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
        super(d.pos, vec2(2, 3), undefined, 0, WHITE, 1);
        this.kind = d.kind;
        this.seed = d.seed;
        this.mass = 0;
    }
    render()
    {
        const C = DATA.c, p = this.pos;
        if (this.kind == 'pylon')
        {
            const pulse = .6 + .4*sin(time*2 + this.seed);
            // shadow + post
            drawEllipse(p.add(vec2(0, -.42)), vec2(.9, .34), alpha(C.bg, .55));
            drawRect(p.add(vec2(0, -.05)), vec2(.3, .9), C.wallTop);
            drawRect(p.add(vec2(0, .42)), vec2(.5, .16), C.blockTop);
            // glowing head
            setAdditiveBlendMode(true);
            drawCircle(p.add(vec2(0, .55)), .55 + pulse*.15, alpha(C.cyan, .16 + pulse*.12));
            setAdditiveBlendMode(false);
            drawCircle(p.add(vec2(0, .55)), .22, C.cyan);
            drawCircle(p.add(vec2(0, .55)), .1, C.ink);
        }
        else if (this.kind == 'arch')
        {
            const pulse = .5 + .5*sin(time*1.6);
            const legs = [-1.6, 1.6];
            for (const lx of legs)
            {
                drawRect(p.add(vec2(lx, .4)), vec2(.5, 3.4), C.wallTop);
                drawRect(p.add(vec2(lx, 2.15)), vec2(.7, .18), alpha(C.neon, .8));
            }
            // the zig-zag bar across the top
            const pts = [];
            for (let i = 0; i <= 8; ++i)
                pts.push(p.add(vec2(-1.6 + i*.4, 2.1 + (i % 2 ? .45 : 0))));
            drawLineList(pts, .16, alpha(C.cyan, .35 + pulse*.35));
            drawLineList(pts, .07, C.ink);
            setAdditiveBlendMode(true);
            drawRect(p.add(vec2(0, 2.3)), vec2(4.4, 1.6), alpha(C.neon, .05 + pulse*.05));
            setAdditiveBlendMode(false);
            drawText('STAGE 01', p.add(vec2(0, 3.1)), .5, C.gold, .04, C.bg, 'center', DATA.ui.font);
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
        const C = DATA.c, p = this.pos, t = time + this.phase;
        const pulse = .5 + .5*sin(t*2.6);
        const near  = player && state == 'world'
            ? clamp(1 - p.subtract(player.pos).length() / 7, 0, 1) : 0;

        // ground pad
        drawEllipse(p.add(vec2(0, -.55)), vec2(3.4, 1.5), alpha(C.bg, .6));
        drawEllipse(p.add(vec2(0, -.55)), vec2(3.4, 1.5), alpha(C.bg, 0), 0,
            C.neon, alpha(C.neon, .35 + near*.4));

        // additive halo
        setAdditiveBlendMode(true);
        drawCircleGradient(p.add(vec2(0, .3)), 4.2 + pulse*.5, alpha(C.neon, .16 + near*.16), alpha(C.neon, 0));
        drawCircleGradient(p.add(vec2(0, .3)), 2.6, alpha(C.cyan, .18), alpha(C.cyan, 0));
        // vertical light shaft
        drawRect(p.add(vec2(0, 2.2)), vec2(.7 + pulse*.25, 4.4), alpha(C.neon, .12 + near*.1));
        setAdditiveBlendMode(false);

        // frame rings
        drawEllipse(p.add(vec2(0, .3)), vec2(2.9 + pulse*.12, 2.9 + pulse*.12), alpha(C.bg, 0), 0,
            C.cyan, alpha(C.cyan, .55 + near*.4));
        drawRegularPoly(p.add(vec2(0, .3)), vec2(2.5), 6, alpha(C.bg, 0), .08,
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

        drawText('STAGE 01', p.add(vec2(0, 2.6)), .55, C.ink, .05, C.bg, 'center', DATA.ui.font);
        drawText('zigzag etude', p.add(vec2(0, 2.05)), .32, C.cyan, 0, C.bg, 'center', DATA.ui.soft);
    }
}

///////////////////////////////////////////////////////////////////////////////
// the player — a little procedural Teto-inspired character
///////////////////////////////////////////////////////////////////////////////

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

        // ---- input: arrows / WASD win outright -----------------------------
        let dir = vec2();
        if (keyIsDown('ArrowLeft'))  dir.x -= 1;
        if (keyIsDown('ArrowRight')) dir.x += 1;
        if (keyIsDown('ArrowUp'))    dir.y += 1;
        if (keyIsDown('ArrowDown'))  dir.y -= 1;

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
        if (!worldHits(vec2(nx, this.pos.y), r)) this.pos.x = nx; else this.vel.x = 0;
        if (!worldHits(vec2(this.pos.x, ny), r)) this.pos.y = ny; else this.vel.y = 0;

        // ---- animation state ------------------------------------------------
        const speed = this.vel.length();
        this.moveAmt = lerp(this.moveAmt, clamp(speed / W.speed), .18);
        this.step += speed*dt*3.2;
        if (this.facing.length() && dir.length())
            this.facing = this.facing.lerp(dir, .3).normalize();

        // ---- the portal ------------------------------------------------------
        const d = this.pos.subtract(portalPos).length();
        if (d < W.portalRange || (keyWasPressed('Space') || keyWasPressed('Enter') ||
            keyWasPressed('NumpadEnter')) && d < W.portalPrompt)
            enterStage();
        else if (mouseWasPressed(0) && d < W.portalPrompt)
            enterStage();
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

        drawTeto(this.pos, 1, this.step, this.facing.x, -this.vel.x*.035,
            1 + this.moveAmt*.14, 1 - this.moveAmt*.14, this.moveAmt, this.bob);
    }
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
// entering / leaving the hub
///////////////////////////////////////////////////////////////////////////////

function initWorld()
{
    if (!worldBuilt) { buildWorld(); worldBuilt = true; }

    cameraPos = worldSpawn.copy();
    cameraScale = DATA.world.camScale;

    makeBackdrop();
    new WorldFloor();
    for (const d of worldDecor) new WorldDecor(d);
    new Portal(portalPos);
    makeAmbient();
    player = new Player(worldSpawn.copy());
}

// move a value toward a target by at most maxDelta
function moveToward(current, target, maxDelta)
{
    const d = target - current;
    return Math.abs(d) <= maxDelta ? target : current + Math.sign(d)*maxDelta;
}
