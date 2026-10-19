# Project file guide

This guide explains the files and folders in the ZIGZAG rhythm adventure project. The game is a static website: its main page can run on its own, and the source files are kept alongside it for editing and publishing.

## Folder map

```text
.
├── .github/workflows/       GitHub Pages publishing workflow
├── assets/                  Game and character artwork
│   ├── img/                 Game sprites and source sprite sheet
│   └── Tiny Neighbours Vol1/ NPC and emote source artwork
├── css/                     Game page styles
├── docs/                    Project documentation and planning notes
├── js/                      Game, editor, audio, and stage support code
├── levels/                  The six playable stage charts
├── scripts/                 Build scripts
├── songs/                   Audio files; the manifest selects playable tracks
└── tests/                   Automated level-format checks
```

The HTML entry pages, Node project files, license, and README stay in the project root because the local build and GitHub Pages publish them from there.

## Root files

| File | Purpose |
| --- | --- |
| `index.html` | Ready-to-play, self-contained game page. It is generated from the template and embeds the playable music and stage charts. Rebuild it after changing source files with `npm run build:standalone`. |
| `index.template.html` | Editable source for the game page, menus, help, and script loading. The build script combines it with the CSS and JavaScript to produce `index.html`. |
| `LevelEditor.html` | Browser-based stage editor. It loads the editor code and game engine from the project folders. |
| `littlejs.min.js` | Minified LittleJS engine used by the game and editor pages. |
| `server.mjs` | Optional local helper for saving edited stages directly into `levels/`. Run it with `npm run dev`; it is not needed to play or publish the game. |
| `package.json` | Project scripts and the LittleJS package dependency. |
| `package-lock.json` | Locked dependency versions for repeatable Node package installation. |
| `README.md` | How to play, edit stages, build, and publish the game. |
| `LICENSE` | License distributed with the project. |
| `.nojekyll` | Tells GitHub Pages not to process the published files with Jekyll. |
| `.gitignore` | Keeps installed dependencies and generated `dist/` output out of Git. |

## Game and editor code (`js/`)

| File | Purpose |
| --- | --- |
| `audio.js` | Plays music and creates synthesized sound effects. |
| `battle.js` | Warden battle scenes and turn-based battle logic. |
| `chart-generator.js` | Shared difficulty tuning and stage star estimates. |
| `data.js` | Shared game data, character and object definitions, and sprite references. |
| `dialog.js` | Overworld dialogue boxes and text flow. |
| `gameplay.js` | Compatibility placeholder; current rhythm gameplay is in `littlejs-game.js`. |
| `hud.js` | Game overlays, playfield display, and results. |
| `input.js` | Compatibility placeholder for older rhythm input code; current input handling is in `littlejs-game.js`. |
| `levelEditor.js` | Stage editor behavior and recording tools for `LevelEditor.html`. |
| `levelFormat.js` | Helpers for reading and migrating the older level format. |
| `levelFormatV1.js` | Validation and helpers for the current stage file format. |
| `littlejs-game.js` | Main game loop, rhythm play, state changes, and progression. |
| `main.js` | Starts the game and connects page-level listeners. |
| `menu.js` | Main menu, stage select, settings, and other page controls. |
| `overworld.js` | Zig Zag Town, world switching, portals, characters, and Warden gates. |
| `settings.js` | Player settings such as volume, timing offset, difficulty, and visual options. |
| `song-manifest.js` | List of playable tracks and their BPM information. The build uses this list to decide which music to embed or publish. |
| `songs.js` | Builds the stage list and reads BPM data. |
| `songs-bpm.txt` | Editable plain-text BPM list for the tracks. |
| `storage.js` | Saves settings and progress in browser storage, with a fallback when storage is unavailable. |
| `themes.js` | Color palettes and theme settings for the menus and game. |

## Game content

- `levels/stage1.level` through `levels/stage6.level` contain the playable note charts. Their numbered stage IDs match the playable tracks. Note times are measured in milliseconds from the start of each track.
- `songs/` contains the audio files. `js/song-manifest.js` selects the tracks used in the game and included in builds. `4-Skillet - Monster.mp3` is not listed or used by the game; check redistribution rights before including it in a release.
- `assets/img/spritesheet.png` is the sprite sheet identified by the overworld source comments. `assets/img/character-spritesheet.png` is additional character artwork; the current game code does not reference that file directly.
- `assets/Tiny Neighbours Vol1/` contains NPC sprite source sheets and emote artwork. NPC image data is embedded in `js/data.js` so it loads without separate image requests; the `Emotes/` folder is retained source art.
- `css/styles.css` styles the game page and its menus.

## Build, publish, and checks

- `scripts/build-standalone.mjs` combines the template, styles, game scripts, listed audio tracks, and stage charts into the root `index.html`.
- `scripts/build-static.mjs` prepares a `dist/` folder for static hosting. It includes only tracks listed in the manifest. The generated `dist/` folder is ignored by Git.
- `.github/workflows/pages.yml` runs the static build and publishes `dist/` to GitHub Pages when changes are pushed to `main` or the workflow is started manually.
- `tests/level-format.test.js` checks the current stage format. Run the checks with `npm test`.
- `docs/Plan.md` contains the project's game-jam plan and design notes.
