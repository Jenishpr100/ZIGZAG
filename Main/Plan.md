# The plan for the game
## The these must be ZIGZAG cause thats why the gamejam wants
- Our goal is not winning, it is to make something that works.

---

*(Full jam plan below — approved Oct 17, 2026. Original notes kept above.)*

# ProjectZigZag — LittleJS Jam 3 Plan
**Working title:** ZIGZAG SYNTH (placeholder — rename freely)
**Jam:** LittleJS Jam 3 · Oct 2 – Nov 2, 2026 · Theme: **ZIGZAG** · Plan date: Oct 17 → **16 days left**

## 1. Jam constraints (non-negotiable)
- **Must** use LittleJS engine ✅ (npm installed: `littlejsengine`)
- **Must** be free & playable in browser (HTML embedded on itch page)
- **ZIGZAG must be visible in gameplay**, not just decoration
- AI allowed for anything — **must disclose tools used** in the itch description
- External assets allowed if you have the right to use them (Teto fan art = fine, **original music only** — no copyrighted UTAU/Vocaloid tracks)
- Majority built during the jam; updates allowed during voting
- Bonus: Wavedash track ($10–100) — attempt **only** if base game ships by Oct 30

## 2. Decision log (locked)
| Decision | Value |
|---|---|
| Genre | **PJSK (Project Sekai) × Piano Tiles** rhythm-tap game — the required presses **ZIGZAG** |
| Audio identity | **Instrument Synth** — taps play synth notes; player performs the song |
| Character | **Teto** (friend's art) |
| Combat | **Bravely Default / Bravely Second–style BP combat** (Default banks BP, Brave spends + debt) — APPROVED |
| Traversal | **Pokémon-style** top-down overworld — ASSUMED |
| Drawing tablet support | REJECTED (mouse/touch/keyboard; LittleJS already routes touch→mouse) |
| Scope | Solid arcade release |
| Structure | **Multiple files allowed**, no bundler (plain `<script>` tags) |
| Work split | Fluid: "anything we want or should do, we do" |
| Goal | Something that **works** > winning |

## 3. Game design

### 3.1 The loop (MVP)
```
title → overworld (Pokémon-style walk) → stage/battle marker
     → rhythm stage (CORE) or rhythm-battle (BP combat) → results
     → back to overworld → unlock next → final → title
localStorage: high scores + unlocks
```

### 3.2 Rhythm core — the ZIGZAG presses
- Notes fall toward a judge line (PJSK lanes + judgment flash)
- **The required tap order zigzags**: next note always alternates side → a literal zigzag polyline connects the notes (theme is unmissable in 30s)
- Piano Tiles flavor: tap where the tile is; keyboard (Space/Enter) also works
- Judgments: **PERFECT / GREAT / GOOD / MISS** — starting windows ±60 / ±110 / ±160 ms (all tunable in `data.js`)
- Combo, score, fever-flashes, screen juice
- **Open design point (decide by M1 playtest with friend):** exact tap rule — "any press near the line" vs "press must be on the tile's side/X"
- Timing clock: template uses engine `time`; **M1 upgrades to `audioContext.currentTime`** for sample-accurate sync (required for a serious rhythm game)

### 3.3 Instrument Synth
- Small custom Web Audio synth (oscillator + envelope) wired into LittleJS `audioMasterGain` → engine volume/mute controls everything
- Each lane/scale-degree → taps produce a pentatonic lead line (**your play IS the song**); miss = silent note, so performance degrades with accuracy — instant juice
- Friend's role: original songs as **charts** (JSON note data: time + lane), synth **presets** (waveform/filter/env), optional overworld BGM
- ZzFX (built into LittleJS) for UI/SFX — generate with the ZzFX designer tool, paste arrays in
- Chart format: `assets/charts/song1.json = { bpm, notes:[{t, side, len?}] }` (holds/stretch notes = stretch goal)

### 3.4 Bravely-style combat (rhythm-battle)
- Encounter on the map (Pokémon-style contact) → battle: enemy with HP + telegraphed intent
- Battle = alternating **rhythm phrases**: notes landed = damage dealt, notes missed = damage taken
- **BP economy (the Bravely twist):**
  - **Default** (guard/bank window): abstain from the bonus-note stream during safe phrases → **+1 BP**, reduced incoming damage
  - **Brave** (press B): spend up to 3 stored BP → burst phrase (×2 damage); BP may drop to **−3 (debt)** — you must Default through future bank windows to recover, else damage taken grows
  - Bravely's risk/tempo loop, expressed rhythmically
- **Cut-line:** if BP drags, fall back to a flat combo multiplier — the rhythm stage alone still ships as a complete game

### 3.5 Overworld (Pokémon-style)
- Grid tile map (start: 1 hub ~24×16), 4-direction step movement with smooth tween, camera follows, wall collision
- Marker triggers: stage portals, battle contacts, NPC dialog box, heal point
- Teto overworld sprite (friend) — **day-1 placeholder: colored square + "T"**; art is an M4 swap, never a blocker
- **Cut-line:** if behind → stage-select menu instead of a map (traversal drops to a list, game still ships)

### 3.6 ZIGZAG theme checklist
1. Press path zigzags — **core gameplay** ✅
2. Zigzag polyline drawn between notes ✅
3. Overworld paths zigzag between nodes (nice-to-have)
4. Title/logo motif (free)

## 4. Architecture

### 4.1 File layout
```
ProjectZigZag/
├── index.html               ← shell: script tags only
├── js/
│   ├── main.js              ← engineInit + 5 callbacks + state machine
│   ├── data.js              ← ALL tuning (windows, lanes, colors, chart list)
│   ├── audio.js             ← synth engine + SFX hooks
│   ├── rhythm.js            ← chart runner + judgment (from M1)
│   ├── overworld.js         ← grid map, movement, triggers (from M2)
│   ├── battle.js            ← HP, intents, BP economy (from M3)
│   └── hud.js               ← score/combo/judgment UI (from M1, split as needed)
├── assets/
│   ├── img/  music/  charts/   ← lowercase filenames only
└── node_modules/littlejsengine/ ← dev only, NEVER uploaded
```
Plain globals, no bundler. One person per file at a time — say in chat which file you're in.

### 4.2 Key LittleJS APIs (from REFERENCE.md)
- `engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost)`
- Input: `keyWasPressed('Space')`, `mouseWasPressed(0)`, `mousePos` (touch auto-routes to mouse)
- Draw: `drawRect/drawLine` (world), `drawTextScreen` (HUD), `cameraPos/cameraScale`
- Audio: `audioContext`, `audioMasterGain`, `Sound`, `zzfx`, `getNoteFrequency`
- Save: `readSaveData(name, defaultObj)` / `writeSaveData(name, obj)`
- Juice: `ParticleEmitter`, `hsl/rgb`, `Tween`, scene system
- Release: swap script src to `littlejs.min.js`

### 4.3 Dev workflow
- Local server when assets appear: `npx http-server` → `http://localhost:8080`
- Git: small commits before/after each chunk, both of you, honest messages
- Playtest together every milestone — one question: **"is it fun yet?"**

## 5. Milestones (Oct 17 → Nov 2)

| Dates | Milestone | Done when |
|---|---|---|
| Oct 17–19 | **M0: Template + shell** | Template files pushed; title → demo stage → results → restart works; judgment demo proves the feel |
| Oct 19–22 | **M1: Rhythm vertical slice** ⭐ | One real zigzag chart + synth notes + ratings + combo; audio-clock timing; tap rule decided with friend — **the fun gate** |
| Oct 22–25 | **M2: Overworld shell** | Grid map, step movement, camera, collision, portals → stages, NPC dialog stub |
| Oct 25–28 | **M3: Battle layer** | Encounters, HP/intents, Default/Brave BP economy, one boss |
| Oct 28–30 | **M4: Content + art** | 2nd chart, Teto art swap-in, PJSK-style juice (fever/particles/flashes), title art |
| Oct 30–Nov 1 | **M5: Polish** | Balance, difficulty, high scores, touch test, pause/volume, bugfix |
| Nov 1 | **Buffer** | Bug fixes only — **no new features** |
| **Nov 2** | **M6: Submit** | Upload **early in the day**; test the itch embed |

**Cut ladder when behind:** 2nd stage → BP economy → overworld map → hold notes → NPC/story → Wavedash.

## 6. Work lanes (fluid, but suggested)
- **You (code driver):** timing core, state machine, input, save, battle logic — the subtle-bug zone. AI writes it; you test it.
- **Friend (content):** charts (THE most important asset), music/synth presets, art (Teto, UI, palette), juice decisions. Can grab small code tasks (HUD text, particle tuning) with AI help.
- **Both:** playtest each milestone; one file at a time; commit constantly.

## 7. Risks & mitigations
1. **Timing precision** → audio clock at M1; test on 60 Hz + laptop
2. **Scope (3 systems)** → cut ladder; rhythm slice is a shippable game alone
3. **Two beginners + AI** → thin `main.js`, all tuning in `data.js`, commented template sections
4. **Art dependency** → placeholders day 1; art only ever swaps in (M4)
5. **Music dependency** → M1 chart = hand-made demo (original click track); friend's charts by M4 — **original compositions only**
6. **Deadline** → submit minimal Nov 1; jam allows updates during voting

## 8. Submission checklist
- [ ] Runs from the **itch embed** (Chrome + Firefox + phone touch)
- [ ] Zip: `index.html` + `js/` + `assets/` + `littlejs.min.js` — **no `node_modules`**
- [ ] AI tools disclosed in description; credits (friend's art/music, LittleJS)
- [ ] ZIGZAG obvious in first 30 seconds
- [ ] Screenshots/GIF, controls listed, high score persists after reload
- [ ] Volume/mute + pause exist

## 9. Status
- [x] Plan approved
- [x] M0 template created (index.html, js/data.js, js/audio.js, js/main.js)
- [ ] M0 tested in browser (open index.html — tap/Space through the demo chart)
- [ ] M1 starts Oct 19: audio-clock timing, real chart, tap-rule decision
---

## AMENDMENTS (2026-10-18, queued while lanes in flight)

### A1. Game title rename
- **Old:** ZIGZAG (temp) → **New:** `MuZiC "Switch"`
- Applied already: `index.html` (<title>, aria-label, footer, noscript), `README.md`.
- **Queued for lanes when they land:**
  - des-2 (hud.js): title screen word (line ~154), HUD corner title (line ~241), results titles → `MuZiC "Switch"` (keep zigzag theme copy elsewhere).
  - fix-3 (menu.js): logo spans `'ZIGZAG'.split('')` (line ~31) → split `MUZIC SWITCH` or render stylized `MuZiC "Switch"`.
  - fix-1 (littlejs-game.js): chart default title `'Zigzag Etude'` → keep (song name, fine) but banner wording may mention game name.
- Theme word "zigzag" stays visible in gameplay/copy (jam theme requirement) — only the *game title* changes.

### A2. DevEdit expands → comprehensive Dialogue + Room + Map Maker/Editor (fix-3 follow-up)
- Add editor tabs: **BEATMAP** (existing play-to-map) + **WORLD** (rooms/doors/NPCs/dialogue).
- WORLD tab: draw room grid, place walls/doors/NPCs/enemies/triggers, link doors to target rooms, author dialogue scripts per NPC/trigger (page-per-line, name per speaker).
- **Export = `GAME.BIN`** (one file, JSON content): all dialogs + all rooms + character placements + door links in a single bundle.
- New shared schema `muzic-switch-world` v0:

```json
{
  "format": "muzic-switch-world", "version": 0,
  "rooms": {
    "town": {
      "name": "Zig Zag Town", "world": "zig",
      "size": [40, 30],
      "terrain": ["####........####", "...row strings..."],
      "doors": [{"id":"d1","x":10,"y":0,"to":"plaza","tx":10,"ty":28,"lockedBy":"boss_north"}],
      "npcs": [{"id":"npc1","sprite":"NPC_1","x":8,"y":6,"dir":"down","dialog":"welcome"}],
      "enemies": [{"id":"boss_north","x":30,"y":4,"hp":100,"name":"Static Warden"}],
      "triggers": [{"x":1,"y":1,"w":3,"h":1,"dialog":"intro_banner"}]
    }
  },
  "dialogs": {
    "welcome": {"name":"Villager","pages":["Welcome!","Press DOWN to switch worlds."]}
  }
}
```
- Save: download `GAME.BIN` + also `localStorage` (`muzic-world`) for instant play; main game loads GAME.BIN if present else built-in default world.
- `levelFormat.js` (beatmap) and world format stay separate files; DevEdit is the one UI editing both.

### A3. Pokémon-style doors (des-2 follow-up)
- Rooms = separate maps (multi-room world instead of single 40×30 hub).
- Walk onto door tile → 0.3–0.4s fade to black → player appears at linked door (target room, tx/ty, facing set by door dir) → fade in.
- `lockedBy` door: if enemy not in `defeatedEnemies` → bump + dialog "The enemy blocks your path!" + red flash (no teleport).
- Both worlds (zig/zag) may define rooms; Down-switch keeps player in same room (palette swap) — room geometry shared, world only changes palette + visible layers (per A2 `world` field: zig/zag/both).

- NOTICE TO LLM: MOVEMENT SHOULD BE LIKE POKEMON GAMEBOY, NOT DIAGONAL. MUSIC ASPECT OF THE GAME IS WRONG. THE ENEMIES SHOULD 
NOT BE DOING THE RHYTHM GAME. THEY SIMPLY ATTACK WITH DIALOG. RESTORE OG MENU FROM PREVIOUS COMMITS. 
