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

/**
 * El probe apunta a la **ClusterIP** del servicio, no a su nombre DNS, y a
 * propósito: con DNS, un `fetch` que falla porque CoreDNS todavía no resuelve
 * es indistinguible de uno que falla porque la NetworkPolicy lo bloqueó —
 * ambos caen en el `catch` y reportan `BLOCKED:`. Ese falso positivo hacía que
 * este test de SEGURIDAD pasara sin probar nada (ver `beforeAll`). Sin DNS de
 * por medio, `BLOCKED:` solo puede significar bloqueo de red.
 */
function probeCodeDataUrl(targetIp: string): string {
  const code = `
      try {
        const resp = await fetch('http://${targetIp}', { signal: AbortSignal.timeout(8000) });
        console.log('REACHED:' + resp.status);
      } catch (e) {
        console.log('BLOCKED:' + e.constructor.name);
      }
    `;
  return `data:application/typescript;base64,${Buffer.from(code, 'utf-8').toString('base64')}`;
}

describe('PodLifecycleService (integración, K3s real)', () => {
  let testK3s: TestK3s;
  let kubeconfigTmpDir: string;
  let service: PodLifecycleService;
  let targetIp: string;
  /** ¿Este K3s aplica NetworkPolicies de verdad? Ver `beforeAll`. */
  let netpolEnforced = false;
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

    const targetService = await testK3s.coreApi.readNamespacedService({
      name: 'target-service',
      namespace: JIN_NAMESPACE,
    });
    const clusterIp = targetService.spec?.clusterIP;
    if (!clusterIp) throw new Error('target-service se creó sin ClusterIP');
    targetIp = clusterIp;

    await waitForTargetReady();
    await detectNetworkPolicyEnforcement();
  }, 180_000);

  /**
   * Lanza un pod en agents-sandbox que intenta alcanzar el servicio de `jin`
   * y devuelve sus logs (`BLOCKED:...` o `REACHED:<status>`).
   */
  async function runIsolationProbe(podName: string): Promise<string> {
    await testK3s.coreApi.createNamespacedPod({
      namespace: AGENTS_SANDBOX_NAMESPACE,
      body: {
        metadata: { name: podName, namespace: AGENTS_SANDBOX_NAMESPACE },
        spec: {
          restartPolicy: 'Never',
          activeDeadlineSeconds: 30,
          // Este pod lo arma el test (no buildPodSpec), pero vive en
          // agents-sandbox: tiene que cumplir PSA `restricted` como cualquiera.
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'probe',
              image: DENO_IMAGE,
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] },
              },
              command: [
                'deno',
                'run',
                `--allow-net=${targetIp}`,
                probeCodeDataUrl(targetIp),
              ],
            },
          ],
        },
      },
    });

    const finalPod = await k8s.waitForPod(podName, 30_000);
    expect(finalPod.status?.phase).toBe('Succeeded');
    const logs = await k8s.getPodLogs(podName);
    await k8s.deletePod(podName);
    return logs;
  }

  /**
   * El pod destino tiene que estar ACEPTANDO conexiones antes de medir nada.
   * Si no, un probe falla por "todavía no hay nadie escuchando" y eso es
   * indistinguible de "la NetworkPolicy lo bloqueó": otro falso `BLOCKED:`
   * que hacía pasar el test sin probar la propiedad (CI, 2026-09-21).
   */
  async function waitForTargetReady(): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const pod = await testK3s.coreApi.readNamespacedPod({
        name: 'target-http-echo',
        namespace: JIN_NAMESPACE,
      });
      const ready = pod.status?.conditions?.some(
        (c) => c.type === 'Ready' && c.status === 'True',
      );
      if (ready) return;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    throw new Error('target-http-echo nunca llegó a Ready');
  }

  /**
   * Determina si ESTE clúster aplica NetworkPolicies de verdad, y espera a que
   * lo haga: la API acepta el objeto al instante, pero el controlador
   * (kube-router en K3s) todavía tiene que programar las reglas.
   *
   * Por qué es necesario: antes, el probe apuntaba al nombre DNS y reportaba
   * `BLOCKED:` ante CUALQUIER excepción — incluida "CoreDNS todavía no
   * resuelve". El primer probe salía antes que el DNS, reportaba `BLOCKED:` y
   * el test pasaba **sin que ninguna NetworkPolicy hubiera bloqueado nada**.
   * Con el probe por IP eso ya no puede pasar.
   *
   * Si dentro del plazo la política nunca bloquea, este entorno no puede
   * verificar la propiedad (K3s anidado en Docker no siempre aplica
   * NetworkPolicies) y el test se salta con un aviso ruidoso, en vez de
   * "pasar" y dar una garantía falsa. El aislamiento real se verifica contra
   * el clúster de producción (activation.md, prueba 8).
   */
  async function detectNetworkPolicyEnforcement(): Promise<void> {
    const deadline = Date.now() + 120_000;
    for (let attempt = 1; Date.now() < deadline; attempt++) {
      const logs = await runIsolationProbe(`netpol-canary-${attempt}`);
      if (logs.includes('BLOCKED:')) {
        netpolEnforced = true;
        return;
      }
    }
  }

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

  it('AISLAMIENTO: un pod en agents-sandbox NO puede alcanzar un servicio en jin', async (ctx) => {
    // Se construye el pod directamente (sin pasar por PodLifecycleService ni
    // por la whitelist de tools) precisamente para probar la propiedad de
    // infraestructura en sí misma: la NetworkPolicy de agents-sandbox. Por eso
    // el probe SÍ lleva --allow-net (permiso de Deno concedido a propósito) —
    // lo que debe bloquear la conexión es la NetworkPolicy de Kubernetes, no
    // el sandboxing de Deno (que ya se prueba en pod-spec.builder.spec.ts).
    if (!netpolEnforced) {
      // Saltar a propósito y con motivo: no es un test deshabilitado, es un
      // entorno que no puede probar la propiedad. Ver `detectNetworkPolicyEnforcement`.
      // eslint-disable-next-line vitest/no-disabled-tests
      ctx.skip(
        'Este K3s no aplica NetworkPolicies (K3s anidado en Docker): el test ' +
          'no puede verificar el aislamiento acá y NO se hace pasar por verde. ' +
          'La verificación real corre contra el clúster: activation.md, prueba 8.',
      );
      return;
    }

    // `beforeAll` ya confirmó que la política bloquea de verdad, así que acá
    // la aserción es de un solo intento: si ve REACHED, es un agujero real.
    const logs = await runIsolationProbe('isolation-probe');

    expect(logs).toContain('BLOCKED:');
    expect(logs).not.toContain('REACHED:');
  }, 60_000);
});
