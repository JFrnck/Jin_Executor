import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXPORT_FILES_SCRIPT,
  RUN_SCRIPT,
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
