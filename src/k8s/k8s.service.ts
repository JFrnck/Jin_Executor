import { Injectable, Logger } from '@nestjs/common';
import {
  CoreV1Api,
  KubeConfig,
  NetworkingV1Api,
  type V1NetworkPolicy,
  type V1Pod,
} from '@kubernetes/client-node';
import { ConfigService } from '@nestjs/config';
import { PodTimeoutError } from './errors';

const POD_POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Único punto de contacto con la API de Kubernetes en todo el proyecto
 * (AGENTS.md 5.3: "el código de Yormun_Core no importa
 * @kubernetes/client-node... Yormun_Executor es el único autorizado").
 *
 * `namespace` se fija UNA vez al construir el servicio y ningún método
 * acepta un namespace como parámetro — así el propio diseño hace
 * estructuralmente imposible que este servicio toque otro namespace que
 * no sea `agents-sandbox` (BLUEPRINT 4.2), más allá de lo que ya impone
 * el RBAC del ServiceAccount en el clúster real.
 */
@Injectable()
export class K8sService {
  private readonly logger = new Logger(K8sService.name);
  private readonly coreApi: CoreV1Api;
  private readonly networkingApi: NetworkingV1Api;
  readonly namespace: string;

  // Tipado como la clase real `ConfigService` (no el alias `AppConfigService`
  // de src/config): NestJS resuelve la inyección de dependencias vía
  // metadata de decoradores sobre el parámetro del constructor, y un
  // alias de tipo (`type X = ConfigService<Env, true>`) no deja rastro en
  // runtime — Nest no podría resolver el token. Los `.get()` de abajo
  // llevan su tipo explícito para no perder seguridad de tipos.
  constructor(configService: ConfigService) {
    const kubeConfig = new KubeConfig();
    const kubeconfigPath = configService.get<string | undefined>(
      'KUBECONFIG_PATH',
    );
    if (kubeconfigPath) {
      kubeConfig.loadFromFile(kubeconfigPath);
    } else {
      // Producción (BLUEPRINT 4.2): ServiceAccount montado del pod.
      kubeConfig.loadFromCluster();
    }
    this.coreApi = kubeConfig.makeApiClient(CoreV1Api);
    this.networkingApi = kubeConfig.makeApiClient(NetworkingV1Api);
    // Con la clase base ConfigService (no el alias validado), .get()
    // devuelve `T | undefined` — el default aquí espeja el de
    // env.schema.ts; en la práctica Zod ya garantiza un valor siempre.
    this.namespace = configService.get<string>(
      'AGENTS_SANDBOX_NAMESPACE',
      'agents-sandbox',
    );
  }

  async createPod(pod: V1Pod): Promise<V1Pod> {
    return this.coreApi.createNamespacedPod({
      namespace: this.namespace,
      body: pod,
    });
  }

  async readPod(name: string): Promise<V1Pod> {
    return this.coreApi.readNamespacedPod({ name, namespace: this.namespace });
  }

  async getPodLogs(name: string): Promise<string> {
    return this.coreApi.readNamespacedPodLog({
      name,
      namespace: this.namespace,
    });
  }

  /** Nunca lanza: borrar un pod que ya no existe no es un error real (pudo terminar y limpiarse antes). */
  async deletePod(name: string): Promise<void> {
    try {
      await this.coreApi.deleteNamespacedPod({
        name,
        namespace: this.namespace,
      });
    } catch (error) {
      this.logger.warn(
        `deletePod(${name}) falló (probablemente ya no existía): ${String(error)}`,
      );
    }
  }

  /** Poll hasta que el pod llegue a un estado terminal (Succeeded/Failed) o venza el timeout. */
  async waitForPod(name: string, timeoutMs: number): Promise<V1Pod> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const pod = await this.readPod(name);
      const phase = pod.status?.phase;
      if (phase === 'Succeeded' || phase === 'Failed') {
        return pod;
      }
      await sleep(POD_POLL_INTERVAL_MS);
    }

    throw new PodTimeoutError(name, timeoutMs);
  }

  async createNetworkPolicy(policy: V1NetworkPolicy): Promise<void> {
    await this.networkingApi.createNamespacedNetworkPolicy({
      namespace: this.namespace,
      body: policy,
    });
  }

  /** Nunca lanza: mismo razonamiento que deletePod. */
  async deleteNetworkPolicy(name: string): Promise<void> {
    try {
      await this.networkingApi.deleteNamespacedNetworkPolicy({
        name,
        namespace: this.namespace,
      });
    } catch (error) {
      this.logger.warn(
        `deleteNetworkPolicy(${name}) falló (probablemente ya no existía): ${String(error)}`,
      );
    }
  }
}
