# MuZiC "Switch"

A small rhythm adventure built with LittleJS. Walk around Zig Zag Town, switch between its two color worlds, challenge three Wardens, and play six four lane music stages. Stage clears and best scores are saved in the browser.

## Open the game directly

Double-click the generated root `index.html` to play the full game. It embeds the game code, styles, six listed music tracks, and all stage charts, so it works from `file://` without a server, port, Node.js, or extra folders. Progress and settings are saved in the browser when local storage is available.

When you change the source HTML, CSS, JavaScript, music manifest, or stage files, regenerate the standalone file with `npm run build:standalone` before sharing it. This build step only creates the HTML file; people who play it do not need to run a build.

The separate `LevelEditor.html` is a project editing tool and still uses the project folders. For GitHub Pages, push to `main`, set the repository's Pages source to **GitHub Actions**, and open the Pages URL when the workflow finishes. The workflow rebuilds the standalone game and publishes it with the editor and source files. It includes only tracks listed in `js/song-manifest.js`; the unused `4-Skillet - Monster.mp3` is not published.

To publish manually as a static site, run `npm run build:static` and upload `dist/`. The game itself does not need a server or port.

## Run locally (optional)

The included Node.js helper is only needed to write a level directly into the local `levels/` folder while editing. Without it, the editor downloads the `.level` file for you to add to the project and publish. To use the optional helper, run `npm run dev` and open [http://127.0.0.1:4173/](http://127.0.0.1:4173/).

## Play

- **Enter the Hub** starts in Zig Zag Town. Walk to the glowing portal and press **Space** or **Enter** to play the selected stage.
- **Stage Select** chooses a stage and takes you to the hub. Stages only start from the hub portal. Clear a stage by landing at least one note to unlock the next one.
- Walk with **WASD** or the arrow keys. **Down** switches between ZIG and ZAG. **Enter** talks to people and challenges a nearby Warden.
- Hit notes with **D F J K** for lanes 1–4. Mouse and touch work too. Keep holding for long notes; follow the gold ribbon across lanes for drags.
- **Page Up / Page Down** selects an unlocked stage in the overworld. **Esc** or **P** pauses; **R** returns to the hub after a stage.
- Misses reduce health. **Practice mode** prevents health loss. Adjust timing offset and difficulty in Settings.

## Stages

The numbered audio file maps to `levels/stageN.level`:

| Stage | Track | Length | BPM |
|---:|---|---:|---:|
| 1 | Demo Pulse | 50 s | 120 |
| 2 | Neon Rush - Remix | 42 s | 172 |
| 3 | Slow Drift | 40 s | 90 |
| 4 | Arcade Sunrise | 32 s | 135 |
| 5 | Glass Steps | 32 s | 108 |
| 6 | Overdrive Circuit | 32 s | 160 |

Stages 4–6 use original synthesized demo music included in `songs/`. The older `4-Skillet - Monster.mp3` file is not listed or used by the game. Confirm its rights before including it in a public release.

## Edit a stage

Open `LevelEditor.html`. It loads the matching `levels/stageN.level` file when one exists. Record notes in the four lane scene, inspect their scrolling timeline, change the timeline range, edit timing, lane, note type, or JSON, and use Quick Replay to review the stage. Undo and redo edits with the buttons or Ctrl+Z / Ctrl+Y. The editor follows the selected theme. Save directly into `levels/` with the optional local helper, or download the `.level` file and add it to that folder before publishing. The stage file is the source of the playable notes; there is no generated seed chart.

Times in `.level` files are milliseconds from the track start. Lanes are numbered 0–3 from left to right. Click, hold, and drag notes are supported. `js/levelFormatV1.js` validates imported and saved files.

## Project map

See [Project file guide](docs/PROJECT_STRUCTURE.md) for a folder map and a description of the files, including which files are generated and which are used by the game, editor, and build tools.

## Credits and release notes

The game uses the LittleJS engine and [Tiny Neighbours by Vryell](https://vryell.itch.io/tiny-neighbours) NPC sprites. The pack allows personal and commercial use, asks users not to redistribute the pack by itself, and says credit is appreciated. Teto sprite art was supplied by a project contributor. The project includes original synthesized demo music for stages 4–6. AI assistance was used for code and procedural audio generation.

The release plan requires original music. Do not bundle the unlisted `4-Skillet - Monster.mp3` unless you have permission to redistribute it.

Run the built-in level format checks with `npm test`.
