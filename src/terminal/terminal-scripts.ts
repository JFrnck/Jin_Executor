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
const SKIP_DIRS = new Set(['node_modules', '.git', '.jin', '.npm', '.cache', '.vite', '.turbo']);
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
 * Arranca el servidor estático fijo de Jin sobre un directorio del espacio de
 * trabajo, en segundo plano. `$1` = directorio relativo a `/workspace`.
 * El servidor sirve el directorio actual, por eso el `cd`.
 */
export const START_STATIC_SERVER =
  'cd "/workspace/$1" && (nohup node /tmp/.jin/static-server.mjs >/tmp/static-server.log 2>&1 </dev/null &)';

/** ¿Responde el servidor? busybox `wget` viene en la imagen alpine. */
export const CHECK_STATIC_SERVER =
  'wget -q -T 2 -O /dev/null http://127.0.0.1:"$1"/ 2>/dev/null';
