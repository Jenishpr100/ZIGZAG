import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = path.join(root, 'index.template.html');
const outputPath = path.join(root, 'index.html');

const manifestSandbox = { window: {} };
vm.runInNewContext(await readFile(path.join(root, 'js/song-manifest.js'), 'utf8'), manifestSandbox, { timeout: 1000 });
const manifest = manifestSandbox.window.ZIGZAG_SONGS;
if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length)
  throw new Error('js/song-manifest.js must provide a non-empty list of playable tracks.');

const mimeTypes = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.webm': 'audio/webm', '.flac': 'audio/flac' };
const embeddedSongs = {};
for (const filename of manifest.files) {
  const extension = path.extname(filename).toLowerCase();
  const mime = mimeTypes[extension];
  if (!mime) throw new Error(`No browser audio type is configured for ${filename}.`);
  const bytes = await readFile(path.join(root, 'songs', filename));
  embeddedSongs[filename] = `data:${mime};base64,${bytes.toString('base64')}`;
}

const levelDirectory = path.join(root, 'levels');
const levelNames = (await readdir(levelDirectory)).filter(name => /^stage\d+\.level$/i.test(name)).sort((a, b) => {
  const number = name => Number(/^stage(\d+)\.level$/i.exec(name)[1]);
  return number(a) - number(b);
});
const embeddedLevels = {};
for (const filename of levelNames) embeddedLevels[filename] = await readFile(path.join(levelDirectory, filename), 'utf8');
for (const filename of manifest.files) {
  const stageId = Number(/^(\d+)-/.exec(filename)?.[1]);
  const levelName = `stage${stageId}.level`;
  if (!stageId || typeof embeddedLevels[levelName] !== 'string')
    throw new Error(`${levelName} is required for the playable track ${filename}.`);
}

const assetsScript = `<script>window.ZIGZAG_INLINE_ASSETS = ${JSON.stringify({ songs: embeddedSongs, levels: embeddedLevels }).replace(/</g, '\\u003c')};</script>`;
const stylesheetPath = path.join(root, 'css', 'styles.css');
let html = await readFile(templatePath, 'utf8');
const stylesheetTag = /<link\s+rel="stylesheet"\s+href="css\/styles\.css"\s*\/?>/i;
if (!stylesheetTag.test(html)) throw new Error('The source template must link css/styles.css exactly once.');
const stylesheet = await readFile(stylesheetPath, 'utf8');
html = html.replace(stylesheetTag, `<style>\n${stylesheet.replace(/<\/style/gi, '<\\/style')}\n</style>`);

const scriptTag = /<script\b[^>]*\bsrc=(['"])([^'"]+)\1[^>]*>\s*<\/script>/gi;
const scriptMatches = [...html.matchAll(scriptTag)];
if (!scriptMatches.length) throw new Error('No external game scripts were found in the source template.');
for (const match of scriptMatches.reverse()) {
  const sourcePath = path.resolve(root, match[2]);
  if (!sourcePath.startsWith(root + path.sep)) throw new Error(`Script path escapes the project: ${match[2]}`);
  const source = await readFile(sourcePath, 'utf8');
  const inlineSource = source.replace(/<\/script/gi, '<\\/script');
  const embeddedAssets = match[2] === 'js/song-manifest.js' ? assetsScript + '\n' : '';
  html = html.slice(0, match.index) + `${embeddedAssets}<script>\n${inlineSource}\n</script>` + html.slice(match.index + match[0].length);
}

html = html.replace('<!-- Source template used to build the self-contained, double-clickable index.html. -->',
  '<!-- Self-contained game: double-click this file to play without a server. -->');
await writeFile(outputPath, html, 'utf8');
const outputBytes = Buffer.byteLength(html, 'utf8');
process.stdout.write(`Built standalone index.html (${(outputBytes / 1024 / 1024).toFixed(2)} MiB; ${manifest.files.length} tracks, ${levelNames.length} stage charts).\n`);
