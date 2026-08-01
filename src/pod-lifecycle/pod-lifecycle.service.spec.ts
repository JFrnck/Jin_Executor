import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ModalService } from '../modal/modal.service';
import { ForbiddenToolError } from '../rbac/errors';
import { RbacValidatorService } from '../rbac/rbac-validator.service';
import type { K8sService } from '../k8s/k8s.service';
import { PodLifecycleService } from './pod-lifecycle.service';

// Estas pruebas solo cubren ramas que retornan/lanzan ANTES de tocar K8s
// (rechazo RBAC, delegación a Modal) — por eso usan colaboradores reales
// (RbacValidatorService, ModalService) salvo K8sService, que ni siquiera
// se invoca en estos caminos y por eso puede quedar como placeholder sin
// comportamiento (AGENTS.md 6.3: nada de mocks de módulos internos). El
// camino feliz de ejecución local se prueba con K3s real en
// pod-lifecycle.service.integration.spec.ts.
const fakeConfigService = new ConfigService({
  MODAL_TOKEN_ID: 'test-token-id',
  MODAL_TOKEN_SECRET: 'test-token-secret',
});

function buildService(
  modal: ModalService = new ModalService(fakeConfigService),
) {
  return new PodLifecycleService(
    new RbacValidatorService(),
    {} as K8sService,
    modal,
    fakeConfigService,
  );
}

describe('PodLifecycleService — ramas previas a K8s', () => {
  it('rechaza con ForbiddenToolError una tool fuera de whitelist, sin tocar K8s ni Modal', async () => {
    const service = buildService();

    await expect(
      service.run({
        tool: 'deleteEverything',
        code: 'x',
        language: 'typescript',
        env: {},
        timeout: 30,
      }),
    ).rejects.toThrow(ForbiddenToolError);
  });

  it('rechaza con ForbiddenToolError una tool de pod de servicio (Fase 5.5) — fail-safe si algo se equivoca de ruta', async () => {
    const service = buildService();

    await expect(
      service.run({
        tool: 'startPreviewService',
        code: 'x',
        language: 'typescript',
        env: {},
        timeout: 30,
      }),
    ).rejects.toThrow(ForbiddenToolError);
  });

  it('language: "python" delega en ModalService.runRemote — decisión automática del Executor (BLUEPRINT 4.5), no del caller', async () => {
    const runRemoteMock = vi
      .fn()
      .mockResolvedValue({ runId: 'sb-1', succeeded: true, logs: 'ok' });
    const modal = { runRemote: runRemoteMock } as unknown as ModalService;
    const service = buildService(modal);

    const result = await service.run({
      tool: 'runCode',
      code: 'print(1)',
      language: 'python',
      env: {},
      timeout: 30,
    });

    expect(runRemoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'runCode' }),
      'print(1)',
      {},
    );
    expect(result).toEqual({ runId: 'sb-1', succeeded: true, logs: 'ok' });
  });
});
