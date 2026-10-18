// ============================================================
// audio.js — tiny synth: taps play notes through the engine's
// master gain, so soundVolume / mute control us too.
// Friend: add presets here (waveform, filter, envelope).
// ============================================================

function audioUnlock() {
  const ac = typeof audioContext != 'undefined' ? audioContext : 0;
  if (ac && ac.state == 'suspended') ac.resume(); // browsers need one gesture
}

function synthNote(semitone, dur = .25, type = 'sawtooth', vol = .22) {
  const ac = typeof audioContext != 'undefined' ? audioContext : 0;
  if (!ac || ac.state != 'running') return;
  const t = ac.currentTime;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.value = getNoteFrequency(semitone); // LittleJS helper
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(.001, t + dur);
  osc.connect(gain);
  gain.connect(typeof audioMasterGain != 'undefined' ? audioMasterGain : ac.destination);
  osc.start(t);
  osc.stop(t + dur);
}
