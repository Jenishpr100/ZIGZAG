/* storage.js — safe localStorage wrapper. Falls back to memory if the browser blocks
   storage for file:// pages, so the game never crashes because of it.

   Every key this build owns lives under ONE stable namespace (NS), so settings, the
   imported song list and anything else written here survive a reload and can be found
   (or wiped) by prefix from any page — DevEdit.html included. Keys that other files
   keep in raw localStorage on purpose are listed in RAW_KEYS and are NOT routed here. */
(function () {
  const Z = (window.ZZ = window.ZZ || {});

  /* namespaced keys -> the real localStorage key is NS + name ("zigzag.settings"). */
  const KEYS = {
    settings: 'settings',    // Z.Settings blob: volumes, seed, difficulty, theme, toggles
    bmpImport: 'bmpImport'   // text of a user-imported songs.bmp (JSON-encoded string)
  };

  /* keys other modules own that deliberately stay raw (no NS prefix). */
  const RAW_KEYS = {
    dev: 'zigzag-dev',          // Z.Dev developer unlock flag (js/settings.js)
    levelPrefix: 'zigzag-level-', // LevelFormat custom levels (js/levelFormat.js)
    world: 'muzic-world'          // WorldFormat instant-play save (js/worldFormat.js)
  };

  const NS = 'zigzag.';
  const mem = {};
  let ok = false;
  try { localStorage.setItem(NS + '__t', '1'); localStorage.removeItem(NS + '__t'); ok = true; } catch (e) {}

  /* JSON.stringify returns undefined for functions/undefined and throws on cycles;
     neither may take the page down or leave a value that JSON.parse can't read back. */
  function encode(value) {
    try {
      const raw = JSON.stringify(value);
      return raw === undefined ? 'null' : raw;
    } catch (e) { return 'null'; }
  }

  Z.Storage = {
    NS, KEYS, RAW_KEYS, persistent: ok,

    /* logical name -> real localStorage key. Names already carrying the namespace pass
       through untouched, so callers can be explicit without double-prefixing. */
    key(name) { return String(name).indexOf(NS) === 0 ? String(name) : NS + name; },

    /* Returns true when storage is the real localStorage (false = memory-only). */
    get(name, def) {
      try {
        const raw = ok ? localStorage.getItem(this.key(name)) : mem[name];
        return raw == null ? def : JSON.parse(raw);
      } catch (e) { return def; }
    },
    set(name, value) {
      const raw = encode(value);
      if (ok) { try { localStorage.setItem(this.key(name), raw); return true; } catch (e) {} }
      mem[name] = raw;
      return false;
    },
    remove(name) { try { if (ok) localStorage.removeItem(this.key(name)); } catch (e) {} delete mem[name]; },
    has(name) { try { return ok ? localStorage.getItem(this.key(name)) !== null : name in mem; } catch (e) { return name in mem; } },

    /* every namespaced key currently in storage — handy for debugging and for a
       "reset everything" button. Never throws, even if localStorage is half-blocked. */
    keys() {
      const out = [];
      if (ok) { try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf(NS) === 0) out.push(k.slice(NS.length)); } } catch (e) {} }
      for (const k in mem) if (out.indexOf(k) < 0) out.push(k);
      return out;
    },

    /* wipe only this build's namespace; raw keys owned by other modules are untouched. */
    clear() { this.keys().forEach(k => this.remove(k)); }
  };
})();