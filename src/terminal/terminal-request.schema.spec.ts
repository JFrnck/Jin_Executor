import { describe, expect, it } from 'vitest';
import {
  ExecTerminalRequestSchema,
  ExportTerminalQuerySchema,
  ExposeTerminalRequestSchema,
  ImportTerminalRequestSchema,
  StartServiceRequestSchema,
  parsePort,
  StartTerminalRequestSchema,
} from './terminal-request.schema';

describe('StartTerminalRequestSchema', () => {
  it('sin archivos es válido (sesión vacía) y rechaza rutas inseguras', () => {
    expect(
      StartTerminalRequestSchema.safeParse({ ttlSeconds: 3600 }).success,
    ).toBe(true);
    for (const path of ['../x', '/etc/passwd', 'a/../../b']) {
      expect(
        StartTerminalRequestSchema.safeParse({
          ttlSeconds: 60,
          files: { [path]: 'x' },
        }).success,
      ).toBe(false);
    }
  });

  it('acota archivos (50) y tamaño (256 KB)', () => {
    const many = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`f${i}`, 'x']),
    );
    expect(
      StartTerminalRequestSchema.safeParse({ ttlSeconds: 60, files: many })
        .success,
    ).toBe(false);
    expect(
      StartTerminalRequestSchema.safeParse({
        ttlSeconds: 60,
        files: { 'a.txt': 'x'.repeat(256 * 1024) },
      }).success,
    ).toBe(false);
  });
});

describe('ExecTerminalRequestSchema', () => {
  it('pone 120 s por defecto y topa en 600 s y 4096 caracteres', () => {
    expect(
      ExecTerminalRequestSchema.parse({ command: 'ls' }).timeoutSeconds,
    ).toBe(120);
    expect(
      ExecTerminalRequestSchema.safeParse({
        command: 'ls',
        timeoutSeconds: 601,
      }).success,
    ).toBe(false);
    expect(
      ExecTerminalRequestSchema.safeParse({ command: 'x'.repeat(4097) })
        .success,
    ).toBe(false);
    expect(ExecTerminalRequestSchema.safeParse({ command: '' }).success).toBe(
      false,
    );
  });
});

describe('export / import / expose', () => {
  it('export: "." o una ruta segura', () => {
    expect(ExportTerminalQuerySchema.parse({}).dir).toBe('.');
    expect(ExportTerminalQuerySchema.safeParse({ dir: '../etc' }).success).toBe(
      false,
    );
  });

  it('import exige archivos con rutas seguras', () => {
    expect(
      ImportTerminalRequestSchema.safeParse({ files: { 'a/b.js': 'x' } })
        .success,
    ).toBe(true);
    expect(
      ImportTerminalRequestSchema.safeParse({ files: { '/abs': 'x' } }).success,
    ).toBe(false);
  });

  it('expose: dist por defecto, puerto 8080, y el servidor es obligatorio', () => {
    const parsed = ExposeTerminalRequestSchema.parse({ serverSource: 'x' });
    expect(parsed.dir).toBe('dist');
    expect(parsed.port).toBe(8080);
    expect(ExposeTerminalRequestSchema.safeParse({}).success).toBe(false);
    expect(
      ExposeTerminalRequestSchema.safeParse({ serverSource: 'x', dir: '../..' })
        .success,
    ).toBe(false);
  });
});

describe('servidores y puertos', () => {
  it('el puerto es de usuario (1024–65535) y el comando entre 1 y 4096 caracteres', () => {
    expect(
      StartServiceRequestSchema.safeParse({
        command: 'npm run dev',
        port: 5173,
      }).success,
    ).toBe(true);
    for (const port of [80, 1023, 65536, 1.5, -1]) {
      expect(
        StartServiceRequestSchema.safeParse({ command: 'x', port }).success,
      ).toBe(false);
    }
    expect(
      StartServiceRequestSchema.safeParse({ command: '', port: 5173 }).success,
    ).toBe(false);
    expect(
      StartServiceRequestSchema.safeParse({
        command: 'x'.repeat(4097),
        port: 5173,
      }).success,
    ).toBe(false);
  });

  it('parsePort solo acepta dígitos dentro del rango', () => {
    expect(parsePort('5173')).toBe(5173);
    for (const bad of [
      '80',
      '1023',
      '65536',
      '5173abc',
      '5e3',
      '-1',
      '',
      ' 5173',
      '0x1400',
    ]) {
      expect(parsePort(bad)).toBeNull();
    }
  });
});
