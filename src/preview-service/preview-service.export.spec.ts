import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { V1Pod } from '@kubernetes/client-node';
import type { K8sService, PodExecOptions } from '../k8s/k8s.service';
import { RbacValidatorService } from '../rbac/rbac-validator.service';
import { PreviewServiceLifecycleService } from './preview-service.service';
import {
  PreviewServiceExportError,
  PreviewServiceNotFoundError,
} from './errors';

function pod(
  id: string,
  over: { expiresAt?: string; requestId?: string } = {},
): V1Pod {
  return {
    metadata: {
      name: `agent-service-${id}`,
      labels: { 'jin.io/service-id': id, 'jin.io/type': 'service' },
      annotations: {
        'jin.io/slug': 'demo-a1b2c3',
        'jin.io/expires-at':
          over.expiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
        ...(over.requestId ? { 'jin.io/request-id': over.requestId } : {}),
      },
    },
  };
}

function setup(pods: V1Pod[], script?: (o: PodExecOptions) => number) {
  const calls: { name: string; options: PodExecOptions }[] = [];
  const k8s = {
    namespace: 'agents-sandbox',
    listPodsByLabel: vi.fn().mockResolvedValue(pods),
    execInPod: vi.fn().mockImplementation((name: string, o: PodExecOptions) => {
      calls.push({ name, options: o });
      return Promise.resolve({
        exitCode: Promise.resolve(script ? script(o) : 0),
        abort: vi.fn(),
      });
    }),
  } as unknown as K8sService;
  const service = new PreviewServiceLifecycleService(
    new RbacValidatorService(),
    k8s,
    { get: (_k: string, d: unknown) => d } as unknown as ConfigService,
  );
  return { service, calls };
}

describe('PreviewServiceLifecycleService.exportFiles', () => {
  it('lee los archivos DENTRO del contenedor del servicio, con el directorio como argumento', async () => {
    const { service, calls } = setup([pod('s1')], (o) => {
      o.onStdout(
        Buffer.from(
          JSON.stringify({
            files: { 'index.html': '<h1>x</h1>' },
            skipped: [],
          }),
        ),
      );
      return 0;
    });

    const result = await service.exportFiles('s1', 'src');

    expect(result.files).toEqual({ 'index.html': '<h1>x</h1>' });
    expect(calls[0]?.name).toBe('agent-service-s1');
    expect(calls[0]?.options.container).toBe('app');
    expect(calls[0]?.options.command.slice(0, 2)).toEqual(['node', '-e']);
    expect(calls[0]?.options.command.at(-1)).toBe('src');
  });

  it('un servicio que no existe o ya venció no se lee (404) y no ejecuta nada', async () => {
    const missing = setup([]);
    await expect(
      missing.service.exportFiles('nope', '.'),
    ).rejects.toBeInstanceOf(PreviewServiceNotFoundError);
    const expired = setup([
      pod('s1', { expiresAt: new Date(Date.now() - 1000).toISOString() }),
    ]);
    await expect(expired.service.exportFiles('s1', '.')).rejects.toBeInstanceOf(
      PreviewServiceNotFoundError,
    );
    expect(expired.calls).toEqual([]);
  });

  it('si el pod falla o devuelve algo que no es JSON, error claro (502)', async () => {
    const failing = setup([pod('s1')], (o) => {
      o.onStderr(Buffer.from('node: not found'));
      return 127;
    });
    await expect(failing.service.exportFiles('s1', '.')).rejects.toThrow(
      /node: not found/,
    );

    const garbage = setup([pod('s1')], (o) => {
      o.onStdout(Buffer.from('esto no es json'));
      return 0;
    });
    await expect(garbage.service.exportFiles('s1', '.')).rejects.toBeInstanceOf(
      PreviewServiceExportError,
    );
  });

  it('la lista de servicios trae la aprobación que los originó, si la tienen', async () => {
    const { service } = setup([
      pod('s1', { requestId: '11111111-1111-4111-8111-111111111111' }),
      pod('s2'),
    ]);
    const list = await service.list();
    expect(list[0]?.requestId).toBe('11111111-1111-4111-8111-111111111111');
    expect(list[1]).not.toHaveProperty('requestId');
  });
});
