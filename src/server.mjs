import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const LevelFormatV1 = require('./js/levelFormatV1.js');
const root = path.dirname(fileURLToPath(import.meta.url));
const levelsDir = path.join(root, 'levels');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.level': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac'
};

function send(response, status, payload, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function localOriginAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch { return false; }
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('Request body is larger than 1 MB.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/api/health') return send(response, 200, { ok: true });

  if (url.pathname === '/api/levels' && request.method === 'GET') {
    const names = (await readdir(levelsDir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^stage[1-9]\d{0,3}\.level$/.test(entry.name))
      .map(entry => entry.name).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    return send(response, 200, { files: names });
  }

  if (url.pathname === '/api/levels' && request.method === 'POST') {
    if (!localOriginAllowed(request)) return send(response, 403, { error: 'Level saving is only available to this local project page.' });
    let payload;
    try { payload = JSON.parse(await readBody(request)); }
    catch (error) { return send(response, error.status || 400, { error: error.status ? error.message : 'Request must contain valid JSON.' }); }
    if (!payload || typeof payload !== 'object' || typeof payload.content !== 'string') return send(response, 400, { error: 'Provide level content as a JSON string.' });
    let level;
    try { level = JSON.parse(payload.content); }
    catch (error) { return send(response, 400, { error: 'Invalid level JSON: ' + error.message }); }
    const validation = LevelFormatV1.validate(level);
    if (!validation.valid) return send(response, 422, { error: validation.errors.join(' ') });
    let expectedName;
    try { expectedName = LevelFormatV1.filenameForStage(level.stage); }
    catch (error) { return send(response, 422, { error: error.message }); }
    if (payload.filename !== expectedName) return send(response, 400, { error: 'Filename must match level stage: ' + expectedName });
    const target = path.join(levelsDir, expectedName);
    try {
      await writeFile(target, LevelFormatV1.toJSON(level), { flag: payload.overwrite === true ? 'w' : 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') return send(response, 409, { exists: true, error: expectedName + ' already exists. Confirm replacement before saving again.' });
      throw error;
    }
    return send(response, 201, { saved: true, filename: expectedName });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, { error: 'Method not allowed.' });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { return send(response, 400, { error: 'Invalid URL encoding.' }); }
  if (pathname === '/') pathname = '/index.html';
  const target = path.resolve(root, '.' + pathname);
  if (target !== root && !target.startsWith(root + path.sep)) return send(response, 403, { error: 'Path is outside the project.' });
  try {
    const actual = await realpath(target);
    if (actual !== root && !actual.startsWith(root + path.sep)) return send(response, 403, { error: 'Path is outside the project.' });
    const body = await readFile(actual);
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(actual).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return send(response, 404, { error: 'File not found.' });
    throw error;
  }
}

const server = createServer((request, response) => {
  handle(request, response).catch(error => {
    console.error(error);
    if (!response.headersSent) send(response, 500, { error: 'Local development server error.' });
    else response.destroy();
  });
});

const port = Number(process.env.PORT || 4173);
server.listen(port, '127.0.0.1', () => console.log('ZIGZAG local server: http://127.0.0.1:' + port));
