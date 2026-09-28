import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { V1Pod } from '@kubernetes/client-node';
import { K8sService, type PodExecution } from '../k8s/k8s.service';
import { collectExec } from '../k8s/pod-exec';
import { podProxyPrefix, undoApiServerRewrite } from '../k8s/pod-proxy';
import type { PodProxyResponse } from '../k8s/k8s.service';
import {
  JINSERVER_TLS_SECRET_NAME,
  REQUEST_ID_ANNOTATION,
  SERVICE_EXPIRES_AT_ANNOTATION,
  SERVICE_ID_LABEL,
  SERVICE_SLUG_ANNOTATION,
  SERVICE_TYPE_LABEL,
  TERMINAL_CONTAINER_NAME,
  TERMINAL_TYPE_VALUE,
  servicePodNameForId,
  terminalPodNameForId,
} from '../k8s/labels';
import { buildServiceIngressNetworkPolicy } from '../k8s/network-policy.builder';
import {
  buildIngressRoute,
  buildService,
} from '../k8s/service-pod-spec.builder';
import {
  buildTerminalEgressPolicy,
  buildTerminalPodSpec,
  terminalEgressPolicyName,
} from '../k8s/terminal-pod-spec.builder';
import { RbacValidatorService } from '../rbac/rbac-validator.service';
import { generateSlug } from '../preview-service/slug';
import {
  TerminalProxyError,
  TerminalServiceError,
  TerminalBusyError,
  TerminalExposeError,
  TerminalFileTransferError,
  TerminalLimitError,
  TerminalNotFoundError,
  TerminalNotRunningError,
} from './errors';
import type {
  ExecTerminalRequest,
  ExposeTerminalRequest,
  StartServiceRequest,
  StartTerminalRequest,
} from './terminal-request.schema';
import {
  CHECK_STATIC_SERVER,
  EXPORT_FILES_SCRIPT,
  SERVICE_SCRIPT,
  RUN_SCRIPT,
  START_STATIC_SERVER,
  WRITE_FILES_SCRIPT,
} from './terminal-scripts';
import type {
  TerminalServiceInfo,
  TerminalServiceStart,
  TerminalExportResult,
  TerminalExposure,
  TerminalSessionInfo,
  TerminalStatus,
  TerminalStreamEvent,
} from './terminal.types';

const ACTIVE_TERMINAL_SELECTOR = `${SERVICE_TYPE_LABEL}=${TERMINAL_TYPE_VALUE}`;
/** Tope de salida que se reenvía por comando; pasado esto se corta y se avisa. */
const MAX_OUTPUT_BYTES = 512 * 1024;
/** Tiempo para que el pod arranque (la primera vez hay que bajar la imagen). */
const START_TIMEOUT_MS = 120_000;
/** Tiempo para las operaciones internas (subir, exportar, arrancar el servidor). */
const SERVER_CHECK_ATTEMPTS = 6;
const SERVER_CHECK_INTERVAL_MS = 300;

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 404
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusOf(pod: V1Pod, now: number): TerminalStatus {
  const expiresAt = pod.metadata?.annotations?.[SERVICE_EXPIRES_AT_ANNOTATION];
  if (expiresAt && new Date(expiresAt).getTime() <= now) return 'expired';
  switch (pod.status?.phase) {
    case 'Pending':
      return 'starting';
    case 'Running':
      return 'running';
    default:
      return 'failed';
  }
}

interface Collected {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Sesiones de terminal del owner (ADR 0016). Kubernetes es el store de estado,
 * como en `PreviewServiceLifecycleService`: sin tabla propia.
 */
@Injectable()
export class TerminalSessionService {
  private readonly logger = new Logger(TerminalSessionService.name);
  private readonly image: string;
  private readonly registryUrl: string;
  private readonly registryNamespace: string;
  private readonly registryPort: number;
  private readonly defaultTtlSeconds: number;
  private readonly maxTtlSeconds: number;
  private readonly maxConcurrent: number;
  /** Sesiones con un comando en curso (uno a la vez por sesión). */
  private readonly busy = new Set<string>();

  constructor(
    private readonly rbacValidator: RbacValidatorService,
    private readonly k8s: K8sService,
    configService: ConfigService,
  ) {
    this.image = configService.get<string>(
      'TERMINAL_NODE_IMAGE',
      'docker.io/library/node:22-alpine',
    );
    this.registryUrl = configService.get<string>(
      'TERMINAL_NPM_REGISTRY_URL',
      'http://verdaccio.registry-proxy.svc.cluster.local:4873',
    );
    this.registryNamespace = configService.get<string>(
      'TERMINAL_REGISTRY_NAMESPACE',
      'registry-proxy',
    );
    this.registryPort = Number(new URL(this.registryUrl).port) || 4873;
    this.defaultTtlSeconds = configService.get<number>(
      'TERMINAL_DEFAULT_TTL_SECONDS',
      60 * 60,
    );
    this.maxTtlSeconds = configService.get<number>(
      'TERMINAL_MAX_TTL_SECONDS',
      4 * 60 * 60,
    );
    this.maxConcurrent = configService.get<number>(
      'TERMINAL_MAX_CONCURRENT',
      1,
    );
  }

  // ── Ciclo de vida ──────────────────────────────────────────────────────

  async start(request: StartTerminalRequest): Promise<TerminalSessionInfo> {
    this.rbacValidator.validate('startTerminalSession');

    const active = (await this.listPods()).filter(
      (pod) => statusOf(pod, Date.now()) !== 'failed',
    );
    if (active.length >= this.maxConcurrent) {
      throw new TerminalLimitError(this.maxConcurrent);
    }

    const terminalId = randomUUID();
    // Nunca se confía en el ttl del request tal cual: el cap duro se aplica acá.
    const ttlSeconds = Math.min(
      Math.max(request.ttlSeconds || this.defaultTtlSeconds, 1),
      this.maxTtlSeconds,
    );
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const namespace = this.k8s.namespace;
    const podName = terminalPodNameForId(terminalId);

    this.logger.log(
      `Abriendo sesión de terminal ${podName} (TTL: ${ttlSeconds}s)`,
    );
    try {
      await this.k8s.createPod(
        buildTerminalPodSpec({
          terminalId,
          namespace,
          image: this.image,
          npmRegistryUrl: this.registryUrl,
          expiresAt,
          requestId: request.requestId,
        }),
      );
      await this.k8s.createNetworkPolicy(
        buildTerminalEgressPolicy({
          terminalId,
          namespace,
          registryNamespace: this.registryNamespace,
          registryPort: this.registryPort,
        }),
      );
      await this.k8s.waitForPodRunning(podName, START_TIMEOUT_MS);
      if (Object.keys(request.files).length > 0) {
        await this.writeFiles(podName, '/workspace', request.files);
      }
    } catch (error) {
      // Nada a medias: una sesión que no terminó de armarse no queda viva.
      await this.stop(terminalId);
      throw error;
    }

    return {
      id: terminalId,
      status: 'running',
      expiresAt: expiresAt.toISOString(),
      requestId: request.requestId ?? null,
      exposure: null,
    };
  }

  async list(): Promise<TerminalSessionInfo[]> {
    const [pods, exposures] = await Promise.all([
      this.listPods(),
      this.listExposures(),
    ]);
    const now = Date.now();
    return pods.map((pod) => {
      const id = pod.metadata?.labels?.[SERVICE_ID_LABEL] ?? '';
      return {
        id,
        status: statusOf(pod, now),
        expiresAt:
          pod.metadata?.annotations?.[SERVICE_EXPIRES_AT_ANNOTATION] ??
          new Date(0).toISOString(),
        requestId: pod.metadata?.annotations?.[REQUEST_ID_ANNOTATION] ?? null,
        exposure: exposures.get(id) ?? null,
      };
    });
  }

  /**
   * Nunca lanza (mismo criterio que `PreviewServiceLifecycleService.stop`):
   * cerrar una sesión que ya no existe no es un error. Orden: primero lo que
   * corta el tráfico y por último el pod.
   */
  async stop(terminalId: string): Promise<void> {
    this.rbacValidator.validate('stopTerminalSession');
    const serviceName = servicePodNameForId(terminalId);
    await this.k8s.deleteIngressRoute(serviceName);
    await this.k8s.deleteService(serviceName);
    await this.k8s.deleteNetworkPolicy(`${terminalId}-ingress`);
    await this.k8s.deleteNetworkPolicy(terminalEgressPolicyName(terminalId));
    await this.k8s.deletePod(terminalPodNameForId(terminalId));
    this.busy.delete(terminalId);
  }

  // ── Comandos ───────────────────────────────────────────────────────────

  /**
   * Corre un comando y reenvía la salida por `emit` a medida que llega.
   * Siempre termina con un evento `exit` (o `error`). `signal` corta la
   * conexión cuando el cliente se va; el `timeout` del pod mata el proceso.
   */
  async exec(
    terminalId: string,
    request: ExecTerminalRequest,
    emit: (event: TerminalStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.rbacValidator.validate('runTerminalCommand');
    if (this.busy.has(terminalId)) throw new TerminalBusyError(terminalId);
    this.busy.add(terminalId);
    try {
      await this.requireRunningPod(terminalId);

      const decoders = {
        out: new StringDecoder('utf8'),
        err: new StringDecoder('utf8'),
      };
      let sent = 0;
      let truncated = false;
      const handle: { current: PodExecution | undefined } = {
        current: undefined,
      };
      const forward = (kind: 'out' | 'err', chunk: Buffer): void => {
        if (truncated) return;
        sent += chunk.length;
        if (sent > MAX_OUTPUT_BYTES) {
          truncated = true;
          handle.current?.abort();
          return;
        }
        const text = decoders[kind].write(chunk);
        if (text) emit({ t: kind, d: text });
      };

      const execution = await this.k8s.execInPod(
        terminalPodNameForId(terminalId),
        {
          container: TERMINAL_CONTAINER_NAME,
          command: [
            'node',
            '-e',
            RUN_SCRIPT,
            String(request.timeoutSeconds),
            request.command,
          ],
          onStdout: (chunk) => forward('out', chunk),
          onStderr: (chunk) => forward('err', chunk),
        },
      );
      handle.current = execution;
      // La salida pudo pasar el tope antes de que existiera el handle.
      if (truncated) execution.abort();
      const running = execution;
      const onAbort = (): void => running.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      // Red de seguridad por si el `timeout` del pod no llega a matar el proceso.
      const watchdog = setTimeout(
        () => running.abort(),
        (request.timeoutSeconds + 10) * 1000,
      );
      try {
        const code = await running.exitCode;
        emit({ t: 'exit', code, truncated });
      } catch (error) {
        if (truncated) {
          emit({ t: 'exit', code: -1, truncated: true });
        } else if (signal?.aborted) {
          // El cliente se fue: no hay a quién avisarle.
        } else {
          emit({
            t: 'error',
            message:
              error instanceof Error ? error.message : 'Falló el comando.',
          });
        }
      } finally {
        clearTimeout(watchdog);
        signal?.removeEventListener('abort', onAbort);
      }
    } finally {
      this.busy.delete(terminalId);
    }
  }

  // ── Archivos ───────────────────────────────────────────────────────────

  async exportFiles(
    terminalId: string,
    dir: string,
  ): Promise<TerminalExportResult> {
    await this.requireRunningPod(terminalId);
    const result = await this.collect(terminalPodNameForId(terminalId), [
      'node',
      '-e',
      EXPORT_FILES_SCRIPT,
      dir,
    ]);
    if (result.code !== 0) {
      throw new TerminalFileTransferError(
        `No se pudieron leer los archivos de la sesión: ${result.stderr.slice(0, 300)}`,
      );
    }
    try {
      return JSON.parse(result.stdout) as TerminalExportResult;
    } catch (cause) {
      throw new TerminalFileTransferError(
        'La sesión devolvió una lista de archivos ilegible.',
        cause,
      );
    }
  }

  async importFiles(
    terminalId: string,
    files: Readonly<Record<string, string>>,
  ): Promise<{ written: number }> {
    await this.requireRunningPod(terminalId);
    await this.writeFiles(
      terminalPodNameForId(terminalId),
      '/workspace',
      files,
    );
    return { written: Object.keys(files).length };
  }

  // ── Servidores en segundo plano y vista previa ─────────────────────────

  /**
   * Lanza un servidor dentro de la sesión (`npm run dev -- --host 0.0.0.0`) que
   * sobrevive al comando, y espera a que el puerto responda. Es código del owner
   * corriendo en su sandbox, como cualquier comando: Jin_Core lo audita antes.
   */
  async startService(
    terminalId: string,
    request: StartServiceRequest,
  ): Promise<TerminalServiceStart> {
    this.rbacValidator.validate('runTerminalCommand');
    await this.requireRunningPod(terminalId);
    const result = await this.runServiceScript(terminalId, [
      'start',
      String(request.port),
      request.command,
    ]);
    return result as unknown as TerminalServiceStart;
  }

  async stopService(terminalId: string, port: number): Promise<void> {
    await this.requireRunningPod(terminalId);
    await this.runServiceScript(terminalId, ['stop', String(port)]);
  }

  async listServices(terminalId: string): Promise<TerminalServiceInfo[]> {
    await this.requireRunningPod(terminalId);
    const result = await this.runServiceScript(terminalId, ['list', '0']);
    return (result.services ?? []) as TerminalServiceInfo[];
  }

  async serviceLogs(terminalId: string, port: number): Promise<string> {
    await this.requireRunningPod(terminalId);
    const result = await this.runServiceScript(terminalId, [
      'logs',
      String(port),
    ]);
    return typeof result.log === 'string' ? result.log : '';
  }

  private async runServiceScript(
    terminalId: string,
    args: readonly string[],
  ): Promise<Record<string, unknown> & { services?: unknown[] }> {
    const result = await this.collect(terminalPodNameForId(terminalId), [
      'node',
      '-e',
      SERVICE_SCRIPT,
      ...args,
    ]);
    if (result.code !== 0) {
      throw new TerminalServiceError(
        `No se pudo manejar el servidor de la sesión: ${result.stderr.slice(0, 300)}`,
        502,
      );
    }
    try {
      return JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      throw new TerminalServiceError(
        'La sesión devolvió una respuesta ilegible.',
        502,
      );
    }
  }

  /**
   * Reenvía una petición HTTP al puerto de un servidor de la sesión, a través
   * del API server. Solo la sesión del propio owner y solo puertos de usuario.
   */
  async proxy(
    terminalId: string,
    port: number,
    request: {
      method: string;
      path: string;
      headers: Readonly<Record<string, string>>;
      body?: Buffer | undefined;
    },
  ): Promise<PodProxyResponse> {
    await this.requireRunningPod(terminalId);
    const podName = terminalPodNameForId(terminalId);
    try {
      const response = await this.k8s.proxyToPod(podName, port, request);
      // El API server reescribe los enlaces del HTML: se deshace para que la
      // página del owner funcione como si hablara directo con su servidor.
      return await undoApiServerRewrite(
        response,
        podProxyPrefix(this.k8s.namespace, podName, port),
      );
    } catch (error) {
      throw new TerminalProxyError(
        error instanceof Error
          ? error.message
          : 'No se pudo llegar al servidor.',
        error instanceof Error && error.message === 'ruta no permitida'
          ? 400
          : 502,
        error,
      );
    }
  }

  // ── Publicar un build ──────────────────────────────────────────────────

  async expose(
    terminalId: string,
    request: ExposeTerminalRequest,
  ): Promise<TerminalExposure> {
    this.rbacValidator.validate('exposeTerminalSession');
    await this.requireRunningPod(terminalId);
    if ((await this.listExposures()).has(terminalId)) {
      throw new TerminalExposeError(
        'Esta sesión ya publicó un build. Cierra la sesión para publicar otro.',
        409,
      );
    }

    const podName = terminalPodNameForId(terminalId);
    const hasIndex = await this.collect(podName, [
      'sh',
      '-c',
      'test -f "/workspace/$1/index.html"',
      'jin',
      request.dir,
    ]);
    if (hasIndex.code !== 0) {
      throw new TerminalExposeError(
        `No hay ${request.dir}/index.html en la sesión: corre el build primero (por ejemplo npm run build).`,
      );
    }

    await this.writeFiles(podName, '/tmp', {
      '.jin/static-server.mjs': request.serverSource,
    });
    await this.collect(podName, [
      'sh',
      '-c',
      START_STATIC_SERVER,
      'jin',
      request.dir,
    ]);
    // Node tarda un instante en abrir el puerto: se sondea en vez de esperar a ciegas.
    let alive = false;
    for (
      let attempt = 0;
      attempt < SERVER_CHECK_ATTEMPTS && !alive;
      attempt++
    ) {
      await sleep(SERVER_CHECK_INTERVAL_MS);
      alive =
        (
          await this.collect(podName, [
            'sh',
            '-c',
            CHECK_STATIC_SERVER,
            'jin',
            String(request.port),
          ])
        ).code === 0;
    }
    if (!alive) {
      const log = await this.collect(podName, [
        'sh',
        '-c',
        'tail -c 400 /tmp/static-server.log',
      ]);
      throw new TerminalExposeError(
        `El servidor estático no arrancó: ${log.stdout.trim() || 'sin salida'}`,
      );
    }

    const namespace = this.k8s.namespace;
    const slug = generateSlug(request.slugHint);
    const service = buildService({
      serviceId: terminalId,
      namespace,
      port: request.port,
    });
    try {
      await this.k8s.createService({
        ...service,
        metadata: {
          ...service.metadata,
          annotations: { [SERVICE_SLUG_ANNOTATION]: slug },
        },
      });
      await this.k8s.createNetworkPolicy(
        buildServiceIngressNetworkPolicy({
          serviceId: terminalId,
          namespace,
          port: request.port,
        }),
      );
      await this.k8s.createIngressRoute(
        buildIngressRoute({
          serviceId: terminalId,
          namespace,
          slug,
          port: request.port,
          tlsSecretName: JINSERVER_TLS_SECRET_NAME,
        }),
      );
    } catch (error) {
      const serviceName = servicePodNameForId(terminalId);
      await this.k8s.deleteIngressRoute(serviceName);
      await this.k8s.deleteService(serviceName);
      await this.k8s.deleteNetworkPolicy(`${terminalId}-ingress`);
      throw error;
    }
    return { slug, url: `https://${slug}.jinserver.com` };
  }

  // ── Internos ───────────────────────────────────────────────────────────

  private async listPods(): Promise<V1Pod[]> {
    const pods = await this.k8s.listPodsByLabel(ACTIVE_TERMINAL_SELECTOR);
    // Un pod que se está borrando (`deletionTimestamp`) sigue "Running" unos
    // segundos: no cuenta como sesión, ni para la lista ni para el límite.
    return pods.filter((pod) => !pod.metadata?.deletionTimestamp);
  }

  /** id de sesión → link publicado, a partir de los Service que ya existen. */
  private async listExposures(): Promise<Map<string, TerminalExposure>> {
    const services = await this.k8s.listServicesByLabel(SERVICE_ID_LABEL);
    const result = new Map<string, TerminalExposure>();
    for (const service of services) {
      const id = service.metadata?.labels?.[SERVICE_ID_LABEL];
      const slug = service.metadata?.annotations?.[SERVICE_SLUG_ANNOTATION];
      if (id && slug && service.metadata?.name === servicePodNameForId(id)) {
        result.set(id, { slug, url: `https://${slug}.jinserver.com` });
      }
    }
    return result;
  }

  private async requireRunningPod(terminalId: string): Promise<V1Pod> {
    let pod: V1Pod;
    try {
      pod = await this.k8s.readPod(terminalPodNameForId(terminalId));
    } catch (error) {
      if (isNotFound(error)) throw new TerminalNotFoundError(terminalId);
      throw error;
    }
    if (pod.metadata?.labels?.[SERVICE_TYPE_LABEL] !== TERMINAL_TYPE_VALUE) {
      throw new TerminalNotFoundError(terminalId);
    }
    const status = statusOf(pod, Date.now());
    if (status !== 'running')
      throw new TerminalNotRunningError(terminalId, status);
    return pod;
  }

  /** Corre un comando corto y junta su salida (subir, exportar, arrancar el servidor). */
  private collect(
    podName: string,
    command: readonly string[],
    stdin?: Buffer,
  ): Promise<Collected> {
    return collectExec(this.k8s, podName, TERMINAL_CONTAINER_NAME, command, {
      ...(stdin ? { stdin } : {}),
    });
  }

  private async writeFiles(
    podName: string,
    root: string,
    files: Readonly<Record<string, string>>,
  ): Promise<void> {
    const body = JSON.stringify({ files });
    const payload = Buffer.from(`${Buffer.byteLength(body)}\n${body}`);
    const result = await this.collect(
      podName,
      ['node', '-e', WRITE_FILES_SCRIPT, root],
      payload,
    );
    if (result.code !== 0) {
      throw new TerminalFileTransferError(
        `No se pudieron copiar los archivos a la sesión: ${result.stderr.slice(0, 300)}`,
      );
    }
  }
}
