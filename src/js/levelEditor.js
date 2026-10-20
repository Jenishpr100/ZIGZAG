(function () {
  'use strict';
  if (!window.ZIGZAG_EDITOR_MODE) return;

  const Z = window.ZZ = window.ZZ || {};
  const F = window.LevelFormatV1;
  if (Z.Settings && Z.applyTheme) {
    const theme = Z.applyTheme(Z.Settings.get('theme'));
    const root = document.documentElement.style;
    root.setProperty('--ink', theme.ui.text);
    root.setProperty('--muted', theme.ui.dim);
    root.setProperty('--cyan', theme.ui.accent2);
    root.setProperty('--pink', theme.ui.accent);
    root.setProperty('--gold', theme.drag);
  }
  const $ = id => document.getElementById(id);
  const laneKeys = ['→', '↓', '↑', '←'];
  let level, currentSong = null, isPlaying = false, recording = false, completed = false;
  let audioDuration = 0, sceneCanvas = null, gesture = null, audioFileUrl = null;
  let undoStack = [], redoStack = [], historySnapshot = '';
  const inputCanvases = new WeakSet();
  let savedFiles = [];

  function manifestFiles() {
    return window.ZIGZAG_SONGS && Array.isArray(window.ZIGZAG_SONGS.files) ? window.ZIGZAG_SONGS.files : [];
  }

  function hasLocalProjectApi() {
    return location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname);
  }

  function makeSongEntry(file, bpm) {
    const parsed = F.parseSongFilename(file);
    if (!parsed) return null;
    return { id: parsed.stage, stage: parsed.stage, name: parsed.name, file: parsed.file,
      url: 'songs/' + encodeURIComponent(parsed.file), bpm: bpm || 120, offset: 0, duration: 0, status: 'unknown' };
  }

  function buildInitialLevel() {
    const parsedFiles = F.buildSongCatalog(manifestFiles()).songs;
    const first = parsedFiles[0] || null;
    if (first) {
      const bmp = Z.Songs && Z.Songs.parseBmp ? Z.Songs.parseBmp((window.ZIGZAG_SONGS || {}).bpm || '') : { map: {} };
      currentSong = makeSongEntry(first.file, bmp.map[first.stage] && bmp.map[first.stage].bpm);
      return F.createBlank({ stage: first.stage, title: first.name, song: first.file,
        bpm: currentSong.bpm, offsetMs: 0, difficulty: 'normal' });
    }
    return F.createBlank({ stage: 1, song: '', bpm: 120 });
  }

  level = buildInitialLevel();

  function setStatus(message, kind) {
    const status = $('status');
    status.textContent = String(message || '');
    status.className = kind || '';
  }

  function statusForLevel() {
    const parsed = F.parseSongFilename(level.song);
    const known = songEntryForFile(level.song);
    if (!parsed) return 'Choose a numbered song file before saving or playing this level.';
    if (!known) return 'Song "' + level.song + '" is not in the project song list. Add it to the manifest or load its audio file.';
    return 'Stage ' + level.stage + ' · ' + level.song + ' · ' + level.notes.length + ' notes.';
  }

  function catalogSongs() {
    const files = manifestFiles();
    const catalog = F.buildSongCatalog(files);
    const loaded = Z.Songs && Z.Songs.list || [];
    const songs = catalog.songs.map(parsed => {
      const existing = loaded.find(song => song.file === parsed.file && song.id > 0);
      return existing || makeSongEntry(parsed.file);
    });
    return { songs, notices: catalog.notices };
  }

  function songEntryForFile(file) {
    if (currentSong && currentSong.file === file) return currentSong;
    const found = catalogSongs().songs.find(song => song.file === file);
    return found || null;
  }

  function fillSongSelect() {
    const select = $('song-select');
    const previous = level.song;
    const result = catalogSongs();
    select.textContent = '';
    result.songs.forEach(song => {
      const option = document.createElement('option');
      option.value = song.file;
      option.textContent = song.id + ' · ' + song.name;
      select.appendChild(option);
    });
    if (currentSong && !result.songs.some(song => song.file === currentSong.file)) {
      const option = document.createElement('option');
      option.value = currentSong.file;
      option.textContent = currentSong.id + ' · ' + currentSong.name + ' (loaded audio)';
      select.appendChild(option);
    }
    if (previous) select.value = previous;
    if (result.notices.length) setStatus(result.notices.join(' '), 'error');
  }

  function syncFields(preserveHistory) {
    $('stage-number').value = level.stage;
    $('song-select').value = level.song;
    $('title').value = level.title;
    $('artist').value = level.artist || '';
    $('author').value = level.author || '';
    $('bpm').value = level.bpm || 120;
    $('offset').value = level.offsetMs || 0;
    $('difficulty').value = level.difficulty || 'normal';
    updateSource();
    renderNotes();
    if (!preserveHistory) resetHistory();
  }

  function readFields() {
    level.stage = Number($('stage-number').value);
    level.title = $('title').value.trim();
    level.artist = $('artist').value;
    level.author = $('author').value;
    level.bpm = Number($('bpm').value);
    level.offsetMs = Number($('offset').value);
    level.difficulty = $('difficulty').value;
    updateSource();
  }

  function updateSource() {
    $('json-source').value = JSON.stringify(level, null, 2) + '\n';
    $('note-count').textContent = level.notes.length + (level.notes.length === 1 ? ' note' : ' notes');
  }

  function resetHistory() {
    historySnapshot = JSON.stringify(level);
    undoStack = [];
    redoStack = [];
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    const undo = $('undo'), redo = $('redo');
    if (undo) undo.disabled = !undoStack.length;
    if (redo) redo.disabled = !redoStack.length;
  }

  function commitHistoryChange() {
    const current = JSON.stringify(level);
    if (historySnapshot && current !== historySnapshot) {
      undoStack.push(historySnapshot);
      if (undoStack.length > 100) undoStack.shift();
      redoStack = [];
      historySnapshot = current;
    }
    updateHistoryButtons();
  }

  function restoreHistory(source, destination) {
    if (!source.length) return;
    destination.push(JSON.stringify(level));
    level = JSON.parse(source.pop());
    historySnapshot = JSON.stringify(level);
    currentSong = songEntryForFile(level.song);
    fillSongSelect();
    syncFields(true);
    rebuildGameChart();
    updateHistoryButtons();
    setStatus('Edit restored.');
  }

  function noteStart(note) { return note.type === 'click' ? note.time : note.startTime; }
  function noteEnd(note) { return note.type === 'click' ? '' : note.endTime; }
  function makeSelect(values, current) {
    const select = document.createElement('select');
    values.forEach(value => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      if (value === current) option.selected = true;
      select.appendChild(option);
    });
    return select;
  }

  function renderNotes() {
    const body = $('notes-body');
    body.textContent = '';
    level.notes.forEach(note => {
      const row = document.createElement('tr');
      const typeCell = document.createElement('td');
      const typeSelect = makeSelect(['click', 'hold', 'drag'], note.type);
      typeSelect.addEventListener('change', () => changeType(note, typeSelect.value));
      typeCell.appendChild(typeSelect);
      row.appendChild(typeCell);

      const laneCell = document.createElement('td');
      const laneSelect = makeSelect(['0', '1', '2', '3'], String(note.lane));
      laneSelect.addEventListener('change', () => {
        note.lane = Number(laneSelect.value);
        if (note.type === 'drag') note.path[0].lane = note.lane;
        changed();
      });
      laneCell.appendChild(laneSelect);
      row.appendChild(laneCell);

      const startCell = document.createElement('td');
      const startInput = document.createElement('input');
      startInput.type = 'number'; startInput.min = '0'; startInput.step = '0.01'; startInput.value = noteStart(note);
      startInput.setAttribute('aria-label', 'Start time in milliseconds');
      startInput.addEventListener('change', () => changeTime(note, Number(startInput.value), null));
      startCell.appendChild(startInput); row.appendChild(startCell);

      const endCell = document.createElement('td');
      if (note.type !== 'click') {
        const endInput = document.createElement('input');
        endInput.type = 'number'; endInput.min = '0'; endInput.step = '0.01'; endInput.value = noteEnd(note);
        endInput.setAttribute('aria-label', 'End time in milliseconds');
        endInput.addEventListener('change', () => changeTime(note, null, Number(endInput.value)));
        endCell.appendChild(endInput);
      }
      row.appendChild(endCell);

      const deleteCell = document.createElement('td');
      const remove = document.createElement('button');
      remove.className = 'delete'; remove.type = 'button'; remove.textContent = '×'; remove.title = 'Delete note';
      remove.addEventListener('click', () => {
        level.notes = level.notes.filter(candidate => candidate.id !== note.id);
        changed();
      });
      deleteCell.appendChild(remove); row.appendChild(deleteCell);
      body.appendChild(row);
    });
  }

  function changeType(note, type) {
    if (note.type === type) return;
    const start = noteStart(note);
    const end = noteEnd(note) || start + 500;
    if (type === 'click') Object.assign(note, { type, time: start }), delete note.startTime, delete note.endTime, delete note.path;
    else if (type === 'hold') Object.assign(note, { type, startTime: start, endTime: Math.max(end, start + 1) }), delete note.time, delete note.path;
    else Object.assign(note, { type, startTime: start, endTime: Math.max(end, start + 1),
      path: [{ lane: note.lane, time: start }, { lane: note.lane, time: Math.max(end, start + 1) }] }), delete note.time;
    changed();
  }

  function changeTime(note, newStart, newEnd) {
    if (newStart != null && Number.isFinite(newStart) && newStart >= 0) {
      if (note.type === 'click') note.time = newStart;
      else {
        const delta = newStart - note.startTime;
        note.startTime = newStart;
        if (note.type === 'drag') note.path.forEach(point => point.time += delta);
        if (note.endTime <= newStart) note.endTime = newStart + 1;
      }
    }
    if (newEnd != null && Number.isFinite(newEnd) && newEnd > note.startTime) {
      note.endTime = newEnd;
      if (note.type === 'drag') note.path[note.path.length - 1].time = newEnd;
    }
    changed();
  }

  function changed() {
    level.notes.sort((a, b) => noteStart(a) - noteStart(b));
    commitHistoryChange();
    updateSource(); renderNotes(); rebuildGameChart();
  }

  function rebuildGameChart() {
    if (typeof window.ZIGZAG_EDITOR_REBUILD === 'function') window.ZIGZAG_EDITOR_REBUILD();
  }

  function chooseSong(file, updateStage) {
    const song = songEntryForFile(file);
    if (!song) { setStatus('That audio filename does not begin with a stage number and hyphen.', 'error'); return; }
    const stageChanged = updateStage && song.id !== level.stage;
    if (file !== level.song || stageChanged) stopTransport();
    if (stageChanged && savedFiles.includes(F.filenameForStage(song.id))) {
      $('stage-number').value = song.id;
      level.stage = song.id;
      loadSavedStage();
      return;
    }
    currentSong = song;
    if (stageChanged) {
      level = F.createBlank({ stage: song.id, title: song.name, song: song.file, bpm: song.bpm,
        offsetMs: (song.offset || 0) * 1000, difficulty: level.difficulty });
      syncFields(); setStatus(statusForLevel()); rebuildGameChart(); return;
    }
    if (updateStage) level.stage = song.id;
    level.song = song.file;
    level.title = song.name;
    level.bpm = song.bpm || level.bpm || 120;
    level.offsetMs = Number.isFinite(song.offset) ? song.offset * 1000 : (level.offsetMs || 0);
    syncFields();
    setStatus(statusForLevel());
    rebuildGameChart();
  }

  function changeStage(value) {
    const stage = Number(value);
    if (!Number.isInteger(stage) || stage < 1 || stage > 9999) {
      setStatus('Stage number must be a whole number from 1 to 9999.', 'error'); return;
    }
    if (stage !== level.stage) stopTransport();
    $('download-stage').value = stage;
    if (savedFiles.includes(F.filenameForStage(stage))) {
      level.stage = stage;
      loadSavedStage();
      return;
    }
    const match = F.defaultSongForStage(stage, manifestFiles()).song;
    if (match) chooseSong(match.file, true);
    else {
      level = F.createBlank({ stage });
      currentSong = null;
      syncFields();
      setStatus('No unique song is mapped to stage ' + stage + '. Choose a song or load a numbered audio file.', 'error');
    }
  }

  function audioTimeMs() {
    const seconds = Z.Audio && Z.Audio.position ? Z.Audio.position() : 0;
    return Math.max(0, seconds * 1000 - (Number(level.offsetMs) || 0));
  }

  const timelineCanvas = $('timeline');
  const timelineLaneColors = Z.theme
    ? [Z.theme.tap, Z.theme.hold, Z.theme.drag, (Z.theme.particles || [])[3] || Z.theme.path]
    : ['#54b5ff', '#66e7c0', '#ffba58', '#f17bd7'];
  let timelineSeconds = 8;
  function timelineGeometry(width) {
    const left = Math.min(44, width * .14), right = width - 8;
    return { left, right, center: (left + right) / 2, scale: Math.max(1, right - left) / timelineSeconds };
  }

  function drawTimeline() {
    const canvas = timelineCanvas;
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const backingWidth = Math.round(rect.width * dpr), backingHeight = Math.round(rect.height * dpr);
      if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
        canvas.width = backingWidth; canvas.height = backingHeight;
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const width = rect.width, height = rect.height;
      const geo = timelineGeometry(width), now = audioTimeMs() / 1000;
      const start = now - timelineSeconds / 2, end = now + timelineSeconds / 2;
      const rowHeight = height / 4;
      const xAt = seconds => geo.center + (seconds - now) * geo.scale;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#080c15'; ctx.fillRect(0, 0, width, height);

      for (let lane = 0; lane < 4; lane++) {
        const y = lane * rowHeight;
        ctx.fillStyle = timelineLaneColors[lane] + '12'; ctx.fillRect(geo.left, y, geo.right - geo.left, rowHeight);
        ctx.fillStyle = timelineLaneColors[lane]; ctx.font = '700 10px ui-monospace,monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(laneKeys[lane], geo.left / 2, y + rowHeight / 2);
        ctx.strokeStyle = '#c9d6ed18'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(geo.left, y + rowHeight); ctx.lineTo(geo.right, y + rowHeight); ctx.stroke();
      }

      const beat = 60 / Math.max(30, Number(level.bpm) || 120);
      for (let tick = Math.max(0, Math.floor(start / beat) * beat); tick <= end; tick += beat) {
        const x = xAt(tick);
        ctx.strokeStyle = Math.abs(tick / beat - Math.round(tick / beat)) < .001 && Math.round(tick / beat) % 4 === 0 ? '#b5c8e833' : '#b5c8e817';
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      }

      for (const note of level.notes) {
        const lane = Math.max(0, Math.min(3, note.lane | 0));
        const y = lane * rowHeight + rowHeight / 2;
        if (note.type === 'drag' && Array.isArray(note.path)) {
          ctx.beginPath();
          note.path.forEach((point, index) => {
            const x = xAt(point.time / 1000), py = point.lane * rowHeight + rowHeight / 2;
            if (index === 0) ctx.moveTo(x, py); else ctx.lineTo(x, py);
          });
          ctx.strokeStyle = '#ffe68c'; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.stroke();
          note.path.forEach(point => {
            const x = xAt(point.time / 1000);
            ctx.fillStyle = '#fff0a9'; ctx.beginPath(); ctx.arc(x, point.lane * rowHeight + rowHeight / 2, 3, 0, Math.PI * 2); ctx.fill();
          });
        } else {
          const from = note.type === 'click' ? note.time : note.startTime;
          const to = note.type === 'click' ? from : note.endTime;
          const x1 = xAt(from / 1000), x2 = xAt(to / 1000);
          const noteHeight = Math.max(5, rowHeight * .48);
          ctx.fillStyle = timelineLaneColors[lane];
          ctx.shadowColor = timelineLaneColors[lane]; ctx.shadowBlur = 8;
          ctx.fillRect(x1 - (note.type === 'click' ? 2 : 0), y - noteHeight / 2,
            Math.max(note.type === 'click' ? 5 : 3, x2 - x1 + (note.type === 'click' ? 4 : 0)), noteHeight);
          ctx.shadowBlur = 0;
        }
      }

      ctx.strokeStyle = '#ffffff99'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(geo.center, 0); ctx.lineTo(geo.center, height); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(geo.center - 5, 0); ctx.lineTo(geo.center + 5, 0); ctx.lineTo(geo.center, 6); ctx.closePath(); ctx.fill();
      const seconds = Math.max(0, Math.floor(now));
      $('timeline-time').textContent = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0') + '.' + String(Math.floor((now % 1) * 1000)).padStart(3, '0');
    }
    requestAnimationFrame(drawTimeline);
  }

  function seekFromTimeline(event) {
    readFields();
    const rect = timelineCanvas.getBoundingClientRect();
    const geo = timelineGeometry(rect.width);
    const current = audioTimeMs() / 1000;
    const target = Math.max(0, current + ((event.clientX - rect.left) - geo.center) / geo.scale);
    const audioTarget = Math.max(0, target + (Number(level.offsetMs) || 0) / 1000);
    recording = false; cancelGesture(''); completed = false; setTransportText();
    if (!Z.Audio || !Z.Audio.isLoaded()) return prepareAndPlay(audioTarget * 1000, false);
    Z.Audio.seek(audioTarget);
    rebuildGameChart();
    if (isPlaying) Z.Audio.play().catch(() => {});
    setStatus('Moved the playhead to ' + target.toFixed(2) + ' seconds.');
  }

  function quickReplay() {
    recording = false; completed = false;
    cancelGesture('');
    prepareAndPlay(0, false);
  }

  function screenLane(clientX, clientY, canvas) {
    if (!canvas || typeof window.ZIGZAG_EDITOR_LANE_FROM_SCREEN !== 'function') return -1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return -1;
    // LittleJS converts backing-canvas pixels to world coordinates. Scale the
    // browser's CSS coordinates so this works at non-100% display scaling too.
    const sx = (clientX - rect.left) * (canvas.width / rect.width);
    const sy = (clientY - rect.top) * (canvas.height / rect.height);
    return window.ZIGZAG_EDITOR_LANE_FROM_SCREEN(sx, sy);
  }

  function appendGesturePoint(lane, time, force) {
    if (!gesture || lane < 0) return;
    const last = gesture.path[gesture.path.length - 1];
    if (!force && last.lane === lane && time - last.time < 100) return;
    if (time <= last.time) return;
    gesture.path.push({ lane, time });
  }

  function onPointerDown(event) {
    if (!recording || !isPlaying || gesture) return;
    const canvas = event.currentTarget;
    const lane = screenLane(event.clientX, event.clientY, canvas);
    if (lane < 0) return;
    event.preventDefault();
    try { canvas.setPointerCapture(event.pointerId); } catch (error) {}
    const time = audioTimeMs();
    gesture = { pointerId: event.pointerId, canvas, startLane: lane, lane, startTime: time,
      lastX: event.clientX, lastY: event.clientY, moved: false, path: [{ lane, time }] };
    $('rec-indicator').textContent = 'ON';
  }

  function onPointerMove(event) {
    if (!gesture || gesture.pointerId !== event.pointerId || !recording || !isPlaying) return;
    const dx = event.clientX - gesture.lastX, dy = event.clientY - gesture.lastY;
    if (Math.hypot(dx, dy) >= 22) gesture.moved = true;
    gesture.lastX = event.clientX; gesture.lastY = event.clientY;
    const lane = screenLane(event.clientX, event.clientY, event.currentTarget);
    const now = audioTimeMs();
    if (lane >= 0 && lane !== gesture.lane) {
      gesture.moved = true;
      gesture.lane = lane;
      appendGesturePoint(lane, now, true);
    } else if (gesture.moved && lane >= 0) {
      appendGesturePoint(lane, now, false);
    }
  }

  function onPointerUp(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    const active = gesture;
    const endTime = Math.max(audioTimeMs(), active.startTime + 1);
    const duration = endTime - active.startTime;
    gesture = null;
    let note;
    if (active.moved) {
      const path = active.path.map(point => ({ lane: point.lane, time: point.time }));
      if (path.length < 2) path.push({ lane: active.lane, time: endTime });
      if (path[path.length - 1].time >= endTime) path[path.length - 1].time = endTime;
      if (path.length > 1 && path[path.length - 1].time <= path[path.length - 2].time) {
        path[path.length - 1] = { lane: active.lane, time: path[path.length - 2].time + 1 };
      }
      note = { id: makeId(), type: 'drag', lane: active.startLane, startTime: active.startTime,
        endTime: path[path.length - 1].time, path };
    } else if (duration >= 180) {
      note = { id: makeId(), type: 'hold', lane: active.startLane, startTime: active.startTime, endTime };
    } else {
      note = { id: makeId(), type: 'click', lane: active.startLane, time: active.startTime };
    }
    level.notes.push(note);
    changed();
    setStatus('Recorded ' + note.type + ' in lane ' + (note.lane + 1) + ' at ' + Math.round(noteStart(note)) + ' ms.');
  }

  function cancelGesture(reason) {
    if (!gesture) return;
    gesture = null;
    setStatus(reason || 'The interrupted gesture was discarded.', 'error');
  }

  function makeId() {
    if (window.crypto && crypto.randomUUID) return 'note-' + crypto.randomUUID();
    return 'note-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 0x1000000).toString(36);
  }

  function attachScene() {
    const canvases = document.querySelectorAll('canvas:not(#timeline)');
    if (!canvases.length) { setTimeout(attachScene, 50); return; }
    // LittleJS may render to a WebGL canvas layered over its input canvas.
    // Listen on each canvas so pointer events on the visible rendering layer
    // reach the editor recorder as well.
    canvases.forEach(canvas => {
      if (inputCanvases.has(canvas)) return;
      inputCanvases.add(canvas);
      canvas.style.touchAction = 'none';
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', () => cancelGesture('Touch or pointer input was cancelled; no partial note was saved.'));
      if (!sceneCanvas || canvas.getBoundingClientRect().width >= sceneCanvas.getBoundingClientRect().width)
        sceneCanvas = canvas;
    });
  }

  async function prepareAndPlay(startMs, shouldRecord) {
    readFields();
    const validation = F.validate(level);
    if (!validation.valid) { setStatus(validation.errors.join(' '), 'error'); return; }
    if (!currentSong || currentSong.file !== level.song) currentSong = songEntryForFile(level.song);
    if (!currentSong) { setStatus('Choose a song before playback.', 'error'); return; }
    recording = !!shouldRecord;
    isPlaying = false;
    completed = false;
    cancelGesture('');
    rebuildGameChart();
    Z.Audio.unlock();
    setTransportText();
    setStatus('Loading ' + currentSong.file + '…');
    const playPromise = Z.Audio.load(currentSong, error => {
      if (error) { recording = false; isPlaying = false; setTransportText(); setStatus(error + ' Supported audio: MP3, WAV, OGG, M4A, AAC, or WebM.', 'error'); return; }
      audioDuration = Z.Audio.duration() || currentSong.duration || 0;
      if (audioDuration) currentSong.duration = audioDuration;
      if (typeof window.ZIGZAG_EDITOR_SET_DURATION === 'function') window.ZIGZAG_EDITOR_SET_DURATION(audioDuration);
    }, true, Math.max(0, startMs) / 1000);
    Z.Audio.onEnded(onPlaybackComplete);
    if (playPromise && playPromise.then) playPromise.then(() => {
      isPlaying = true; setTransportText();
      setStatus(shouldRecord ? 'Recording against the audio clock. Click, hold, or drag in one of the four lanes.' : 'Playing the current .level preview in sync with its music.');
    }).catch(() => {
      isPlaying = false; recording = false; setTransportText();
      setStatus('The browser could not start this audio. Press Play again, and check that the audio file is supported.', 'error');
    });
  }

  function setTransportText() {
    $('transport-state').textContent = isPlaying ? 'playing' : completed ? 'finished' : Z.Audio && Z.Audio.isLoaded() ? 'paused' : 'stopped';
    $('rec-indicator').textContent = recording && isPlaying ? 'ON' : 'OFF';
    $('record').classList.toggle('primary', !recording);
    $('record').textContent = recording ? '■ Stop recording' : '● Record';
  }

  function stopTransport() {
    if (Z.Audio) Z.Audio.stop();
    isPlaying = false; recording = false; completed = false; audioDuration = 0;
    gesture = null;
    const dialog = $('complete-dialog');
    if (dialog.open) dialog.close();
    setTransportText();
  }

  function pauseTransport() {
    if (!isPlaying) return;
    Z.Audio.pause();
    isPlaying = false;
    cancelGesture('Recording paused; the unfinished gesture was discarded.');
    setTransportText();
    setStatus('Paused. Resume to continue from the same audio position.');
  }

  function resumeTransport() {
    if (isPlaying) return;
    if (!Z.Audio || !Z.Audio.isLoaded()) return prepareAndPlay(0, recording);
    Z.Audio.play().then(() => {
      isPlaying = true; completed = false; setTransportText();
      setStatus(recording ? 'Recording resumed from the saved audio position.' : 'Playback resumed from the saved audio position.');
    }).catch(() => setStatus('The browser blocked audio playback. Press Play again.', 'error'));
  }

  function rewind() {
    cancelGesture('');
    completed = false;
    if (!Z.Audio || !Z.Audio.isLoaded()) {
      if (isPlaying) prepareAndPlay(0, recording);
      else { setTransportText(); setStatus('Rewind is ready. Press Play or Record to load the song from the beginning.'); }
      return;
    }
    Z.Audio.seek(0);
    rebuildGameChart();
    setTransportText();
    if (isPlaying) Z.Audio.play().catch(() => {});
    setStatus('Rewound to 0:00. Existing notes were kept.');
  }

  function syncAndPlay() {
    recording = false;
    cancelGesture('');
    prepareAndPlay(0, false);
  }

  function recordAnotherSection() {
    if (isPlaying) {
      recording = true; setTransportText();
      setStatus('Recording is armed at the current song position; existing notes are kept.');
    } else if (Z.Audio && Z.Audio.isLoaded()) {
      recording = true; resumeTransport();
    } else {
      prepareAndPlay(0, true);
    }
  }

  function toggleRecord() {
    if (recording && isPlaying) {
      recording = false; cancelGesture(''); setTransportText();
      setStatus('Recording stopped. Your notes are still in the level.');
    } else if (isPlaying) {
      recording = true; setTransportText(); setStatus('Recording is armed at the current song position.');
    } else if (Z.Audio && Z.Audio.isLoaded()) {
      recording = true; resumeTransport();
    } else prepareAndPlay(0, true);
  }

  function onPlaybackComplete() {
    if (completed) return;
    completed = true; isPlaying = false; recording = false; cancelGesture(''); setTransportText();
    $('complete-dialog').showModal();
    setStatus('Song complete. The level data is preserved and ready to copy, save, or download.', 'success');
  }

  async function loadSavedStage() {
    stopTransport();
    readFields();
    let filename;
    try { filename = F.filenameForStage(Number(level.stage)); }
    catch (error) { setStatus(error.message, 'error'); return; }
    try {
      const response = await fetch('levels/' + filename, { cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 404 ? filename + ' does not exist yet.' : 'The published site returned ' + response.status + '.');
      const parsed = F.parse(await response.text());
      if (!parsed.valid) throw new Error(parsed.errors.join(' '));
      if (parsed.level.stage !== level.stage) throw new Error(filename + ' contains stage ' + parsed.level.stage + '.');
      level = parsed.level; currentSong = songEntryForFile(level.song);
      syncFields(); rebuildGameChart();
      setStatus(parsed.notice || (currentSong ? 'Loaded ' + filename + ' from the project levels folder.' : 'Loaded ' + filename + ', but its song is not in the manifest. Load the audio file to preview.'), parsed.notice ? '' : currentSong ? 'success' : 'error');
    } catch (error) { setStatus('Could not open ' + filename + ': ' + error.message + ' Use Open .level to load a downloaded chart.', 'error'); }
  }

  async function refreshSavedFiles() {
    if (!hasLocalProjectApi()) {
      savedFiles = F.buildSongCatalog(manifestFiles()).songs.map(song => F.filenameForStage(song.stage));
      return;
    }
    try {
      const response = await fetch('/api/levels', { cache: 'no-store' });
      if (!response.ok) return;
      const result = await response.json();
      savedFiles = Array.isArray(result.files) ? result.files : [];
    } catch (error) { savedFiles = []; }
  }

  async function saveToProject() {
    readFields();
    const validation = F.validate(level);
    if (!validation.valid) { setStatus(validation.errors.join(' '), 'error'); return; }
    const filename = F.filenameForStage(level.stage);
    const content = F.toJSON(level);
    if (!hasLocalProjectApi()) {
      try {
        await writeLevelFile(filename, content);
        setStatus('Downloaded ' + filename + '. Replace the matching file in levels/ and publish the project to update the game.', 'success');
      } catch (error) {
        setStatus(error.name === 'AbortError' ? 'Download cancelled.' : 'Could not download ' + filename + ': ' + error.message, 'error');
      }
      return;
    }
    try {
      let response = await fetch('/api/levels', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content, overwrite: false }) });
      if (response.status === 409) {
        const result = await response.json();
        if (!window.confirm(result.error + ' Replace it with this level?')) {
          setStatus('Save cancelled; the existing project file was kept.'); return;
        }
        response = await fetch('/api/levels', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename, content, overwrite: true }) });
      }
      const result = await response.json();
      if (!response.ok || !result.saved) throw new Error(result.error || 'The server did not confirm the save.');
      await refreshSavedFiles();
      setStatus('Saved ' + result.filename + ' to the project levels folder.', 'success');
    } catch (error) {
      try {
        await writeLevelFile(filename, content);
        setStatus('Project saving is unavailable here. Downloaded ' + filename + ' so you can add it to levels/.', 'success');
      } catch (downloadError) {
        setStatus(downloadError.name === 'AbortError' ? 'Download cancelled.' : 'Could not save or download ' + filename + ': ' + downloadError.message, 'error');
      }
    }
  }

  async function writeLevelFile(filename, content) {
    const blob = new Blob([content], { type: 'application/json' });
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: filename,
        types: [{ description: 'ZIGZAG level file', accept: { 'application/json': ['.level'] } }] });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function copyLevel() {
    readFields();
    const validation = F.validate(level);
    if (!validation.valid) { setStatus(validation.errors.join(' '), 'error'); return; }
    const json = F.toJSON(level);
    try {
      await navigator.clipboard.writeText(json);
      setStatus('Copied the complete .level JSON to the clipboard.', 'success');
    } catch (error) {
      const box = $('json-source'); box.value = json; box.focus(); box.select();
      const ok = document.execCommand('copy');
      setStatus(ok ? 'Copied the complete .level JSON to the clipboard.' : 'Clipboard access failed. The complete JSON is selected for copying.', ok ? 'success' : 'error');
    }
  }

  function openDownloadDialog() {
    readFields();
    $('download-stage').value = level.stage;
    updateDownloadPreview();
    $('download-dialog').showModal();
  }

  function updateDownloadPreview() {
    const stage = Number($('download-stage').value);
    if (!Number.isInteger(stage) || stage < 1 || stage > 9999) {
      $('download-filename').textContent = 'Invalid stage'; $('download-song').textContent = '—';
      $('download-message').textContent = 'Enter a whole number from 1 to 9999.'; return;
    }
    $('download-filename').textContent = F.filenameForStage(stage);
    const defaultSong = F.defaultSongForStage(stage, manifestFiles()).song;
    const explicitSong = level.stage === stage && level.song ? level.song : null;
    $('download-song').textContent = explicitSong || (defaultSong ? defaultSong.file : (level.song || 'No unique default song; the current song will be kept.'));
    $('download-message').textContent = savedFiles.includes(F.filenameForStage(stage))
      ? 'A project file with this name exists. Use Save to levels folder to confirm replacement, or download a separate copy.'
      : 'The browser will download this .level file. The selected stage and default song will be written into its metadata.';
  }

  function applyDownloadStage() {
    const stage = Number($('download-stage').value);
    if (!Number.isInteger(stage) || stage < 1 || stage > 9999) throw new Error('Stage number must be a whole number from 1 to 9999.');
    const outputLevel = JSON.parse(JSON.stringify(level));
    const oldStage = outputLevel.stage;
    outputLevel.stage = stage;
    const mapped = F.defaultSongForStage(stage, manifestFiles()).song;
    if (mapped && (stage !== oldStage || !outputLevel.song)) {
      const mappedEntry = songEntryForFile(mapped.file);
      outputLevel.song = mapped.file;
      if (stage !== oldStage && mappedEntry && mappedEntry.bpm) outputLevel.bpm = mappedEntry.bpm;
    }
    const validation = F.validate(outputLevel);
    if (!validation.valid) throw new Error(validation.errors.join(' '));
    return { filename: F.filenameForStage(stage), content: F.toJSON(outputLevel), level: outputLevel };
  }

  async function downloadLevel() {
    try {
      const file = applyDownloadStage();
      await writeLevelFile(file.filename, file.content);
      level = file.level;
      currentSong = songEntryForFile(level.song);
      syncFields(); rebuildGameChart();
      $('download-dialog').close();
      setStatus('Downloaded ' + file.filename + ' with the selected stage metadata.', 'success');
    } catch (error) {
      if (error.name === 'AbortError') { setStatus('Download cancelled.'); return; }
      $('download-message').textContent = error.message;
      setStatus('Could not download the level: ' + error.message, 'error');
    }
  }

  function importLevelFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => setStatus('Could not read ' + file.name + '.', 'error');
    reader.onload = () => {
      const parsed = F.parse(String(reader.result));
      if (!parsed.valid) { setStatus('Could not open ' + file.name + ': ' + parsed.errors.join(' '), 'error'); return; }
      stopTransport();
      level = parsed.level;
      currentSong = songEntryForFile(level.song);
      fillSongSelect(); syncFields(); rebuildGameChart();
      setStatus(parsed.notice || (currentSong ? 'Loaded ' + file.name + '. The file remains editable as JSON.' : 'Loaded ' + file.name + ', but its song is not in the manifest. Load the audio file to preview.'), parsed.notice ? '' : currentSong ? 'success' : 'error');
    };
    reader.readAsText(file);
  }

  function applyJSONEdits() {
    const parsed = F.parse($('json-source').value);
    if (!parsed.valid) { setStatus(parsed.errors.join(' '), 'error'); return; }
    stopTransport();
    level = parsed.level;
    currentSong = songEntryForFile(level.song);
    fillSongSelect(); syncFields(); rebuildGameChart();
    setStatus(parsed.notice || statusForLevel(), parsed.notice ? '' : currentSong ? 'success' : 'error');
  }

  function loadAudioFile(file) {
    if (!file) return;
    const parsed = F.parseSongFilename(file.name);
    if (!parsed) { setStatus('Audio filenames need a stage prefix such as 3-Slow Drift.mp3.', 'error'); return; }
    stopTransport();
    if (audioFileUrl) URL.revokeObjectURL(audioFileUrl);
    audioFileUrl = URL.createObjectURL(file);
    currentSong = { id: parsed.stage, stage: parsed.stage, name: parsed.name, file: parsed.file,
      url: audioFileUrl, bpm: level.bpm || 120, offset: 0, duration: 0, status: 'unknown' };
    level.stage = parsed.stage; level.song = parsed.file; level.title = parsed.name;
    fillSongSelect(); syncFields();
    setStatus('Loaded local audio file ' + parsed.file + '. It will be used for preview and recording until the page closes.', 'success');
  }

  function bind() {
    fillSongSelect(); syncFields();
    $('stage-number').addEventListener('change', event => changeStage(event.target.value));
    $('song-select').addEventListener('change', event => chooseSong(event.target.value, true));
    ['title','artist','author','bpm','offset','difficulty'].forEach(id => $(id).addEventListener('change', () => { readFields(); commitHistoryChange(); rebuildGameChart(); }));
    $('record').addEventListener('click', toggleRecord);
    $('play').addEventListener('click', resumeTransport);
    $('quick-replay').addEventListener('click', quickReplay);
    $('pause').addEventListener('click', pauseTransport);
    $('rewind').addEventListener('click', rewind);
    $('sync').addEventListener('click', syncAndPlay);
    $('record-section').addEventListener('click', recordAnotherSection);
    $('save-project').addEventListener('click', saveToProject);
    $('download').addEventListener('click', openDownloadDialog);
    $('copy').addEventListener('click', copyLevel);
    $('apply-json').addEventListener('click', applyJSONEdits);
    $('load-stage').addEventListener('click', loadSavedStage);
    $('open-file').addEventListener('click', () => $('level-file').click());
    $('level-file').addEventListener('change', event => { importLevelFile(event.target.files[0]); event.target.value = ''; });
    $('open-audio').addEventListener('click', () => $('audio-file').click());
    $('audio-file').addEventListener('change', event => { loadAudioFile(event.target.files[0]); event.target.value = ''; });
    $('download-stage').addEventListener('input', updateDownloadPreview);
    $('confirm-download').addEventListener('click', downloadLevel);
    $('complete-copy').addEventListener('click', copyLevel);
    $('complete-download').addEventListener('click', () => { $('complete-dialog').close(); openDownloadDialog(); });
    $('complete-replay').addEventListener('click', () => { $('complete-dialog').close(); quickReplay(); });
    $('undo').addEventListener('click', () => restoreHistory(undoStack, redoStack));
    $('redo').addEventListener('click', () => restoreHistory(redoStack, undoStack));
    $('timeline-zoom').addEventListener('change', event => { timelineSeconds = Number(event.target.value) || 8; });
    timelineCanvas.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); seekFromTimeline(event); });
    document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
    document.addEventListener('keydown', event => {
      const inTextField = event.target && /^(INPUT|TEXTAREA)$/.test(event.target.tagName) &&
        !['range', 'checkbox', 'radio', 'button', 'submit'].includes(event.target.type);
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyS') { event.preventDefault(); saveToProject(); }
      else if (!inTextField && (event.ctrlKey || event.metaKey) && event.code === 'KeyZ' && !event.shiftKey) { event.preventDefault(); restoreHistory(undoStack, redoStack); }
      else if (!inTextField && (event.ctrlKey || event.metaKey) && (event.code === 'KeyY' || event.code === 'KeyZ' && event.shiftKey)) { event.preventDefault(); restoreHistory(redoStack, undoStack); }
      else if (event.code === 'Escape' && gesture) cancelGesture('The active gesture was cancelled.');
    });
    window.addEventListener('blur', () => {
      cancelGesture('The window lost focus; the unfinished gesture was discarded.');
      if (isPlaying) pauseTransport();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        cancelGesture('The page was hidden; the unfinished gesture was discarded.');
        if (isPlaying) pauseTransport();
      }
    });
    const loadInitialStage = async () => {
      if (Z.Songs && Z.Songs.load) await new Promise(resolve => Z.Songs.load(resolve));
      fillSongSelect();
      await refreshSavedFiles();
      await loadSavedStage();
    };
    loadInitialStage();
    drawTimeline();
    setInterval(() => {
      const rate = typeof window.ZIGZAG_SIMULATION_STATUS === 'function' ? window.ZIGZAG_SIMULATION_STATUS() : { measuredTPS: 0, droppedTicks: 0 };
      $('sim-rate').textContent = 'SIM ' + Math.round(rate.measuredTPS) + ' / 240 TPS' + (rate.droppedTicks ? ' · dropped ' + rate.droppedTicks : '');
    }, 300);
  }

  Z.LevelEditor = {
    getLevel: () => level,
    getSongEntry: () => currentSong || songEntryForFile(level.song),
    getDuration: () => audioDuration,
    isPlaying: () => isPlaying,
    isRecording: () => recording && isPlaying,
    togglePause: () => isPlaying ? pauseTransport() : resumeTransport(),
    onGameReady: attachScene,
    onPlaybackComplete,
  };

  window.ZIGZAG_EDITOR_LANE_FROM_SCREEN = (x, y) => {
    if (typeof screenToWorld !== 'function' || typeof vec2 !== 'function') return -1;
    const world = screenToWorld(vec2(x, y));
    let best = -1, distance = Infinity;
    [-5.25, -1.75, 1.75, 5.25].forEach((center, lane) => {
      const gap = Math.abs(world.x - center);
      if (gap < distance) { distance = gap; best = lane; }
    });
    return distance <= 1.8 ? best : -1;
  };

  window.ZIGZAG_SIMULATION_STATUS = () => ({
    targetTPS: 240,
    measuredTPS: typeof playSimulation !== 'undefined' ? playSimulation.measuredTPS : 0,
    droppedTicks: typeof playSimulation !== 'undefined' ? playSimulation.droppedTicks : 0,
  });

  bind();
})();
