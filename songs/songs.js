/* songs/songs.js — the song manifest. Browsers cannot list a folder from file://, so every MP3
   in this folder must be listed here.

   files: file names, exactly as they appear in this folder: "<ID>-<Song Name>.mp3"
          (ID = unique whole number; the name may contain spaces and more hyphens).
   bpm:   a copy of songs.bmp (same format) used when the browser blocks reading songs.bmp.
          Keep the two in sync: edit songs.bmp, then paste the same lines here. */
window.ZIGZAG_SONGS = {
  files: [
    "1-Demo Pulse.mp3",
    "2-Neon Rush - Remix.mp3",
    "3-Slow Drift.mp3",
    "4-Skillet - Monster.mp3",
  ],
  bpm: `
# id=bpm   (optional: id=bpm,firstBeatSeconds)
1=120
2=172
3=90
4=135
`
};
