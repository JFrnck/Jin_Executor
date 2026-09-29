import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXPORT_FILES_SCRIPT,
  FS_SCRIPT,
  RUN_SCRIPT,
  SERVICE_SCRIPT,
  WRITE_FILES_SCRIPT,
} from './terminal-scripts';

// Estos programas corren dentro del pod, pero son JS/sh comunes: se prueban de
// verdad contra un directorio temporal en vez de solo comparar strings.

function tmp(): string {
  // realpath: en macOS /var es un enlace a /private/var y `pwd` devuelve el real.
  return realpathSync(mkdtempSync(join(tmpdir(), 'jin-terminal-')));
}

function payload(files: Record<string, string>): Buffer {
  const body = JSON.stringify({ files });
  return Buffer.from(`${Buffer.byteLength(body)}\n${body}`);
}

function runWrite(root: string, input: Buffer) {
  return spawnSync('node', ['-e', WRITE_FILES_SCRIPT, root], { input });
}

function runExport(workspace: string, dir = '.') {
  const out = execFileSync('node', ['-e', EXPORT_FILES_SCRIPT, dir], {
    env: { ...process.env, JIN_WORKSPACE: workspace },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.toString()) as {
    files: Record<string, string>;
    skipped: { path: string; reason: string }[];
  };
}

describe('WRITE_FILES_SCRIPT', () => {
  it('escribe archivos anidados con contenido UTF-8 y responde cuántos', () => {
    const root = tmp();
    const result = runWrite(
      root,
      payload({ 'index.html': '<h1>Hola ñandú 🎉</h1>', 'src/js/app.js': 'a' }),
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ written: 2 });
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe(
      '<h1>Hola ñandú 🎉</h1>',
    );
    expect(readFileSync(join(root, 'src/js/app.js'), 'utf8')).toBe('a');
  });

  it('no depende de ver EOF: termina cuando llegaron los bytes anunciados', () => {
    const root = tmp();
    // Un stdin que nunca se cierra colgaría el script si esperara EOF; con el
    // largo por delante termina solo (spawnSync con timeout lo comprueba).
    const result = spawnSync('node', ['-e', WRITE_FILES_SCRIPT, root], {
      input: payload({ 'a.txt': 'x' }),
      timeout: 5000,
    });
    expect(result.status).toBe(0);
  });

  it('rechaza rutas que salen de la raíz', () => {
    const root = tmp();
    const result = runWrite(root, payload({ '../escapa.txt': 'x' }));
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain('fuera de la raíz');
  });

  it('un archivo grande (200 KB) llega completo aunque el stdin llegue en trozos', () => {
    const root = tmp();
    const big = 'línea de prueba con acentos ñ\n'.repeat(7000);
    const result = runWrite(root, payload({ 'big.txt': big }));
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, 'big.txt'), 'utf8')).toBe(big);
  });
});

describe('EXPORT_FILES_SCRIPT', () => {
  function project(): string {
    const ws = tmp();
    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(ws, 'node_modules/pkg'), { recursive: true });
    mkdirSync(join(ws, 'dist'), { recursive: true });
    mkdirSync(join(ws, '.git'), { recursive: true });
    writeFileSync(join(ws, 'package.json'), '{"name":"x"}');
    writeFileSync(join(ws, 'src/main.js'), 'console.log(1)');
    writeFileSync(join(ws, 'node_modules/pkg/index.js'), 'x');
    writeFileSync(join(ws, 'dist/index.html'), '<html>');
    writeFileSync(join(ws, '.git/config'), 'x');
    writeFileSync(join(ws, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    writeFileSync(join(ws, 'latin1.txt'), Buffer.from([0xe9, 0xe9, 0xe9]));
    return ws;
  }

  it('exporta el código del proyecto y deja fuera node_modules, .git y dist', () => {
    const { files, skipped } = runExport(project());
    expect(Object.keys(files).sort()).toEqual(['package.json', 'src/main.js']);
    const reasons = Object.fromEntries(skipped.map((s) => [s.path, s.reason]));
    expect(reasons['node_modules/']).toBe('omitida');
    expect(reasons['.git/']).toBe('omitida');
    expect(reasons['dist/']).toBe('omitida');
    expect(reasons['logo.png']).toBe('binario');
    expect(reasons['latin1.txt']).toBe('no es UTF-8');
  });

  it('exportar dist/ sí lo incluye (rutas relativas a ese directorio)', () => {
    const { files } = runExport(project(), 'dist');
    expect(Object.keys(files)).toEqual(['index.html']);
  });

  it('respeta los topes de Publicar: 50 archivos y 256 KB', () => {
    const ws = tmp();
    for (let i = 0; i < 60; i++)
      writeFileSync(join(ws, `f${String(i).padStart(2, '0')}.txt`), 'x');
    const many = runExport(ws);
    expect(Object.keys(many.files)).toHaveLength(50);
    expect(
      many.skipped.filter((s) => s.reason === 'más de 50 archivos'),
    ).toHaveLength(10);

    const heavy = tmp();
    for (let i = 0; i < 4; i++)
      writeFileSync(join(heavy, `h${i}.txt`), 'a'.repeat(100 * 1024));
    const result = runExport(heavy);
    expect(Object.keys(result.files)).toHaveLength(2);
    expect(
      result.skipped.some((s) => s.reason === 'supera 256 KB en total'),
    ).toBe(true);
  });

  it('un enlace simbólico no se sigue: no puede sacar archivos de fuera del espacio de trabajo', () => {
    const ws = tmp();
    const outside = join(tmp(), 'secreto.txt');
    writeFileSync(outside, 'contenido-secreto');
    symlinkSync(outside, join(ws, 'enlace.txt'));
    symlinkSync(dirname(outside), join(ws, 'carpeta-enlace'));
    writeFileSync(join(ws, 'ok.txt'), 'ok');
    const { files } = runExport(ws);
    expect(Object.keys(files)).toEqual(['ok.txt']);
    expect(JSON.stringify(files)).not.toContain('contenido-secreto');
  });

  it('no sale del espacio de trabajo', () => {
    const ws = tmp();
    expect(() => runExport(ws, '../..')).toThrow();
  });
});

describe('RUN_SCRIPT (el ejecutor de cada comando)', () => {
  function run(command: string, env: Record<string, string>, seconds = 20) {
    return spawnSync('node', ['-e', RUN_SCRIPT, String(seconds), command], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  it('conserva el directorio entre comandos y devuelve el código de salida del comando', () => {
    const ws = tmp();
    mkdirSync(join(ws, 'app'));
    const env = { JIN_WORKSPACE: ws, JIN_CWD_FILE: join(ws, '.cwd') };

    expect(run('cd app', env).status).toBe(0);
    expect(run('pwd', env).stdout.trim()).toBe(join(ws, 'app'));

    const failing = run('exit 3', env);
    expect(failing.status).toBe(3);
    // Un comando que falla no pierde el directorio guardado.
    expect(run('pwd', env).stdout.trim()).toBe(join(ws, 'app'));
  });

  it('separa stdout y stderr', () => {
    const ws = tmp();
    const result = run('echo fuera; echo dentro >&2', {
      JIN_WORKSPACE: ws,
      JIN_CWD_FILE: join(ws, '.cwd'),
    });
    expect(result.stdout).toBe('fuera\n');
    expect(result.stderr).toBe('dentro\n');
  });

  it('el comando es un dato: no puede romper el ejecutor ni inyectar en otros argumentos', () => {
    const ws = tmp();
    const env = { JIN_WORKSPACE: ws, JIN_CWD_FILE: join(ws, '.cwd') };
    const result = run('echo \'a b\' "$(echo c)"; echo $0', env);
    expect(result.stdout).toBe('a b c\njin\n');
  });

  it('si el directorio guardado ya no existe, vuelve a la raíz del espacio de trabajo', () => {
    const ws = tmp();
    const cwdFile = join(ws, '.cwd');
    writeFileSync(cwdFile, join(ws, 'borrado'));
    const result = run('pwd', { JIN_WORKSPACE: ws, JIN_CWD_FILE: cwdFile });
    expect(result.stdout.trim()).toBe(ws);
  });

  it('al vencer el timeout mata TODO el grupo (también los huérfanos) y sale con 137', () => {
    const ws = tmp();
    const marker = join(ws, 'huerfano-vivo');
    const started = Date.now();
    // El huérfano escribiría el marcador a los 4 s si sobreviviera al timeout de 1 s.
    const result = run(
      `(sleep 4; touch "${marker}") & sleep 30`,
      { JIN_WORKSPACE: ws, JIN_CWD_FILE: join(ws, '.cwd') },
      1,
    );
    expect(result.status).toBe(137);
    expect(Date.now() - started).toBeLessThan(3000);
    // Esperar más que lo que tardaría el huérfano.
    spawnSync('sleep', ['5']);
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  it('un proceso en segundo plano no deja colgado el comando: se mata al terminar', () => {
    const ws = tmp();
    const started = Date.now();
    const result = run('sleep 30 & echo listo', {
      JIN_WORKSPACE: ws,
      JIN_CWD_FILE: join(ws, '.cwd'),
    });
    expect(result.stdout).toBe('listo\n');
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('SERVICE_SCRIPT (servidores en segundo plano)', () => {
  function svc(args: string[], env: Record<string, string>, timeout = 30_000) {
    const result = spawnSync('node', ['-e', SERVICE_SCRIPT, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout,
    });
    return {
      code: result.status,
      json: JSON.parse(result.stdout || '{}') as {
        status?: string;
        code?: number;
        log?: string;
        stopped?: boolean;
        services?: unknown[];
      },
      stderr: result.stderr,
    };
  }

  function freePort(): number {
    return 30_000 + Math.floor(Math.random() * 20_000);
  }

  function sandbox() {
    const dir = tmp();
    return {
      dir,
      env: {
        JIN_SVC_DIR: join(dir, 'svc'),
        JIN_WORKSPACE: dir,
        JIN_CWD_FILE: join(dir, '.cwd'),
      },
    };
  }

  const server = (port: number) =>
    `node -e "require('http').createServer((q,r)=>r.end('hola desde '+process.cwd())).listen(${port},'0.0.0.0')"`;

  async function get(port: number): Promise<string | null> {
    try {
      return await (await fetch(`http://127.0.0.1:${port}/`)).text();
    } catch {
      return null;
    }
  }

  it('lanza un servidor que SOBREVIVE al ejecutor, lo lista, muestra su log y lo detiene', async () => {
    const { env } = sandbox();
    const port = freePort();

    const started = svc(['start', String(port), server(port)], env);
    expect(started.code).toBe(0);
    expect(started.json.status).toBe('listening');
    // El ejecutor ya terminó y el servidor sigue respondiendo.
    expect(await get(port)).toContain('hola desde');

    const listed = svc(['list', '0'], env);
    expect(listed.json.services).toEqual([
      expect.objectContaining({ port, running: true, listening: true }),
    ]);
    expect(svc(['logs', String(port)], env).json.log).toBeDefined();

    const stopped = svc(['stop', String(port)], env);
    expect(stopped.json.stopped).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await get(port)).toBeNull();
    expect(svc(['list', '0'], env).json.services).toEqual([]);
  }, 60_000);

  it('el servidor corre en el directorio guardado por `cd` (el del proyecto)', async () => {
    const { dir, env } = sandbox();
    mkdirSync(join(dir, 'app'));
    writeFileSync(env.JIN_CWD_FILE, join(dir, 'app'));
    const port = freePort();
    try {
      expect(svc(['start', String(port), server(port)], env).json.status).toBe(
        'listening',
      );
      expect(await get(port)).toBe(`hola desde ${join(dir, 'app')}`);
    } finally {
      svc(['stop', String(port)], env);
    }
  }, 60_000);

  it('un servidor que muere al arrancar devuelve exited con su log; uno ya corriendo no se duplica', () => {
    const { env } = sandbox();
    const failing = svc(
      [
        'start',
        String(freePort()),
        'echo "Error: no encuentro vite" >&2; exit 3',
      ],
      env,
    );
    expect(failing.json.status).toBe('exited');
    expect(failing.json.code).toBe(3);
    expect(failing.json.log).toContain('no encuentro vite');

    const port = freePort();
    try {
      expect(svc(['start', String(port), server(port)], env).json.status).toBe(
        'listening',
      );
      expect(svc(['start', String(port), server(port)], env).json.status).toBe(
        'already-running',
      );
    } finally {
      svc(['stop', String(port)], env);
    }
  }, 60_000);

  it('detener mata el grupo entero (un `npm run dev` que lanza hijos no deja huérfanos)', async () => {
    const { dir, env } = sandbox();
    const port = freePort();
    // sh -c "node server & wait": el servidor es nieto del sh.
    writeFileSync(
      join(dir, 'srv.js'),
      "require('http').createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT), '0.0.0.0');",
    );
    const command = `PORT=${port} sh -c 'node ${join(dir, 'srv.js')} & wait'`;
    expect(svc(['start', String(port), command], env).json.status).toBe(
      'listening',
    );
    expect(await get(port)).not.toBeNull();
    svc(['stop', String(port)], env);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await get(port)).toBeNull();
  }, 60_000);

  it('detener algo que no existe no falla', () => {
    const { env } = sandbox();
    expect(svc(['stop', '45678'], env).json.stopped).toBe(false);
  });
});

// ── FS_SCRIPT: explorador de archivos del pod ────────────────────────────

interface FsOk<T> {
  ok: true;
  data: T;
}
interface FsFail {
  ok: false;
  code: string;
  message: string;
  [extra: string]: unknown;
}
type FsResult<T = Record<string, unknown>> = FsOk<T> | FsFail;

function runFs<T = Record<string, unknown>>(
  workspace: string,
  op: string,
  target = '.',
  input?: object,
): FsResult<T> {
  let stdin: Buffer | undefined;
  if (input) {
    const body = JSON.stringify(input);
    stdin = Buffer.from(`${Buffer.byteLength(body)}\n${body}`);
  }
  const result = spawnSync('node', ['-e', FS_SCRIPT, op, target], {
    env: { ...process.env, JIN_WORKSPACE: workspace },
    ...(stdin ? { input: stdin } : {}),
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.toString()) as FsResult<T>;
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('FS_SCRIPT — list', () => {
  it('lista carpetas primero, luego archivos por nombre, con tipo y tamaño; node_modules aparece', () => {
    const root = tmp();
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'b.txt'), 'bb');
    writeFileSync(join(root, 'a.txt'), 'a');

    const result = runFs<{
      entries: { name: string; type: string; size: number }[];
      truncated: boolean;
    }>(root, 'list');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries.map((e) => `${e.type}:${e.name}`)).toEqual([
      'dir:node_modules',
      'dir:src',
      'file:a.txt',
      'file:b.txt',
    ]);
    expect(result.data.entries.find((e) => e.name === 'b.txt')?.size).toBe(2);
    expect(result.data.truncated).toBe(false);
  });

  it('un enlace simbólico se lista como link y no se sigue', () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'secreto.txt'), 'x');
    symlinkSync(outside, join(root, 'salida'));

    const listed = runFs<{ entries: { name: string; type: string }[] }>(
      root,
      'list',
    );
    expect(listed.ok && listed.data.entries).toEqual([
      expect.objectContaining({ name: 'salida', type: 'link' }),
    ]);

    const inside = runFs(root, 'list', 'salida');
    expect(inside).toMatchObject({ ok: false, code: 'outside' });
  });

  it('una subcarpeta y errores: no existe, y un archivo no es una carpeta', () => {
    const root = tmp();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'main.js'), 'x');
    writeFileSync(join(root, 'f.txt'), 'x');

    const sub = runFs<{ entries: { name: string }[] }>(root, 'list', 'src');
    expect(sub.ok && sub.data.entries.map((e) => e.name)).toEqual(['main.js']);
    expect(runFs(root, 'list', 'nada')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(runFs(root, 'list', 'f.txt')).toMatchObject({
      ok: false,
      code: 'not_file',
    });
  });
});

describe('FS_SCRIPT — read', () => {
  it('devuelve el contenido UTF-8, el tamaño y el sha256 de los bytes', () => {
    const root = tmp();
    writeFileSync(join(root, 'hola.txt'), 'Hola ñandú 🎉');

    const result = runFs<{ content: string; size: number; sha256: string }>(
      root,
      'read',
      'hola.txt',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.content).toBe('Hola ñandú 🎉');
    expect(result.data.size).toBe(Buffer.byteLength('Hola ñandú 🎉'));
    expect(result.data.sha256).toBe(sha('Hola ñandú 🎉'));
  });

  it('rechaza binarios, no-UTF-8, archivos grandes, carpetas y enlaces', () => {
    const root = tmp();
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    writeFileSync(join(root, 'latin1.txt'), Buffer.from([0xe9, 0xe9]));
    writeFileSync(join(root, 'grande.txt'), 'x'.repeat(512 * 1024 + 1));
    mkdirSync(join(root, 'carpeta'));
    writeFileSync(join(root, 'real.txt'), 'x');
    symlinkSync(join(root, 'real.txt'), join(root, 'enlace.txt'));

    expect(runFs(root, 'read', 'bin.dat')).toMatchObject({
      ok: false,
      code: 'not_text',
    });
    expect(runFs(root, 'read', 'latin1.txt')).toMatchObject({
      ok: false,
      code: 'not_text',
    });
    expect(runFs(root, 'read', 'grande.txt')).toMatchObject({
      ok: false,
      code: 'too_large',
      size: 512 * 1024 + 1,
    });
    expect(runFs(root, 'read', 'carpeta')).toMatchObject({
      ok: false,
      code: 'not_file',
    });
    expect(runFs(root, 'read', 'enlace.txt')).toMatchObject({
      ok: false,
      code: 'symlink',
    });
    expect(runFs(root, 'read', 'no-existe.txt')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('un archivo de exactamente 512 KB se lee', () => {
    const root = tmp();
    writeFileSync(join(root, 'justo.txt'), 'x'.repeat(512 * 1024));
    expect(runFs(root, 'read', 'justo.txt')).toMatchObject({ ok: true });
  });
});

describe('FS_SCRIPT — no se sale del espacio de trabajo', () => {
  it('rechaza .., rutas absolutas y caracteres raros en todas las operaciones', () => {
    const root = tmp();
    const parent = join(root, '..');
    writeFileSync(join(parent, 'fuera-fs-test.txt'), 'secreto');

    for (const target of [
      '../fuera-fs-test.txt',
      '/etc/passwd',
      'a/../../fuera-fs-test.txt',
      'a\\b',
    ]) {
      expect(runFs(root, 'read', target), `read ${target}`).toMatchObject({
        ok: false,
        code: 'outside',
      });
      expect(runFs(root, 'list', target), `list ${target}`).toMatchObject({
        ok: false,
        code: 'outside',
      });
      expect(
        runFs(root, 'write', target, { content: 'x', force: true }),
        `write ${target}`,
      ).toMatchObject({ ok: false, code: 'outside' });
      expect(runFs(root, 'mkdir', target), `mkdir ${target}`).toMatchObject({
        ok: false,
        code: 'outside',
      });
      expect(runFs(root, 'delete', target), `delete ${target}`).toMatchObject({
        ok: false,
        code: 'outside',
      });
    }
    expect(readFileSync(join(parent, 'fuera-fs-test.txt'), 'utf8')).toBe(
      'secreto',
    );
  });

  it('una carpeta que es enlace hacia afuera no permite leer, escribir, crear ni borrar a través de ella', () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'secreto.txt'), 'secreto');
    symlinkSync(outside, join(root, 'trampa'));

    expect(runFs(root, 'read', 'trampa/secreto.txt')).toMatchObject({
      ok: false,
      code: 'outside',
    });
    expect(
      runFs(root, 'write', 'trampa/nuevo.txt', { content: 'x', force: true }),
    ).toMatchObject({ ok: false, code: 'outside' });
    expect(
      runFs(root, 'write', 'trampa/otra/nuevo.txt', {
        content: 'x',
        force: true,
      }),
    ).toMatchObject({ ok: false, code: 'outside' });
    expect(runFs(root, 'mkdir', 'trampa/carpeta')).toMatchObject({
      ok: false,
      code: 'outside',
    });
    expect(runFs(root, 'delete', 'trampa/secreto.txt')).toMatchObject({
      ok: false,
      code: 'outside',
    });

    expect(existsSync(join(outside, 'nuevo.txt'))).toBe(false);
    expect(existsSync(join(outside, 'otra'))).toBe(false);
    expect(existsSync(join(outside, 'carpeta'))).toBe(false);
    expect(readFileSync(join(outside, 'secreto.txt'), 'utf8')).toBe('secreto');
  });

  it('un archivo que es enlace hacia afuera no se lee ni se escribe', () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'secreto.txt'), 'secreto');
    symlinkSync(join(outside, 'secreto.txt'), join(root, 'enlace.txt'));

    expect(runFs(root, 'read', 'enlace.txt')).toMatchObject({
      ok: false,
      code: 'outside',
    });
    expect(
      runFs(root, 'write', 'enlace.txt', { content: 'pisado', force: true }),
    ).toMatchObject({ ok: false, code: 'outside' });
    expect(readFileSync(join(outside, 'secreto.txt'), 'utf8')).toBe('secreto');
  });

  it('un operación desconocida se rechaza', () => {
    expect(runFs(tmp(), 'chmod', 'x')).toMatchObject({ ok: false });
  });
});

describe('FS_SCRIPT — write', () => {
  it('crea un archivo nuevo (y sus carpetas) y devuelve el sha256', () => {
    const root = tmp();
    const result = runFs<{ sha256: string; size: number }>(
      root,
      'write',
      'src/components/App.jsx',
      {
        content: 'export default 1;\n',
        force: false,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sha256).toBe(sha('export default 1;\n'));
    expect(readFileSync(join(root, 'src/components/App.jsx'), 'utf8')).toBe(
      'export default 1;\n',
    );
  });

  it('el contenido con caracteres de varios bytes llega intacto (el largo va en bytes)', () => {
    const root = tmp();
    const content = 'ñandú 🎉 你好'.repeat(200);
    runFs(root, 'write', 'utf8.txt', { content, force: false });
    expect(readFileSync(join(root, 'utf8.txt'), 'utf8')).toBe(content);
  });

  it('un archivo existente sin expectedSha256 ni force no se pisa', () => {
    const root = tmp();
    writeFileSync(join(root, 'a.txt'), 'original');
    expect(
      runFs(root, 'write', 'a.txt', { content: 'nuevo', force: false }),
    ).toMatchObject({ ok: false, code: 'exists' });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('original');
  });

  it('con expectedSha256 correcto guarda; con uno viejo da conflicto con el hash actual y no toca nada', () => {
    const root = tmp();
    writeFileSync(join(root, 'a.txt'), 'v1');

    const saved = runFs(root, 'write', 'a.txt', {
      content: 'v2',
      expectedSha256: sha('v1'),
      force: false,
    });
    expect(saved).toMatchObject({ ok: true });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v2');

    writeFileSync(join(root, 'a.txt'), 'v3-cambiado-en-el-pod');
    const conflict = runFs(root, 'write', 'a.txt', {
      content: 'v4',
      expectedSha256: sha('v2'),
      force: false,
    });
    expect(conflict).toMatchObject({
      ok: false,
      code: 'conflict',
      currentSha256: sha('v3-cambiado-en-el-pod'),
    });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe(
      'v3-cambiado-en-el-pod',
    );
  });

  it('force sobrescribe (el "sobrescribir" de la alerta de conflicto)', () => {
    const root = tmp();
    writeFileSync(join(root, 'a.txt'), 'original');
    expect(
      runFs(root, 'write', 'a.txt', { content: 'forzado', force: true }),
    ).toMatchObject({ ok: true });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('forzado');
  });

  it('es atómico: no deja archivos temporales y conserva el modo (ej. un script ejecutable)', () => {
    const root = tmp();
    writeFileSync(join(root, 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(root, 'run.sh'), 0o755);

    runFs(root, 'write', 'run.sh', {
      content: '#!/bin/sh\necho hola\n',
      force: true,
    });

    expect(readdirSync(root)).toEqual(['run.sh']);
    expect(lstatSync(join(root, 'run.sh')).mode & 0o777).toBe(0o755);
  });

  it('rechaza más de 512 KB sin escribir, y acepta exactamente 512 KB', () => {
    const root = tmp();
    expect(
      runFs(root, 'write', 'g.txt', {
        content: 'x'.repeat(512 * 1024 + 1),
        force: true,
      }),
    ).toMatchObject({ ok: false, code: 'too_large' });
    expect(existsSync(join(root, 'g.txt'))).toBe(false);
    expect(
      runFs(root, 'write', 'j.txt', {
        content: 'x'.repeat(512 * 1024),
        force: true,
      }),
    ).toMatchObject({ ok: true });
  });

  it('no escribe sobre una carpeta ni sobre la raíz', () => {
    const root = tmp();
    mkdirSync(join(root, 'carpeta'));
    expect(
      runFs(root, 'write', 'carpeta', { content: 'x', force: true }),
    ).toMatchObject({ ok: false, code: 'not_file' });
    expect(
      runFs(root, 'write', '.', { content: 'x', force: true }),
    ).toMatchObject({ ok: false, code: 'not_file' });
  });
});

describe('FS_SCRIPT — mkdir y delete', () => {
  it('mkdir crea carpetas anidadas y es idempotente; no pisa un archivo', () => {
    const root = tmp();
    expect(runFs(root, 'mkdir', 'a/b/c')).toMatchObject({ ok: true });
    expect(lstatSync(join(root, 'a/b/c')).isDirectory()).toBe(true);
    expect(runFs(root, 'mkdir', 'a/b/c')).toMatchObject({ ok: true });
    writeFileSync(join(root, 'f'), 'x');
    expect(runFs(root, 'mkdir', 'f')).toMatchObject({
      ok: false,
      code: 'exists',
    });
  });

  it('delete borra un archivo y una carpeta vacía, no una con contenido, no la raíz, no lo que no existe', () => {
    const root = tmp();
    writeFileSync(join(root, 'a.txt'), 'x');
    mkdirSync(join(root, 'vacia'));
    mkdirSync(join(root, 'llena'));
    writeFileSync(join(root, 'llena', 'x'), 'x');

    expect(runFs(root, 'delete', 'a.txt')).toMatchObject({ ok: true });
    expect(runFs(root, 'delete', 'vacia')).toMatchObject({ ok: true });
    expect(runFs(root, 'delete', 'llena')).toMatchObject({
      ok: false,
      code: 'not_empty',
    });
    expect(runFs(root, 'delete', '.')).toMatchObject({
      ok: false,
      code: 'outside',
    });
    expect(runFs(root, 'delete', 'nada')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(existsSync(join(root, 'a.txt'))).toBe(false);
    expect(existsSync(join(root, 'llena', 'x'))).toBe(true);
  });

  it('borrar un enlace simbólico borra el enlace, no lo que apunta', () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'importante.txt'), 'x');
    symlinkSync(join(outside, 'importante.txt'), join(root, 'enlace'));

    expect(runFs(root, 'delete', 'enlace')).toMatchObject({ ok: true });
    expect(existsSync(join(root, 'enlace'))).toBe(false);
    expect(readFileSync(join(outside, 'importante.txt'), 'utf8')).toBe('x');
  });
});
