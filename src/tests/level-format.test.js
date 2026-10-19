const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../js/levelFormatV1.js');

test('numbered filenames preserve spaces and punctuation', () => {
  assert.deepEqual(F.parseSongFilename('2-Neon Rush - Remix.mp3'), {
    stage: 2, name: 'Neon Rush - Remix', file: '2-Neon Rush - Remix.mp3', extension: 'mp3'
  });
  assert.equal(F.filenameForStage(12), 'stage12.level');
  assert.equal(F.parseSongFilename('Demo.mp3'), null);
  assert.equal(F.parseSongFilename('1-Notes.js'), null);
});

test('bundled example levels parse and convert to four-lane playback charts', () => {
  for (const name of ['stage1', 'stage2']) {
    const content = fs.readFileSync(path.join(__dirname, '..', 'levels', name + '.level'), 'utf8');
    const result = F.parse(content);
    assert.equal(result.valid, true, result.errors.join('; '));
    const chart = F.toChart(result.level);
    assert.equal(chart.fourLane, true);
    assert.ok(chart.notes.some(note => note.type === 'tap'));
    assert.ok(chart.notes.some(note => note.type === 'hold'));
    assert.ok(chart.notes.some(note => note.type === 'drag' && note.path.length >= 2));
    assert.ok(chart.notes.every(note => note.lane >= 0 && note.lane <= 3));
  }
});

test('invalid values and inconsistent drag timing are rejected', () => {
  const level = F.createBlank({ stage: 1, song: '1-Demo Pulse.mp3' });
  level.notes = [
    { id: 'bad-lane', type: 'click', lane: 4, time: -1 },
    { id: 'bad-hold', type: 'hold', lane: 0, startTime: 100, endTime: 100 },
    { id: 'bad-drag', type: 'drag', lane: 1, startTime: 300, endTime: 500,
      path: [{ lane: 1, time: 300 }, { lane: 2, time: 250 }] }
  ];
  const result = F.validate(level);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /lane must be an integer/);
  assert.match(result.errors.join(' '), /non-negative/);
  assert.match(result.errors.join(' '), /endTime must be greater/);
  assert.match(result.errors.join(' '), /times must increase strictly/);
});

test('duplicate song stage numbers are not mapped arbitrarily', () => {
  const catalog = F.buildSongCatalog(['1-A.mp3', '1-B.mp3', '2-C.mp3']);
  assert.deepEqual(catalog.songs.map(song => song.stage), [2]);
  assert.match(catalog.notices.join(' '), /neither is selected automatically/);
  assert.equal(F.defaultSongForStage(1, ['1-A.mp3', '1-B.mp3']).song, null);
});

test('legacy v0 levels remain importable through an explicit migration', () => {
  const old = { format: 'zigzag-level', version: 0, title: 'Old', artist: '', audio: 'songs/3-Slow Drift.mp3', bpm: 90,
    offsetMs: 0, difficulties: { NORMAL: { notes: [{ t: 1.25, lane: 'top', type: 'tap' }] } } };
  const result = F.parse(JSON.stringify(old));
  assert.equal(result.valid, true);
  assert.equal(result.migrated, true);
  assert.equal(result.level.stage, 3);
  assert.deepEqual(result.level.notes[0], { id: 'legacy-1', type: 'click', lane: 3, time: 1250 });
});
