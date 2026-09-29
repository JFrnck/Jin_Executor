import { describe, expect, it } from 'vitest';
import {
  buildTerminalEgressPolicy,
  buildTerminalPodSpec,
  buildTerminalWorkspacePvc,
} from './terminal-pod-spec.builder';

const NOW = new Date('2026-09-28T11:00:00.000Z');

const pod = buildTerminalPodSpec({
  workspaceId: 'abc',
  namespace: 'agents-sandbox',
  image: 'docker.io/library/node:22-alpine',
  npmRegistryUrl: 'http://verdaccio.registry-proxy.svc.cluster.local:4873',
  expiresAt: new Date('2026-09-28T12:00:00.000Z'),
  now: NOW,
});

describe('buildTerminalPodSpec', () => {
  it('cumple PSA restricted: sin root, sin escalada, sin capabilities y sin token de ServiceAccount', () => {
    expect(pod.spec?.automountServiceAccountToken).toBe(false);
    expect(pod.spec?.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    const container = pod.spec?.containers[0];
    expect(container?.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      privileged: false,
      capabilities: { drop: ['ALL'] },
    });
  });

  it('no expone puertos, y el espacio de trabajo es el PVC del proyecto (no el compartido pnpm-store)', () => {
    const container = pod.spec?.containers[0];
    expect(container?.ports).toBeUndefined();
    const workspaceVolume = pod.spec?.volumes?.find(
      (v) => v.name === 'workspace',
    );
    expect(workspaceVolume?.persistentVolumeClaim?.claimName).toBe(
      'terminal-ws-abc',
    );
    expect(workspaceVolume?.emptyDir).toBeUndefined();
    // /tmp sigue siendo scratch: no hace falta persistirlo.
    const tmpVolume = pod.spec?.volumes?.find((v) => v.name === 'tmp');
    expect(tmpVolume?.emptyDir).toBeDefined();
  });

  it('no le pasa nada del sistema: solo la URL del proxy y ajustes de npm', () => {
    const env = Object.fromEntries(
      (pod.spec?.containers[0]?.env ?? []).map((entry) => [
        entry.name,
        entry.value,
      ]),
    );
    expect(env.npm_config_registry).toBe(
      'http://verdaccio.registry-proxy.svc.cluster.local:4873',
    );
    expect(env.COREPACK_NPM_REGISTRY).toBe(env.npm_config_registry);
    // La caché de npm va al disco del proyecto: en /tmp (512 Mi) un `npm install`
    // de Vite expulsaba el pod (visto en producción).
    expect(env.npm_config_cache).toBe('/workspace/.cache/npm');
    expect(env.XDG_CACHE_HOME).toBe('/workspace/.cache');
    // Una ráfaga de conexiones nuevas saturaba al proxy (visto en K3s real).
    expect(env.npm_config_maxsockets).toBe('8');
    expect(env.npm_config_fetch_retries).toBe('5');
    for (const name of Object.keys(env)) {
      expect(name).not.toMatch(
        /TOKEN|SECRET|KEY|PASSWORD|DATABASE|MODAL|INFISICAL/i,
      );
    }
    expect(pod.spec?.containers[0]?.env?.some((entry) => entry.valueFrom)).toBe(
      false,
    );
  });

  it('está dentro del LimitRange (máx 1Gi/1000m, ratio de memoria ≤ 3) y no se reinicia solo', () => {
    const resources = pod.spec?.containers[0]?.resources;
    expect(resources?.limits).toEqual({ cpu: '1000m', memory: '1Gi' });
    expect(resources?.requests).toEqual({ cpu: '250m', memory: '384Mi' });
    expect(1024 / 384).toBeLessThanOrEqual(3);
    expect(pod.spec?.restartPolicy).toBe('Never');
  });

  it('lleva el label de tipo terminal (no aparece en la lista de previews), el TTL y una actividad inicial', () => {
    expect(pod.metadata?.labels).toEqual({
      'jin.io/service-id': 'abc',
      'jin.io/type': 'terminal',
    });
    expect(pod.metadata?.annotations?.['jin.io/expires-at']).toBe(
      '2026-09-28T12:00:00.000Z',
    );
    // Valor inicial: patchPodAnnotation() solo sabe REEMPLAZAR, la clave debe existir desde ya.
    expect(pod.metadata?.annotations?.['jin.io/last-activity-at']).toBe(
      NOW.toISOString(),
    );
    expect(pod.metadata?.name).toBe('agent-terminal-abc');
  });
});

describe('enlace con el audit', () => {
  it('el pod lleva la aprobación que lo originó, y sin ella no inventa nada', () => {
    const withId = buildTerminalPodSpec({
      workspaceId: 'abc',
      namespace: 'agents-sandbox',
      image: 'i',
      npmRegistryUrl: 'http://x:4873',
      expiresAt: new Date(),
      requestId: '11111111-1111-4111-8111-111111111111',
      now: NOW,
    });
    expect(withId.metadata?.annotations?.['jin.io/request-id']).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(pod.metadata?.annotations).not.toHaveProperty('jin.io/request-id');
  });
});

describe('buildTerminalWorkspacePvc', () => {
  const pvc = buildTerminalWorkspacePvc({
    workspaceId: 'abc',
    namespace: 'agents-sandbox',
    storageSize: '3Gi',
  });

  it('un disco por proyecto: nombre y label enlazados al mismo id que el pod', () => {
    expect(pvc.metadata?.name).toBe('terminal-ws-abc');
    expect(pvc.metadata?.labels).toEqual({
      'jin.io/service-id': 'abc',
      'jin.io/type': 'workspace',
    });
  });

  it('ReadWriteOnce (un solo nodo) y la cuota pedida', () => {
    expect(pvc.spec?.accessModes).toEqual(['ReadWriteOnce']);
    expect(pvc.spec?.resources?.requests?.storage).toBe('3Gi');
  });
});

describe('buildTerminalEgressPolicy', () => {
  const policy = buildTerminalEgressPolicy({
    workspaceId: 'abc',
    namespace: 'agents-sandbox',
    registryNamespace: 'registry-proxy',
    registryPort: 4873,
  });

  it('la única salida es el pod de Verdaccio, en su puerto, sin ipBlock hacia internet', () => {
    expect(policy.spec?.policyTypes).toEqual(['Egress']);
    expect(policy.spec?.egress).toHaveLength(1);
    const rule = policy.spec?.egress?.[0];
    expect(rule?.to).toEqual([
      {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': 'registry-proxy' },
        },
        podSelector: { matchLabels: { 'app.kubernetes.io/name': 'verdaccio' } },
      },
    ]);
    expect(rule?.ports).toEqual([{ protocol: 'TCP', port: 4873 }]);
    expect(JSON.stringify(policy)).not.toContain('ipBlock');
  });

  it('solo alcanza a los pods de ese proyecto', () => {
    expect(policy.spec?.podSelector).toEqual({
      matchLabels: { 'jin.io/service-id': 'abc' },
    });
  });
});
