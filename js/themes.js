/* themes.js — data-driven themes. To add a theme, copy one entry below and give it a new key.
   Canvas colors drive the playfield; "ui" colors become CSS variables for the menus. */
(function () {
  const Z = (window.ZZ = window.ZZ || {});
  Z.THEMES = {
    neon: {
      name: 'Neon',
      bg: ['#0b0620', '#1d0b3f'], grid: 'rgba(255,255,255,.07)',
      tap: '#ff4fa3', hold: '#4ff3ff', drag: '#c6ff4f', path: '#ffffff',
      particles: ['#ff4fa3', '#4ff3ff', '#fff36b', '#c6ff4f'],
      ui: { accent: '#ff4fa3', accent2: '#4ff3ff', bg: '#0b0620', panel: 'rgba(32,14,66,.72)', text: '#f6efff', dim: '#b7a6d9' }
    },
    ocean: {
      name: 'Ocean',
      bg: ['#031a2b', '#06384f'], grid: 'rgba(160,230,255,.08)',
      tap: '#38d6ff', hold: '#7affc8', drag: '#ffd166', path: '#d9f6ff',
      particles: ['#38d6ff', '#7affc8', '#ffffff', '#6aa9ff'],
      ui: { accent: '#38d6ff', accent2: '#7affc8', bg: '#031a2b', panel: 'rgba(5,50,74,.72)', text: '#e8f9ff', dim: '#8fb9c9' }
    },
    sunset: {
      name: 'Sunset',
      bg: ['#2a0a1c', '#5c1a2b'], grid: 'rgba(255,200,150,.08)',
      tap: '#ff8a3d', hold: '#ffd23f', drag: '#ff4f7b', path: '#ffe6cf',
      particles: ['#ff8a3d', '#ffd23f', '#ff4f7b', '#ffffff'],
      ui: { accent: '#ff8a3d', accent2: '#ff4f7b', bg: '#2a0a1c', panel: 'rgba(80,22,36,.72)', text: '#fff1e6', dim: '#d5a58f' }
    },
    mono: {
      name: 'Monochrome',
      bg: ['#0d0d0d', '#262626'], grid: 'rgba(255,255,255,.07)',
      tap: '#f2f2f2', hold: '#bdbdbd', drag: '#8f8f8f', path: '#ffffff',
      particles: ['#ffffff', '#cfcfcf', '#9a9a9a'],
      ui: { accent: '#f2f2f2', accent2: '#9a9a9a', bg: '#0d0d0d', panel: 'rgba(40,40,40,.75)', text: '#f5f5f5', dim: '#9d9d9d' }
    }
  };
  Z.theme = Z.THEMES.neon;
  Z.applyTheme = function (id) {
    const t = Z.THEMES[id] || Z.THEMES.neon;
    Z.theme = t;
    const r = document.documentElement.style;
    for (const k in t.ui) r.setProperty('--' + k, t.ui[k]);
    r.setProperty('--bg2', t.bg[1]);
    return t;
  };
})();
