import { Injectable, Logger } from '@nestjs/common';
import http from 'node:http';
import https from 'node:https';
import { Readable, Writable } from 'node:stream';
import {
  CoreV1Api,
  CustomObjectsApi,
  Exec,
  KubeConfig,
  NetworkingV1Api,
  type V1NetworkPolicy,
  type V1Pod,
  type V1Service,
  type V1Status,
} from '@kubernetes/client-node';
import { ConfigService } from '@nestjs/config';
import { PodTimeoutError } from './errors';

// Primer uso en el repo de un CRD de terceros (Fase 5.5, ADR 0006 punto
// 7): IngressRoute de Traefik. Grupo `traefik.io` (no el legado
// `traefik.containo.us`) — confirmado contra la versión de K3s pinneada
// en los tests de integración (v1.36.2-k3s1, bundlea Traefik v3).
const INGRESSROUTE_GROUP = 'traefik.io';
const INGRESSROUTE_VERSION = 'v1alpha1';
const INGRESSROUTE_PLURAL = 'ingressroutes';

const POD_POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Código de salida que informa Kubernetes en el `V1Status` final de un `exec`. */
export function exitCodeFromStatus(status: V1Status): number {
  if (status.status === 'Success') return 0;
  const cause = status.details?.causes?.find(
    (candidate) => candidate.reason === 'ExitCode',
  );
  const parsed = Number(cause?.message);
  return Number.isInteger(parsed) ? parsed : -1;
}

export interface PodProxyRequest {
  readonly method: string;
  /** Ruta dentro del pod, con `/` inicial y query (`/src/main.js?t=1`). */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Buffer | undefined;
  readonly timeoutMs?: number;
}

export interface PodProxyResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Readable;
}

export interface PodExecOptions {
  readonly container: string;
  readonly command: readonly string[];
  /** Si se pasa, el proceso lo recibe por stdin y ve EOF al terminar. */
  readonly stdin?: Buffer;
  readonly onStdout: (chunk: Buffer) => void;
  readonly onStderr: (chunk: Buffer) => void;
}

/** Lo mínimo que se usa del WebSocket de `Exec` (sus tipos vienen de `ws`, sin tipar acá). */
interface ExecSocket {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  close(): void;
}

export interface PodExecution {
  /** Resuelve con el código de salida; rechaza si la conexión se cae antes. */
  readonly exitCode: Promise<number>;
  /** Corta la conexión (el proceso puede seguir hasta su propio timeout). */
  abort(): void;
}

/**
 * Único punto de contacto con la API de Kubernetes en todo el proyecto
 * (AGENTS.md 5.3: "el código de Jin_Core no importa
 * @kubernetes/client-node... Jin_Executor es el único autorizado").
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
  private readonly customObjectsApi: CustomObjectsApi;
  private readonly kubeConfig: KubeConfig;
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
    this.kubeConfig = kubeConfig;
    this.coreApi = kubeConfig.makeApiClient(CoreV1Api);
    this.networkingApi = kubeConfig.makeApiClient(NetworkingV1Api);
    this.customObjectsApi = kubeConfig.makeApiClient(CustomObjectsApi);
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

  /** Poll hasta que el pod esté `Running`; falla rápido si terminó o si vence el plazo. */
  async waitForPodRunning(name: string, timeoutMs: number): Promise<V1Pod> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const pod = await this.readPod(name);
      const phase = pod.status?.phase;
      if (phase === 'Running') {
        return pod;
      }
      if (phase === 'Succeeded' || phase === 'Failed') {
        throw new Error(`El pod ${name} terminó (${phase}) antes de arrancar.`);
      }
      await sleep(POD_POLL_INTERVAL_MS);
    }

    throw new PodTimeoutError(name, timeoutMs);
  }

  /**
   * Ejecuta un comando dentro de un pod que ya corre (subrecurso `pods/exec`,
   * ADR 0016). Devuelve enseguida un handle: la salida llega por los
   * callbacks y el código de salida por `exitCode`.
   */
  async execInPod(
    name: string,
    options: PodExecOptions,
  ): Promise<PodExecution> {
    const stdout = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        options.onStdout(chunk);
        done();
      },
    });
    const stderr = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        options.onStderr(chunk);
        done();
      },
    });
    const stdin = options.stdin ? Readable.from([options.stdin]) : null;

    let settle: {
      resolve: (code: number) => void;
      reject: (error: Error) => void;
    };
    const exitCode = new Promise<number>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // Un rechazo que nadie espera (abort) no debe tumbar el proceso.
    exitCode.catch(() => undefined);

    const socket = (await new Exec(this.kubeConfig).exec(
      this.namespace,
      name,
      options.container,
      [...options.command],
      stdout,
      stderr,
      stdin,
      false,
      (status) => settle.resolve(exitCodeFromStatus(status)),
    )) as unknown as ExecSocket;
    socket.on('error', (error: Error) => settle.reject(error));
    socket.on('close', () =>
      settle.reject(
        new Error(
          'La conexión con el pod se cerró antes de terminar el comando.',
        ),
      ),
    );

    return {
      exitCode,
      abort: () => {
        try {
          socket.close();
        } catch {
          // ya estaba cerrado
        }
      },
    };
  }

  /**
   * Hace una petición HTTP a un puerto de un pod a través del subrecurso
   * `pods/proxy` del API server. El Executor no alcanza los pods directamente
   * (su NetworkPolicy excluye los CIDRs del clúster): todo pasa por el API
   * server, con el RBAC del Role. La ruta se valida ACÁ: sin `..` (ni escapado)
   * para que no pueda salir del prefijo del pod y llegar a otra ruta del API.
   */
  async proxyToPod(
    podName: string,
    port: number,
    request: PodProxyRequest,
  ): Promise<PodProxyResponse> {
    const [rawPath = '/'] = request.path.split('?');
    let decoded = rawPath;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      throw new Error('ruta mal codificada');
    }
    if (
      !request.path.startsWith('/') ||
      decoded.split('/').includes('..') ||
      decoded.includes('\\') ||
      [...request.path].some((char) => char.charCodeAt(0) < 32)
    ) {
      throw new Error('ruta no permitida');
    }

    const cluster = this.kubeConfig.getCurrentCluster();
    if (!cluster) throw new Error('kubeconfig sin cluster');
    const server = new URL(cluster.server);
    const options: https.RequestOptions = {
      method: request.method,
      hostname: server.hostname,
      port: server.port || (server.protocol === 'https:' ? 443 : 80),
      path: `/api/v1/namespaces/${this.namespace}/pods/${podName}:${port}/proxy${request.path}`,
      headers: { ...request.headers },
    };
    await this.kubeConfig.applyToHTTPSOptions(options);
    const transport = server.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const outgoing = transport.request(options, (response) =>
        resolve({
          status: response.statusCode ?? 502,
          headers: response.headers,
          body: response,
        }),
      );
      outgoing.on('error', reject);
      outgoing.setTimeout(request.timeoutMs ?? 30_000, () =>
        outgoing.destroy(new Error('el pod no respondió a tiempo')),
      );
      if (request.body && request.body.length > 0) outgoing.write(request.body);
      outgoing.end();
    });
  }

  async listServicesByLabel(labelSelector: string): Promise<V1Service[]> {
    const result = await this.coreApi.listNamespacedService({
      namespace: this.namespace,
      labelSelector,
    });
    return result.items;
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

  /** Lista pods por label selector exacto — usado por `PreviewServiceLifecycleService`/el reaper (Fase 5.5) en vez de una tabla propia: Kubernetes YA es el store de estado (ADR 0006 punto 3). */
  async listPodsByLabel(labelSelector: string): Promise<V1Pod[]> {
    const result = await this.coreApi.listNamespacedPod({
      namespace: this.namespace,
      labelSelector,
    });
    return result.items;
  }

  async createService(service: V1Service): Promise<V1Service> {
    return this.coreApi.createNamespacedService({
      namespace: this.namespace,
      body: service,
    });
  }

  /** Nunca lanza: mismo razonamiento que deletePod. */
  async deleteService(name: string): Promise<void> {
    try {
      await this.coreApi.deleteNamespacedService({
        name,
        namespace: this.namespace,
      });
    } catch (error) {
      this.logger.warn(
        `deleteService(${name}) falló (probablemente ya no existía): ${String(error)}`,
      );
    }
  }

  /**
   * `IngressRoute` (CRD de Traefik, Fase 5.5 ADR 0006 punto 7) vía
   * `CustomObjectsApi` — no es un recurso built-in de K8s, así que no
   * hay un método tipado como `createNamespacedPod`; `body` queda como
   * `unknown` a propósito (el caller, `service-pod-spec.builder.ts`, es
   * quien conoce y valida la forma real del manifest).
   */
  async createIngressRoute(body: unknown): Promise<void> {
    await this.customObjectsApi.createNamespacedCustomObject({
      group: INGRESSROUTE_GROUP,
      version: INGRESSROUTE_VERSION,
      namespace: this.namespace,
      plural: INGRESSROUTE_PLURAL,
      body,
    });
  }

  /** Nunca lanza: mismo razonamiento que deletePod. */
  async deleteIngressRoute(name: string): Promise<void> {
    try {
      await this.customObjectsApi.deleteNamespacedCustomObject({
        group: INGRESSROUTE_GROUP,
        version: INGRESSROUTE_VERSION,
        namespace: this.namespace,
        plural: INGRESSROUTE_PLURAL,
        name,
      });
    } catch (error) {
      this.logger.warn(
        `deleteIngressRoute(${name}) falló (probablemente ya no existía): ${String(error)}`,
      );
    }
  }
}
