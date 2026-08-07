import { describe, expect, it } from 'vitest';
import { StartPreviewServiceRequestSchema } from './preview-service-request.schema';

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
