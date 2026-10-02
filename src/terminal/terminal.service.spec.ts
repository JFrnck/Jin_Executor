import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type {
  V1PersistentVolumeClaim,
  V1Pod,
  V1Service,
} from '@kubernetes/client-node';
import type { K8sService, PodExecOptions } from '../k8s/k8s.service';
import { RbacValidatorService } from '../rbac/rbac-validator.service';
import {
  TerminalBusyError,
  TerminalExposeError,
  TerminalLimitError,
  TerminalNotRunningError,
  TerminalWorkspaceLimitError,
  TerminalWorkspaceNotFoundError,
} from './errors';
import { TerminalWorkspaceService } from './terminal.service';
import type { TerminalStreamEvent } from './terminal.types';

type Script = (options: PodExecOptions) => Promise<number> | number;

function pod(
  id: string,
  overrides: { phase?: string; expiresAt?: string } = {},
): V1Pod {
  return {
    metadata: {
      name: `agent-terminal-${id}`,
      labels: { 'jin.io/service-id': id, 'jin.io/type': 'terminal' },
      annotations: {
        'jin.io/expires-at':
          overrides.expiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
      },
    },
    status: { phase: overrides.phase ?? 'Running' },
  };
}

function pvc(
  id: string,
  overrides: { createdAt?: string } = {},
): V1PersistentVolumeClaim {
  return {
    metadata: {
      name: `terminal-ws-${id}`,
      labels: { 'jin.io/service-id': id, 'jin.io/type': 'workspace' },
      creationTimestamp: new Date(
        overrides.createdAt ?? '2026-09-28T10:00:00.000Z',
      ),
    },
  };
}

interface PatchCall {
  readonly name: string;
  readonly key: string;
  readonly value: string;
}

/** K8s simulado: `scripts` decide qué "devuelve" cada exec, en orden. */
function fakeK8s(
  options: {
    pods?: V1Pod[];
    pvcs?: V1PersistentVolumeClaim[];
    services?: V1Service[];
    scripts?: Script[];
    proxyToPod?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const pods = options.pods ?? [];
  const pvcs = [...(options.pvcs ?? [])];
  const scripts = [...(options.scripts ?? [])];
  const calls: PodExecOptions[] = [];
  const patchCalls: PatchCall[] = [];
  const order: string[] = [];

  const log = (name: string) =>
    vi.fn().mockImplementation(() => {
      order.push(name);
      return Promise.resolve(undefined);
    });
  const mocks = {
    listPodsByLabel: vi.fn().mockImplementation(() => Promise.resolve(pods)),
    listPvcsByLabel: vi.fn().mockImplementation(() => Promise.resolve(pvcs)),
    listServicesByLabel: vi.fn().mockResolvedValue(options.services ?? []),
    createPod: log('createPod'),
    createPvc: vi.fn().mockImplementation((body: V1PersistentVolumeClaim) => {
      order.push('createPvc');
      pvcs.push(body);
      return Promise.resolve(body);
    }),
    createNetworkPolicy: log('createNetworkPolicy'),
    createService: log('createService'),
    createIngressRoute: log('createIngressRoute'),
    waitForPodRunning: vi.fn().mockResolvedValue({}),
    waitForPodGone: vi.fn().mockResolvedValue(undefined),
    proxyToPod: options.proxyToPod ?? vi.fn(),
    deleteIngressRoute: log('deleteIngressRoute'),
    deleteService: log('deleteService'),
    deleteNetworkPolicy: log('deleteNetworkPolicy'),
    deletePod: log('deletePod'),
    deletePvc: log('deletePvc'),
    deletePvcOrThrow: log('deletePvcOrThrow'),
    patchPodAnnotation: vi
      .fn()
      .mockImplementation((name: string, key: string, value: string) => {
        patchCalls.push({ name, key, value });
        return Promise.resolve(undefined);
      }),
    readPod: vi.fn().mockImplementation((name: string) => {
      const found = pods.find((candidate) => candidate.metadata?.name === name);
      return found
        ? Promise.resolve(found)
        : Promise.reject(Object.assign(new Error('not found'), { code: 404 }));
    }),
    readPvc: vi.fn().mockImplementation((name: string) => {
      const found = pvcs.find((candidate) => candidate.metadata?.name === name);
      return found
        ? Promise.resolve(found)
        : Promise.reject(Object.assign(new Error('not found'), { code: 404 }));
    }),
    execInPod: vi
      .fn()
      .mockImplementation((_name: string, execOptions: PodExecOptions) => {
        calls.push(execOptions);
        const script = scripts.shift();
        const exitCode = Promise.resolve().then(async () => {
          if (!script) return 0;
          return script(execOptions);
        });
        return Promise.resolve({ exitCode, abort: () => undefined });
      }),
  };
  return {
    k8s: { namespace: 'agents-sandbox', ...mocks } as unknown as K8sService,
    mocks,
    calls,
    patchCalls,
    order,
  };
}

function config(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    TERMINAL_NODE_IMAGE: 'docker.io/library/node:22-alpine',
    TERMINAL_NPM_REGISTRY_URL:
      'http://verdaccio.registry-proxy.svc.cluster.local:4873',
    TERMINAL_REGISTRY_NAMESPACE: 'registry-proxy',
    TERMINAL_CLAUDE_EGRESS_URL:
      'http://claude-egress.claude-egress.svc.cluster.local:3128',
    TERMINAL_CLAUDE_EGRESS_NAMESPACE: 'claude-egress',
    TERMINAL_DEFAULT_TTL_SECONDS: 3600,
    TERMINAL_MAX_TTL_SECONDS: 14400,
    TERMINAL_MAX_CONCURRENT: 1,
    TERMINAL_MAX_WORKSPACES: 10,
    TERMINAL_WORKSPACE_STORAGE_GI: 3,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function service(k8s: K8sService, overrides: Record<string, unknown> = {}) {
  return new TerminalWorkspaceService(
    new RbacValidatorService(),
    k8s,
    config(overrides),
  );
}

describe('TerminalWorkspaceService.start — proyecto nuevo', () => {
  it('crea el disco y el pod, en ese orden, y sube los archivos (solo pasa la primera vez)', async () => {
    const { k8s, mocks, calls, order } = fakeK8s({ scripts: [() => 0] });
    const info = await service(k8s).start('t1', {
      files: { 'index.html': '<h1>x</h1>' },
      ttlSeconds: 1800,
    });

    expect(info.status).toBe('running');
    expect(info.exposure).toBeNull();
    expect(order.slice(0, 3)).toEqual([
      'createPvc',
      'createPod',
      'createNetworkPolicy',
    ]);
    expect(mocks.waitForPodRunning).toHaveBeenCalledTimes(1);
    const createdPvc = mocks.createPvc.mock
      .calls[0]?.[0] as V1PersistentVolumeClaim;
    expect(createdPvc.metadata?.name).toBe('terminal-ws-t1');
    // Los archivos viajan por stdin con el largo por delante, no por argumentos.
    const upload = calls[0];
    expect(upload?.command.slice(0, 2)).toEqual(['node', '-e']);
    expect(upload?.command.at(-1)).toBe('/workspace');
    const stdin = upload?.stdin?.toString('utf8') ?? '';
    const [length, body] = [
      stdin.slice(0, stdin.indexOf('\n')),
      stdin.slice(stdin.indexOf('\n') + 1),
    ];
    expect(Number(length)).toBe(Buffer.byteLength(body));
    expect(JSON.parse(body)).toEqual({ files: { 'index.html': '<h1>x</h1>' } });
  });

  it('respeta el TTL máximo aunque el request pida más', async () => {
    const { k8s } = fakeK8s();
    const before = Date.now();
    const info = await service(k8s, { TERMINAL_MAX_TTL_SECONDS: 7200 }).start(
      't1',
      { files: {}, ttlSeconds: 86400 },
    );
    const ttl = (new Date(info.expiresAt ?? 0).getTime() - before) / 1000;
    expect(ttl).toBeGreaterThan(7190);
    expect(ttl).toBeLessThanOrEqual(7201);
  });

  it('tope de proyectos con disco (workspaces): uno nuevo no entra si ya se llegó al límite', async () => {
    const { k8s, mocks } = fakeK8s({ pvcs: [pvc('a'), pvc('b')] });
    await expect(
      service(k8s, { TERMINAL_MAX_WORKSPACES: 2 }).start('c', {
        files: {},
        ttlSeconds: 60,
      }),
    ).rejects.toBeInstanceOf(TerminalWorkspaceLimitError);
    expect(mocks.createPvc).not.toHaveBeenCalled();
    expect(mocks.createPod).not.toHaveBeenCalled();
  });

  it('reanudar uno de los proyectos que YA tienen disco no cuenta contra el tope, aunque esté al límite', async () => {
    const { k8s } = fakeK8s({ pvcs: [pvc('a'), pvc('b')] });
    await expect(
      service(k8s, { TERMINAL_MAX_WORKSPACES: 2 }).start('a', {
        files: {},
        ttlSeconds: 60,
      }),
    ).resolves.toMatchObject({ status: 'running' });
  });

  it('tope de pods CORRIENDO a la vez: otro proyecto ya corriendo bloquea uno nuevo, sin tocar discos', async () => {
    const { k8s, mocks } = fakeK8s({ pods: [pod('otro')] });
    await expect(
      service(k8s).start('nuevo', { files: {}, ttlSeconds: 60 }),
    ).rejects.toBeInstanceOf(TerminalLimitError);
    expect(mocks.createPvc).not.toHaveBeenCalled();
    expect(mocks.createPod).not.toHaveBeenCalled();
  });

  it('si algo falla al armarlo, no deja nada vivo; como el disco es NUEVO, también se borra', async () => {
    const { k8s, mocks } = fakeK8s();
    mocks.waitForPodRunning.mockRejectedValueOnce(new Error('imagen no baja'));
    await expect(
      service(k8s).start('t1', { files: {}, ttlSeconds: 60 }),
    ).rejects.toThrow('imagen no baja');
    expect(mocks.deletePod).toHaveBeenCalledTimes(1);
    expect(mocks.deleteNetworkPolicy).toHaveBeenCalledTimes(2);
    expect(mocks.deletePvc).toHaveBeenCalledTimes(1);
  });

  it('si la subida de archivos falla (código != 0) también se limpia, disco incluido', async () => {
    const { k8s, mocks } = fakeK8s({ scripts: [() => 1] });
    await expect(
      service(k8s).start('t1', { files: { 'a.txt': 'x' }, ttlSeconds: 60 }),
    ).rejects.toThrow(/copiar los archivos/);
    expect(mocks.deletePod).toHaveBeenCalledTimes(1);
    expect(mocks.deletePvc).toHaveBeenCalledTimes(1);
  });
});

describe('TerminalWorkspaceService.start — proyecto que ya tenía disco', () => {
  it('reanudarlo NO crea el disco de nuevo ni sube los archivos, aunque se los pasen', async () => {
    const { k8s, mocks, calls } = fakeK8s({ pvcs: [pvc('t1')] });
    const info = await service(k8s).start('t1', {
      files: { 'index.html': '<h1>no debería escribirse</h1>' },
      ttlSeconds: 1800,
    });
    expect(info.status).toBe('running');
    expect(mocks.createPvc).not.toHaveBeenCalled();
    expect(calls).toEqual([]); // sin exec: no hubo subida de archivos
  });

  it('ya está corriendo (o arrancando): no crea nada, toca actividad y devuelve lo que hay', async () => {
    for (const phase of ['Running', 'Pending']) {
      const { k8s, mocks, patchCalls } = fakeK8s({
        pods: [pod('t1', { phase })],
        pvcs: [pvc('t1')],
      });
      const info = await service(k8s).start('t1', {
        files: {},
        ttlSeconds: 60,
      });
      expect(info.status).toBe(phase === 'Running' ? 'running' : 'starting');
      expect(mocks.createPod).not.toHaveBeenCalled();
      expect(mocks.waitForPodRunning).not.toHaveBeenCalled();
      expect(patchCalls).toHaveLength(1); // actividad tocada al reanudar
    }
  });

  it('vencido o caído: se limpia y se vuelve a crear el pod, con el MISMO disco (no uno nuevo)', async () => {
    const { k8s, mocks } = fakeK8s({
      pods: [
        pod('t1', { expiresAt: new Date(Date.now() - 1000).toISOString() }),
      ],
      pvcs: [pvc('t1')],
    });
    const info = await service(k8s).start('t1', { files: {}, ttlSeconds: 60 });
    expect(info.status).toBe('running');
    expect(mocks.deletePod).toHaveBeenCalledTimes(1); // limpieza del pod vencido
    expect(mocks.createPod).toHaveBeenCalledTimes(1); // uno nuevo
    expect(mocks.createPvc).not.toHaveBeenCalled(); // el disco no se toca
  });

  it('si falla al recrearlo, NO borra el disco (ya existía antes de este intento)', async () => {
    const { k8s, mocks } = fakeK8s({ pvcs: [pvc('t1')] });
    mocks.waitForPodRunning.mockRejectedValueOnce(
      new Error('sin cupo en el nodo'),
    );
    await expect(
      service(k8s).start('t1', { files: {}, ttlSeconds: 60 }),
    ).rejects.toThrow('sin cupo en el nodo');
    expect(mocks.deletePvc).not.toHaveBeenCalled();
  });
});

describe('TerminalWorkspaceService.exec', () => {
  async function run(
    k8sOptions: Parameters<typeof fakeK8s>[0],
    command = 'npm run build',
    timeoutSeconds = 120,
  ) {
    const fake = fakeK8s({ pods: [pod('t1')], ...k8sOptions });
    const events: TerminalStreamEvent[] = [];
    await service(fake.k8s).exec('t1', { command, timeoutSeconds }, (event) =>
      events.push(event),
    );
    return { ...fake, events };
  }

  it('reenvía stdout/stderr en orden y termina con el código de salida', async () => {
    const { events } = await run({
      scripts: [
        (options) => {
          options.onStdout(Buffer.from('compilando\n'));
          options.onStderr(Buffer.from('aviso\n'));
          return 2;
        },
      ],
    });
    expect(events).toEqual([
      { t: 'out', d: 'compilando\n' },
      { t: 'err', d: 'aviso\n' },
      { t: 'exit', code: 2, truncated: false },
    ]);
  });

  it('el comando va como dato (argumento), nunca dentro del texto del script', async () => {
    const hostile = '\'; rm -rf / #"$(reboot)';
    const { calls } = await run({}, hostile, 45);
    const command = calls[0]?.command ?? [];
    expect(command.slice(0, 2)).toEqual(['node', '-e']);
    expect(command[3]).toBe('45');
    expect(command.at(-1)).toBe(hostile);
    expect(command[2]).not.toContain('rm -rf');
    expect(command).toHaveLength(5);
  });

  it('no parte un carácter multibyte entre dos chunks', async () => {
    const bytes = Buffer.from('ñandú 🎉');
    const { events } = await run({
      scripts: [
        (options) => {
          options.onStdout(bytes.subarray(0, 1));
          options.onStdout(bytes.subarray(1, 3));
          options.onStdout(bytes.subarray(3, bytes.length - 2));
          options.onStdout(bytes.subarray(bytes.length - 2));
          return 0;
        },
      ],
    });
    const text = events
      .filter((event) => event.t === 'out')
      .map((event) => (event as { d: string }).d)
      .join('');
    expect(text).toBe('ñandú 🎉');
  });

  it('corta la salida a los 512 KB y avisa que se truncó', async () => {
    const abort = vi.fn();
    const fake = fakeK8s({ pods: [pod('t1')] });
    const mocks = fake.mocks;
    mocks.execInPod.mockImplementationOnce(
      (_name: string, options: PodExecOptions) => {
        const big = Buffer.alloc(300 * 1024, 'a');
        options.onStdout(big);
        options.onStdout(big); // pasa el tope: se ignora y se aborta
        options.onStdout(Buffer.from('nunca llega'));
        return Promise.resolve({
          exitCode: Promise.reject(new Error('conexión cerrada')),
          abort,
        });
      },
    );
    const events: TerminalStreamEvent[] = [];
    await service(fake.k8s).exec(
      't1',
      { command: 'yes', timeoutSeconds: 10 },
      (event) => events.push(event),
    );
    expect(abort).toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ t: 'exit', code: -1, truncated: true });
    expect(
      events.some(
        (event) => event.t === 'out' && event.d.includes('nunca llega'),
      ),
    ).toBe(false);
  });

  it('un comando a la vez por proyecto', async () => {
    const fake = fakeK8s({ pods: [pod('t1')] });
    let release: (code: number) => void = () => undefined;
    fake.mocks.execInPod.mockImplementationOnce(() =>
      Promise.resolve({
        exitCode: new Promise<number>((resolve) => {
          release = resolve;
        }),
        abort: vi.fn(),
      }),
    );
    const svc = service(fake.k8s);
    const first = svc.exec(
      't1',
      { command: 'sleep 5', timeoutSeconds: 10 },
      () => undefined,
    );
    await vi.waitFor(() => expect(fake.mocks.execInPod).toHaveBeenCalled());
    await expect(
      svc.exec('t1', { command: 'ls', timeoutSeconds: 10 }, () => undefined),
    ).rejects.toBeInstanceOf(TerminalBusyError);
    release(0);
    await first;
    // Ya libre: el siguiente corre.
    await expect(
      svc.exec('t1', { command: 'ls', timeoutSeconds: 10 }, () => undefined),
    ).resolves.toBeUndefined();
  });

  it('proyecto sin disco: error claro (404), no runningo ejecuta nada', async () => {
    const missing = fakeK8s();
    await expect(
      service(missing.k8s).exec(
        'nope',
        { command: 'ls', timeoutSeconds: 10 },
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(TerminalWorkspaceNotFoundError);
    expect(missing.mocks.execInPod).not.toHaveBeenCalled();
  });

  it('con disco pero sin pod (nunca se inició, o se detuvo): pide iniciarlo (409), distinto de "no existe" (404)', async () => {
    const stopped = fakeK8s({ pvcs: [pvc('t1')] });
    await expect(
      service(stopped.k8s).exec(
        't1',
        { command: 'ls', timeoutSeconds: 10 },
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(TerminalNotRunningError);
  });

  it('vencido o sin arrancar: error claro y no se ejecuta nada', async () => {
    const expired = fakeK8s({
      pods: [
        pod('t1', { expiresAt: new Date(Date.now() - 1000).toISOString() }),
      ],
    });
    await expect(
      service(expired.k8s).exec(
        't1',
        { command: 'ls', timeoutSeconds: 10 },
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(TerminalNotRunningError);
    expect(expired.mocks.execInPod).not.toHaveBeenCalled();

    const pending = fakeK8s({ pods: [pod('t1', { phase: 'Pending' })] });
    await expect(
      service(pending.k8s).exec(
        't1',
        { command: 'ls', timeoutSeconds: 10 },
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(TerminalNotRunningError);
  });

  it('un pod al que ya se le pidió borrarse (deletionTimestamp) no acepta comandos, aunque siga en phase Running', async () => {
    const terminating = pod('t1');
    if (terminating.metadata)
      terminating.metadata.deletionTimestamp = new Date();
    const fake = fakeK8s({ pods: [terminating] });
    await expect(
      service(fake.k8s).exec(
        't1',
        { command: 'ls', timeoutSeconds: 10 },
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(TerminalNotRunningError);
    expect(fake.mocks.execInPod).not.toHaveBeenCalled();
  });

  it('un pod con otro tipo de label no se trata como terminal de un proyecto', async () => {
    const preview: V1Pod = {
      metadata: {
        name: 'agent-terminal-x',
        labels: { 'jin.io/type': 'service' },
      },
      status: { phase: 'Running' },
    };
    const fake = fakeK8s({ pods: [preview] });
    await expect(
      service(fake.k8s).exec(
        'x',
        { command: 'ls', timeoutSeconds: 10 },
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(TerminalWorkspaceNotFoundError);
  });

  it('si la conexión cae, informa un evento error (no cuelga ni lanza)', async () => {
    const { events } = await run({
      scripts: [
        () => {
          throw new Error('conexión perdida');
        },
      ],
    });
    expect(events).toEqual([{ t: 'error', message: 'conexión perdida' }]);
  });
});

describe('TerminalWorkspaceService: actividad (para el reaper por inactividad)', () => {
  it('exec toca la actividad del pod, pero no más seguido que cada 60 s', async () => {
    vi.useFakeTimers();
    try {
      const start = new Date('2026-09-28T10:00:00.000Z');
      vi.setSystemTime(start);
      const fake = fakeK8s({
        pods: [pod('t1')],
        scripts: [() => 0, () => 0, () => 0],
      });
      const svc = service(fake.k8s);

      await svc.exec(
        't1',
        { command: 'ls', timeoutSeconds: 10 },
        () => undefined,
      );
      expect(fake.patchCalls).toHaveLength(1);
      expect(fake.patchCalls[0]).toEqual({
        name: 'agent-terminal-t1',
        key: 'jin.io/last-activity-at',
        value: start.toISOString(),
      });

      vi.setSystemTime(new Date(start.getTime() + 30_000)); // dentro del throttle
      await svc.exec(
        't1',
        { command: 'ls', timeoutSeconds: 10 },
        () => undefined,
      );
      expect(fake.patchCalls).toHaveLength(1);

      vi.setSystemTime(new Date(start.getTime() + 61_000)); // ya pasó
      await svc.exec(
        't1',
        { command: 'ls', timeoutSeconds: 10 },
        () => undefined,
      );
      expect(fake.patchCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TerminalWorkspaceService.expose', () => {
  const exposeRequest = {
    dir: 'dist',
    port: 8080,
    serverSource: 'console.log(1)',
  } as const;

  it('sin dist/index.html no publica nada', async () => {
    const { k8s, mocks } = fakeK8s({ pods: [pod('t1')], scripts: [() => 1] });
    await expect(service(k8s).expose('t1', exposeRequest)).rejects.toThrow(
      /corre el build primero/,
    );
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it('con build: sube el servidor, lo arranca, comprueba que responde y crea Service, policy e IngressRoute', async () => {
    const { k8s, mocks, calls } = fakeK8s({
      pods: [pod('t1')],
      scripts: [() => 0, () => 0, () => 0, () => 0],
    });
    const exposure = await service(k8s).expose('t1', {
      ...exposeRequest,
      slugHint: 'mi-app',
    });

    expect(exposure.url).toMatch(
      /^https:\/\/mi-app-[a-z0-9]{6}\.jinserver\.com$/,
    );
    // el servidor de Jin se sube a /tmp, no al espacio de trabajo del owner
    expect(calls[1]?.command.at(-1)).toBe('/tmp');
    expect(
      JSON.parse(calls[1]?.stdin?.toString('utf8').split('\n')[1] ?? '{}'),
    ).toEqual({
      files: { '.jin/static-server.mjs': 'console.log(1)' },
    });
    // el directorio del build es un argumento, no parte del script
    expect(calls[2]?.command.at(-1)).toBe('dist');
    const created = mocks.createService.mock.calls[0]?.[0] as V1Service;
    expect(created.metadata?.annotations?.['jin.io/slug']).toBe(exposure.slug);
    expect(created.metadata?.name).toBe('agent-service-t1');
    expect(mocks.createNetworkPolicy).toHaveBeenCalledTimes(1);
    expect(mocks.createIngressRoute).toHaveBeenCalledTimes(1);
  });

  it('si el servidor no responde, no expone y muestra el log', async () => {
    const { k8s, mocks } = fakeK8s({
      pods: [pod('t1')],
      scripts: [
        () => 0,
        () => 0,
        () => 0,
        ...Array.from({ length: 6 }, () => () => 1),
        (options) => {
          options.onStdout(Buffer.from('SyntaxError: algo'));
          return 0;
        },
      ],
    });
    await expect(service(k8s).expose('t1', exposeRequest)).rejects.toThrow(
      /SyntaxError: algo/,
    );
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it('si ya publicó, responde 409 y no crea nada más', async () => {
    const existing: V1Service = {
      metadata: {
        name: 'agent-service-t1',
        labels: { 'jin.io/service-id': 't1' },
        annotations: { 'jin.io/slug': 'ya-abc123' },
      },
    };
    const { k8s, mocks } = fakeK8s({ pods: [pod('t1')], services: [existing] });
    const error = await service(k8s)
      .expose('t1', exposeRequest)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TerminalExposeError);
    expect((error as TerminalExposeError).httpStatus).toBe(409);
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it('si falla crear el IngressRoute, deshace lo que ya había creado', async () => {
    const { k8s, mocks } = fakeK8s({
      pods: [pod('t1')],
      scripts: [() => 0, () => 0, () => 0, () => 0],
    });
    mocks.createIngressRoute.mockRejectedValueOnce(
      new Error('traefik no responde'),
    );
    await expect(service(k8s).expose('t1', exposeRequest)).rejects.toThrow(
      'traefik no responde',
    );
    expect(mocks.deleteService).toHaveBeenCalled();
    expect(mocks.deleteIngressRoute).toHaveBeenCalled();
  });
});

describe('TerminalWorkspaceService: servidores en segundo plano y vista previa', () => {
  it('lanzar un servidor manda el comando y el puerto como argumentos (nunca dentro del script)', async () => {
    const { k8s, calls } = fakeK8s({
      pods: [pod('t1')],
      scripts: [
        (o) => {
          o.onStdout(
            Buffer.from(
              JSON.stringify({ status: 'listening', port: 5173, log: 'ready' }),
            ),
          );
          return 0;
        },
      ],
    });
    const hostile = 'npm run dev; $(reboot) "\'';
    const result = await service(k8s).startService('t1', {
      command: hostile,
      port: 5173,
    });

    expect(result).toMatchObject({ status: 'listening', port: 5173 });
    const command = calls[0]?.command ?? [];
    expect(command.slice(0, 2)).toEqual(['node', '-e']);
    expect(command.slice(3)).toEqual(['start', '5173', hostile]);
    expect(command[2]).not.toContain('reboot');
  });

  it('listar, detener y ver el log de un servidor exigen un pod corriendo', async () => {
    const missing = fakeK8s();
    await expect(
      service(missing.k8s).listServices('nope'),
    ).rejects.toBeInstanceOf(TerminalWorkspaceNotFoundError);
    await expect(
      service(missing.k8s).stopService('nope', 5173),
    ).rejects.toBeInstanceOf(TerminalWorkspaceNotFoundError);
    await expect(
      service(missing.k8s).serviceLogs('nope', 5173),
    ).rejects.toBeInstanceOf(TerminalWorkspaceNotFoundError);
    expect(missing.mocks.execInPod).not.toHaveBeenCalled();
  });

  it('listar devuelve los servidores; si el script falla, error claro (502)', async () => {
    const ok = fakeK8s({
      pods: [pod('t1')],
      scripts: [
        (o) => {
          o.onStdout(
            Buffer.from(
              JSON.stringify({
                services: [
                  {
                    port: 5173,
                    command: 'npm run dev',
                    startedAt: 'x',
                    running: true,
                    listening: true,
                  },
                ],
              }),
            ),
          );
          return 0;
        },
      ],
    });
    expect((await service(ok.k8s).listServices('t1'))[0]).toMatchObject({
      port: 5173,
      listening: true,
    });

    const bad = fakeK8s({
      pods: [pod('t1')],
      scripts: [
        (o) => {
          o.onStderr(Buffer.from('boom'));
          return 1;
        },
      ],
    });
    await expect(service(bad.k8s).listServices('t1')).rejects.toThrow(/boom/);
  });

  it('el proxy reenvía al proyecto y traduce un fallo de red a 502; una ruta no permitida a 400', async () => {
    const proxyToPod = vi
      .fn()
      .mockResolvedValue({ status: 200, headers: {}, body: {} });
    const fake = fakeK8s({ pods: [pod('t1')], proxyToPod });
    const svc = service(fake.k8s);
    const request = { method: 'GET', path: '/', headers: {} };

    await svc.proxy('t1', 5173, request);
    expect(proxyToPod).toHaveBeenCalledWith('agent-terminal-t1', 5173, request);

    proxyToPod.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const down = await svc.proxy('t1', 5173, request).catch((e: unknown) => e);
    expect((down as { httpStatus: number }).httpStatus).toBe(502);

    proxyToPod.mockRejectedValueOnce(new Error('ruta no permitida'));
    const bad = await svc.proxy('t1', 5173, request).catch((e: unknown) => e);
    expect((bad as { httpStatus: number }).httpStatus).toBe(400);

    await expect(svc.proxy('nope', 5173, request)).rejects.toBeInstanceOf(
      TerminalWorkspaceNotFoundError,
    );
  });
});

describe('TerminalWorkspaceService.list', () => {
  it('un pod que se está borrando no cuenta: ni se lista ni ocupa el cupo de un pod nuevo', async () => {
    const terminating = pod('t1');
    if (terminating.metadata)
      terminating.metadata.deletionTimestamp = new Date();
    const { k8s, mocks } = fakeK8s({ pods: [terminating] });
    expect(await service(k8s).list()).toEqual([]);
    await expect(
      service(k8s).start('otro', { files: {}, ttlSeconds: 60 }),
    ).resolves.toBeDefined();
    expect(mocks.createPod).toHaveBeenCalledTimes(1);
  });

  it('un disco sin pod aparece "stopped", sin TTL ni actividad; con pod trae todo, ordenado por creado más reciente', async () => {
    const svcResource: V1Service = {
      metadata: {
        name: 'agent-service-t1',
        labels: { 'jin.io/service-id': 't1' },
        annotations: { 'jin.io/slug': 'sitio-abc123' },
      },
    };
    const { k8s } = fakeK8s({
      pods: [
        pod('t1'),
        pod('t2', { phase: 'Pending' }),
        pod('t3', { expiresAt: new Date(Date.now() - 1000).toISOString() }),
      ],
      pvcs: [
        pvc('t1', { createdAt: '2026-09-27T00:00:00.000Z' }),
        pvc('t2', { createdAt: '2026-09-28T00:00:00.000Z' }),
        pvc('t3', { createdAt: '2026-09-26T00:00:00.000Z' }),
        pvc('t5-parado', { createdAt: '2026-09-29T00:00:00.000Z' }),
      ],
      services: [svcResource],
    });
    const list = await service(k8s).list();

    expect(list.map((w) => w.id)).toEqual(['t5-parado', 't2', 't1', 't3']);
    const stopped = list.find((w) => w.id === 't5-parado');
    expect(stopped).toMatchObject({
      status: 'stopped',
      expiresAt: null,
      requestId: null,
      exposure: null,
      lastActivityAt: null,
    });
    const running = list.find((w) => w.id === 't1');
    expect(running?.status).toBe('running');
    expect(running?.exposure).toEqual({
      slug: 'sitio-abc123',
      url: 'https://sitio-abc123.jinserver.com',
    });
    expect(list.find((w) => w.id === 't2')?.status).toBe('starting');
    expect(list.find((w) => w.id === 't3')?.status).toBe('expired');
  });
});

describe('TerminalWorkspaceService.list — PVC en proceso de borrado', () => {
  it('un disco al que ya se le pidió borrarse no cuenta como que el proyecto sigue ahí', async () => {
    const deleting = pvc('t1');
    if (deleting.metadata) deleting.metadata.deletionTimestamp = new Date();
    const { k8s } = fakeK8s({ pvcs: [deleting] });
    expect(await service(k8s).list()).toEqual([]);
  });
});

describe('TerminalWorkspaceService.stopPod / deleteWorkspace', () => {
  it('detener corta primero el tráfico y destruye el pod al final, y NUNCA toca el disco', async () => {
    const { k8s, order, mocks } = fakeK8s();
    await service(k8s).stopPod('t1');
    expect(order).toEqual([
      'deleteIngressRoute',
      'deleteService',
      'deleteNetworkPolicy',
      'deleteNetworkPolicy',
      'deletePod',
    ]);
    expect(mocks.deletePvc).not.toHaveBeenCalled();
  });

  it('no falla si ya no existe nada', async () => {
    const { k8s } = fakeK8s();
    await expect(service(k8s).stopPod('nope')).resolves.toBeUndefined();
    await expect(service(k8s).deleteWorkspace('nope')).resolves.toBeUndefined();
  });

  it('eliminar el workspace detiene el pod (si corre) y DESPUÉS borra el disco', async () => {
    const { k8s, order } = fakeK8s({ pods: [pod('t1')], pvcs: [pvc('t1')] });
    await service(k8s).deleteWorkspace('t1');
    expect(order).toEqual([
      'deleteIngressRoute',
      'deleteService',
      'deleteNetworkPolicy',
      'deleteNetworkPolicy',
      'deletePod',
      'deletePvcOrThrow',
    ]);
  });

  it('si el disco NO se pudo borrar, deleteWorkspace falla (no devuelve "eliminado" con el disco todavía ahí)', async () => {
    const { k8s, mocks } = fakeK8s({ pods: [pod('t1')], pvcs: [pvc('t1')] });
    mocks.deletePvcOrThrow.mockRejectedValueOnce(new Error('API caída'));

    await expect(service(k8s).deleteWorkspace('t1')).rejects.toThrow(
      'API caída',
    );
  });
});

describe('TerminalWorkspaceService.start — Claude Code (ADR 0017)', () => {
  it('sin la bandera: ni label, ni proxy, ni regla de salida a Anthropic', async () => {
    const { k8s, mocks } = fakeK8s({ scripts: [() => 0] });
    const info = await service(k8s).start('c0', {
      files: {},
      ttlSeconds: 1800,
    });

    const pod = mocks.createPod.mock.calls[0]?.[0] as V1Pod;
    expect(pod.metadata?.labels?.['jin.io/claude']).toBeUndefined();
    const policy = mocks.createNetworkPolicy.mock.calls[0]?.[0] as {
      spec: { egress: unknown[] };
    };
    expect(policy.spec.egress).toHaveLength(1);
    expect(info.claudeCode).toBe(false);
  });

  it('con la bandera: el pod lleva el label y el proxy, la política suma la regla, y la info lo dice', async () => {
    const { k8s, mocks } = fakeK8s({ scripts: [() => 0] });
    const info = await service(k8s).start('c1', {
      files: {},
      ttlSeconds: 1800,
      claudeCode: true,
    });

    const pod = mocks.createPod.mock.calls[0]?.[0] as V1Pod;
    expect(pod.metadata?.labels?.['jin.io/claude']).toBe('enabled');
    const env = Object.fromEntries(
      (pod.spec?.containers[0]?.env ?? []).map((e) => [e.name, e.value]),
    );
    expect(env.HTTPS_PROXY).toBe(
      'http://claude-egress.claude-egress.svc.cluster.local:3128',
    );
    expect(env.NO_PROXY).toContain(
      'verdaccio.registry-proxy.svc.cluster.local',
    );
    const policy = mocks.createNetworkPolicy.mock.calls[0]?.[0] as {
      spec: { egress: { ports: { port: number }[] }[] };
    };
    expect(policy.spec.egress).toHaveLength(2);
    expect(policy.spec.egress[1]?.ports).toEqual([
      { protocol: 'TCP', port: 3128 },
    ]);
    expect(info.claudeCode).toBe(true);
  });
});
