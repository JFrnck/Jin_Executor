import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ModalNotImplementedError } from '../modal/errors';
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
function buildService(): PodLifecycleService {
  const fakeConfigService = new ConfigService({});
  return new PodLifecycleService(
    new RbacValidatorService(),
    {} as K8sService,
    new ModalService(),
    fakeConfigService,
  );
}

describe('PodLifecycleService — ramas previas a K8s', () => {
  it('rechaza con ForbiddenToolError una tool fuera de whitelist, sin tocar K8s', async () => {
    const service = buildService();

    await expect(
      service.run({
        tool: 'deleteEverything',
        code: 'x',
        env: {},
        timeout: 30,
        remote: false,
      }),
    ).rejects.toThrow(ForbiddenToolError);
  });

  it('remote:true delega en ModalService (stub: lanza ModalNotImplementedError)', async () => {
    const service = buildService();

    await expect(
      service.run({
        tool: 'runCode',
        code: 'x',
        env: {},
        timeout: 30,
        remote: true,
      }),
    ).rejects.toThrow(ModalNotImplementedError);
  });
});
