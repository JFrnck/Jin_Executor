import { describe, expect, it } from 'vitest';
import {
  ExtendPreviewServiceRequestSchema,
  StartPreviewServiceRequestSchema,
} from './preview-service-request.schema';

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    tool: 'startPreviewService',
    files: { 'index.js': 'console.log("hola")' },
    command: ['node', 'index.js'],
    port: 3000,
    ttlSeconds: 3600,
    ...overrides,
  };
}

describe('StartPreviewServiceRequestSchema', () => {
  it('acepta un request válido con paths relativos normales', () => {
    const result = StartPreviewServiceRequestSchema.safeParse(
      validRequest({
        files: {
          'index.js': 'x',
          'src/nested/util.ts': 'x',
          'foo..bar.js': 'x',
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rechaza una clave de files absoluta o con ".." (zip-slip, docs/RECOMENDACIONES.md #10)', () => {
    for (const badPath of ['/etc/passwd', '../evil.js', 'a/../../b.js']) {
      const result = StartPreviewServiceRequestSchema.safeParse(
        validRequest({ files: { [badPath]: 'x' } }),
      );
      expect(result.success).toBe(false);
    }
  });

  it('rechaza si falta algún campo requerido', () => {
    const raw = validRequest() as Record<string, unknown>;
    delete raw.command;
    expect(StartPreviewServiceRequestSchema.safeParse(raw).success).toBe(false);
  });
});

describe('mailEgress y ExtendPreviewServiceRequestSchema', () => {
  it('mailEgress es opcional y debe ser booleano', () => {
    expect(
      StartPreviewServiceRequestSchema.safeParse(validRequest()).success,
    ).toBe(true);
    expect(
      StartPreviewServiceRequestSchema.safeParse(
        validRequest({ mailEgress: true }),
      ).success,
    ).toBe(true);
    expect(
      StartPreviewServiceRequestSchema.safeParse(
        validRequest({ mailEgress: 'si' }),
      ).success,
    ).toBe(false);
  });

  it('extend: segundos enteros positivos de hasta 7 días', () => {
    const ok = (extraSeconds: unknown) =>
      ExtendPreviewServiceRequestSchema.safeParse({ extraSeconds }).success;
    expect(ok(3600)).toBe(true);
    expect(ok(7 * 24 * 60 * 60)).toBe(true);
    expect(ok(7 * 24 * 60 * 60 + 1)).toBe(false);
    expect(ok(0)).toBe(false);
    expect(ok(-5)).toBe(false);
    expect(ok(1.5)).toBe(false);
    expect(ok('3600')).toBe(false);
  });
});

describe('db', () => {
  it('acepta solo los cuatro motores de demo; es opcional', () => {
    const ok = (db: unknown) =>
      StartPreviewServiceRequestSchema.safeParse(validRequest({ db })).success;
    for (const engine of ['sqlite', 'redis', 'postgres', 'mongodb']) {
      expect(ok(engine)).toBe(true);
    }
    expect(ok('mysql')).toBe(false);
    expect(ok('POSTGRES')).toBe(false);
    expect(ok({ engine: 'redis' })).toBe(false);
    expect(
      StartPreviewServiceRequestSchema.safeParse(validRequest()).success,
    ).toBe(true);
  });
});

describe('secrets', () => {
  it('lista de nombres válidos (minúsculas, números, guiones), hasta 5; es opcional', () => {
    const ok = (secrets: unknown) =>
      StartPreviewServiceRequestSchema.safeParse(validRequest({ secrets }))
        .success;
    expect(ok(['brevo'])).toBe(true);
    expect(ok(['a', 'b-2', 'c3', 'd', 'e'])).toBe(true);
    expect(ok(['a', 'b', 'c', 'd', 'e', 'f'])).toBe(false);
    for (const bad of [
      'Brevo',
      '../x',
      'a b',
      '',
      '-x',
      'a/b',
      'x'.repeat(40),
      5,
    ]) {
      expect(ok([bad])).toBe(false);
    }
    expect(ok('brevo')).toBe(false);
    expect(
      StartPreviewServiceRequestSchema.safeParse(validRequest()).success,
    ).toBe(true);
  });
});

describe('env (variables de la demo)', () => {
  // Construido en ejecución (nada con forma de credencial en el repo).
  const VALUE = `w${'5678901234'.repeat(3)}`;

  it('acepta variables válidas; es opcional', () => {
    const parse = (env: unknown) =>
      StartPreviewServiceRequestSchema.safeParse(validRequest({ env }));
    expect(parse({ BREVO_API_KEY: VALUE }).success).toBe(true);
    expect(parse({}).success).toBe(true);
    expect(
      StartPreviewServiceRequestSchema.safeParse(validRequest()).success,
    ).toBe(true);
    expect(parse({ BREVO_API_KEY: 5 }).success).toBe(false);
  });

  it('rechaza nombres reservados o inválidos, y el error NO repite el valor', () => {
    const result = StartPreviewServiceRequestSchema.safeParse(
      validRequest({ env: { PORT: VALUE, malo: VALUE } }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(VALUE);
    expect(JSON.stringify(result.error?.issues)).toContain('PORT');
  });
});
