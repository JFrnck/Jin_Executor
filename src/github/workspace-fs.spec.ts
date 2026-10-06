import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReplaceScript, workspacePath } from './workspace-fs';

describe('buildReplaceScript (el script que corre dentro del pod, probado con sh real)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    const root = mkdtempSync(path.join(tmpdir(), 'ws-'));
    roots.push(root);
    const src = mkdtempSync(path.join(tmpdir(), 'src-'));
    roots.push(src);
    return { root, src };
  }
  const tarOf = (dir: string): Buffer =>
    execFileSync('tar', ['-cf', '-', '-C', dir, '.']);
  const replace = (root: string, dir: string, tar: Buffer): void => {
    execFileSync('sh', ['-c', buildReplaceScript(root), 'sh', dir], {
      input: tar,
    });
  };

  it('reemplaza lo viejo por lo nuevo (con archivos que tienen espacios) y conserva node_modules y las carpetas del entorno', () => {
    const { root, src } = setup();
    mkdirSync(path.join(root, 'node_modules/x'), { recursive: true });
    mkdirSync(path.join(root, '.home'));
    mkdirSync(path.join(root, '.jin'));
    writeFileSync(path.join(root, 'viejo.txt'), 'viejo');
    writeFileSync(path.join(root, 'otro viejo.txt'), 'viejo');
    writeFileSync(path.join(src, 'nuevo archivo.txt'), 'nuevo');
    mkdirSync(path.join(src, 'sub'));
    writeFileSync(path.join(src, 'sub/.oculto'), 'oculto');

    replace(root, root, tarOf(src));

    expect(readFileSync(path.join(root, 'nuevo archivo.txt'), 'utf8')).toBe(
      'nuevo',
    );
    expect(readFileSync(path.join(root, 'sub/.oculto'), 'utf8')).toBe('oculto');
    expect(existsSync(path.join(root, 'viejo.txt'))).toBe(false);
    expect(existsSync(path.join(root, 'otro viejo.txt'))).toBe(false);
    for (const kept of ['node_modules/x', '.home', '.jin'])
      expect(existsSync(path.join(root, kept))).toBe(true);
    expect(existsSync(path.join(root, '.jin-tmp-')) || readdirTmp(root)).toBe(
      false,
    );
  });

  it('crea la carpeta destino si no existe y si el tar es inválido NO borra lo anterior', () => {
    const { root, src } = setup();
    writeFileSync(path.join(src, 'a.txt'), 'a');
    replace(root, path.join(root, 'proyectos/app'), tarOf(src));
    expect(readFileSync(path.join(root, 'proyectos/app/a.txt'), 'utf8')).toBe(
      'a',
    );

    expect(() =>
      replace(
        root,
        path.join(root, 'proyectos/app'),
        Buffer.from('esto no es un tar'),
      ),
    ).toThrow();
    expect(readFileSync(path.join(root, 'proyectos/app/a.txt'), 'utf8')).toBe(
      'a',
    );
  });
});

function readdirTmp(root: string): boolean {
  return execFileSync('ls', ['-A', root], { encoding: 'utf8' })
    .split('\n')
    .some((name) => name.startsWith('.jin-tmp-'));
}

describe('workspacePath', () => {
  it('acepta la raíz y subcarpetas; rechaza rutas que se escapan', () => {
    expect(workspacePath('.')).toBe('/workspace');
    expect(workspacePath('proyectos/app')).toBe('/workspace/proyectos/app');
    for (const bad of ['../x', '/etc', 'a/../b', 'a//b', 'a\\b'])
      expect(() => workspacePath(bad)).toThrow();
  });
});
