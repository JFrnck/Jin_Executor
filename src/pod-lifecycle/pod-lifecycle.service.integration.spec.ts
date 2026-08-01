import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENTS_SANDBOX_NAMESPACE,
  startTestK3s,
  JIN_NAMESPACE,
  type TestK3s,
} from '../../test/support/k3s-testcontainer';
import { K8sService } from '../k8s/k8s.service';
import { ModalService } from '../modal/modal.service';
import { RbacValidatorService } from '../rbac/rbac-validator.service';
import { PodLifecycleService } from './pod-lifecycle.service';

const DENO_IMAGE = 'docker.io/denoland/deno:distroless-2.9.3';
const HTTP_ECHO_IMAGE = 'docker.io/hashicorp/http-echo:1.0.0';

describe('PodLifecycleService (integración, K3s real)', () => {
  let testK3s: TestK3s;
  let kubeconfigTmpDir: string;
  let service: PodLifecycleService;
  let k8s: K8sService;

  beforeAll(async () => {
    testK3s = await startTestK3s([DENO_IMAGE, HTTP_ECHO_IMAGE]);

    kubeconfigTmpDir = mkdtempSync(
      path.join(tmpdir(), 'jin-executor-kubeconfig-'),
    );
    const kubeconfigPath = path.join(kubeconfigTmpDir, 'kubeconfig.yaml');
    writeFileSync(kubeconfigPath, testK3s.kubeConfigString);

    const configService = new ConfigService({
      KUBECONFIG_PATH: kubeconfigPath,
      AGENTS_SANDBOX_NAMESPACE,
      DENO_IMAGE,
      // Este test solo ejercita el tier LOCAL (pods Deno) — ModalService
      // nunca llega a invocar la API real de Modal acá, solo necesita
      // construirse sin lanzar (Zod ya no corre en este ConfigService de
      // prueba, así que estos valores son puramente para no crashear el
      // constructor de ModalService).
      MODAL_TOKEN_ID: 'test-token-id',
      MODAL_TOKEN_SECRET: 'test-token-secret',
    });

    k8s = new K8sService(configService);
    service = new PodLifecycleService(
      new RbacValidatorService(),
      k8s,
      new ModalService(configService),
      configService,
    );

    // Objetivo del test de aislamiento: un servicio HTTP trivial en el
    // namespace `jin` (el núcleo confiable, BLUEPRINT 5.2).
    await testK3s.coreApi.createNamespacedPod({
      namespace: JIN_NAMESPACE,
      body: {
        metadata: {
          name: 'target-http-echo',
          namespace: JIN_NAMESPACE,
          labels: { app: 'target' },
        },
        spec: {
          restartPolicy: 'Always',
          containers: [
            {
              name: 'echo',
              image: HTTP_ECHO_IMAGE,
              args: ['-listen=:8080', '-text=hello-from-jin-namespace'],
              ports: [{ containerPort: 8080 }],
            },
          ],
        },
      },
    });
    await testK3s.coreApi.createNamespacedService({
      namespace: JIN_NAMESPACE,
      body: {
        metadata: { name: 'target-service', namespace: JIN_NAMESPACE },
        spec: {
          selector: { app: 'target' },
          ports: [{ port: 80, targetPort: 8080 }],
        },
      },
    });
  }, 180_000);

  afterAll(async () => {
    // Si beforeAll falló antes de asignar testK3s, no hay nada que
    // limpiar — evita un segundo error que tape el real.
    if (testK3s) {
      await testK3s.stop();
    }
    if (kubeconfigTmpDir) {
      rmSync(kubeconfigTmpDir, { recursive: true, force: true });
    }
  });

  it('ejecuta código real en un pod Deno y devuelve sus logs (camino feliz, sin egreso)', async () => {
    const result = await service.run({
      tool: 'runCode',
      code: "console.log('hello from pod')",
      language: 'typescript',
      env: {},
      timeout: 60,
    });

    expect(result.succeeded).toBe(true);
    expect(result.logs).toContain('hello from pod');

    // Limpieza: el pod se destruye siempre, éxito o no (BLUEPRINT 4.4).
    await expect(
      k8s.readPod(`agent-run-${result.runId}`),
    ).rejects.toBeDefined();
  }, 120_000);

  it('AISLAMIENTO: un pod en agents-sandbox NO puede alcanzar un servicio en jin', async () => {
    // Se construye el pod directamente (sin pasar por PodLifecycleService
    // ni por la whitelist de tools) precisamente para probar la
    // propiedad de infraestructura en sí misma: la NetworkPolicy de
    // agents-sandbox. Por eso el probe SÍ lleva --allow-net (permiso de
    // Deno concedido a propósito) — lo que debe bloquear la conexión es
    // la NetworkPolicy de Kubernetes, no el sandboxing de Deno (que ya se
    // prueba aparte en pod-spec.builder.spec.ts). Usa "deno run" con un
    // data: URL, igual que buildPodSpec: "deno eval" ignora --allow-net
    // por completo en Deno 2.9 (ver el comentario en pod-spec.builder.ts).
    const probeCode = `
      try {
        const resp = await fetch('http://target-service.jin.svc.cluster.local', { signal: AbortSignal.timeout(8000) });
        console.log('REACHED:' + resp.status);
      } catch (e) {
        console.log('BLOCKED:' + e.constructor.name);
      }
    `;
    const probeCodeDataUrl = `data:application/typescript;base64,${Buffer.from(probeCode, 'utf-8').toString('base64')}`;

    const podName = 'isolation-probe';
    await testK3s.coreApi.createNamespacedPod({
      namespace: AGENTS_SANDBOX_NAMESPACE,
      body: {
        metadata: { name: podName, namespace: AGENTS_SANDBOX_NAMESPACE },
        spec: {
          restartPolicy: 'Never',
          activeDeadlineSeconds: 30,
          containers: [
            {
              name: 'probe',
              image: DENO_IMAGE,
              command: [
                'deno',
                'run',
                '--allow-net=target-service.jin.svc.cluster.local',
                probeCodeDataUrl,
              ],
            },
          ],
        },
      },
    });

    const finalPod = await k8s.waitForPod(podName, 30_000);
    const logs = await k8s.getPodLogs(podName);

    expect(finalPod.status?.phase).toBe('Succeeded');
    // La conexión NUNCA debe llegar a destino — debe fallar por la
    // NetworkPolicy (timeout/refused), nunca ver un status HTTP real.
    expect(logs).toContain('BLOCKED:');
    expect(logs).not.toContain('REACHED:');

    await k8s.deletePod(podName);
  }, 60_000);
});
