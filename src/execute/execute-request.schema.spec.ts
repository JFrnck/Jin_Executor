import { describe, expect, it } from 'vitest';
import { ExecuteRequestSchema } from './execute-request.schema';

describe('ExecuteRequestSchema', () => {
  it('acepta un request válido mínimo', () => {
    const result = ExecuteRequestSchema.safeParse({
      tool: 'runCode',
      code: 'console.log(1)',
      language: 'typescript',
      timeout: 30,
    });
    expect(result.success).toBe(true);
  });

  it('rellena env con {} por defecto', () => {
    const result = ExecuteRequestSchema.parse({
      tool: 'runCode',
      code: 'x',
      language: 'typescript',
      timeout: 30,
    });
    expect(result.env).toEqual({});
  });

  it.each([
    [
      'tool vacío',
      { tool: '', code: 'x', language: 'typescript', timeout: 30 },
    ],
    [
      'code vacío',
      { tool: 'runCode', code: '', language: 'typescript', timeout: 30 },
    ],
    ['language ausente', { tool: 'runCode', code: 'x', timeout: 30 }],
    [
      'language fuera del enum',
      { tool: 'runCode', code: 'x', language: 'ruby', timeout: 30 },
    ],
    [
      'timeout negativo',
      { tool: 'runCode', code: 'x', language: 'typescript', timeout: -1 },
    ],
    [
      'timeout cero',
      { tool: 'runCode', code: 'x', language: 'typescript', timeout: 0 },
    ],
    [
      'timeout no entero',
      { tool: 'runCode', code: 'x', language: 'typescript', timeout: 1.5 },
    ],
    [
      'timeout excesivo',
      { tool: 'runCode', code: 'x', language: 'typescript', timeout: 999_999 },
    ],
    [
      'env con valores no-string',
      {
        tool: 'runCode',
        code: 'x',
        language: 'typescript',
        timeout: 30,
        env: { X: 1 },
      },
    ],
  ])('rechaza: %s', (_label, input) => {
    expect(ExecuteRequestSchema.safeParse(input).success).toBe(false);
  });
});
