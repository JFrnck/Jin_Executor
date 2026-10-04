import { describe, expect, it } from 'vitest';
import {
  isReservedEnvName,
  MAX_ENV_TOTAL_BYTES,
  MAX_ENV_VALUE_BYTES,
  MAX_ENV_VARS,
  validateDemoEnv,
} from './demo-env';

// Construido en ejecución (nada con forma de credencial en el repo).
const SECRET_LOOKING = `s${'9876543210'.repeat(3)}`;

describe('validateDemoEnv', () => {
  it('acepta un mapa normal', () => {
    expect(
      validateDemoEnv({
        BREVO_API_KEY: SECRET_LOOKING,
        BREVO_SENDER_NAME: 'evento',
        X1_Y: '',
      }),
    ).toEqual([]);
  });

  it('rechaza nombres inválidos (minúsculas, empiezan con número, símbolos, vacío, muy largo)', () => {
    for (const name of [
      'brevo',
      '1KEY',
      'A-B',
      'A B',
      '',
      'A'.repeat(65),
      'ñ',
    ]) {
      expect(validateDemoEnv({ [name]: 'v' }).length).toBeGreaterThan(0);
    }
    expect(validateDemoEnv({ ['A'.repeat(64)]: 'v' })).toEqual([]);
  });

  it('rechaza nombres reservados (los fija Jin o el sistema) y prefijos peligrosos', () => {
    for (const name of [
      'PORT',
      'PATH',
      'HOME',
      'DATABASE_URL',
      'REDIS_URL',
      'MONGODB_URI',
      'SQLITE_PATH',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'NODE_OPTIONS',
      'NODE_ENV',
      'LD_PRELOAD',
      'NPM_CONFIG_REGISTRY',
      'KUBERNETES_SERVICE_HOST',
    ]) {
      expect(isReservedEnvName(name)).toBe(true);
      expect(validateDemoEnv({ [name]: 'v' })).toEqual([
        { name, reason: 'nombre reservado por Jin' },
      ]);
    }
    expect(isReservedEnvName('BREVO_API_KEY')).toBe(false);
    expect(isReservedEnvName('MY_NODE_VERSION')).toBe(false);
  });

  it('respeta los topes: 30 variables, 8 KB por valor, 64 KB en total', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_ENV_VARS + 1 }, (_, i) => [`V${i}`, 'x']),
    );
    expect(validateDemoEnv(many).some((p) => p.reason.includes('máximo'))).toBe(
      true,
    );
    expect(
      validateDemoEnv({ BIG: 'x'.repeat(MAX_ENV_VALUE_BYTES + 1) }).some(
        (p) => p.name === 'BIG',
      ),
    ).toBe(true);
    const total = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `T${i}`,
        'x'.repeat(MAX_ENV_VALUE_BYTES),
      ]),
    );
    expect(MAX_ENV_TOTAL_BYTES).toBe(65536);
    expect(validateDemoEnv(total).some((p) => p.reason.includes('total'))).toBe(
      true,
    );
  });

  it('NINGÚN mensaje de error contiene un valor', () => {
    const problems = validateDemoEnv({
      port: SECRET_LOOKING,
      PORT: SECRET_LOOKING,
      NODE_OPTIONS: SECRET_LOOKING,
      BIG: SECRET_LOOKING.repeat(2000),
    });
    expect(problems.length).toBeGreaterThan(0);
    const text = JSON.stringify(problems);
    expect(text).not.toContain(SECRET_LOOKING);
  });
});
