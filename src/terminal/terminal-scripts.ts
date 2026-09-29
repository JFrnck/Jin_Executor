/**
 * Programas fijos que el Executor corre DENTRO del pod de una sesión (ADR
 * 0016). Son código de Jin, no del owner ni de un agente: lo único variable
 * llega como argumento posicional o por stdin, nunca interpolado en el texto
 * del script, así que no hay inyección de shell ni de JS.
 */

/**
 * Ejecutor de cada comando del owner (corre dentro del pod, con `node -e`).
 * `argv[1]` = segundos de timeout, `argv[2]` = el comando (un dato: se le pasa
 * a `sh -c 'eval "$1"'`, nunca se interpola en el texto de ningún script).
 *
 * - **Grupo de procesos:** el comando corre en su propio grupo y, al terminar
 *   (o al vencer el timeout), se mata el grupo entero con SIGKILL. `timeout`
 *   de busybox solo mata al hijo directo: un `sleep` o un `npm` huérfano
 *   dejaría abierto el stream del `exec` hasta que lo corte el Executor.
 *   Consecuencia: **los procesos en segundo plano no sobreviven al comando.**
 * - **Directorio:** se guarda en `JIN_CWD_FILE` para que `cd` valga entre
 *   comandos aunque cada uno corra en una shell nueva.
 * - **Código de salida:** el del comando; 137 si venció el timeout; 128+señal
 *   si lo mató una señal.
 */
export const RUN_SCRIPT = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const seconds = Number(process.argv[1]);
const command = process.argv[2];
const workspace = process.env.JIN_WORKSPACE || '/workspace';
const cwdFile = process.env.JIN_CWD_FILE || '/tmp/.jin-cwd';
let cwd = workspace;
try {
  const saved = fs.readFileSync(cwdFile, 'utf8').trim();
  if (saved && fs.statSync(saved).isDirectory()) cwd = saved;
} catch {}
const child = spawn(
  'sh',
  ['-c', 'eval "$1"; status=$?; pwd > "$2"; exit $status', 'jin', command, cwdFile],
  { cwd, stdio: 'inherit', detached: true },
);
let timedOut = false;
function killGroup() {
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}
const timer = setTimeout(() => { timedOut = true; killGroup(); }, seconds * 1000);
child.on('error', (error) => {
  process.stderr.write('No se pudo ejecutar el comando: ' + error.message + '\\n');
  process.exit(127);
});
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  killGroup();
  if (timedOut) process.exit(137);
  if (signal) process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 }[signal] || 1));
  process.exit(code ?? 1);
});
`;

/**
 * Escribe archivos en una raíz. `argv[1]` = raíz (`/workspace` o `/tmp`).
 * stdin = `<bytes>\n<json>`: el largo va primero, así el programa no depende
 * de ver EOF en el canal (los servidores antiguos de K8s no lo soportan).
 * El JSON es `{ "files": { "ruta": "contenido" } }`.
 */
export const WRITE_FILES_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[1]);
const chunks = [];
let expected = -1;
let received = 0;
let header = '';
process.stdin.on('data', (chunk) => {
  if (expected < 0) {
    header += chunk.toString('latin1');
    const newline = header.indexOf('\\n');
    if (newline < 0) return;
    expected = Number(header.slice(0, newline));
    const rest = Buffer.from(header.slice(newline + 1), 'latin1');
    chunks.push(rest);
    received += rest.length;
  } else {
    chunks.push(chunk);
    received += chunk.length;
  }
  if (expected >= 0 && received >= expected) finish();
});
let done = false;
function finish() {
  if (done) return;
  done = true;
  const body = Buffer.concat(chunks).subarray(0, expected).toString('utf8');
  const { files } = JSON.parse(body);
  let written = 0;
  for (const [relative, content] of Object.entries(files)) {
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error('ruta fuera de la raíz: ' + relative);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    written += 1;
  }
  process.stdout.write(JSON.stringify({ written }));
  process.exit(0);
}
`;

/**
 * Lista los archivos de texto de un directorio del espacio de trabajo y los
 * devuelve como JSON. `argv[1]` = directorio relativo a `/workspace`. Deja
 * afuera lo que no es código del proyecto (node_modules, .git, caches, builds
 * cuando se exporta la raíz), lo que no es texto UTF-8 y lo que pasaría los
 * topes de Publicar (50 archivos, 256 KB).
 */
export const EXPORT_FILES_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const workspace = path.resolve(process.env.JIN_WORKSPACE || '/workspace');
const base = path.resolve(workspace, process.argv[1] || '.');
const MAX_FILES = 50;
const MAX_TOTAL = 256 * 1024;
const MAX_FILE = 200 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.jin', '.npm', '.cache', '.vite', '.turbo', '.home', '.npm-global']);
const rootExport = base === workspace;
const files = {};
const skipped = [];
let total = 0;
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(base, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || (rootExport && entry.name === 'dist')) {
        skipped.push({ path: relative + '/', reason: 'omitida' });
        continue;
      }
      walk(full);
    } else if (entry.isFile()) {
      const size = fs.statSync(full).size;
      if (size > MAX_FILE) { skipped.push({ path: relative, reason: 'mayor a 200 KB' }); continue; }
      const buffer = fs.readFileSync(full);
      if (buffer.includes(0)) { skipped.push({ path: relative, reason: 'binario' }); continue; }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { skipped.push({ path: relative, reason: 'no es UTF-8' }); continue; }
      const cost = Buffer.byteLength(relative) + buffer.length;
      if (Object.keys(files).length >= MAX_FILES) { skipped.push({ path: relative, reason: 'más de 50 archivos' }); continue; }
      if (total + cost > MAX_TOTAL) { skipped.push({ path: relative, reason: 'supera 256 KB en total' }); continue; }
      files[relative] = text;
      total += cost;
    }
  }
}
if (base !== workspace && !base.startsWith(workspace + path.sep)) {
  throw new Error('directorio fuera del espacio de trabajo');
}
walk(base);
process.stdout.write(JSON.stringify({ files, skipped }));
`;

/**
 * Explorador y editor de archivos del pod (2026-09-29): una operación por
 * ejecución sobre el DISCO REAL del proyecto. `argv[1]` = operación
 * (`list`, `read`, `write`, `mkdir`, `delete`), `argv[2]` = ruta relativa a
 * `/workspace` (`.` = la raíz). Solo `write` usa stdin: `<bytes>\n<json>` con
 * `{ content, expectedSha256?, force? }` (el largo va primero, igual que
 * `WRITE_FILES_SCRIPT`, porque no se puede depender de ver EOF).
 *
 * Responde SIEMPRE un JSON por stdout con código de salida 0: `{ ok: true,
 * data }` o `{ ok: false, code, message }`, para que el Executor distinga
 * "no existe" o "cambió" de un fallo real del programa.
 *
 * Seguridad — lo que hay en el disco es dato no confiable (lo escribió un
 * `npm install`, un agente o Claude Code):
 * - la ruta se resuelve contra `/workspace` y se verifica con `realpath` que
 *   ni ella ni su carpeta existente más cercana se salgan (un `..` o un
 *   enlace simbólico hacia afuera se rechazan);
 * - nunca se sigue un enlace simbólico: se listan como `link` y no se leen ni
 *   escriben;
 * - solo texto UTF-8 de hasta 512 KB;
 * - escribir es atómico (archivo temporal + rename) y, con `expectedSha256`,
 *   falla con `conflict` si el archivo cambió desde que se leyó.
 */
export const FS_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_FILE = 512 * 1024;
const MAX_ENTRIES = 2000;
const workspace = fs.realpathSync(process.env.JIN_WORKSPACE || '/workspace');
const op = process.argv[1];
const rel = process.argv[2] || '.';

class Fail extends Error {
  constructor(code, message, extra) { super(message); this.code = code; this.extra = extra || {}; }
}
function within(p) { return p === workspace || p.startsWith(workspace + path.sep); }
function resolveSafe(relative, followLast) {
  if (relative.includes('\\0') || relative.includes('\\\\')) throw new Fail('outside', 'ruta inválida');
  const target = path.resolve(workspace, relative);
  if (!within(target)) throw new Fail('outside', 'ruta fuera del espacio de trabajo');
  // Borrar un enlace simbólico no lo sigue (unlink): basta con que su CARPETA esté adentro.
  let existing = followLast ? target : path.dirname(target);
  while (existing !== workspace && !fs.existsSync(existing)) existing = path.dirname(existing);
  if (!within(fs.realpathSync(existing))) throw new Fail('outside', 'la ruta sale del espacio de trabajo');
  return target;
}
function lstatOrNull(p) { try { return fs.lstatSync(p); } catch { return null; } }
function sha(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function readText(target) {
  const stat = lstatOrNull(target);
  if (!stat) throw new Fail('not_found', 'no existe');
  if (stat.isSymbolicLink()) throw new Fail('symlink', 'es un enlace simbólico');
  if (!stat.isFile()) throw new Fail('not_file', 'no es un archivo');
  if (stat.size > MAX_FILE) throw new Fail('too_large', 'supera 512 KB', { size: stat.size });
  const buffer = fs.readFileSync(target);
  if (buffer.includes(0)) throw new Fail('not_text', 'es un archivo binario');
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Fail('not_text', 'no es texto UTF-8'); }
  return { content, size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha(buffer), buffer };
}

function list(target) {
  const stat = lstatOrNull(target);
  if (!stat) throw new Fail('not_found', 'no existe');
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Fail('not_file', 'no es una carpeta');
  const all = fs.readdirSync(target, { withFileTypes: true });
  const entries = all.slice(0, MAX_ENTRIES).map((entry) => {
    const full = path.join(target, entry.name);
    const info = lstatOrNull(full);
    const type = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other';
    return { name: entry.name, type, size: info && type === 'file' ? info.size : 0, mtimeMs: info ? info.mtimeMs : 0 };
  });
  entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
  return { entries, truncated: all.length > MAX_ENTRIES };
}

function read(target) {
  const { buffer, ...rest } = readText(target);
  return rest;
}

function write(target, input) {
  if (target === workspace) throw new Fail('not_file', 'no es un archivo');
  if (typeof input.content !== 'string') throw new Fail('outside', 'falta el contenido');
  const data = Buffer.from(input.content, 'utf8');
  if (data.length > MAX_FILE) throw new Fail('too_large', 'supera 512 KB', { size: data.length });
  const stat = lstatOrNull(target);
  let mode = 0o644;
  if (stat) {
    if (stat.isSymbolicLink()) throw new Fail('symlink', 'es un enlace simbólico');
    if (!stat.isFile()) throw new Fail('not_file', 'no es un archivo');
    mode = stat.mode & 0o777;
    if (input.expectedSha256) {
      const current = sha(fs.readFileSync(target));
      if (current !== input.expectedSha256) throw new Fail('conflict', 'el archivo cambió en el pod', { currentSha256: current });
    } else if (!input.force) {
      throw new Fail('exists', 'el archivo ya existe');
    }
  }
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  if (!within(fs.realpathSync(dir))) throw new Fail('outside', 'la ruta sale del espacio de trabajo');
  const temp = path.join(dir, '.jin-tmp-' + crypto.randomBytes(6).toString('hex'));
  try {
    fs.writeFileSync(temp, data, { mode });
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
  const after = fs.lstatSync(target);
  return { sha256: sha(data), size: after.size, mtimeMs: after.mtimeMs };
}

function mkdir(target) {
  const stat = lstatOrNull(target);
  if (stat && !stat.isDirectory()) throw new Fail('exists', 'ya existe y no es una carpeta');
  fs.mkdirSync(target, { recursive: true });
  if (!within(fs.realpathSync(target))) throw new Fail('outside', 'la ruta sale del espacio de trabajo');
  return {};
}

function remove(target) {
  if (target === workspace) throw new Fail('outside', 'no se puede borrar la raíz del proyecto');
  const stat = lstatOrNull(target);
  if (!stat) throw new Fail('not_found', 'no existe');
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    if (fs.readdirSync(target).length > 0) throw new Fail('not_empty', 'la carpeta no está vacía');
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
  return {};
}

// process.exit() antes de que se vacíe el pipe cortaba la salida en 64 KB (un archivo grande daba JSON truncado).
let responded = false;
function respond(payload) {
  if (responded) return;
  responded = true;
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
}
function run(input) {
  try {
    const target = resolveSafe(rel, op !== 'delete');
    const data = op === 'list' ? list(target)
      : op === 'read' ? read(target)
      : op === 'write' ? write(target, input)
      : op === 'mkdir' ? mkdir(target)
      : op === 'delete' ? remove(target)
      : (() => { throw new Fail('outside', 'operación desconocida'); })();
    respond({ ok: true, data });
  } catch (error) {
    if (error instanceof Fail) respond({ ok: false, code: error.code, message: error.message, ...error.extra });
    respond({ ok: false, code: 'failed', message: String(error && error.message || error).slice(0, 200) });
  }
}

if (op !== 'write') {
  run(null);
} else {
  const chunks = [];
  let expected = -1;
  let received = 0;
  let header = '';
  let started = false;
  process.stdin.on('data', (chunk) => {
    if (started) return;
    if (expected < 0) {
      header += chunk.toString('latin1');
      const newline = header.indexOf('\\n');
      if (newline < 0) return;
      expected = Number(header.slice(0, newline));
      const rest = Buffer.from(header.slice(newline + 1), 'latin1');
      chunks.push(rest);
      received += rest.length;
    } else {
      chunks.push(chunk);
      received += chunk.length;
    }
    if (expected >= 0 && received >= expected) {
      started = true;
      run(JSON.parse(Buffer.concat(chunks).subarray(0, expected).toString('utf8')));
    }
  });
}
`;

/**
 * Arranca el servidor estático fijo de Jin sobre un directorio del espacio de
 * trabajo, en segundo plano. `$1` = directorio relativo a `/workspace`.
 * El servidor sirve el directorio actual, por eso el `cd`.
 */
export const START_STATIC_SERVER =
  'cd "/workspace/$1" && (nohup node /tmp/.jin/static-server.mjs >/tmp/static-server.log 2>&1 </dev/null &)';

/** ¿Responde el servidor? busybox `wget` viene en la imagen alpine. */
export const CHECK_STATIC_SERVER =
  'wget -q -T 2 -O /dev/null http://127.0.0.1:"$1"/ 2>/dev/null';

/**
 * Servidores en segundo plano dentro de la sesión (`npm run dev`, un backend en
 * el puerto 3000…). `node -e SERVICE_SCRIPT <modo> <puerto> [comando]`.
 *
 * A diferencia de `RUN_SCRIPT`, el proceso NO muere con el comando: se lanza en
 * su propio grupo, con la salida a un archivo, y el ejecutor termina. Cada
 * servidor guarda su pid/comando en `JIN_SVC_DIR` (`/tmp/.jin-svc`) para poder
 * listarlo, ver su log y detenerlo (se mata el grupo entero).
 *
 * - `start`: lanza `sh -c <comando>` y espera (hasta 45 s) a que el puerto
 *   acepte conexiones, o a que el proceso termine. Devuelve `listening`,
 *   `exited` o `timeout` con las últimas líneas del log.
 * - `stop`, `list` y `logs` son lo que dicen.
 */
export const SERVICE_SCRIPT = `
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dir = process.env.JIN_SVC_DIR || '/tmp/.jin-svc';
const workspace = process.env.JIN_WORKSPACE || '/workspace';
const cwdFile = process.env.JIN_CWD_FILE || '/tmp/.jin-cwd';
const mode = process.argv[1];
const port = Number(process.argv[2]);
const command = process.argv[3];
fs.mkdirSync(dir, { recursive: true });
const metaFile = (p) => path.join(dir, p + '.json');
const logFile = (p) => path.join(dir, p + '.log');
const out = (value) => { process.stdout.write(JSON.stringify(value)); };
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function readMeta(p) { try { return JSON.parse(fs.readFileSync(metaFile(p), 'utf8')); } catch { return null; } }
function tail(p, bytes) {
  try {
    const buffer = fs.readFileSync(logFile(p));
    return buffer.subarray(Math.max(0, buffer.length - bytes)).toString('utf8');
  } catch { return ''; }
}
function listening(p) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: p, host: '127.0.0.1' });
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function killGroup(pid, signal) { try { process.kill(-pid, signal); } catch {} }

async function main() {
  if (mode === 'start') {
    const previous = readMeta(port);
    if (previous && alive(previous.pid)) {
      out({ status: 'already-running', pid: previous.pid, port, log: tail(port, 1500) });
      return;
    }
    let cwd = workspace;
    try {
      const saved = fs.readFileSync(cwdFile, 'utf8').trim();
      if (saved && fs.statSync(saved).isDirectory()) cwd = saved;
    } catch {}
    const fd = fs.openSync(logFile(port), 'w');
    const child = spawn('sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', fd, fd] });
    let exited = null;
    child.on('exit', (code) => { exited = code === null ? 1 : code; });
    child.on('error', () => { exited = 127; });
    fs.writeFileSync(metaFile(port), JSON.stringify({ pid: child.pid, port, command, cwd, startedAt: new Date().toISOString() }));
    for (let waited = 0; waited < 45000; waited += 300) {
      if (await listening(port)) {
        child.unref();
        out({ status: 'listening', pid: child.pid, port, log: tail(port, 1500) });
        return;
      }
      if (exited !== null) {
        out({ status: 'exited', code: exited, port, log: tail(port, 3000) });
        try { fs.unlinkSync(metaFile(port)); } catch {}
        return;
      }
      await sleep(300);
    }
    child.unref();
    out({ status: 'timeout', pid: child.pid, port, log: tail(port, 3000) });
    return;
  }
  if (mode === 'stop') {
    const meta = readMeta(port);
    if (!meta) { out({ stopped: false }); return; }
    killGroup(meta.pid, 'SIGTERM');
    for (let i = 0; i < 10 && alive(meta.pid); i++) await sleep(200);
    if (alive(meta.pid)) killGroup(meta.pid, 'SIGKILL');
    try { fs.unlinkSync(metaFile(port)); } catch {}
    out({ stopped: true });
    return;
  }
  if (mode === 'list') {
    const services = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const meta = readMeta(Number(name.slice(0, -5)));
      if (!meta) continue;
      const isAlive = alive(meta.pid);
      services.push({ port: meta.port, command: meta.command, startedAt: meta.startedAt, running: isAlive, listening: isAlive && (await listening(meta.port)) });
    }
    services.sort((a, b) => a.port - b.port);
    out({ services });
    return;
  }
  if (mode === 'logs') {
    out({ log: tail(port, 8000) });
    return;
  }
  throw new Error('modo desconocido: ' + mode);
}
main().then(() => process.exit(0), (error) => { process.stderr.write(String(error && error.message || error)); process.exit(1); });
`;
