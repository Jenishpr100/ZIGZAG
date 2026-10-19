/* storage.js — safe localStorage wrapper. Falls back to memory if the browser blocks
   storage for file:// pages, so the game never crashes because of it. */
(function () {
  const Z = (window.ZZ = window.ZZ || {});
  const mem = {};
  let ok = false;
  try { localStorage.setItem('zigzag.__t', '1'); localStorage.removeItem('zigzag.__t'); ok = true; } catch (e) {}
  Z.Storage = {
    persistent: ok,
    get(key, def) {
      try {
        const raw = ok ? localStorage.getItem('zigzag.' + key) : mem[key];
        return raw == null ? def : JSON.parse(raw);
      } catch (e) { return def; }
    },
    set(key, value) {
      const raw = JSON.stringify(value);
      if (ok) { try { localStorage.setItem('zigzag.' + key, raw); return; } catch (e) {} }
      mem[key] = raw;
    },
    remove(key) { try { if (ok) localStorage.removeItem('zigzag.' + key); } catch (e) {} delete mem[key]; }
  };
})();
