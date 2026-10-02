import type { V1Container, V1EnvVar, V1Volume } from '@kubernetes/client-node';

/**
 * Bases de datos de DEMO para los pods de servicio (2026-10-02). Son datos de
 * prueba para mostrar un frontend a un cliente, NO una base de producción:
 * - `sqlite`: sin contenedor; la app usa un archivo en `/workspace/data`.
 * - `redis` / `postgres` / `mongodb`: un contenedor AUXILIAR dentro del mismo pod
 *   (sidecar nativo de K8s ≥ 1.29: arranca antes que la app y la app espera a que
 *   su `startupProbe` pase). Solo escucha en 127.0.0.1 del pod, con una contraseña
 *   aleatoria por demo, y sus datos van en un `emptyDir`: viven lo que viva el pod.
 */
export const DEMO_DB_ENGINES = [
  'sqlite',
  'redis',
  'postgres',
  'mongodb',
] as const;
export type DemoDbEngine = (typeof DEMO_DB_ENGINES)[number];

export const DEMO_DB_CONTAINER_NAME = 'demo-db';
export const DEMO_DB_VOLUME = 'demo-db-data';
/** Tope del disco de la base (emptyDir): una demo no debe llenar el nodo. */
const DATA_SIZE_LIMIT = '512Mi';
const DB_NAME = 'demo';
const DB_USER = 'demo';
export const SQLITE_PATH = '/workspace/data/app.db';

interface EngineSpec {
  readonly image: string;
  /** uid con el que corre el proceso (los de las imágenes oficiales). */
  readonly runAsUser: number;
  readonly port: number;
  readonly dataPath: string;
  readonly env: (password: string) => V1EnvVar[];
  readonly command?: readonly string[];
  readonly args?: readonly string[];
  readonly probe: readonly string[];
  readonly resources: {
    readonly requests: { cpu: string; memory: string };
    readonly limits: { cpu: string; memory: string };
  };
  /** Variables que recibe la APP para conectarse (siempre 127.0.0.1). */
  readonly appEnv: (password: string) => V1EnvVar[];
}

// Imágenes pinneadas (nunca `latest`), multi-arch con ARM64 (la VM es Ampere).
// requests.memory ≥ limits.memory / 3: lo exige el LimitRange de agents-sandbox.
const ENGINES: Record<Exclude<DemoDbEngine, 'sqlite'>, EngineSpec> = {
  redis: {
    image: 'docker.io/library/redis:7.4-alpine',
    runAsUser: 999,
    port: 6379,
    dataPath: '/data',
    env: (password) => [{ name: 'REDIS_PASSWORD', value: password }],
    // Sin persistencia (`--save ""`, sin AOF): los datos de una demo no se guardan en disco.
    command: ['sh', '-c'],
    args: [
      'exec redis-server --bind 127.0.0.1 --port 6379 --requirepass "$REDIS_PASSWORD" --save "" --appendonly no --dir /data --maxmemory 96mb --maxmemory-policy allkeys-lru',
    ],
    probe: [
      'sh',
      '-c',
      'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -h 127.0.0.1 ping | grep -q PONG',
    ],
    resources: {
      requests: { cpu: '25m', memory: '64Mi' },
      limits: { cpu: '200m', memory: '192Mi' },
    },
    appEnv: (password) => [
      { name: 'REDIS_URL', value: `redis://:${password}@127.0.0.1:6379` },
    ],
  },
  postgres: {
    image: 'docker.io/library/postgres:16.4-alpine',
    runAsUser: 70, // `postgres` en la imagen alpine: initdb exige un uid con entrada en passwd
    port: 5432,
    dataPath: '/var/lib/postgresql/data',
    env: (password) => [
      { name: 'POSTGRES_USER', value: DB_USER },
      { name: 'POSTGRES_PASSWORD', value: password },
      { name: 'POSTGRES_DB', value: DB_NAME },
      { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
      // La imagen oficial CONFÍA en 127.0.0.1 por defecto (la contraseña no se exigía:
      // verificado en un K3s real). TCP exige scram; el socket local sigue en trust,
      // que es lo que usa el entrypoint para crear el usuario y no sale del pod.
      {
        name: 'POSTGRES_INITDB_ARGS',
        value: '--auth-host=scram-sha-256 --auth-local=trust',
      },
    ],
    args: [
      'postgres',
      '-c',
      'listen_addresses=127.0.0.1',
      '-c',
      'shared_buffers=48MB',
      '-c',
      'max_connections=30',
      '-c',
      'fsync=off', // datos de demo: más rápido, sin durabilidad
    ],
    probe: ['sh', '-c', `pg_isready -h 127.0.0.1 -U ${DB_USER} -d ${DB_NAME}`],
    resources: {
      requests: { cpu: '50m', memory: '192Mi' },
      limits: { cpu: '500m', memory: '512Mi' },
    },
    appEnv: (password) => [
      {
        name: 'DATABASE_URL',
        value: `postgres://${DB_USER}:${password}@127.0.0.1:5432/${DB_NAME}`,
      },
    ],
  },
  mongodb: {
    image: 'docker.io/library/mongo:7.0',
    runAsUser: 999,
    port: 27017,
    dataPath: '/data/db',
    env: (password) => [
      { name: 'MONGO_INITDB_ROOT_USERNAME', value: DB_USER },
      { name: 'MONGO_INITDB_ROOT_PASSWORD', value: password },
      { name: 'MONGO_INITDB_DATABASE', value: DB_NAME },
    ],
    // La imagen activa `--auth` sola al crear el usuario raíz (MONGO_INITDB_*).
    args: [
      'mongod',
      '--bind_ip',
      '127.0.0.1',
      '--wiredTigerCacheSizeGB',
      '0.25',
    ],
    // Listo SOLO cuando corre el servidor DEFINITIVO. La imagen arranca primero un mongod
    // temporal (crea el usuario raíz) y luego lo reinicia con `--auth`; un sondeo que pasara
    // en esa fase dejaba arrancar a la app y, unos segundos después, la base rechazaba la
    // conexión (visto en producción 2026-10-02). Solo el definitivo lleva el argumento
    // `--auth`: se busca en las líneas de comando de los procesos (la imagen no trae pgrep).
    // El patrón `--aut[h]` no se reconoce a sí mismo: el propio grep también aparece en /proc.
    probe: [
      'sh',
      '-c',
      `cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' '\\n' | grep -qx -e '--aut[h]' && mongosh --quiet --host 127.0.0.1 -u ${DB_USER} -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval 'db.adminCommand("ping").ok'`,
    ],
    resources: {
      requests: { cpu: '75m', memory: '256Mi' },
      limits: { cpu: '500m', memory: '768Mi' },
    },
    appEnv: (password) => [
      {
        name: 'MONGODB_URI',
        value: `mongodb://${DB_USER}:${password}@127.0.0.1:27017/${DB_NAME}?authSource=admin`,
      },
    ],
  },
};

export interface DemoDbParts {
  /** Contenedor auxiliar nativo (va en `initContainers` con `restartPolicy: Always`); ausente con sqlite. */
  readonly sidecar?: V1Container;
  readonly volumes: V1Volume[];
  /** Variables para el contenedor de la app. */
  readonly appEnv: V1EnvVar[];
}

/** Contraseña aleatoria de una demo: hex, sin caracteres que haya que escapar en una URL. */
export function isUrlSafePassword(password: string): boolean {
  return /^[a-f0-9]{16,}$/.test(password);
}

export function buildDemoDb(
  engine: DemoDbEngine,
  password: string,
): DemoDbParts {
  if (engine === 'sqlite') {
    // Sin contenedor: un archivo en el espacio de trabajo (el servidor crea `data/`).
    return {
      volumes: [],
      appEnv: [
        { name: 'DATABASE_URL', value: `file:${SQLITE_PATH}` },
        { name: 'SQLITE_PATH', value: SQLITE_PATH },
      ],
    };
  }
  if (!isUrlSafePassword(password)) {
    // Defensa: la contraseña se interpola en una URL de conexión.
    throw new Error(
      'La contraseña de la base de datos de demo debe ser hexadecimal.',
    );
  }

  const spec = ENGINES[engine];
  const sidecar: V1Container = {
    name: DEMO_DB_CONTAINER_NAME,
    image: spec.image,
    // Sidecar nativo: arranca antes que la app y sigue corriendo con el pod.
    restartPolicy: 'Always',
    ...(spec.command ? { command: [...spec.command] } : {}),
    ...(spec.args ? { args: [...spec.args] } : {}),
    env: spec.env(password),
    ports: [{ containerPort: spec.port, name: 'demo-db' }],
    // La app NO arranca hasta que la base responde.
    startupProbe: {
      exec: { command: [...spec.probe] },
      periodSeconds: 2,
      failureThreshold: 60,
      timeoutSeconds: 5,
    },
    volumeMounts: [{ name: DEMO_DB_VOLUME, mountPath: spec.dataPath }],
    securityContext: {
      runAsNonRoot: true,
      runAsUser: spec.runAsUser,
      runAsGroup: spec.runAsUser,
      allowPrivilegeEscalation: false,
      privileged: false,
      capabilities: { drop: ['ALL'] },
    },
    resources: {
      requests: { ...spec.resources.requests },
      limits: { ...spec.resources.limits },
    },
  };
  return {
    sidecar,
    volumes: [
      { name: DEMO_DB_VOLUME, emptyDir: { sizeLimit: DATA_SIZE_LIMIT } },
    ],
    appEnv: spec.appEnv(password),
  };
}
