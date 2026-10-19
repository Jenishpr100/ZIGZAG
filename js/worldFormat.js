/* worldFormat.js — shared "muzic-switch-world" v0 schema (Plan.md A2): rooms, terrain,
   doors, NPCs, enemies, triggers and dialogs. Dependency-free like levelFormat.js: no
   LittleJS, no DOM APIs — safe in the main game (index.html), the runtime overworld.js,
   and the standalone DevEdit.html WORLD tab.

   Dialogs are paged. A dialog MAY also carry `options` — a branching choice list
   shown after the last page:

     "welcome": { "name": "Villager",
                  "pages": ["Welcome!", "…"],
                  "options": [ { "text": "Tell me about the ZAG world.", "goto": "zag_lore" },
                               { "text": "Goodbye.",               "goto": null      } ] }

   `options` is optional (a dialog without it is exactly as before: linear pages, then
   close). 1..6 entries; `text` non-empty; `goto` is a dialog id or null (close).

   Storage key: localStorage 'muzic-world' (instant-play save). GAME.BIN files are the
   same JSON produced by toJSON()/fromJSON(). */
(function () {
  'use strict';

  const FORMAT = 'muzic-switch-world';
  const VERSION = 0;
  const LS_KEY = 'muzic-world';
  const WORLDS = ['zig', 'zag', 'both'];
  const DIRS = ['up', 'down', 'left', 'right'];
  const TERRAIN_CHARS = ['#', '.', '-'];   // # wall · . floor · - path
  const MAX_OPTIONS = 6;                    // max branching choices per dialog (dialogs.*.options)

  /* ---- storage (localStorage with in-memory fallback for file:// lockdowns / Node) ---- */
  const mem = {};
  function lsGet(k) {
    try { return localStorage.getItem(k); } catch (e) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; }
  }

  /* ---- helpers ---- */
  const isNum = x => typeof x === 'number' && isFinite(x);
  const isInt = x => isNum(x) && Math.floor(x) === x;

  /* ---- validation ---- */
  function validate(world) {
    const errors = [];
    if (!world || typeof world !== 'object' || Array.isArray(world))
      return { valid: false, errors: ['World must be an object.'] };
    if (world.format !== FORMAT) errors.push('format must be "' + FORMAT + '" (got ' + JSON.stringify(world.format) + ').');
    if (!isNum(world.version)) errors.push('version must be a number.');
    else if (world.version !== VERSION) errors.push('version must be ' + VERSION + ' (got ' + world.version + ').');

    const rooms = world.rooms;
    const dialogs = world.dialogs;
    if (!rooms || typeof rooms !== 'object' || Array.isArray(rooms) || !Object.keys(rooms).length)
      errors.push('rooms must be a non-empty object of room entries.');
    if (!dialogs || typeof dialogs !== 'object' || Array.isArray(dialogs))
      errors.push('dialogs must be an object (may be empty).');

    const roomIds = rooms && typeof rooms === 'object' && !Array.isArray(rooms) ? Object.keys(rooms) : [];
    const dialogIds = dialogs && typeof dialogs === 'object' && !Array.isArray(dialogs) ? Object.keys(dialogs) : [];

    /* ---- dialogs ---- */
    dialogIds.forEach(dk => {
      const d = dialogs[dk], where = 'dialogs.' + dk;
      if (!d || typeof d !== 'object' || Array.isArray(d)) { errors.push(where + ' must be an object.'); return; }
      if (typeof d.name !== 'string' || !d.name.trim()) errors.push(where + '.name must be a non-empty string (speaker).');
      if (!Array.isArray(d.pages) || !d.pages.length) errors.push(where + '.pages must be a non-empty array of strings.');
      else d.pages.forEach((p, i) => {
        if (typeof p !== 'string' || !p.length) errors.push(where + '.pages[' + i + '] must be a non-empty string.');
      });

      /* optional branching choices, shown after the last page */
      if (d.options != null) {
        if (!Array.isArray(d.options))
          errors.push(where + '.options must be an array of 1..' + MAX_OPTIONS + ' choices (omit it for a linear dialog).');
        else if (d.options.length < 1 || d.options.length > MAX_OPTIONS)
          errors.push(where + '.options must have between 1 and ' + MAX_OPTIONS + ' entries (got ' + d.options.length + ').');
        else d.options.forEach((o, i) => {
          const w2 = where + '.options[' + i + ']';
          if (!o || typeof o !== 'object' || Array.isArray(o)) { errors.push(w2 + ' must be an object.'); return; }
          if (typeof o.text !== 'string' || !o.text.trim()) errors.push(w2 + '.text must be a non-empty string.');
          if (o.goto != null) {
            if (typeof o.goto !== 'string' || !o.goto) errors.push(w2 + '.goto must be a non-empty dialog id string, or null to close the dialog.');
            else if (dialogIds.indexOf(o.goto) < 0) errors.push(w2 + '.goto references missing dialog "' + o.goto + '".');
          }
        });
      }
    });

    /* ---- rooms ---- */
    roomIds.forEach(rk => {
      const r = rooms[rk], where = 'rooms.' + rk;
      if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push(where + ' must be an object.'); return; }
      if (typeof r.name !== 'string' || !r.name.trim()) errors.push(where + '.name must be a non-empty string.');
      if (WORLDS.indexOf(r.world) < 0) errors.push(where + '.world must be "zig", "zag" or "both" (got ' + JSON.stringify(r.world) + ').');
      let W = 0, H = 0;
      if (!Array.isArray(r.size) || r.size.length !== 2 || !isInt(r.size[0]) || !isInt(r.size[1]) || r.size[0] < 1 || r.size[1] < 1) {
        errors.push(where + '.size must be [w, h] of positive integers.');
      } else { W = r.size[0]; H = r.size[1]; }
      if (!Array.isArray(r.terrain)) {
        errors.push(where + '.terrain must be an array of row strings.');
      } else if (W && H) {
        if (r.terrain.length !== H) errors.push(where + '.terrain must have exactly ' + H + ' rows (size h), got ' + r.terrain.length + '.');
        r.terrain.forEach((row, y) => {
          if (typeof row !== 'string') { errors.push(where + '.terrain[' + y + '] must be a string.'); return; }
          if (row.length !== W) errors.push(where + '.terrain[' + y + '] must be exactly ' + W + ' chars (size w), got ' + row.length + '.');
          for (let x = 0; x < row.length; x++) {
            if (TERRAIN_CHARS.indexOf(row[x]) < 0) {
              errors.push(where + '.terrain[' + y + '] has invalid char ' + JSON.stringify(row[x]) + ' at x=' + x + ' (allowed: ' + TERRAIN_CHARS.join(' ') + ').');
              break; // one error per row is enough
            }
          }
        });
      }
      const inBounds = (x, y) => !W || (isInt(x) && isInt(y) && x >= 0 && y >= 0 && x < W && y < H);
      const checkDialogRef = (ref, where2) => {
        if (ref == null) return;
        if (typeof ref !== 'string' || !ref) { errors.push(where2 + ' must be a non-empty dialog id string.'); return; }
        if (dialogIds.indexOf(ref) < 0) errors.push(where2 + ' references missing dialog "' + ref + '".');
      };

      /* doors */
      if (!Array.isArray(r.doors)) errors.push(where + '.doors must be an array.');
      else {
        const seen = {};
        r.doors.forEach((d, i) => {
          const w2 = where + '.doors[' + i + ']';
          if (!d || typeof d !== 'object') { errors.push(w2 + ' must be an object.'); return; }
          if (typeof d.id !== 'string' || !d.id) errors.push(w2 + '.id must be a non-empty string.');
          else if (seen[d.id]) errors.push(w2 + '.id "' + d.id + '" is duplicated in this room.');
          else seen[d.id] = 1;
          if (!inBounds(d.x, d.y)) errors.push(w2 + '.x/.y must be integer tile coords inside the room.');
          if (typeof d.to !== 'string' || !d.to) errors.push(w2 + '.to must be a non-empty room id.');
          else if (roomIds.indexOf(d.to) < 0) errors.push(w2 + '.to references missing room "' + d.to + '".');
          if (!isInt(d.tx) || !isInt(d.ty)) errors.push(w2 + '.tx/.ty must be integers (target tile in "' + d.to + '").');
          if (d.lockedBy != null && (typeof d.lockedBy !== 'string' || !d.lockedBy)) errors.push(w2 + '.lockedBy must be a non-empty enemy id string when present.');
          if (d.dir != null && DIRS.indexOf(d.dir) < 0) errors.push(w2 + '.dir must be one of ' + DIRS.join('/') + ' when present.');
        });
      }

      /* npcs */
      if (!Array.isArray(r.npcs)) errors.push(where + '.npcs must be an array.');
      else {
        const seen = {};
        r.npcs.forEach((n, i) => {
          const w2 = where + '.npcs[' + i + ']';
          if (!n || typeof n !== 'object') { errors.push(w2 + ' must be an object.'); return; }
          if (typeof n.id !== 'string' || !n.id) errors.push(w2 + '.id must be a non-empty string.');
          else if (seen[n.id]) errors.push(w2 + '.id "' + n.id + '" is duplicated in this room.');
          else seen[n.id] = 1;
          if (typeof n.sprite !== 'string' || !n.sprite) errors.push(w2 + '.sprite must be a non-empty string (e.g. "NPC_1").');
          if (!inBounds(n.x, n.y)) errors.push(w2 + '.x/.y must be integer tile coords inside the room.');
          if (n.dir != null && DIRS.indexOf(n.dir) < 0) errors.push(w2 + '.dir must be one of ' + DIRS.join('/') + ' when present.');
          checkDialogRef(n.dialog, w2 + '.dialog');
        });
      }

      /* enemies */
      if (!Array.isArray(r.enemies)) errors.push(where + '.enemies must be an array.');
      else {
        const seen = {};
        r.enemies.forEach((n, i) => {
          const w2 = where + '.enemies[' + i + ']';
          if (!n || typeof n !== 'object') { errors.push(w2 + ' must be an object.'); return; }
          if (typeof n.id !== 'string' || !n.id) errors.push(w2 + '.id must be a non-empty string.');
          else if (seen[n.id]) errors.push(w2 + '.id "' + n.id + '" is duplicated in this room.');
          else seen[n.id] = 1;
          if (!inBounds(n.x, n.y)) errors.push(w2 + '.x/.y must be integer tile coords inside the room.');
          if (!isNum(n.hp) || n.hp <= 0) errors.push(w2 + '.hp must be a positive number.');
          if (typeof n.name !== 'string' || !n.name.trim()) errors.push(w2 + '.name must be a non-empty string.');
        });
      }

      /* triggers */
      if (!Array.isArray(r.triggers)) errors.push(where + '.triggers must be an array.');
      else r.triggers.forEach((t, i) => {
        const w2 = where + '.triggers[' + i + ']';
        if (!t || typeof t !== 'object') { errors.push(w2 + ' must be an object.'); return; }
        if (!inBounds(t.x, t.y)) errors.push(w2 + '.x/.y must be integer tile coords inside the room.');
        if (!isInt(t.w) || !isInt(t.h) || t.w < 1 || t.h < 1) errors.push(w2 + '.w/.h must be integers >= 1.');
        else if (W && H && (t.x < 0 || t.y < 0 || t.x + t.w > W || t.y + t.h > H))
          errors.push(w2 + ' rect (' + t.x + ',' + t.y + ' ' + t.w + 'x' + t.h + ') sticks out of the ' + W + 'x' + H + ' room.');
        if (typeof t.dialog !== 'string' || !t.dialog) errors.push(w2 + '.dialog must be a non-empty dialog id string.');
        else if (dialogIds.indexOf(t.dialog) < 0) errors.push(w2 + '.dialog references missing dialog "' + t.dialog + '".');
      });
    });

    return { valid: !errors.length, errors };
  }

  /* ---- template world: one starter room + one dialog ---- */
  function createBlank() {
    const W = 20, H = 12;
    const terrain = [];
    for (let y = 0; y < H; y++) {
      let row = '';
      for (let x = 0; x < W; x++)
        row += (y === 0 || y === H - 1 || x === 0 || x === W - 1) ? '#' : (x === 10 ? '-' : '.');
      terrain.push(row);
    }
    return {
      format: FORMAT,
      version: VERSION,
      rooms: {
        hub: {
          name: 'Starter Room',
          world: 'both',
          size: [W, H],
          terrain,
          doors: [],
          npcs: [{ id: 'npc1', sprite: 'NPC_1', x: 9, y: 6, dir: 'down', dialog: 'welcome' }],
          enemies: [],
          triggers: [{ x: 1, y: 1, w: 3, h: 1, dialog: 'welcome' }]
        }
      },
      dialogs: {
        welcome: {
          name: 'Villager',
          pages: ['Welcome to MuZiC "Switch"!', 'This world was made in DevEdit.']
        }
      }
    };
  }

  /* ---- persistence ---- */
  function getWorld() {
    const raw = lsGet(LS_KEY);
    if (raw == null) return null;
    let world = null;
    try { world = JSON.parse(raw); } catch (e) { return null; }
    if (!validate(world).valid) return null;
    return world;
  }
  function save(world) {
    const v = validate(world);
    if (!v.valid) return { saved: false, errors: v.errors };
    lsSet(LS_KEY, JSON.stringify(world));
    return { saved: true, errors: [] };
  }

  /* ---- JSON import/export (GAME.BIN content) ---- */
  function toJSON(world) { return JSON.stringify(world, null, 2); }
  function fromJSON(jsonString) {
    let world = null;
    try { world = JSON.parse(String(jsonString)); }
    catch (e) { return { valid: false, world: null, errors: ['Invalid JSON: ' + e.message] }; }
    const v = validate(world);
    return { valid: v.valid, world: v.valid ? world : null, errors: v.errors };
  }

  window.WorldFormat = {
    FORMAT, VERSION, LS_KEY, WORLDS, DIRS, TERRAIN_CHARS, MAX_OPTIONS,
    validate, createBlank, getWorld, save, toJSON, fromJSON
  };
})();
