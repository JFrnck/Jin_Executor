import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTarGzBase64, isSafeRelativePath } from './tar-payload';

/**
 * Verifica el USTAR armado a mano extrayéndolo con el binario `tar` real
 * del sistema (no un parser JS propio, que solo probaría contra sí
 * mismo) — la misma garantía que necesita el init container real dentro
 * del pod (Fase 5.5).
 */
function extractWithSystemTar(base64: string): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'tar-payload-test-'));
  try {
    const tarGzPath = join(dir, 'payload.tar.gz');
    writeFileSync(tarGzPath, Buffer.from(base64, 'base64'));
    execFileSync('tar', ['xzf', tarGzPath, '-C', dir]);

    const result: Record<string, string> = {};
    for (const name of [
      'a.txt',
      'src/nested/b.ts',
      'package.json',
      'foo..bar.js',
    ]) {
      try {
        result[name] = readFileSync(join(dir, name), 'utf-8');
      } catch {
        // No existe en este fixture particular — el caller decide si importa.
      }
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('buildTarGzBase64', () => {
  it('round-trip con el tar real del sistema: un archivo simple', () => {
    const base64 = buildTarGzBase64({ 'a.txt': 'hola mundo' });
    const extracted = extractWithSystemTar(base64);
    expect(extracted['a.txt']).toBe('hola mundo');
  });

  it('round-trip: múltiples archivos con subdirectorios', () => {
    const files = {
      'package.json': '{"name":"demo"}',
      'src/nested/b.ts': 'export const x = 1;',
    };
    const base64 = buildTarGzBase64(files);
    const extracted = extractWithSystemTar(base64);
    expect(extracted['package.json']).toBe(files['package.json']);
    expect(extracted['src/nested/b.ts']).toBe(files['src/nested/b.ts']);
  });

  it('round-trip: contenido con caracteres UTF-8 y tamaño no múltiplo de 512', () => {
    const content = 'á é í ó ú ñ — '.repeat(50);
    const base64 = buildTarGzBase64({ 'a.txt': content });
    const extracted = extractWithSystemTar(base64);
    expect(extracted['a.txt']).toBe(content);
  });

  it('objeto vacío produce un tar.gz válido (solo el trailer)', () => {
    const base64 = buildTarGzBase64({});
    expect(() => extractWithSystemTar(base64)).not.toThrow();
  });

  it('lanza si una ruta excede el límite de 99 bytes (sin soporte de prefix largo)', () => {
    const longPath = `${'a'.repeat(100)}.txt`;
    expect(() => buildTarGzBase64({ [longPath]: 'x' })).toThrow(/excede/);
  });

  it('lanza si una clave de files intenta escapar de /workspace (zip-slip, docs/RECOMENDACIONES.md #10)', () => {
    expect(() => buildTarGzBase64({ '../evil.js': 'x' })).toThrow(/insegura/);
    expect(() => buildTarGzBase64({ '/etc/passwd': 'x' })).toThrow(/insegura/);
    expect(() => buildTarGzBase64({ 'sub/../../escape.js': 'x' })).toThrow(
      /insegura/,
    );
  });

  it('no lanza con una ruta que solo CONTIENE ".." como substring, no como segmento', () => {
    const base64 = buildTarGzBase64({ 'foo..bar.js': 'contenido válido' });
    const extracted = extractWithSystemTar(base64);
    expect(extracted['foo..bar.js']).toBe('contenido válido');
  });
});

describe('isSafeRelativePath', () => {
  it('rechaza rutas absolutas', () => {
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
  });

  it('rechaza cualquier segmento ".." en la ruta', () => {
    expect(isSafeRelativePath('../evil.js')).toBe(false);
    expect(isSafeRelativePath('a/../../b.js')).toBe(false);
    expect(isSafeRelativePath('a/b/..')).toBe(false);
  });

  it('acepta rutas relativas normales, incluidas las que contienen ".." como parte de un nombre', () => {
    expect(isSafeRelativePath('src/index.ts')).toBe(true);
    expect(isSafeRelativePath('foo..bar.js')).toBe(true);
    expect(isSafeRelativePath('a.b..c/d.ts')).toBe(true);
  });
});
