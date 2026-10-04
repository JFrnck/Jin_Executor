import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiextensionsV1Api, KubeConfig } from '@kubernetes/client-node';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENTS_SANDBOX_NAMESPACE,
  startTestK3s,
  type TestK3s,
} from '../../test/support/k3s-testcontainer';
import { K8sService } from '../k8s/k8s.service';
import { collectExec } from '../k8s/pod-exec';
import { RbacValidatorService } from '../rbac/rbac-validator.service';
import { PreviewServiceLifecycleService } from './preview-service.service';

// Las MISMAS imágenes que usa `demo-db.builder.ts` (si cambian allá, este test las baja).
const NODE_IMAGE = 'docker.io/library/node:22-alpine';
const BUSYBOX_IMAGE = 'docker.io/library/busybox:1.37.0';
const REDIS_IMAGE = 'docker.io/library/redis:7.4-alpine';
const POSTGRES_IMAGE = 'docker.io/library/postgres:16.4-alpine';
const MONGO_IMAGE = 'docker.io/library/mongo:7.0';
const PNPM_STORE_PVC_NAME = 'pnpm-store';

/** IngressRoute: el CRD no existe en el K3s de prueba (ver preview-service.service.integration.spec.ts). */
async function registerIngressRouteCrd(
  kubeConfigString: string,
): Promise<void> {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromString(kubeConfigString);
  await kubeConfig
    .makeApiClient(ApiextensionsV1Api)
    .createCustomResourceDefinition({
      body: {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: 'ingressroutes.traefik.io' },
        spec: {
          group: 'traefik.io',
          names: {
            plural: 'ingressroutes',
            singular: 'ingressroute',
            kind: 'IngressRoute',
            listKind: 'IngressRouteList',
          },
          scope: 'Namespaced',
          versions: [
            {
              name: 'v1alpha1',
              served: true,
              storage: true,
              schema: {
                openAPIV3Schema: {
                  type: 'object',
                  ...({
                    'x-kubernetes-preserve-unknown-fields': true,
                  } as Record<string, unknown>),
                },
              },
            },
          ],
        },
      },
    });
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

/**
 * Demos con base de datos (Fase 3, 2026-10-02) contra un K3s REAL, con las reglas del
 * namespace de producción: PSA "restricted" (ya viene en el K3s de prueba) y el
 * LimitRange de agents-sandbox. Lo que se comprueba es lo que un test unitario no puede:
 * que cada imagen arranca como no-root, que el contenedor auxiliar nativo deja listo
 * el motor ANTES de la app, y que se puede escribir y leer con la contraseña de la demo.
 */
describe('Demos con base de datos (integración, K3s real)', () => {
  let testK3s: TestK3s;
  let kubeconfigTmpDir: string;
  let service: PreviewServiceLifecycleService;
  let k8s: K8sService;

  beforeAll(async () => {
    testK3s = await startTestK3s([
      NODE_IMAGE,
      BUSYBOX_IMAGE,
      REDIS_IMAGE,
      POSTGRES_IMAGE,
      MONGO_IMAGE,
    ]);
    await registerIngressRouteCrd(testK3s.kubeConfigString);

    await testK3s.coreApi.createNamespacedLimitRange({
      namespace: AGENTS_SANDBOX_NAMESPACE,
      body: {
        metadata: { name: 'agents-sandbox-limits' },
        spec: {
          limits: [
            {
              type: 'Container',
              _default: { cpu: '500m', memory: '512Mi' },
              defaultRequest: { cpu: '250m', memory: '256Mi' },
              max: { cpu: '1000m', memory: '1Gi' },
              maxLimitRequestRatio: { memory: '3' },
            },
          ],
        },
      },
    });
    await testK3s.coreApi.createNamespacedPersistentVolumeClaim({
      namespace: AGENTS_SANDBOX_NAMESPACE,
      body: {
        metadata: {
          name: PNPM_STORE_PVC_NAME,
          namespace: AGENTS_SANDBOX_NAMESPACE,
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: '100Mi' } },
        },
      },
    });

    kubeconfigTmpDir = mkdtempSync(
      path.join(tmpdir(), 'jin-executor-demo-db-kubeconfig-'),
    );
    const kubeconfigPath = path.join(kubeconfigTmpDir, 'kubeconfig.yaml');
    writeFileSync(kubeconfigPath, testK3s.kubeConfigString);
    const configService = new ConfigService({
      KUBECONFIG_PATH: kubeconfigPath,
      AGENTS_SANDBOX_NAMESPACE,
      PREVIEW_SERVICE_NODE_IMAGE: NODE_IMAGE,
      PREVIEW_SERVICE_DEFAULT_TTL_SECONDS: 3600,
      PREVIEW_SERVICE_MAX_TTL_SECONDS: 86400,
      // Cada test para su demo, pero el pod tarda en irse (terminando sigue contando): este
      // archivo no prueba el límite de concurrencia, así que se deja holgado.
      PREVIEW_SERVICE_MAX_CONCURRENT: 10,
      PREVIEW_SERVICE_ALLOWED_SECRETS: 'brevo,faltante',
    });
    k8s = new K8sService(configService);
    service = new PreviewServiceLifecycleService(
      new RbacValidatorService(),
      k8s,
      configService,
    );
  }, 900_000);

  afterAll(async () => {
    if (testK3s) await testK3s.stop();
    if (kubeconfigTmpDir)
      rmSync(kubeconfigTmpDir, { recursive: true, force: true });
  });

  /** Una demo mínima (el proceso solo se queda vivo) con el motor pedido. */
  async function startDemo(db: 'sqlite' | 'redis' | 'postgres' | 'mongodb') {
    const info = await service.start({
      tool: 'startPreviewService',
      files: { 'index.js': 'setInterval(() => {}, 1e6);' },
      command: ['node', 'index.js'],
      port: 3000,
      ttlSeconds: 900,
      db,
    });
    const podName = `agent-service-${info.id}`;
    await k8s.waitForPodRunning(podName, 360_000);
    const pod = await k8s.readPod(podName);
    return { info, podName, pod };
  }

  const appEnv = (
    pod: {
      spec?: { containers: { env?: { name: string; value?: string }[] }[] };
    },
    name: string,
  ): string =>
    pod.spec?.containers[0]?.env?.find((e) => e.name === name)?.value ?? '';

  it('redis: arranca como no-root, la app lo ve en 127.0.0.1 y se puede escribir y leer con la contraseña', async () => {
    const { info, podName, pod } = await startDemo('redis');
    try {
      expect(pod.status?.phase).toBe('Running');
      const url = appEnv(pod, 'REDIS_URL');
      const password = /^redis:\/\/:([a-f0-9]+)@/.exec(url)?.[1] ?? '';
      expect(password).toHaveLength(32);

      const run = (script: string) =>
        collectExec(k8s, podName, 'demo-db', ['sh', '-c', script]);
      const write = await run(
        `REDISCLI_AUTH=${password} redis-cli -h 127.0.0.1 set demo hola && REDISCLI_AUTH=${password} redis-cli -h 127.0.0.1 get demo`,
      );
      expect(write.stdout).toContain('hola');
      // Sin contraseña, no entra.
      const noAuth = await run('redis-cli -h 127.0.0.1 get demo');
      expect(noAuth.stdout + noAuth.stderr).toMatch(/NOAUTH|Authentication/i);
      // La app (otro contenedor del MISMO pod) llega por 127.0.0.1.
      const fromApp = await collectExec(k8s, podName, 'app', [
        'node',
        '-e',
        'require("net").connect(6379,"127.0.0.1").on("connect",()=>{console.log("OK");process.exit(0)}).on("error",()=>process.exit(2))',
      ]);
      expect(fromApp.stdout).toContain('OK');
      expect(
        (await k8s.readPod(podName)).metadata?.annotations?.[
          'jin.io/db-engine'
        ],
      ).toBe('redis');
    } finally {
      await service.stop(info.id);
    }
  }, 480_000);

  it('postgres: initdb como uid 70, la app espera a que responda, crea una tabla y la lee', async () => {
    const { info, podName, pod } = await startDemo('postgres');
    try {
      expect(pod.status?.phase).toBe('Running');
      const url = appEnv(pod, 'DATABASE_URL');
      const password =
        /^postgres:\/\/demo:([a-f0-9]+)@127\.0\.0\.1:5432\/demo$/.exec(
          url,
        )?.[1] ?? '';
      expect(password).toHaveLength(32);

      const result = await collectExec(k8s, podName, 'demo-db', [
        'sh',
        '-c',
        `PGPASSWORD=${password} psql -h 127.0.0.1 -U demo -d demo -tA -c "create table t(x int); insert into t values (42); select x from t;"`,
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('42');
      const bad = await collectExec(k8s, podName, 'demo-db', [
        'sh',
        '-c',
        `PGPASSWORD=${'x'.repeat(12)} psql -h 127.0.0.1 -U demo -d demo -tA -c "select 1"`,
      ]);
      expect(bad.code).not.toBe(0);
    } finally {
      await service.stop(info.id);
    }
  }, 480_000);

  it('mongodb: arranca como uid 999 con autenticación, inserta y cuenta con la contraseña', async () => {
    const { info, podName, pod } = await startDemo('mongodb');
    try {
      expect(pod.status?.phase).toBe('Running');
      const uri = appEnv(pod, 'MONGODB_URI');
      const password =
        /^mongodb:\/\/demo:([a-f0-9]+)@127\.0\.0\.1:27017\/demo\?authSource=admin$/.exec(
          uri,
        )?.[1] ?? '';
      expect(password).toHaveLength(32);

      const result = await collectExec(k8s, podName, 'demo-db', [
        'mongosh',
        '--quiet',
        '--host',
        '127.0.0.1',
        '-u',
        'demo',
        '-p',
        password,
        '--authenticationDatabase',
        'admin',
        '--eval',
        'db.getSiblingDB("demo").c.insertOne({a:1}); print("COUNT=" + db.getSiblingDB("demo").c.countDocuments())',
      ]);
      expect(result.stdout).toContain('COUNT=1');
    } finally {
      await service.stop(info.id);
    }
  }, 600_000);

  it('sqlite: sin contenedor auxiliar; la app recibe la ruta y puede crear y usar el archivo', async () => {
    const { info, podName, pod } = await startDemo('sqlite');
    try {
      expect((pod.spec?.initContainers ?? []).map((c) => c.name)).toEqual([
        'extract-workspace',
      ]);
      expect(appEnv(pod, 'SQLITE_PATH')).toBe('/workspace/data/app.db');
      // node:22 trae node:sqlite.
      const result = await collectExec(k8s, podName, 'app', [
        'node',
        '--no-warnings',
        '-e',
        'const {DatabaseSync}=require("node:sqlite");require("fs").mkdirSync("/workspace/data",{recursive:true});const db=new DatabaseSync(process.env.SQLITE_PATH);db.exec("create table t(x int);insert into t values (7)");console.log("ROW="+db.prepare("select x from t").get().x)',
      ]);
      expect(result.stdout).toContain('ROW=7');
    } finally {
      await service.stop(info.id);
    }
  }, 240_000);

  it('secretos de demo: el pod recibe el Secret como variables de entorno (valor resuelto por K8s, no por el Executor); si el Secret no existe, falla ruidosamente', async () => {
    // Valores de ejemplo construidos en ejecución (nada con forma de credencial en el repo).
    const fakeKey = `k${'0123456789'.repeat(3)}`;
    await testK3s.coreApi.createNamespacedSecret({
      namespace: AGENTS_SANDBOX_NAMESPACE,
      body: {
        metadata: { name: 'demo-secret-brevo' },
        stringData: { BREVO_API_KEY: fakeKey, BREVO_SENDER_NAME: 'evento' },
      },
    });

    const withSecret = await service.start({
      tool: 'startPreviewService',
      files: { 'index.js': 'setInterval(() => {}, 1e6);' },
      command: ['node', 'index.js'],
      port: 3000,
      ttlSeconds: 900,
      secrets: ['brevo'],
    });
    const okPod = `agent-service-${withSecret.id}`;
    try {
      await k8s.waitForPodRunning(okPod, 240_000);
      const env = await collectExec(k8s, okPod, 'app', [
        'node',
        '-e',
        'console.log("LEN=" + (process.env.BREVO_API_KEY ?? "").length + " NAME=" + process.env.BREVO_SENDER_NAME)',
      ]);
      expect(env.stdout).toContain(`LEN=${fakeKey.length} NAME=evento`);
      // El valor NO está en el pod spec: solo la referencia al Secret.
      const spec = JSON.stringify((await k8s.readPod(okPod)).spec);
      expect(spec).not.toContain(fakeKey);
      expect(spec).toContain('demo-secret-brevo');
    } finally {
      await service.stop(withSecret.id);
    }

    const missing = await service.start({
      tool: 'startPreviewService',
      files: { 'index.js': 'setInterval(() => {}, 1e6);' },
      command: ['node', 'index.js'],
      port: 3000,
      ttlSeconds: 900,
      secrets: ['faltante'],
    });
    const missingPod = `agent-service-${missing.id}`;
    try {
      let reason = '';
      for (let i = 0; i < 60 && reason === ''; i++) {
        const pod = await k8s.readPod(missingPod);
        const waiting = [
          ...(pod.status?.containerStatuses ?? []),
          ...(pod.status?.initContainerStatuses ?? []),
        ].find(
          (c) => c.state?.waiting?.reason === 'CreateContainerConfigError',
        );
        reason = waiting ? 'CreateContainerConfigError' : '';
        if (reason === '') await new Promise((r) => setTimeout(r, 2000));
      }
      expect(reason).toBe('CreateContainerConfigError');
    } finally {
      await service.stop(missing.id);
    }
  }, 480_000);
});
