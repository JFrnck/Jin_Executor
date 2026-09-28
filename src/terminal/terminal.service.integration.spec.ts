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
import { RbacValidatorService } from '../rbac/rbac-validator.service';
import { TerminalReaperService } from './terminal-reaper.service';
import { TerminalSessionService } from './terminal.service';
import type { TerminalStreamEvent } from './terminal.types';

const NODE_IMAGE = 'docker.io/library/node:22-alpine';

/** Igual que en el test de preview-service: el K3s de testcontainers no trae Traefik. */
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

/** Servidor mínimo que sirve el directorio actual: hace de "servidor estático de Jin" en el test. */
const TEST_SERVER_SOURCE = `
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
createServer((req, res) => res.end(readFileSync('index.html'))).listen(8080, '0.0.0.0');
`;

describe('TerminalSessionService (integración, K3s real)', () => {
  let testK3s: TestK3s;
  let kubeconfigTmpDir: string;
  let terminal: TerminalSessionService;
  let reaper: TerminalReaperService;
  let k8s: K8sService;

  beforeAll(async () => {
    testK3s = await startTestK3s([NODE_IMAGE]);
    await registerIngressRouteCrd(testK3s.kubeConfigString);

    kubeconfigTmpDir = mkdtempSync(
      path.join(tmpdir(), 'jin-executor-terminal-kubeconfig-'),
    );
    const kubeconfigPath = path.join(kubeconfigTmpDir, 'kubeconfig.yaml');
    writeFileSync(kubeconfigPath, testK3s.kubeConfigString);

    const configService = new ConfigService({
      KUBECONFIG_PATH: kubeconfigPath,
      AGENTS_SANDBOX_NAMESPACE,
      TERMINAL_NODE_IMAGE: NODE_IMAGE,
      TERMINAL_NPM_REGISTRY_URL:
        'http://verdaccio.registry-proxy.svc.cluster.local:4873',
      TERMINAL_REGISTRY_NAMESPACE: 'registry-proxy',
      TERMINAL_DEFAULT_TTL_SECONDS: 3600,
      TERMINAL_MAX_TTL_SECONDS: 14400,
      TERMINAL_MAX_CONCURRENT: 1,
    });
    k8s = new K8sService(configService);
    terminal = new TerminalSessionService(
      new RbacValidatorService(),
      k8s,
      configService,
    );
    reaper = new TerminalReaperService(terminal);
  }, 300_000);

  afterAll(async () => {
    if (testK3s) await testK3s.stop();
    if (kubeconfigTmpDir)
      rmSync(kubeconfigTmpDir, { recursive: true, force: true });
  });

  async function run(id: string, command: string, timeoutSeconds = 30) {
    const events: TerminalStreamEvent[] = [];
    await terminal.exec(id, { command, timeoutSeconds }, (event) =>
      events.push(event),
    );
    const text = (kind: 'out' | 'err') =>
      events
        .filter((event) => event.t === kind)
        .map((event) => (event as { d: string }).d)
        .join('');
    const last = events.at(-1);
    return {
      events,
      out: text('out'),
      err: text('err'),
      exit: last?.t === 'exit' ? last : undefined,
    };
  }

  it('sesión completa: sube archivos, corre comandos, conserva el cd, exporta, publica y cierra', async () => {
    const info = await terminal.start({
      files: {
        'index.html': '<h1>hola</h1>',
        'src/main.js': 'console.log(40 + 2)',
      },
      ttlSeconds: 3600,
    });
    expect(info.status).toBe('running');

    // Los archivos subidos están, y el pod corre como usuario sin privilegios.
    const listing = await run(info.id, 'ls && id -u');
    expect(listing.exit?.code).toBe(0);
    expect(listing.out).toContain('index.html');
    expect(listing.out.trim().endsWith('1000')).toBe(true);

    // node corre código del proyecto; stderr y el código de salida llegan aparte.
    expect((await run(info.id, 'node src/main.js')).out).toBe('42\n');
    const failing = await run(info.id, 'echo malo >&2; exit 3');
    expect(failing.err).toBe('malo\n');
    expect(failing.exit?.code).toBe(3);

    // Cada comando es una shell nueva, pero el directorio se conserva.
    await run(info.id, 'mkdir -p build && cd build');
    expect((await run(info.id, 'pwd')).out.trim()).toBe('/workspace/build');

    // Sin internet: la única salida sería el proxy de npm (que acá no existe).
    const net = await run(
      info.id,
      'wget -q -T 3 -O /dev/null http://1.1.1.1/',
      15,
    );
    expect(net.exit?.code).not.toBe(0);

    // Lo que se genera dentro se puede traer de vuelta al editor.
    await run(
      info.id,
      'cd /workspace && mkdir -p out && echo "<h1>build</h1>" > out/index.html',
    );
    const exported = await terminal.exportFiles(info.id, '.');
    expect(Object.keys(exported.files).sort()).toEqual([
      'index.html',
      'out/index.html',
      'src/main.js',
    ]);

    // Publicar sin build falla claro; con build, el servidor responde dentro del pod.
    await expect(
      terminal.expose(info.id, {
        dir: 'dist',
        port: 8080,
        serverSource: TEST_SERVER_SOURCE,
      }),
    ).rejects.toThrow(/corre el build primero/);
    const exposure = await terminal.expose(info.id, {
      dir: 'out',
      port: 8080,
      slugHint: 'mi-build',
      serverSource: TEST_SERVER_SOURCE,
    });
    expect(exposure.url).toMatch(
      /^https:\/\/mi-build-[a-z0-9]{6}\.jinserver\.com$/,
    );
    expect((await terminal.list())[0]?.exposure?.slug).toBe(exposure.slug);
    expect(
      (await run(info.id, 'wget -q -O - http://127.0.0.1:8080/')).out,
    ).toContain('<h1>build</h1>');

    // Cierra todo: pod, Service y policies.
    await terminal.stop(info.id);
    expect(await terminal.list()).toEqual([]);
    const services = await testK3s.coreApi.listNamespacedService({
      namespace: AGENTS_SANDBOX_NAMESPACE,
    });
    expect(
      services.items.filter((service) =>
        service.metadata?.name?.includes(info.id),
      ),
    ).toEqual([]);
  }, 240_000);

  it('vista previa en vivo: un servidor en segundo plano sobrevive al comando y se ve a través del API server, con las NetworkPolicies puestas', async () => {
    const info = await terminal.start({
      files: {
        'server.js': `
          require('http').createServer((req, res) => {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
              if (req.url === '/pagina') {
                res.setHeader('content-type', 'text/html');
                res.end('<script type="module" src="/@vite/client"></script><link href="/favicon.svg"><a href="/">inicio</a>');
                return;
              }
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, body, cookie: req.headers.cookie ?? null, auth: req.headers.authorization ?? null }));
            });
          }).listen(5173, '0.0.0.0');
        `,
      },
      ttlSeconds: 3600,
    });
    try {
      const started = await terminal.startService(info.id, {
        command: 'node server.js',
        port: 5173,
      });
      expect(started.status).toBe('listening');

      // Un comando aparte no lo mata: el servidor es de la sesión, no del comando.
      await run(info.id, 'echo otro comando');
      expect((await terminal.listServices(info.id))[0]).toMatchObject({
        port: 5173,
        running: true,
        listening: true,
      });

      const read = async (res: Awaited<ReturnType<typeof terminal.proxy>>) => {
        const chunks: Buffer[] = [];
        for await (const chunk of res.body) chunks.push(chunk as Buffer);
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          unknown
        >;
      };

      const get = await terminal.proxy(info.id, 5173, {
        method: 'GET',
        path: '/src/main.js?t=1',
        headers: { host: 'localhost:5173', 'accept-encoding': 'identity' },
      });
      expect(get.status).toBe(200);
      expect(await read(get)).toMatchObject({
        method: 'GET',
        url: '/src/main.js?t=1',
        host: 'localhost:5173',
        cookie: null,
        auth: null,
      });

      // El API server reescribe los enlaces del HTML; el Executor lo deshace.
      const page = await terminal.proxy(info.id, 5173, {
        method: 'GET',
        path: '/pagina',
        headers: { host: 'localhost:5173', 'accept-encoding': 'identity' },
      });
      const pageChunks: Buffer[] = [];
      for await (const chunk of page.body) pageChunks.push(chunk as Buffer);
      expect(Buffer.concat(pageChunks).toString('utf8')).toBe(
        '<script type="module" src="/@vite/client"></script><link href="/favicon.svg"><a href="/">inicio</a>',
      );

      const post = await terminal.proxy(info.id, 5173, {
        method: 'POST',
        path: '/api/items',
        headers: { host: 'localhost:5173', 'content-type': 'application/json' },
        body: Buffer.from('{"a":1}'),
      });
      expect(await read(post)).toMatchObject({
        method: 'POST',
        body: '{"a":1}',
      });

      // Un puerto donde no hay nada: el API server responde con error, no cuelga.
      const nothing = await terminal
        .proxy(info.id, 5999, { method: 'GET', path: '/', headers: {} })
        .then((res) => res.status)
        .catch(() => 502);
      expect(nothing).toBeGreaterThanOrEqual(500);

      // Detener el servidor lo apaga de verdad.
      await terminal.stopService(info.id, 5173);
      expect(await terminal.listServices(info.id)).toEqual([]);
      const after = await terminal
        .proxy(info.id, 5173, { method: 'GET', path: '/', headers: {} })
        .then((res) => res.status)
        .catch(() => 502);
      expect(after).toBeGreaterThanOrEqual(500);
    } finally {
      await terminal.stop(info.id);
    }
  }, 180_000);

  it('el timeout del pod mata el comando (KILL) y avisa con 137', async () => {
    const info = await terminal.start({ files: {}, ttlSeconds: 3600 });
    try {
      const started = Date.now();
      const result = await run(info.id, 'sleep 60', 2);
      expect(result.exit?.code).toBe(137);
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      await terminal.stop(info.id);
    }
  }, 120_000);

  it('el límite de una sesión a la vez se hace cumplir y el reaper cierra la vencida', async () => {
    const info = await terminal.start({ files: {}, ttlSeconds: 3600 });
    try {
      await expect(
        terminal.start({ files: {}, ttlSeconds: 60 }),
      ).rejects.toThrow(/límite/);

      // Se vence a mano y el reaper la destruye.
      const pod = await k8s.readPod(`agent-terminal-${info.id}`);
      expect(pod.metadata?.annotations?.['jin.io/expires-at']).toBeDefined();
      await testK3s.coreApi.patchNamespacedPod({
        name: `agent-terminal-${info.id}`,
        namespace: AGENTS_SANDBOX_NAMESPACE,
        body: [
          {
            op: 'replace',
            path: '/metadata/annotations/jin.io~1expires-at',
            value: new Date(Date.now() - 1000).toISOString(),
          },
        ],
      });
      await reaper.reapExpired();
      await expect(run(info.id, 'ls')).rejects.toThrow();
    } finally {
      await terminal.stop(info.id);
    }
  }, 120_000);
});
