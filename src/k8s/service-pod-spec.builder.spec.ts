import { describe, expect, it } from 'vitest';
import {
  buildIngressRoute,
  buildService,
  buildServicePodSpec,
} from './service-pod-spec.builder';

describe('buildServicePodSpec', () => {
  const baseInput = {
    serviceId: 'svc-1',
    slug: 'demo-a1b2c3',
    namespace: 'agents-sandbox',
    nodeImage: 'docker.io/library/node:22-alpine',
    workspaceTarGzBase64: 'ZmFrZS10YXItcGF5bG9hZA==',
    command: ['node', 'index.js'],
    port: 3000,
    expiresAt: new Date('2026-08-01T12:00:00.000Z'),
  };

  it('nombra el pod como agent-service-<serviceId>, lo etiqueta como tipo "service" y anota TTL + slug', () => {
    const pod = buildServicePodSpec(baseInput);

    expect(pod.metadata?.name).toBe('agent-service-svc-1');
    expect(pod.metadata?.labels).toEqual({
      'jin.io/service-id': 'svc-1',
      'jin.io/type': 'service',
    });
    expect(pod.metadata?.annotations?.['jin.io/expires-at']).toBe(
      '2026-08-01T12:00:00.000Z',
    );
    expect(pod.metadata?.annotations?.['jin.io/slug']).toBe('demo-a1b2c3');
  });

  it('restartPolicy: Always (opuesto a los pods run-to-completion) — nunca activeDeadlineSeconds', () => {
    const pod = buildServicePodSpec(baseInput);
    expect(pod.spec?.restartPolicy).toBe('Always');
    expect(pod.spec?.activeDeadlineSeconds).toBeUndefined();
  });

  it('el init container recibe el payload SOLO vía env var (nunca interpolado en el comando en sí)', () => {
    const pod = buildServicePodSpec(baseInput);
    const initContainer = pod.spec?.initContainers?.[0];

    expect(initContainer?.name).toBe('extract-workspace');
    const commandStr = (initContainer?.command ?? []).join(' ');
    // El payload NO debe aparecer embebido en el comando — pasa como var
    // de entorno, no interpolado directamente (misma razón que
    // buildPodSpec evita construir un string de shell con datos externos).
    expect(commandStr).not.toContain(baseInput.workspaceTarGzBase64);
    expect(
      initContainer?.env?.find((e) => e.name === 'WORKSPACE_TAR_GZ_BASE64')
        ?.value,
    ).toBe(baseInput.workspaceTarGzBase64);
  });

  it('el contenedor principal corre el command declarado y expone el puerto', () => {
    const pod = buildServicePodSpec(baseInput);
    const container = pod.spec?.containers?.[0];

    expect(container?.command).toEqual(['node', 'index.js']);
    expect(container?.ports).toEqual([{ containerPort: 3000 }]);
  });

  it('monta el PVC compartido de pnpm-store (ADR 0006 punto 4) además del workspace', () => {
    const pod = buildServicePodSpec(baseInput);
    const volumes = pod.spec?.volumes ?? [];

    const pnpmVolume = volumes.find((v) => v.name === 'pnpm-store');
    expect(pnpmVolume?.persistentVolumeClaim?.claimName).toBe('pnpm-store');
    const workspaceVolume = volumes.find((v) => v.name === 'workspace');
    expect(workspaceVolume?.emptyDir).toBeDefined();
  });

  it('respeta el LimitRange de agents-sandbox: request/limit dentro de 512Mi/500m default y 2Gi/1500m máximo', () => {
    const pod = buildServicePodSpec(baseInput);
    const resources = pod.spec?.containers?.[0]?.resources;

    expect(resources?.requests?.memory).toBe('256Mi');
    expect(resources?.limits?.memory).toBe('1Gi');
    expect(resources?.limits?.cpu).toBe('1000m');
  });

  it('nunca corre como root: securityContext consistente con buildPodSpec', () => {
    const pod = buildServicePodSpec(baseInput);
    expect(pod.spec?.securityContext?.runAsNonRoot).toBe(true);
    expect(
      pod.spec?.containers?.[0]?.securityContext?.allowPrivilegeEscalation,
    ).toBe(false);
  });

  // `readOnlyRootFilesystem: true` en el container `app` se probó en este
  // mismo PR y se revirtió: colgó el smoke test de K3s real sin causa
  // identificable sin acceso a un clúster real (ver comentario en
  // service-pod-spec.builder.ts). El zip-slip en sí queda cerrado en la
  // capa de datos (tar-payload.spec.ts / preview-service-request.schema.spec.ts),
  // no depende de este endurecimiento adicional.

  it('cumple PSA "restricted" de agents-sandbox: seccompProfile RuntimeDefault a nivel de pod (cubre init container y app)', () => {
    const pod = buildServicePodSpec(baseInput);

    // Sin esto el API server responde 403 "violates PodSecurity restricted".
    expect(pod.spec?.securityContext?.seccompProfile).toEqual({
      type: 'RuntimeDefault',
    });
  });

  it('el init container extract-workspace declara resources propios, no depende del LimitRange de otro repo (docs/RECOMENDACIONES.md #26)', () => {
    const pod = buildServicePodSpec(baseInput);
    const resources = pod.spec?.initContainers?.[0]?.resources;

    expect(resources?.requests?.cpu).toBe('250m');
    expect(resources?.requests?.memory).toBe('256Mi');
    expect(resources?.limits?.cpu).toBe('500m');
    expect(resources?.limits?.memory).toBe('512Mi');
  });
});

describe('buildService', () => {
  it('selecciona el pod por su service-id y mapea el puerto declarado', () => {
    const service = buildService({
      serviceId: 'svc-1',
      namespace: 'agents-sandbox',
      port: 3000,
    });

    expect(service.metadata?.name).toBe('agent-service-svc-1');
    expect(service.spec?.selector).toEqual({ 'jin.io/service-id': 'svc-1' });
    expect(service.spec?.ports).toEqual([{ port: 3000, targetPort: 3000 }]);
  });
});

describe('buildIngressRoute', () => {
  it('arma el Host rule bajo <slug>.jinserver.com, nunca jeanfranck.com (regla de oro #10)', () => {
    const route = buildIngressRoute({
      serviceId: 'svc-1',
      namespace: 'agents-sandbox',
      slug: 'demo-a1b2c3',
      port: 3000,
      tlsSecretName: 'wildcard-jinserver-com-tls',
    }) as {
      apiVersion: string;
      kind: string;
      spec: { routes: { match: string }[]; tls: { secretName: string } };
    };

    expect(route.apiVersion).toBe('traefik.io/v1alpha1');
    expect(route.kind).toBe('IngressRoute');
    expect(route.spec.routes[0]?.match).toBe(
      'Host(`demo-a1b2c3.jinserver.com`)',
    );
    expect(route.spec.routes[0]?.match).not.toContain('jeanfranck.com');
    expect(route.spec.tls.secretName).toBe('wildcard-jinserver-com-tls');
  });
});
