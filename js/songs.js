/* songs.js — song list + BPM parsing.
   Browsers cannot list a folder from file://, so songs come from js/song-manifest.js.
   BPM values come from js/songs-bpm.txt (plain text). Browsers often block reading that file
   from file://, so the manifest embeds a copy (ZIGZAG_SONGS.bpm) as a fallback, and the Song
   Select screen can also import a BPM text file with a file picker. */
(function () {
  const Z = (window.ZZ = window.ZZ || {});
  const FILE_RE = /^(\d+)-(.+)\.(mp3|wav|ogg|m4a|aac|webm|flac)$/i; // numbered, browser-playable audio filename
  const DEFAULT_BPM = 120;

  function parseFilename(file) {
    const m = FILE_RE.exec(String(file).trim());
    if (!m) return null;
    const id = parseInt(m[1], 10), name = m[2].trim();
    if (!name) return null;
    return { id, name, file };
  }

  /* Format:  id=bpm   or   id=bpm,firstBeatSeconds   (# comments, blank lines ignored) */
  function parseBmp(text) {
    const map = {}, errors = [];
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
      const line = raw.replace(/^\uFEFF/, '').trim();
      if (!line || line[0] === '#') return;
      const m = /^(\d+)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*(?:,\s*([0-9]+(?:\.[0-9]+)?))?\s*(?:#.*)?$/.exec(line);
      if (!m) { errors.push('BPM list line ' + (i + 1) + ': cannot read "' + line + '" (use id=bpm).'); return; }
      const id = parseInt(m[1], 10), bpm = parseFloat(m[2]);
      if (bpm < 30 || bpm > 400) { errors.push('BPM list line ' + (i + 1) + ': BPM ' + bpm + ' is outside 30–400.'); return; }
      if (map[id]) errors.push('BPM list line ' + (i + 1) + ': song ' + id + ' listed twice; using the last value.');
      map[id] = { bpm, offset: m[3] ? parseFloat(m[3]) : 0 };
    });
    return { map, errors };
  }

  function readBmpFile(cb) {            // works on http(s) and some browsers; fails quietly on file://
    try {
      const x = new XMLHttpRequest();
      x.open('GET', 'js/songs-bpm.txt?' + Date.now());
      x.overrideMimeType('text/plain');
      x.onload = () => cb((x.status === 200 || (x.status === 0 && x.responseText)) ? x.responseText : null);
      x.onerror = () => cb(null);
      x.send();
    } catch (e) { cb(null); }
  }

  const Songs = Z.Songs = {
    list: [], notices: [], bpmSource: '',
    parseFilename, parseBmp,
    build(bmpText, source) {
      const man = window.ZIGZAG_SONGS || { files: [], bpm: '' };
      const notices = [], seen = {}, list = [];
      if (!window.ZIGZAG_SONGS) notices.push('js/song-manifest.js is missing or has an error, so no songs are listed.');
      const parsed = parseBmp(bmpText);
      parsed.errors.forEach(e => notices.push(e));
      (man.files || []).forEach(f => {
        const p = parseFilename(f);
        if (!p) { notices.push('Ignored "' + f + '": use a numbered audio filename such as 1-Song Name.mp3'); return; }
        if (seen[p.id]) { notices.push('Ignored "' + f + '": ID ' + p.id + ' is already used by "' + seen[p.id] + '".'); return; }
        seen[p.id] = f;
        const b = parsed.map[p.id];
        if (!b) notices.push('No BPM for song ' + p.id + ' (' + p.name + ') in the BPM list; using ' + DEFAULT_BPM + '.');
        const embeddedSong = window.ZIGZAG_INLINE_ASSETS && window.ZIGZAG_INLINE_ASSETS.songs && window.ZIGZAG_INLINE_ASSETS.songs[f];
        list.push({ id: p.id, name: p.name, file: f, url: embeddedSong || 'songs/' + encodeURIComponent(f),
          bpm: b ? b.bpm : DEFAULT_BPM, offset: b ? b.offset : 0,
          duration: Number(man.durations && man.durations[f]) || 0, status: 'unknown' });
      });
      Object.keys(parsed.map).forEach(id => { if (!seen[id]) notices.push('The BPM list contains ID ' + id + ' but the matching audio file is not in js/song-manifest.js.'); });

      list.sort((a, b) => (b.id > 0) - (a.id > 0) || a.id - b.id || a.name.localeCompare(b.name));
      Songs.list = list; Songs.notices = notices; Songs.bpmSource = source;
    },
    load(cb) {
      const man = window.ZIGZAG_SONGS || {};
      if (window.ZIGZAG_INLINE_ASSETS) {
        Songs.build(man.bpm || '', 'embedded in index.html');
        cb();
        return;
      }
      readBmpFile(text => {
        if (text != null) { Songs.build(text, 'js/songs-bpm.txt'); return cb(); }
        const imported = Z.Storage.get('bmpImport', null);
        if (imported) { Songs.build(imported, 'imported BPM list'); return cb(); }
        Songs.build(man.bpm || '', 'built-in copy in js/song-manifest.js');
        cb();
      });
    },
    importBmp(text) { Z.Storage.set('bmpImport', text); Songs.build(text, 'imported BPM list'); },
    clearImport() { Z.Storage.remove('bmpImport'); Songs.build((window.ZIGZAG_SONGS || {}).bpm || '', 'built-in copy in js/song-manifest.js'); },
    byId(id) { return Songs.list.find(s => s.id === id) || null; },
  };
})();
