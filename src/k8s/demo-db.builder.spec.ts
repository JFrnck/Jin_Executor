import { describe, expect, it } from 'vitest';
import {
  buildDemoDb,
  DEMO_DB_ENGINES,
  DEMO_DB_VOLUME,
  SQLITE_PATH,
} from './demo-db.builder';

// Construida en ejecución (nunca un literal con forma de credencial: GitGuardian).
const PASSWORD = Array.from({ length: 4 }, (_, i) =>
  `${i}a${i}b${i}c${i}d`.repeat(2),
).join('');
const ENGINES_WITH_SIDECAR = DEMO_DB_ENGINES.filter((e) => e !== 'sqlite');

const toMi = (value: string | undefined): number =>
  Number((value ?? '').replace('Mi', ''));

describe('buildDemoDb', () => {
  it('los cuatro motores que pidió el owner existen', () => {
    expect([...DEMO_DB_ENGINES]).toEqual([
      'sqlite',
      'redis',
      'postgres',
      'mongodb',
    ]);
  });

  it('sqlite: sin contenedor ni volumen; la app recibe la ruta del archivo en el espacio de trabajo', () => {
    const parts = buildDemoDb('sqlite', PASSWORD);
    expect(parts.sidecar).toBeUndefined();
    expect(parts.volumes).toEqual([]);
    expect(
      Object.fromEntries(parts.appEnv.map((e) => [e.name, e.value])),
    ).toEqual({
      DATABASE_URL: `file:${SQLITE_PATH}`,
      SQLITE_PATH,
    });
  });

  it.each(ENGINES_WITH_SIDECAR)(
    '%s: contenedor auxiliar nativo con imagen pinneada y la app espera a que responda (startupProbe)',
    (engine) => {
      const { sidecar } = buildDemoDb(engine, PASSWORD);
      expect(sidecar?.restartPolicy).toBe('Always'); // sidecar nativo
      expect(sidecar?.image).toMatch(/:[0-9]+[.0-9]*(-alpine)?$/); // tag fijo, nunca latest
      expect(sidecar?.image).not.toContain('latest');
      expect(sidecar?.startupProbe?.exec?.command?.length).toBeGreaterThan(0);
      expect(sidecar?.startupProbe?.failureThreshold).toBeGreaterThanOrEqual(
        30,
      );
    },
  );

  it.each(ENGINES_WITH_SIDECAR)(
    '%s: cumple PSA "restricted" y el LimitRange de agents-sandbox (≤1Gi/1000m por contenedor, limit ≤ 3× request)',
    (engine) => {
      const { sidecar } = buildDemoDb(engine, PASSWORD);
      expect(sidecar?.securityContext).toMatchObject({
        runAsNonRoot: true,
        allowPrivilegeEscalation: false,
        privileged: false,
        capabilities: { drop: ['ALL'] },
      });
      expect(sidecar?.securityContext?.runAsUser).toBeGreaterThan(0);

      const requests = sidecar?.resources?.requests;
      const limits = sidecar?.resources?.limits;
      expect(toMi(limits?.memory)).toBeLessThanOrEqual(1024);
      expect(toMi(limits?.memory)).toBeLessThanOrEqual(
        3 * toMi(requests?.memory),
      );
      expect(Number((limits?.cpu ?? '').replace('m', ''))).toBeLessThanOrEqual(
        1000,
      );
    },
  );

  it.each(ENGINES_WITH_SIDECAR)(
    '%s: solo escucha en 127.0.0.1, con volumen de datos acotado y sin ningún puerto hacia fuera del pod',
    (engine) => {
      const { sidecar, volumes } = buildDemoDb(engine, PASSWORD);
      const invocation = JSON.stringify([sidecar?.command, sidecar?.args]);
      expect(invocation).toContain('127.0.0.1');
      expect(volumes).toHaveLength(1);
      expect(volumes[0]?.name).toBe(DEMO_DB_VOLUME);
      expect(volumes[0]?.emptyDir?.sizeLimit).toBe('512Mi');
      expect(sidecar?.volumeMounts?.[0]?.name).toBe(DEMO_DB_VOLUME);
    },
  );

  it('redis: URL con la contraseña y protegido con requirepass', () => {
    const { sidecar, appEnv } = buildDemoDb('redis', PASSWORD);
    expect(appEnv).toEqual([
      { name: 'REDIS_URL', value: `redis://:${PASSWORD}@127.0.0.1:6379` },
    ]);
    const script = sidecar?.args?.[0] ?? '';
    expect(script).toContain('--requirepass');
    // Sin persistencia: los datos de una demo no se escriben a disco.
    expect(script).toContain('--save ""');
    expect(script).toContain('--appendonly no');
  });

  it('postgres: DATABASE_URL, usuario y base "demo", corre como el uid 70 de la imagen alpine', () => {
    const { sidecar, appEnv } = buildDemoDb('postgres', PASSWORD);
    expect(appEnv).toEqual([
      {
        name: 'DATABASE_URL',
        value: `postgres://demo:${PASSWORD}@127.0.0.1:5432/demo`,
      },
    ]);
    expect(sidecar?.securityContext?.runAsUser).toBe(70);
    const env = Object.fromEntries(
      (sidecar?.env ?? []).map((e) => [e.name, e.value]),
    );
    expect(env.POSTGRES_PASSWORD).toBe(PASSWORD);
    expect(env.POSTGRES_DB).toBe('demo');
    // TCP debe exigir contraseña (la imagen confía en 127.0.0.1 si no se le dice).
    expect(env.POSTGRES_INITDB_ARGS).toContain('--auth-host=scram-sha-256');
  });

  it('mongodb: MONGODB_URI con authSource=admin y sondeo CON credenciales (no pasa durante el arranque temporal)', () => {
    const { sidecar, appEnv } = buildDemoDb('mongodb', PASSWORD);
    expect(appEnv).toEqual([
      {
        name: 'MONGODB_URI',
        value: `mongodb://demo:${PASSWORD}@127.0.0.1:27017/demo?authSource=admin`,
      },
    ]);
    expect(JSON.stringify(sidecar?.startupProbe?.exec?.command)).toContain(
      '--authenticationDatabase',
    );
    expect(sidecar?.securityContext?.runAsUser).toBe(999);
  });

  it('la contraseña se interpola en una URL: solo hexadecimal (rechaza caracteres que la romperían o inyectarían)', () => {
    for (const bad of [
      '',
      'corta',
      'a@b:c/d?e',
      'x'.repeat(32),
      'ABCDEF0123456789abcdef0123456789',
    ]) {
      expect(() => buildDemoDb('redis', bad)).toThrow(/hexadecimal/);
    }
    // sqlite no usa contraseña: no la valida.
    expect(() => buildDemoDb('sqlite', '')).not.toThrow();
  });
});
