import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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
import { PreviewServiceReaperService } from './preview-service-reaper.service';
import { PreviewServiceLifecycleService } from './preview-service.service';

const NODE_IMAGE = 'docker.io/library/node:22-alpine';
const BUSYBOX_IMAGE = 'docker.io/library/busybox:1.37.0';
// Usada solo por el pod-probe de kube-system (mismo image del resto del
// repo para "deno run" con --allow-net, ver isolation test de PodLifecycleService).
const DENO_IMAGE = 'docker.io/denoland/deno:distroless-2.9.3';
const PNPM_STORE_PVC_NAME = 'pnpm-store';

/**
 * `@testcontainers/k3s` arranca con `--disable=traefik` (verificado en
 * su código fuente) — el CRD `IngressRoute` no existe en este clúster de
 * prueba por defecto. En vez de mockear `createIngressRoute` (lo que
 * dejaría el manifest real de `buildIngressRoute` sin validar contra un
 * apiserver real), se registra acá un `CustomResourceDefinition`
 * mínimo-pero-válido para `ingressroutes.traefik.io/v1alpha1` — sin
 * controller de Traefik reconciliándolo (no hay ruteo real), pero el
 * apiserver SÍ valida y persiste el objeto, ejercitando el código real
 * de principio a fin. No hay DNS/TLS reales disponibles en
 * testcontainers de todos modos (mismo criterio de éxito de PROMPTS.md
 * §5.5, verificado como HTTP dentro del clúster).
 */
async function registerIngressRouteCrd(
  kubeConfigString: string,
): Promise<void> {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromString(kubeConfigString);
  const apiextensionsApi = kubeConfig.makeApiClient(ApiextensionsV1Api);

  await apiextensionsApi.createCustomResourceDefinition({
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
                // `apiextensions.k8s.io/v1` exige preserve-unknown-fields
                // POR VERSIÓN (el campo `spec.preserveUnknownFields` de
                // v1beta1 quedó prohibido) — el tipo `V1JSONSchemaProps`
                // de este cliente no expone ese campo, así que se agrega
                // vía cast: esquema abierto a propósito, este test no
                // necesita validar la forma exacta del spec de Traefik
                // (eso lo hace `service-pod-spec.builder.spec.ts`), solo
                // que el apiserver real acepte y persista el objeto.
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

  // El apiserver tarda un instante en registrar el recurso nuevo en su
  // discovery — sin esperar, el primer create/delete real puede pegarle
  // a una API todavía no publicada.
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
describe('PreviewServiceLifecycleService (integración, K3s real)', () => {
  let testK3s: TestK3s;
  let kubeconfigTmpDir: string;
  let service: PreviewServiceLifecycleService;
  let reaper: PreviewServiceReaperService;
  let k8s: K8sService;

  beforeAll(async () => {
    testK3s = await startTestK3s([NODE_IMAGE, BUSYBOX_IMAGE, DENO_IMAGE]);
    await registerIngressRouteCrd(testK3s.kubeConfigString);

    await testK3s.coreApi.createNamespacedPersistentVolumeClaim({
      namespace: AGENTS_SANDBOX_NAMESPACE,
      body: {
        metadata: {
          name: PNPM_STORE_PVC_NAME,
          namespace: AGENTS_SANDBOX_NAMESPACE,
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: '100Mi' } },
        },
      },
    });

    kubeconfigTmpDir = mkdtempSync(
      path.join(tmpdir(), 'jin-executor-preview-service-kubeconfig-'),
    );
    const kubeconfigPath = path.join(kubeconfigTmpDir, 'kubeconfig.yaml');
    writeFileSync(kubeconfigPath, testK3s.kubeConfigString);

    const configService = new ConfigService({
      KUBECONFIG_PATH: kubeconfigPath,
      AGENTS_SANDBOX_NAMESPACE,
      PREVIEW_SERVICE_NODE_IMAGE: NODE_IMAGE,
      PREVIEW_SERVICE_DEFAULT_TTL_SECONDS: 3600,
      PREVIEW_SERVICE_MAX_TTL_SECONDS: 86400,
      PREVIEW_SERVICE_MAX_CONCURRENT: 3,
    });

    k8s = new K8sService(configService);
    service = new PreviewServiceLifecycleService(
      new RbacValidatorService(),
      k8s,
      configService,
    );
    reaper = new PreviewServiceReaperService(service);
  }, 180_000);

  afterAll(async () => {
    if (testK3s) {
      await testK3s.stop();
    }
    if (kubeconfigTmpDir) {
      rmSync(kubeconfigTmpDir, { recursive: true, force: true });
    }
  });

  it('camino feliz: el pod de servicio arranca y el Service responde HTTP dentro del clúster', async () => {
    const info = await service.start({
      tool: 'startPreviewService',
      files: {
        'index.js':
          'require("http").createServer((req, res) => res.end("hola-desde-preview")).listen(process.env.PORT);',
      },
      command: ['node', 'index.js'],
      port: 3000,
      ttlSeconds: 3600,
    });

    expect(info.status).toBe('running');

    // Probe desde kube-system: es el único namespace que la
    // NetworkPolicy de ingreso del pod de servicio permite (mismo
    // origen que usaría Traefik en producción, ver
    // buildServiceIngressNetworkPolicy) — un pod en agents-sandbox
    // sería bloqueado a propósito, igual que prueba el test de
    // aislamiento de PodLifecycleService.
    const podName = `agent-service-${info.id}`;
    await waitUntilPodRunning(k8s, podName);

    const probeCode = `
      try {
        const resp = await fetch('http://${podName}.agents-sandbox.svc.cluster.local:3000', { signal: AbortSignal.timeout(8000) });
        const text = await resp.text();
        console.log('REACHED:' + text);
      } catch (e) {
        console.log('BLOCKED:' + e.constructor.name);
      }
    `;
    await runProbeInKubeSystem(testK3s, k8s, probeCode);

    await service.stop(info.id);
  }, 120_000);

  it('el reaper destruye pod + Service + NetworkPolicy vencidos', async () => {
    const info = await service.start({
      tool: 'startPreviewService',
      files: {
        'index.js':
          'require("http").createServer((_,r)=>r.end("x")).listen(process.env.PORT);',
      },
      command: ['node', 'index.js'],
      port: 3000,
      // TTL ya vencido a propósito — el reaper lo debe destruir en la
      // primera pasada, sin esperar el intervalo real del @Cron.
      ttlSeconds: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    await reaper.reapExpired();

    // `deletePod` inicia el borrado (grace period default de K8s,
    // ~30s) — no es instantáneo, así que se espera a que el pod
    // desaparezca en vez de asumir un throw inmediato.
    const podName = `agent-service-${info.id}`;
    await waitUntilPodGone(k8s, podName);

    await expect(k8s.readPod(podName)).rejects.toBeDefined();
  }, 60_000);
});

async function waitUntilPodGone(
  k8s: K8sService,
  podName: string,
  timeoutMs = 40_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await k8s.readPod(podName);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Pod ${podName} seguía existiendo tras ${timeoutMs}ms`);
}

async function waitUntilPodRunning(
  k8s: K8sService,
  podName: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pod = await k8s.readPod(podName);
    if (pod.status?.phase === 'Running') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Pod ${podName} no llegó a Running dentro de ${timeoutMs}ms`);
}

async function runProbeInKubeSystem(
  testK3s: TestK3s,
  k8s: K8sService,
  code: string,
): Promise<void> {
  const probeCodeDataUrl = `data:application/typescript;base64,${Buffer.from(code, 'utf-8').toString('base64')}`;
  const podName = 'preview-service-probe';
  await testK3s.coreApi.createNamespacedPod({
    namespace: 'kube-system',
    body: {
      metadata: { name: podName, namespace: 'kube-system' },
      spec: {
        restartPolicy: 'Never',
        activeDeadlineSeconds: 30,
        containers: [
          {
            name: 'probe',
            image: DENO_IMAGE,
            command: ['deno', 'run', '--allow-net', probeCodeDataUrl],
          },
        ],
      },
    },
  });

  const deadline = Date.now() + 30_000;
  let phase: string | undefined;
  while (Date.now() < deadline) {
    const pod = await testK3s.coreApi.readNamespacedPod({
      name: podName,
      namespace: 'kube-system',
    });
    phase = pod.status?.phase;
    if (phase === 'Succeeded' || phase === 'Failed') break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const logs = await testK3s.coreApi.readNamespacedPodLog({
    name: podName,
    namespace: 'kube-system',
  });
  expect(phase).toBe('Succeeded');
  expect(logs).toContain('REACHED:hola-desde-preview');

  await testK3s.coreApi.deleteNamespacedPod({
    name: podName,
    namespace: 'kube-system',
  });
}
