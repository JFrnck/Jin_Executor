import { randomUUID } from 'node:crypto';
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
import { TerminalPtyService } from './terminal-pty.service';
import { TerminalReaperService } from './terminal-reaper.service';
import { TerminalWorkspaceService } from './terminal.service';
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

describe('TerminalWorkspaceService (integración, K3s real)', () => {
  let testK3s: TestK3s;
  let kubeconfigTmpDir: string;
  let terminal: TerminalWorkspaceService;
  let reaper: TerminalReaperService;
  let k8s: K8sService;
  let baseConfigValues: Record<string, unknown>;

  beforeAll(async () => {
    testK3s = await startTestK3s([NODE_IMAGE]);
    await registerIngressRouteCrd(testK3s.kubeConfigString);

    kubeconfigTmpDir = mkdtempSync(
      path.join(tmpdir(), 'jin-executor-terminal-kubeconfig-'),
    );
    const kubeconfigPath = path.join(kubeconfigTmpDir, 'kubeconfig.yaml');
    writeFileSync(kubeconfigPath, testK3s.kubeConfigString);

    baseConfigValues = {
      KUBECONFIG_PATH: kubeconfigPath,
      AGENTS_SANDBOX_NAMESPACE,
      TERMINAL_NODE_IMAGE: NODE_IMAGE,
      TERMINAL_NPM_REGISTRY_URL:
        'http://verdaccio.registry-proxy.svc.cluster.local:4873',
      TERMINAL_REGISTRY_NAMESPACE: 'registry-proxy',
      TERMINAL_DEFAULT_TTL_SECONDS: 3600,
      TERMINAL_MAX_TTL_SECONDS: 14400,
      TERMINAL_MAX_CONCURRENT: 1,
      TERMINAL_MAX_WORKSPACES: 10,
      TERMINAL_WORKSPACE_STORAGE_GI: 1,
    };
    const configService = new ConfigService(baseConfigValues);
    k8s = new K8sService(configService);
    terminal = new TerminalWorkspaceService(
      new RbacValidatorService(),
      k8s,
      configService,
    );
    reaper = new TerminalReaperService(terminal, configService);
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

  it('proyecto completo: sube archivos, corre comandos, conserva el cd, exporta, publica y cierra', async () => {
    const id = randomUUID();
    const info = await terminal.start(id, {
      files: {
        'index.html': '<h1>hola</h1>',
        'src/main.js': 'console.log(40 + 2)',
      },
      ttlSeconds: 3600,
    });
    expect(info.status).toBe('running');

    try {
      // Los archivos subidos están (el disco monta con permisos de escritura
      // para el usuario 1000 — fsGroup sobre un PVC local-path), y el pod
      // corre sin privilegios.
      const listing = await run(id, 'ls && id -u');
      expect(listing.exit?.code).toBe(0);
      expect(listing.out).toContain('index.html');
      expect(listing.out.trim().endsWith('1000')).toBe(true);

      // node corre código del proyecto; stderr y el código de salida llegan aparte.
      expect((await run(id, 'node src/main.js')).out).toBe('42\n');
      const failing = await run(id, 'echo malo >&2; exit 3');
      expect(failing.err).toBe('malo\n');
      expect(failing.exit?.code).toBe(3);

      // Cada comando es una shell nueva, pero el directorio se conserva.
      await run(id, 'mkdir -p build && cd build');
      expect((await run(id, 'pwd')).out.trim()).toBe('/workspace/build');

      // Sin internet: la única salida sería el proxy de npm (que acá no existe).
      const net = await run(
        id,
        'wget -q -T 3 -O /dev/null http://1.1.1.1/',
        15,
      );
      expect(net.exit?.code).not.toBe(0);

      // Lo que se genera dentro se puede traer de vuelta al editor.
      await run(
        id,
        'cd /workspace && mkdir -p out && echo "<h1>build</h1>" > out/index.html',
      );
      const exported = await terminal.exportFiles(id, '.');
      expect(Object.keys(exported.files).sort()).toEqual([
        'index.html',
        'out/index.html',
        'src/main.js',
      ]);

      // Publicar sin build falla claro; con build, el servidor responde dentro del pod.
      await expect(
        terminal.expose(id, {
          dir: 'dist',
          port: 8080,
          serverSource: TEST_SERVER_SOURCE,
        }),
      ).rejects.toThrow(/corre el build primero/);
      const exposure = await terminal.expose(id, {
        dir: 'out',
        port: 8080,
        slugHint: 'mi-build',
        serverSource: TEST_SERVER_SOURCE,
      });
      expect(exposure.url).toMatch(
        /^https:\/\/mi-build-[a-z0-9]{6}\.jinserver\.com$/,
      );
      expect(
        (await terminal.list()).find((w) => w.id === id)?.exposure?.slug,
      ).toBe(exposure.slug);
      expect(
        (await run(id, 'wget -q -O - http://127.0.0.1:8080/')).out,
      ).toContain('<h1>build</h1>');
    } finally {
      // Elimina TODO (pod + disco): este proyecto no se retoma en otro test.
      await terminal.deleteWorkspace(id);
    }
    expect((await terminal.list()).find((w) => w.id === id)).toBeUndefined();
    const services = await testK3s.coreApi.listNamespacedService({
      namespace: AGENTS_SANDBOX_NAMESPACE,
    });
    expect(
      services.items.filter((service) => service.metadata?.name?.includes(id)),
    ).toEqual([]);
  }, 240_000);

  it('el disco sobrevive a detener el pod: al reanudar, el proyecto sigue tal como se dejó', async () => {
    const id = randomUUID();
    const first = await terminal.start(id, {
      files: { 'notas.txt': 'primera línea\n' },
      ttlSeconds: 3600,
    });
    try {
      await run(id, 'echo "segunda línea" >> notas.txt && mkdir -p pkg');

      // Detener el pod: el disco (PVC) NO se toca.
      await terminal.stopPod(id);
      const stopped = (await terminal.list()).find((w) => w.id === id);
      expect(stopped).toMatchObject({ id, status: 'stopped', expiresAt: null });
      await expect(run(id, 'ls')).rejects.toThrow();

      // Reanudar: mismo id, sin mandar archivos — el pod nuevo ve el disco de antes.
      const second = await terminal.start(id, { files: {}, ttlSeconds: 3600 });
      expect(second.status).toBe('running');
      // El disco es el mismo: "creado" no cambió al reanudar.
      expect(second.createdAt).toBe(first.createdAt);

      const contents = await run(id, 'cat notas.txt && ls pkg');
      expect(contents.out).toBe('primera línea\nsegunda línea\n');
      expect(contents.exit?.code).toBe(0); // `ls pkg` no falla: la carpeta sigue ahí
    } finally {
      await terminal.deleteWorkspace(id);
    }
  }, 240_000);

  it('vista previa en vivo: un servidor en segundo plano sobrevive al comando y se ve a través del API server, con las NetworkPolicies puestas', async () => {
    const id = randomUUID();
    const info = await terminal.start(id, {
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
    expect(info.status).toBe('running');
    try {
      const started = await terminal.startService(id, {
        command: 'node server.js',
        port: 5173,
      });
      expect(started.status).toBe('listening');

      // Un comando aparte no lo mata: el servidor es del proyecto, no del comando.
      await run(id, 'echo otro comando');
      expect((await terminal.listServices(id))[0]).toMatchObject({
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

      const get = await terminal.proxy(id, 5173, {
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
      const page = await terminal.proxy(id, 5173, {
        method: 'GET',
        path: '/pagina',
        headers: { host: 'localhost:5173', 'accept-encoding': 'identity' },
      });
      const pageChunks: Buffer[] = [];
      for await (const chunk of page.body) pageChunks.push(chunk as Buffer);
      expect(Buffer.concat(pageChunks).toString('utf8')).toBe(
        '<script type="module" src="/@vite/client"></script><link href="/favicon.svg"><a href="/">inicio</a>',
      );

      const post = await terminal.proxy(id, 5173, {
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
        .proxy(id, 5999, { method: 'GET', path: '/', headers: {} })
        .then((res) => res.status)
        .catch(() => 502);
      expect(nothing).toBeGreaterThanOrEqual(500);

      // Detener el servidor lo apaga de verdad.
      await terminal.stopService(id, 5173);
      expect(await terminal.listServices(id)).toEqual([]);
      const after = await terminal
        .proxy(id, 5173, { method: 'GET', path: '/', headers: {} })
        .then((res) => res.status)
        .catch(() => 502);
      expect(after).toBeGreaterThanOrEqual(500);
    } finally {
      await terminal.deleteWorkspace(id);
    }
  }, 180_000);

  it('el timeout del pod mata el comando (KILL) y avisa con 137', async () => {
    const id = randomUUID();
    await terminal.start(id, { files: {}, ttlSeconds: 3600 });
    try {
      const started = Date.now();
      const result = await run(id, 'sleep 60', 2);
      expect(result.exit?.code).toBe(137);
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      await terminal.deleteWorkspace(id);
    }
  }, 120_000);

  it('el límite de un pod corriendo a la vez se hace cumplir y el reaper libera el vencido (el disco sigue listado)', async () => {
    const id = randomUUID();
    await terminal.start(id, { files: {}, ttlSeconds: 3600 });
    try {
      await expect(
        terminal.start(randomUUID(), { files: {}, ttlSeconds: 60 }),
      ).rejects.toThrow(/corriendo/);

      // Se vence a mano y el reaper lo libera (el disco NO desaparece).
      const podName = `agent-terminal-${id}`;
      const pod = await k8s.readPod(podName);
      expect(pod.metadata?.annotations?.['jin.io/expires-at']).toBeDefined();
      await testK3s.coreApi.patchNamespacedPod({
        name: podName,
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
      await expect(run(id, 'ls')).rejects.toThrow();
      expect((await terminal.list()).find((w) => w.id === id)?.status).toBe(
        'stopped',
      );
    } finally {
      await terminal.deleteWorkspace(id);
    }
  }, 120_000);

  it('el reaper libera un pod inactivo (sin comandos) pero conserva su disco', async () => {
    const idleConfig = new ConfigService({
      ...baseConfigValues,
      TERMINAL_IDLE_TIMEOUT_SECONDS: 1,
    });
    const idleReaper = new TerminalReaperService(terminal, idleConfig);

    const id = randomUUID();
    await terminal.start(id, { files: {}, ttlSeconds: 3600 });
    try {
      await run(id, 'echo actividad'); // deja "última actividad" en el pod
      await new Promise((resolve) => setTimeout(resolve, 2000)); // pasa el minuto... o el segundo, acá

      await idleReaper.reapExpired();

      const workspace = (await terminal.list()).find((w) => w.id === id);
      expect(workspace?.status).toBe('stopped'); // el pod se liberó...
      await expect(run(id, 'ls')).rejects.toThrow();

      // ...pero el disco sigue: reanudar retoma el mismo proyecto.
      const resumed = await terminal.start(id, { files: {}, ttlSeconds: 3600 });
      expect(resumed.status).toBe('running');
      expect(resumed.createdAt).toBe(workspace?.createdAt);
    } finally {
      await terminal.deleteWorkspace(id);
    }
  }, 120_000);
  it('terminal interactiva (PTY): TTY real, teclas en vivo, prompts, resize, Ctrl+C y cierre', async () => {
    const id = randomUUID();
    await terminal.start(id, { files: {}, ttlSeconds: 3600 });
    const pty = new TerminalPtyService(
      terminal,
      k8s,
      new ConfigService(baseConfigValues),
    );
    try {
      const { ptyId } = await pty.open(id, { cols: 100, rows: 30 });
      let out = '';
      let last: { t: string; code?: number } | undefined;
      const controller = new AbortController();
      const done = pty.subscribe(
        id,
        ptyId,
        (event) => {
          if (event.t === 'out')
            out += Buffer.from(event.d, 'base64').toString();
          else last = event;
          return true;
        },
        controller.signal,
      );
      const type = (text: string): void =>
        pty.write(id, ptyId, Buffer.from(text));
      const waitFor = async (needle: string): Promise<void> => {
        const deadline = Date.now() + 30_000;
        while (!out.includes(needle)) {
          if (Date.now() > deadline)
            throw new Error(`No apareció "${needle}". Salida:\n${out}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      };

      // Un TTY de verdad, con el tamaño pedido.
      type('test -t 0 && echo TTY_OK; stty size\r');
      await waitFor('TTY_OK');
      await waitFor('30 100');

      // El resize llega al pod.
      pty.resize(id, ptyId, { cols: 120, rows: 40 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      type('stty size\r');
      await waitFor('40 120');

      // Un prompt que espera lo que se teclea (lo que no podía la terminal por comandos).
      type('read -p "nombre: " N; echo hola-$N\r');
      await waitFor('nombre: ');
      type('Ana\r');
      await waitFor('hola-Ana');

      // Ctrl+C corta el comando en curso y el shell sigue vivo.
      type('sleep 100\r');
      await new Promise((resolve) => setTimeout(resolve, 500));
      type('\x03');
      type('echo despues\r');
      await waitFor('despues');

      // Arranca en el espacio de trabajo.
      type('pwd\r');
      await waitFor('/workspace');

      type('exit\r');
      await done;
      expect(last).toEqual({ t: 'exit', code: 0 });
      // La sesión terminada libera el workspace para abrir otra.
      const again = await pty.open(id, { cols: 80, rows: 24 });
      pty.close(id, again.ptyId);
    } finally {
      pty.onModuleDestroy();
      await terminal.deleteWorkspace(id);
    }
  }, 180_000);
});
