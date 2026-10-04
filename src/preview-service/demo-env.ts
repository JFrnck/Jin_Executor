/**
 * Variables de entorno de UNA demo (2026-10-04, ADR 0020). Las escribe el owner desde la app;
 * el Executor las guarda en un Secret `demo-env-<serviceId>` ligado al pod (se borra con él).
 * Este archivo solo VALIDA: ningún mensaje de aquí devuelve un valor, solo nombre y motivo.
 */
export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_ENV_VARS = 30;
export const MAX_ENV_VALUE_BYTES = 8 * 1024;
export const MAX_ENV_TOTAL_BYTES = 64 * 1024;

/** Nombres que Jin o el sistema ya fijan: una demo no puede pisarlos. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'PORT',
  'PATH',
  'HOME',
  'HOSTNAME',
  'USER',
  'SHELL',
  'TZ',
  'CI',
  'PNPM_HOME',
  'XDG_CACHE_HOME',
  // Las que Jin inyecta según `db`.
  'DATABASE_URL',
  'REDIS_URL',
  'MONGODB_URI',
  'SQLITE_PATH',
  // Proxies: cambiarlos podría saltarse las salidas controladas del pod.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
]);
const RESERVED_PREFIXES = [
  'NODE_',
  'LD_',
  'NPM_CONFIG_',
  'KUBERNETES_',
] as const;

export interface EnvProblem {
  /** Nombre de la variable (nunca su valor). */
  readonly name: string;
  readonly reason: string;
}

export function isReservedEnvName(name: string): boolean {
  return (
    RESERVED_NAMES.has(name) ||
    RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** Problemas de un mapa de variables; vacío = válido. Sin valores en los mensajes. */
export function validateDemoEnv(
  env: Readonly<Record<string, string>>,
): EnvProblem[] {
  const problems: EnvProblem[] = [];
  const names = Object.keys(env);
  if (names.length > MAX_ENV_VARS) {
    problems.push({
      name: '(todas)',
      reason: `máximo ${MAX_ENV_VARS} variables`,
    });
  }
  let total = 0;
  for (const name of names) {
    const value = env[name] ?? '';
    if (!ENV_NAME_PATTERN.test(name)) {
      problems.push({
        name: name.slice(0, 64),
        reason: 'nombre inválido (MAYÚSCULAS, números y _; empieza con letra)',
      });
      continue;
    }
    if (isReservedEnvName(name)) {
      problems.push({ name, reason: 'nombre reservado por Jin' });
    }
    const bytes = Buffer.byteLength(value);
    total += bytes;
    if (bytes > MAX_ENV_VALUE_BYTES) {
      problems.push({
        name,
        reason: `el valor supera ${MAX_ENV_VALUE_BYTES / 1024} KB`,
      });
    }
  }
  if (total > MAX_ENV_TOTAL_BYTES) {
    problems.push({
      name: '(todas)',
      reason: `el total supera ${MAX_ENV_TOTAL_BYTES / 1024} KB`,
    });
  }
  return problems;
}
