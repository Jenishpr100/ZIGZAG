(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.LevelFormatV1 = api;
    root.ZZ = root.ZZ || {};
    root.ZZ.LevelFormatV1 = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 1;
  const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'webm', 'flac']);
  const DIFFICULTIES = new Set(['easy', 'normal', 'hard', 'expert']);
  const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
  const safeStage = stage => Number.isInteger(stage) && stage > 0 && stage <= 9999;

  function parseSongFilename(filename) {
    const value = String(filename || '').trim();
    const match = /^(\d+)-(.+)\.([a-z0-9]+)$/i.exec(value);
    if (!match || !match[2].trim()) return null;
    const ext = match[3].toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) return null;
    const stage = Number(match[1]);
    if (!safeStage(stage)) return null;
    return { stage, name: match[2].trim(), file: value, extension: ext };
  }

  function buildSongCatalog(files) {
    const songs = [];
    const notices = [];
    const byStage = new Map();
    (Array.isArray(files) ? files : []).forEach(file => {
      const parsed = parseSongFilename(file);
      if (!parsed) {
        notices.push('Ignored "' + String(file) + '": use a numbered audio filename such as 2-Neon Rush.mp3.');
        return;
      }
      if (byStage.has(parsed.stage)) {
        const previous = byStage.get(parsed.stage);
        if (previous) notices.push('Stage ' + parsed.stage + ' has more than one song ("' + previous.file + '" and "' + parsed.file + '"). Rename one file; neither is selected automatically.');
        byStage.set(parsed.stage, null);
        return;
      }
      byStage.set(parsed.stage, parsed);
      songs.push(parsed);
    });
    return { songs: songs.filter(song => byStage.get(song.stage)), notices };
  }

  function filenameForStage(stage) {
    if (!safeStage(stage)) throw new Error('Stage number must be a whole number from 1 to 9999.');
    return 'stage' + stage + '.level';
  }

  function defaultSongForStage(stage, files) {
    const catalog = buildSongCatalog(files);
    const matches = catalog.songs.filter(song => song.stage === Number(stage));
    return { song: matches.length === 1 ? matches[0] : null, notices: catalog.notices };
  }

  function createBlank(options) {
    const o = options || {};
    return {
      version: VERSION,
      stage: safeStage(Number(o.stage)) ? Number(o.stage) : 1,
      title: typeof o.title === 'string' && o.title.trim() ? o.title.trim() : 'Untitled Stage',
      artist: typeof o.artist === 'string' ? o.artist : '',
      author: typeof o.author === 'string' ? o.author : '',
      song: typeof o.song === 'string' ? o.song : '',
      bpm: isFiniteNumber(o.bpm) ? o.bpm : 120,
      offsetMs: isFiniteNumber(o.offsetMs) ? o.offsetMs : 0,
      difficulty: DIFFICULTIES.has(String(o.difficulty || '').toLowerCase()) ? String(o.difficulty).toLowerCase() : 'normal',
      notes: []
    };
  }

  function validate(level) {
    const errors = [];
    if (!level || typeof level !== 'object' || Array.isArray(level)) return { valid: false, errors: ['Level data must be a JSON object.'] };
    if (level.version !== VERSION) errors.push('version must be ' + VERSION + '.');
    if (!safeStage(level.stage)) errors.push('stage must be a whole number from 1 to 9999.');
    if (typeof level.title !== 'string' || !level.title.trim()) errors.push('title must be a non-empty string.');
    for (const field of ['artist', 'author']) {
      if (level[field] != null && typeof level[field] !== 'string') errors.push(field + ' must be a string.');
    }
    if (typeof level.song !== 'string' || !level.song.trim()) {
      errors.push('song must name an associated audio file.');
    } else if (/[\\/]/.test(level.song) || !parseSongFilename(level.song)) {
      errors.push('song must be an audio filename such as 1-Demo Pulse.mp3, without a folder path.');
    }
    if (level.bpm != null && (!isFiniteNumber(level.bpm) || level.bpm < 30 || level.bpm > 400)) errors.push('bpm must be between 30 and 400 when provided.');
    if (level.offsetMs != null && !isFiniteNumber(level.offsetMs)) errors.push('offsetMs must be a finite number of milliseconds.');
    if (level.difficulty != null && !DIFFICULTIES.has(String(level.difficulty).toLowerCase())) errors.push('difficulty must be easy, normal, hard, or expert.');
    if (!Array.isArray(level.notes)) {
      errors.push('notes must be an array.');
      return { valid: false, errors };
    }

    const ids = new Set();
    level.notes.forEach((note, index) => {
      const where = 'notes[' + index + ']';
      if (!note || typeof note !== 'object' || Array.isArray(note)) {
        errors.push(where + ' must be an object.');
        return;
      }
      if (typeof note.id !== 'string' || !note.id.trim()) errors.push(where + '.id must be a non-empty stable identifier.');
      else if (ids.has(note.id)) errors.push(where + '.id is duplicated ("' + note.id + '").');
      else ids.add(note.id);
      if (!Number.isInteger(note.lane) || note.lane < 0 || note.lane > 3) errors.push(where + '.lane must be an integer from 0 to 3.');
      if (note.type === 'click') {
        if (!isFiniteNumber(note.time) || note.time < 0) errors.push(where + '.time must be a non-negative number of milliseconds.');
        if ('startTime' in note || 'endTime' in note || 'path' in note) errors.push(where + ' click notes may only use time.');
      } else if (note.type === 'hold') {
        if (!isFiniteNumber(note.startTime) || note.startTime < 0) errors.push(where + '.startTime must be a non-negative number of milliseconds.');
        if (!isFiniteNumber(note.endTime) || note.endTime <= note.startTime) errors.push(where + '.endTime must be greater than startTime.');
        if ('time' in note || 'path' in note) errors.push(where + ' hold notes may only use startTime and endTime.');
      } else if (note.type === 'drag') {
        if (!isFiniteNumber(note.startTime) || note.startTime < 0) errors.push(where + '.startTime must be a non-negative number of milliseconds.');
        if (!isFiniteNumber(note.endTime) || note.endTime <= note.startTime) errors.push(where + '.endTime must be greater than startTime.');
        if (!Array.isArray(note.path) || note.path.length < 2) {
          errors.push(where + '.path must contain at least two lane/time points.');
          return;
        }
        let previousTime = -Infinity;
        note.path.forEach((point, pointIndex) => {
          const pointWhere = where + '.path[' + pointIndex + ']';
          if (!point || typeof point !== 'object') {
            errors.push(pointWhere + ' must be an object.');
            return;
          }
          if (!Number.isInteger(point.lane) || point.lane < 0 || point.lane > 3) errors.push(pointWhere + '.lane must be an integer from 0 to 3.');
          if (!isFiniteNumber(point.time) || point.time < 0) errors.push(pointWhere + '.time must be a non-negative number of milliseconds.');
          if (isFiniteNumber(point.time) && point.time <= previousTime) errors.push(where + ' drag path times must increase strictly.');
          if (isFiniteNumber(point.time)) previousTime = point.time;
        });
        const first = note.path[0], last = note.path[note.path.length - 1];
        if (isFiniteNumber(note.startTime) && first && first.time !== note.startTime) errors.push(where + ' first path time must equal startTime.');
        if (isFiniteNumber(note.endTime) && last && last.time !== note.endTime) errors.push(where + ' last path time must equal endTime.');
        if (first && Number.isInteger(note.lane) && first.lane !== note.lane) errors.push(where + ' lane must match the first drag path lane.');
        if ('time' in note) errors.push(where + ' drag notes use startTime and endTime, not time.');
      } else {
        errors.push(where + '.type must be click, hold, or drag.');
      }
    });
    return { valid: errors.length === 0, errors };
  }

  function parse(jsonText) {
    let value;
    try { value = JSON.parse(String(jsonText)); }
    catch (error) { return { valid: false, level: null, errors: ['Invalid JSON: ' + error.message] }; }
    const result = validate(value);
    if (result.valid) return { valid: true, level: value, errors: [], migrated: false };
    const legacy = migrateLegacy(value);
    if (legacy) return { valid: true, level: legacy, errors: [], migrated: true, notice: 'This older level was converted to version 1 in memory. Save or export it to update the file.' };
    return { valid: false, level: null, errors: result.errors };
  }

  function toJSON(level) {
    const result = validate(level);
    if (!result.valid) throw new Error(result.errors.join('\n'));
    return JSON.stringify(level, null, 2) + '\n';
  }

  function toChart(level) {
    const validation = validate(level);
    if (!validation.valid) throw new Error(validation.errors.join('\n'));
    const offset = (level.offsetMs || 0) / 1000;
    const notes = level.notes.map(note => {
      if (note.type === 'click') return { id: note.id, type: 'tap', t: note.time / 1000 + offset, lane: note.lane };
      if (note.type === 'hold') {
        const t = note.startTime / 1000 + offset;
        const end = note.endTime / 1000 + offset;
        return { id: note.id, type: 'hold', t, lane: note.lane, end, dur: end - t, ticks: [] };
      }
      const path = note.path.map(point => ({ t: point.time / 1000 + offset, lane: point.lane }));
      const t = path[0].t, end = path[path.length - 1].t;
      return { id: note.id, type: 'drag', t, lane: note.lane, end, dur: end - t, path, nodes: path.map(point => ({ t: point.t, lane: point.lane })) };
    }).sort((a, b) => a.t - b.t);
    const last = notes.reduce((max, note) => Math.max(max, note.end || note.t), 0);
    return { version: VERSION, custom: true, fourLane: true, level, notes, units: notes.length, length: last + 1.5,
      title: level.title, artist: level.artist || '', bpm: level.bpm || 120, offsetMs: level.offsetMs || 0, song: null };
  }

  function migrateLegacy(level) {
    if (!level || level.format !== 'zigzag-level' || level.version !== 0 || !level.difficulties) return null;
    const audioFile = String(level.audio || '').replace(/^.*[\\/]/, '');
    const songMeta = parseSongFilename(audioFile);
    const stage = songMeta ? songMeta.stage : 1;
    const source = level.difficulties.NORMAL && level.difficulties.NORMAL.notes || [];
    const notes = [];
    source.forEach((note, index) => {
      const lane = note.lane === 'top' ? 3 : note.lane === 'center' ? 1 : 0;
      const id = 'legacy-' + (index + 1);
      if (note.type === 'hold' && Number.isFinite(note.dur) && note.dur > 0) {
        notes.push({ id, type: 'hold', lane, startTime: note.t * 1000, endTime: (note.t + note.dur) * 1000 });
      } else {
        notes.push({ id, type: 'click', lane, time: note.t * 1000 });
      }
      if (Array.isArray(note.flicks)) note.flicks.forEach((time, flickIndex) => notes.push({
        id: id + '-flick-' + (flickIndex + 1), type: 'click', lane, time: time * 1000
      }));
    });
    const migrated = createBlank({ stage, title: level.title, artist: level.artist, author: level.author,
      song: songMeta ? songMeta.file : audioFile, bpm: level.bpm, offsetMs: level.offsetMs, difficulty: 'normal' });
    migrated.notes = notes;
    return validate(migrated).valid ? migrated : null;
  }

  return { VERSION, AUDIO_EXTENSIONS: Array.from(AUDIO_EXTENSIONS), DIFFICULTIES: Array.from(DIFFICULTIES),
    parseSongFilename, buildSongCatalog, filenameForStage, defaultSongForStage, createBlank, validate, parse, toJSON, toChart, migrateLegacy };
});
