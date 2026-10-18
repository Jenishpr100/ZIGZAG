# ZIGZAG

A rhythm game in plain HTML, CSS and JavaScript. Tap, hold and drag along a zigzag path to your own MP3s.

## Run it
Double-click **index.html**. That's it: no server, npm or build step, and it works offline. Everything uses relative paths, so the folder can be moved to any computer. Use a current Chrome, Edge, Firefox or Safari.

## Controls
- **Mouse / trackpad / touch:** click or tap; hold the button or finger for hold notes; hold and slide along the ribbon for drag notes.
- **Keyboard (optional):** `D F J K` are lanes 1–4. For drags, hold the key of the lane the ribbon is in and roll to the next key as it moves.
- `Esc` / `P` / `Space` pause, `R` restart. Menus work with `Tab`, arrow keys, `Enter` and `Esc` (back).
- The in-game **How to Play** screen explains all of this.

## Add a song
1. Name the MP3 `ID-Song Name.mp3`, e.g. `4-My Cool Song.mp3`. The number before the **first** hyphen is the unique song ID. Everything after it is the displayed name; spaces and more hyphens are fine (`5-Neon Rush - Remix.mp3`).
2. Put the file in the `songs` folder.
3. Add the exact file name to `files` in `songs/songs.js` (browsers cannot scan a folder from `file://`, so this list is required).
4. Add its BPM to `songs/songs.bmp` **and** to the `bpm` text in `songs/songs.js`.

Invalid names, duplicate IDs and missing BPMs are skipped or defaulted (120) and listed under **Song list notices** on the Song Select screen. Songs are sorted by ID.

## songs.bmp format
Plain text despite the extension:
```
# comments start with #
1=120
2=172
3=90,0.35     # optional: first beat at 0.35 s
```
Browsers usually block reading `songs.bmp` from a double-clicked page, so the game falls back to the copy in `songs/songs.js`. You can also use **Song Select → Song list notices → Load songs.bmp…** to load your edited file (remembered until you click "Use built-in list"). BPM must be 30–400.

How BPM is used: it sets the beat grid notes snap to and, with difficulty, the density. Very fast songs automatically drop to half-time so charts never exceed what each difficulty can handle.

## Seeds
Every chart is generated from **song ID + BPM + difficulty + seed** with a seeded random generator, so the same inputs always give the same chart, and a new seed gives a new one. Seeds can be text or numbers (text is hashed to a number). Change the seed on Song Select or Settings, or press **Random Seed**. The seed is saved, shown on the results screen, and high scores are stored per `song ID + difficulty + seed`.

## Themes
Edit `js/themes.js`. Each theme is one object (background gradient, note, hold, drag and path colors, particle colors, and `ui` colors for the menus). Copy an entry, give it a new key and name, and it appears in the theme selectors automatically.

## Settings
Volumes, timing offset (ms), seed, difficulty, theme, fullscreen, reduced motion, screen shake, hit effects, practice mode (cannot fail), and reset. All saved in `localStorage`.

## Troubleshooting
- **"Cannot load songs/…"**: the file is missing or its name differs from `songs/songs.js` (case and spaces matter), or the MP3 is damaged.
- **Song not listed**: the name must match `number-name.mp3` and be in `songs/songs.js`; check the notices panel.
- **No sound**: browsers need a click before audio. Start from a button, and check the volume sliders.
- **Notes feel early/late**: adjust Timing offset in Settings (Bluetooth headphones often need a positive value).
- **Notes don't match the beat**: if your song's first beat isn't at 0:00, add the first-beat time to `songs.bmp` (`id=bpm,seconds`).
- **Settings not saved**: some browsers block `localStorage` on `file://`; the game still works but forgets settings after closing.

## Files
```
index.html            entry point
css/styles.css        menu styling
js/storage.js         safe localStorage wrapper
js/settings.js        saved settings
js/themes.js          theme data
js/songs.js           filename + songs.bmp parsing
js/audio.js           music playback + synthesized sound effects
js/chart-generator.js seeded chart generator, difficulty table
js/input.js           pointer + keyboard input
js/gameplay.js        state machine, judging, scoring, rendering
js/menu.js            screens, song select, settings UI
js/main.js            boot and global listeners
songs/                songs.js (manifest), songs.bmp (BPM), MP3s
```
The three demo MP3s are generated tones made for this project.
