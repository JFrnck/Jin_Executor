import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { V1Pod } from '@kubernetes/client-node';
import type { K8sService } from '../k8s/k8s.service';
import { ForbiddenToolError } from '../rbac/errors';
import { RbacValidatorService } from '../rbac/rbac-validator.service';
import { PreviewServiceLimitError } from './errors';
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
  return { get: (key: string) => values[key] } as unknown as ConfigService;
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
    expect(deletePod).toHaveBeenCalledWith('agent-service-svc-1');
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
