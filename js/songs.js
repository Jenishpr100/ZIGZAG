/* songs.js — song list + BPM parsing.
   Browsers cannot list a folder from file://, so songs come from songs/songs.js (the manifest).
   BPM values come from songs/songs.bmp (plain text). Browsers often block reading that file
   from file://, so the manifest embeds a copy (ZIGZAG_SONGS.bpm) as a fallback, and the Song
   Select screen can also import songs.bmp with a file picker. */
(function () {
  const Z = (window.ZZ = window.ZZ || {});
  const FILE_RE = /^(\d+)-(.+)\.mp3$/i;      // "12-My - Song.mp3" -> id 12, name "My - Song"
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
      if (!m) { errors.push('songs.bmp line ' + (i + 1) + ': cannot read "' + line + '" (use id=bpm).'); return; }
      const id = parseInt(m[1], 10), bpm = parseFloat(m[2]);
      if (bpm < 30 || bpm > 400) { errors.push('songs.bmp line ' + (i + 1) + ': BPM ' + bpm + ' is outside 30–400.'); return; }
      if (map[id]) errors.push('songs.bmp line ' + (i + 1) + ': song ' + id + ' listed twice; using the last value.');
      map[id] = { bpm, offset: m[3] ? parseFloat(m[3]) : 0 };
    });
    return { map, errors };
  }

  function readBmpFile(cb) {            // works on http(s) and some browsers; fails quietly on file://
    try {
      const x = new XMLHttpRequest();
      x.open('GET', 'songs/songs.bmp?' + Date.now());
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
      if (!window.ZIGZAG_SONGS) notices.push('songs/songs.js is missing or has an error, so no songs are listed.');
      const parsed = parseBmp(bmpText);
      parsed.errors.forEach(e => notices.push(e));
      (man.files || []).forEach(f => {
        const p = parseFilename(f);
        if (!p) { notices.push('Ignored "' + f + '": file names must look like 1-Song Name.mp3'); return; }
        if (seen[p.id]) { notices.push('Ignored "' + f + '": ID ' + p.id + ' is already used by "' + seen[p.id] + '".'); return; }
        seen[p.id] = f;
        const b = parsed.map[p.id];
        if (!b) notices.push('No BPM for song ' + p.id + ' (' + p.name + ') in songs.bmp; using ' + DEFAULT_BPM + '.');
        list.push({ id: p.id, name: p.name, file: f, url: 'songs/' + encodeURIComponent(f),
          bpm: b ? b.bpm : DEFAULT_BPM, offset: b ? b.offset : 0, duration: 0, status: 'unknown' });
      });
      Object.keys(parsed.map).forEach(id => { if (!seen[id]) notices.push('songs.bmp lists ID ' + id + ' but no matching MP3 is in songs/songs.js.'); });

      /* Custom mapped levels (js/levelFormat.js): shown after the built-in songs, tagged CUSTOM.
         They reuse the same entry shape so Song Select / gameplay / preview work unchanged;
         Z.Chart.generate() sees song.custom && song.level and plays the mapped notes as-is. */
      if (window.LevelFormat && LevelFormat.list) {
        LevelFormat.list().forEach((lv, i) => {
          if (!lv || typeof lv.title !== 'string') return;
          const full = window.LevelFormat.load ? LevelFormat.load(lv.slug) : null;
          const lvl = full && full.format === 'zigzag-level' ? full : null;
          const audio = lvl ? lvl.audio : '';
          if (!audio) { notices.push('Custom level "' + lv.title + '" has no audio path; skipped.'); return; }
          list.push({
            id: -(i + 1), name: '★ ' + lv.title, file: String(audio).replace(/^songs\//, ''),
            url: audio, bpm: (lvl && lvl.bpm) || 120, offset: ((lvl && lvl.offsetMs) || 0) / 1000,
            duration: 0, status: 'unknown', custom: true, levelSlug: lv.slug,
            level: lvl || { difficulties: null }
          });
        });
      }

      list.sort((a, b) => (b.id > 0) - (a.id > 0) || a.id - b.id || a.name.localeCompare(b.name));
      Songs.list = list; Songs.notices = notices; Songs.bpmSource = source;
    },
    load(cb) {
      const man = window.ZIGZAG_SONGS || {};
      readBmpFile(text => {
        if (text != null) { Songs.build(text, 'songs/songs.bmp'); return cb(); }
        const imported = Z.Storage.get('bmpImport', null);
        if (imported) { Songs.build(imported, 'imported songs.bmp'); return cb(); }
        Songs.build(man.bpm || '', 'built-in copy in songs/songs.js');
        cb();
      });
    },
    importBmp(text) { Z.Storage.set('bmpImport', text); Songs.build(text, 'imported songs.bmp'); },
    clearImport() { Z.Storage.remove('bmpImport'); Songs.build((window.ZIGZAG_SONGS || {}).bpm || '', 'built-in copy in songs/songs.js'); },
    byId(id) { return Songs.list.find(s => s.id === id) || null; },
    /* Custom LevelFormat levels get negative IDs; Z.Chart.generate() uses this to bypass seeding. */
    customById(id) { return Songs.list.find(s => s.custom && s.id === id) || null; },
    customLevels() { return Songs.list.filter(s => s.custom); },
    byLevelSlug(slg) { return Songs.list.find(s => s.custom && s.levelSlug === slg) || null; }
  };
})();
