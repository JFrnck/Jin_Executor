import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { V1Pod } from '@kubernetes/client-node';
import type { K8sService } from '../k8s/k8s.service';
import { ForbiddenToolError } from '../rbac/errors';
import { RbacValidatorService } from '../rbac/rbac-validator.service';
import {
  PreviewServiceLimitError,
  PreviewServiceNotFoundError,
  PreviewServiceTtlCapError,
} from './errors';
import { PreviewServiceLifecycleService } from './preview-service.service';

// Cada método queda como const nombrada (no `k8s.metodo` en las
// aserciones) — mismo patrón que pod-lifecycle.service.spec.ts
// (`runRemoteMock`): evita que @typescript-eslint/unbound-method
// se queje de leer un método de clase como referencia suelta.
function fakeK8s(overrides: Partial<Record<keyof K8sService, unknown>> = {}) {
  const listPodsByLabel = vi.fn().mockResolvedValue([]);
  const createPod = vi.fn().mockResolvedValue({});
  const createNetworkPolicy = vi.fn().mockResolvedValue(undefined);
  const createService = vi.fn().mockResolvedValue({});
  const createIngressRoute = vi.fn().mockResolvedValue(undefined);
  const deleteIngressRoute = vi.fn().mockResolvedValue(undefined);
  const deleteService = vi.fn().mockResolvedValue(undefined);
  const deleteNetworkPolicy = vi.fn().mockResolvedValue(undefined);
  const deletePod = vi.fn().mockResolvedValue(undefined);

  const mocks = {
    listPodsByLabel,
    createPod,
    createNetworkPolicy,
    createService,
    createIngressRoute,
    deleteIngressRoute,
    deleteService,
    deleteNetworkPolicy,
    deletePod,
    ...overrides,
  };

  const k8s = {
    namespace: 'agents-sandbox',
    ...mocks,
  } as unknown as K8sService;

  return { k8s, ...mocks };
}

function fakeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    PREVIEW_SERVICE_NODE_IMAGE: 'docker.io/library/node:22-alpine',
    PREVIEW_SERVICE_DEFAULT_TTL_SECONDS: 3600,
    PREVIEW_SERVICE_MAX_TTL_SECONDS: 86400,
    PREVIEW_SERVICE_MAX_CONCURRENT: 3,
    ...overrides,
  };
  // Como el ConfigService real: sin valor configurado, devuelve el default del llamador.
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    tool: 'startPreviewService',
    files: { 'index.js': 'console.log("hola")' },
    command: ['node', 'index.js'],
    port: 3000,
    ttlSeconds: 3600,
    ...overrides,
  } as Parameters<PreviewServiceLifecycleService['start']>[0];
}

describe('PreviewServiceLifecycleService.start', () => {
  it('rechaza con ForbiddenToolError si la tool no es una de servicio (fail-safe simétrico a PodLifecycleService)', async () => {
    const { k8s } = fakeK8s();
    const service = new PreviewServiceLifecycleService(
      new RbacValidatorService(),
      k8s,
      fakeConfig(),
    );

    await expect(
      service.start(baseRequest({ tool: 'runCode' })),
    ).rejects.toThrow(ForbiddenToolError);
  });

  it('rechaza con ForbiddenToolError una tool fuera de whitelist', async () => {
    const { k8s } = fakeK8s();
    const service = new PreviewServiceLifecycleService(
      new RbacValidatorService(),
      k8s,
      fakeConfig(),
    );

    await expect(
      service.start(baseRequest({ tool: 'borrarTodo' })),
    ).rejects.toThrow(ForbiddenToolError);
  });

  it('lanza PreviewServiceLimitError al alcanzar max_concurrent_services, sin crear ningún recurso', async () => {
    const { k8s, createPod } = fakeK8s({
      listPodsByLabel: vi.fn().mockResolvedValue([{}, {}, {}]),
    });
    const service = new PreviewServiceLifecycleService(
      new RbacValidatorService(),
      k8s,
      fakeConfig({ PREVIEW_SERVICE_MAX_CONCURRENT: 3 }),
    );

    await expect(service.start(baseRequest())).rejects.toThrow(
      PreviewServiceLimitError,
    );
    expect(createPod).not.toHaveBeenCalled();
  });

  it('crea pod + NetworkPolicy + Service + IngressRoute, en ese orden, y devuelve la URL bajo jinserver.com', async () => {
    const {
      k8s,
      createPod,
      createNetworkPolicy,
      createService,
      createIngressRoute,
    } = fakeK8s();
    const service = new PreviewServiceLifecycleService(
      new RbacValidatorService(),
      k8s,
      fakeConfig(),
    );

    const result = await service.start(baseRequest());

    expect(createPod).toHaveBeenCalledTimes(1);
    expect(createNetworkPolicy).toHaveBeenCalledTimes(1);
    expect(createService).toHaveBeenCalledTimes(1);
    expect(createIngressRoute).toHaveBeenCalledTimes(1);
    expect(result.url).toMatch(/^https:\/\/.+\.jinserver\.com$/);
    expect(result.status).toBe('running');
  });

  it('npm: crea ANTES del pod la policy de salida SOLO a Verdaccio, y el pod lleva label y variables de npm', async () => {
    const order: string[] = [];
    const createPod = vi.fn((pod: V1Pod): Promise<unknown> => {
      order.push(`pod:${JSON.stringify(pod.metadata?.labels)}`);
      return Promise.resolve({});
    });
    const createNetworkPolicy = vi.fn(
      (policy: { metadata?: { name?: string } }) => {
        order.push(`policy:${policy.metadata?.name ?? ''}`);
        return Promise.resolve(undefined);
      },
    );
    const { k8s } = fakeK8s({ createPod, createNetworkPolicy });
    const service = new PreviewServiceLifecycleService(
      new RbacValidatorService(),
      k8s,
      fakeConfig(),
    );

    const result = await service.start(baseRequest({ npm: true }));

    expect(order[0]).toMatch(/^policy:.+-egress$/);
    expect(order[1]).toContain('"jin.io/npm":"enabled"');
    expect(order[2]).toMatch(/^policy:.+-ingress$/);

    const egress = createNetworkPolicy.mock.calls[0]?.[0] as unknown as {
      spec: { policyTypes: string[]; egress: { ports: { port: number }[] }[] };
    };
    expect(egress.spec.policyTypes).toEqual(['Egress']);
    expect(egress.spec.egress).toHaveLength(1);
    expect(egress.spec.egress[0]?.ports).toEqual([
      { protocol: 'TCP', port: 4873 },
    ]);

    const env = (createPod.mock.calls[0]?.[0].spec?.containers[0]?.env ??
      []) as {
      name: string;
      value?: string;
    }[];
    const get = (name: string) => env.find((e) => e.name === name)?.value;
    expect(get('npm_config_registry')).toBe(
      'http://verdaccio.registry-proxy.svc.cluster.local:4873',
    );
    expect(get('npm_config_ignore_scripts')).toBe('true');
    expect(result.url).toMatch(/jinserver\.com$/);
  });

  it('sin npm: ni policy de salida, ni label, ni variables de npm (el pod no llega a ningún registro)', async () => {
    const { k8s, createPod, createNetworkPolicy } = fakeK8s();
    const service = new PreviewServiceLifecycleService(
      new RbacValidatorService(),
      k8s,
      fakeConfig(),
    );

    await service.start(baseRequest());

    expect(createNetworkPolicy).toHaveBeenCalledTimes(1); // solo la de ingreso
    const pod = (createPod as Mock).mock.calls[0]?.[0] as V1Pod;
    expect(pod.metadata?.labels).not.toHaveProperty('jin.io/npm');
    const names = (pod.spec?.containers[0]?.env ?? []).map((e) => e.name);
    expect(names).not.toContain('npm_config_registry');
    expect(names).not.toContain('npm_config_ignore_scripts');
  });

  it('acota ttlSeconds al cap duro configurado, nunca confía en el valor del request', async () => {
    const { k8s } = fakeK8s();
    const service = new PreviewServiceLifecycleService(
      new RbacValidatorService(),
      k8s,
      fakeConfig({ PREVIEW_SERVICE_MAX_TTL_SECONDS: 100 }),
    );

    const before = Date.now();
    const result = await service.start(baseRequest({ ttlSeconds: 999_999 }));
    const expiresInMs = new Date(result.expiresAt).getTime() - before;

    // Acotado a 100s (con margen por el tiempo real de ejecución del test).
    expect(expiresInMs).toBeLessThanOrEqual(101_000);
    expect(expiresInMs).toBeGreaterThan(0);
  });

  it('nunca vuelve a contar el servicio recién creado como parte del límite de la MISMA llamada (chequeo de límite antes de crear)', async () => {
    const { k8s, createPod } = fakeK8s({
      listPodsByLabel: vi.fn().mockResolvedValue([]),
    });
    const service = new PreviewServiceLifecycleService(
      new RbacValidatorService(),
      k8s,
      fakeConfig({ PREVIEW_SERVICE_MAX_CONCURRENT: 1 }),
    );

    await service.start(baseRequest());
    expect(createPod).toHaveBeenCalledTimes(1);
  });
});

describe('PreviewServiceLifecycleService.stop', () => {
  it('borra IngressRoute, Service, NetworkPolicy y Pod — todos, sin lanzar si alguno ya no existe', async () => {
    const {
      k8s,
      deleteIngressRoute,
      deleteService,
      deleteNetworkPolicy,
      deletePod,
    } = fakeK8s();
    const service = new PreviewServiceLifecycleService(
      new RbacValidatorService(),
      k8s,
      fakeConfig(),
    );

    await service.stop('svc-1');

    expect(deleteIngressRoute).toHaveBeenCalledWith('agent-service-svc-1');
    expect(deleteService).toHaveBeenCalledWith('agent-service-svc-1');
    expect(deleteNetworkPolicy).toHaveBeenCalledWith('svc-1-ingress');
    // También la de salida a npm (no-throw: si el servicio no la tenía, no pasa nada).
    expect(deleteNetworkPolicy).toHaveBeenCalledWith('svc-1-egress');
    expect(deletePod).toHaveBeenCalledWith('agent-service-svc-1');
  });
});

describe('PreviewServiceLifecycleService.extend', () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  function podCreatedAgo(createdMsAgo: number, expiresInMs: number): V1Pod {
    return {
      metadata: {
        name: 'agent-service-svc-1',
        creationTimestamp: new Date(Date.now() - createdMsAgo),
        labels: { 'jin.io/service-id': 'svc-1' },
        annotations: {
          'jin.io/expires-at': new Date(Date.now() + expiresInMs).toISOString(),
          'jin.io/slug': 'demo-abc123',
        },
      },
    };
  }

  function setup(pod: V1Pod, maxTtl = 7 * 86_400) {
    const replacePodAnnotationStrict = vi.fn().mockResolvedValue(undefined);
    const { k8s } = fakeK8s({
      listPodsByLabel: vi.fn().mockResolvedValue([pod]),
      replacePodAnnotationStrict,
    });
    const service = new PreviewServiceLifecycleService(
      new RbacValidatorService(),
      k8s,
      fakeConfig({ PREVIEW_SERVICE_MAX_TTL_SECONDS: maxTtl }),
    );
    return { service, replacePodAnnotationStrict };
  }

  it('suma al vencimiento actual y actualiza la annotation', async () => {
    const { service, replacePodAnnotationStrict } = setup(
      podCreatedAgo(2 * HOUR, 22 * HOUR),
    );
    const before = Date.now();

    const result = await service.extend('svc-1', DAY / 1000);

    const expected = before + 22 * HOUR + DAY;
    expect(
      Math.abs(new Date(result.expiresAt).getTime() - expected),
    ).toBeLessThan(5_000);
    expect(replacePodAnnotationStrict).toHaveBeenCalledWith(
      'agent-service-svc-1',
      'jin.io/expires-at',
      result.expiresAt,
    );
  });

  it('nunca pasa del tope desde la CREACIÓN del pod: recorta lo que sobra', async () => {
    // Creado hace 6 días, vence en 12 h: el tope de 7 días deja solo 1 día desde la creación.
    const { service } = setup(podCreatedAgo(6 * DAY, 12 * HOUR));
    const created = Date.now() - 6 * DAY;

    const result = await service.extend('svc-1', (3 * DAY) / 1000);

    expect(
      Math.abs(new Date(result.expiresAt).getTime() - (created + 7 * DAY)),
    ).toBeLessThan(5_000);
  });

  it('en el tope no alarga y lo dice (409), sin tocar el pod', async () => {
    const { service, replacePodAnnotationStrict } = setup(
      podCreatedAgo(6 * DAY + 23 * HOUR, 1 * HOUR),
    );

    await expect(service.extend('svc-1', 3600)).rejects.toBeInstanceOf(
      PreviewServiceTtlCapError,
    );
    expect(replacePodAnnotationStrict).not.toHaveBeenCalled();
  });

  it('un servicio vencido no se renueva (404, el reaper puede estar destruyéndolo)', async () => {
    const { service, replacePodAnnotationStrict } = setup(
      podCreatedAgo(2 * DAY, -1000),
    );

    await expect(service.extend('svc-1', 3600)).rejects.toBeInstanceOf(
      PreviewServiceNotFoundError,
    );
    expect(replacePodAnnotationStrict).not.toHaveBeenCalled();
  });

  it('un id que no existe es 404', async () => {
    const { service } = setup(podCreatedAgo(HOUR, HOUR));
    await expect(service.extend('otro', 3600)).rejects.toBeInstanceOf(
      PreviewServiceNotFoundError,
    );
  });

  it('si el K8s falla al anotar, el error SALE (no se miente con un nuevo vencimiento)', async () => {
    const pod = podCreatedAgo(HOUR, HOUR);
    const { k8s } = fakeK8s({
      listPodsByLabel: vi.fn().mockResolvedValue([pod]),
      replacePodAnnotationStrict: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const service = new PreviewServiceLifecycleService(
      new RbacValidatorService(),
      k8s,
      fakeConfig(),
    );

    await expect(service.extend('svc-1', 3600)).rejects.toThrow('boom');
  });
});

describe('PreviewServiceLifecycleService.list', () => {
  it('deriva status "expired" de la annotation de TTL vencida, "running" si no', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const pods: V1Pod[] = [
      {
        metadata: {
          labels: { 'jin.io/service-id': 'expired-1' },
          annotations: {
            'jin.io/expires-at': past,
            'jin.io/slug': 'demo-abc123',
          },
        },
      },
      {
        metadata: {
          labels: { 'jin.io/service-id': 'running-1' },
          annotations: {
            'jin.io/expires-at': future,
            'jin.io/slug': 'demo2-def456',
          },
        },
      },
    ];
    const { k8s } = fakeK8s({
      listPodsByLabel: vi.fn().mockResolvedValue(pods),
    });
    const service = new PreviewServiceLifecycleService(
      new RbacValidatorService(),
      k8s,
      fakeConfig(),
    );

    const result = await service.list();

    expect(result.find((s) => s.id === 'expired-1')?.status).toBe('expired');
    expect(result.find((s) => s.id === 'running-1')?.status).toBe('running');
  });

  it('lista por el label selector de servicio, no de run-to-completion', async () => {
    const { k8s, listPodsByLabel } = fakeK8s();
    const service = new PreviewServiceLifecycleService(
      new RbacValidatorService(),
      k8s,
      fakeConfig(),
    );

    await service.list();

    expect(listPodsByLabel).toHaveBeenCalledWith('jin.io/type=service');
  });
});
