import { StringDecoder } from 'node:string_decoder';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { V1PersistentVolumeClaim, V1Pod } from '@kubernetes/client-node';
import { K8sService, type PodExecution } from '../k8s/k8s.service';
import { collectExec } from '../k8s/pod-exec';
import { podProxyPrefix, undoApiServerRewrite } from '../k8s/pod-proxy';
import type { PodProxyResponse } from '../k8s/k8s.service';
import {
  CLAUDE_LABEL,
  CLAUDE_LABEL_VALUE,
  JINSERVER_TLS_SECRET_NAME,
  LAST_ACTIVITY_ANNOTATION,
  REQUEST_ID_ANNOTATION,
  SERVICE_EXPIRES_AT_ANNOTATION,
  SERVICE_ID_LABEL,
  SERVICE_SLUG_ANNOTATION,
  SERVICE_TYPE_LABEL,
  TERMINAL_CONTAINER_NAME,
  TERMINAL_TYPE_VALUE,
  WORKSPACE_TYPE_VALUE,
  servicePodNameForId,
  terminalPodNameForId,
  terminalWorkspacePvcNameForId,
} from '../k8s/labels';
import { buildServiceIngressNetworkPolicy } from '../k8s/network-policy.builder';
import {
  buildIngressRoute,
  buildService,
} from '../k8s/service-pod-spec.builder';
import {
  buildTerminalEgressPolicy,
  buildTerminalPodSpec,
  buildTerminalWorkspacePvc,
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
  TerminalFsError,
  TerminalLimitError,
  TerminalNotRunningError,
  TerminalWorkspaceLimitError,
  TerminalWorkspaceNotFoundError,
} from './errors';
import type {
  ExecTerminalRequest,
  ExposeTerminalRequest,
  FsWriteBody,
  StartServiceRequest,
  StartTerminalRequest,
} from './terminal-request.schema';
import {
  CHECK_STATIC_SERVER,
  EXPORT_FILES_SCRIPT,
  FS_SCRIPT,
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
  TerminalFsFile,
  TerminalFsList,
  TerminalFsWritten,
  TerminalStatus,
  TerminalStreamEvent,
  TerminalWorkspaceInfo,
} from './terminal.types';

const ACTIVE_TERMINAL_SELECTOR = `${SERVICE_TYPE_LABEL}=${TERMINAL_TYPE_VALUE}`;
const WORKSPACE_SELECTOR = `${SERVICE_TYPE_LABEL}=${WORKSPACE_TYPE_VALUE}`;
/** Tope de salida que se reenvía por comando; pasado esto se corta y se avisa. */
const MAX_OUTPUT_BYTES = 512 * 1024;
/** Tiempo para que el pod arranque (la primera vez hay que bajar la imagen). */
const START_TIMEOUT_MS = 120_000;
/** Tiempo para que un pod vencido/caído termine de irse antes de recrearlo (mismo nombre). */
const POD_GONE_TIMEOUT_MS = 30_000;
const SERVER_CHECK_ATTEMPTS = 6;
const SERVER_CHECK_INTERVAL_MS = 300;
/** No se toca la annotation de actividad más seguido que esto (evita hablarle de más al API server). */
const TOUCH_THROTTLE_MS = 60_000;

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

function isoOf(value: Date | string | undefined): string {
  if (!value) return new Date(0).toISOString();
  return typeof value === 'string' ? value : value.toISOString();
}

function statusOf(pod: V1Pod, now: number): TerminalStatus {
  // Un pod al que ya se le pidió borrarse sigue reportando `phase: Running`
  // durante su `terminationGracePeriodSeconds` (el proceso sigue vivo un
  // instante): sin este chequeo, exec()/proxy() seguían hablándole a un pod
  // que ya no debería aceptar nada (hallazgo con K3s real).
  if (pod.metadata?.deletionTimestamp) return 'failed';
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
 * Un workspace por proyecto (2026-09-28, ADR 0016 ampliada): un disco (PVC)
 * que sobrevive a que su pod se destruya y se vuelva a crear. Kubernetes
 * sigue siendo el store de estado — sin tabla propia — pero ahora hay DOS
 * recursos por proyecto (PVC + Pod, cuando corre), no solo el pod.
 *
 * Solo un pod de terminal corre A LA VEZ (`TERMINAL_MAX_CONCURRENT`), pero
 * puede haber varios discos guardados (`TERMINAL_MAX_WORKSPACES`): el disco
 * no cuesta CPU/memoria, así que no compite por la cuota del clúster.
 */
@Injectable()
export class TerminalWorkspaceService {
  private readonly logger = new Logger(TerminalWorkspaceService.name);
  private readonly image: string;
  private readonly registryUrl: string;
  private readonly registryNamespace: string;
  private readonly registryPort: number;
  private readonly claudeEgressUrl: string;
  private readonly claudeEgressNamespace: string;
  private readonly claudeEgressPort: number;
  private readonly defaultTtlSeconds: number;
  private readonly maxTtlSeconds: number;
  private readonly maxConcurrent: number;
  private readonly maxWorkspaces: number;
  private readonly workspaceStorageSize: string;
  /** Workspaces con un comando en curso (uno a la vez por workspace). */
  private readonly busy = new Set<string>();
  /** Último `patchPodAnnotation` de actividad por workspace (throttle en memoria). */
  private readonly lastTouch = new Map<string, number>();

  constructor(
    private readonly rbacValidator: RbacValidatorService,
    private readonly k8s: K8sService,
    configService: ConfigService,
  ) {
    this.image = configService.get<string>(
      'TERMINAL_NODE_IMAGE',
      'docker.io/library/node:22-bookworm',
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
    this.claudeEgressUrl = configService.get<string>(
      'TERMINAL_CLAUDE_EGRESS_URL',
      'http://claude-egress.claude-egress.svc.cluster.local:3128',
    );
    this.claudeEgressNamespace = configService.get<string>(
      'TERMINAL_CLAUDE_EGRESS_NAMESPACE',
      'claude-egress',
    );
    this.claudeEgressPort = Number(new URL(this.claudeEgressUrl).port) || 3128;
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
    this.maxWorkspaces = configService.get<number>(
      'TERMINAL_MAX_WORKSPACES',
      10,
    );
    const storageGi = configService.get<number>(
      'TERMINAL_WORKSPACE_STORAGE_GI',
      3,
    );
    this.workspaceStorageSize = `${storageGi}Gi`;
  }

  // ── Ciclo de vida ──────────────────────────────────────────────────────

  /**
   * Inicia (o reanuda) el pod de un workspace. Si ya está corriendo, no crea
   * nada: devuelve lo que hay. Si el disco no existe todavía, lo crea (y solo
   * entonces cuentan `files` y el tope de workspaces); si ya existía, `files`
   * se ignora — no se pisa lo que el owner dejó en el disco.
   */
  async start(
    workspaceId: string,
    request: StartTerminalRequest,
  ): Promise<TerminalWorkspaceInfo> {
    this.rbacValidator.validate('startTerminalSession');

    const podName = terminalPodNameForId(workspaceId);
    const pvc = await this.readPvcOrNull(workspaceId);
    const pod = await this.readPodOrNull(podName);

    if (pod) {
      const phase = statusOf(pod, Date.now());
      if (phase === 'running' || phase === 'starting') {
        await this.touchActivity(workspaceId, podName);
        return this.infoFrom(workspaceId, pod, pvc, null);
      }
      // Vencido, caído, o ya borrándose: hay que esperar a que termine de irse
      // ANTES de crear uno nuevo con el mismo nombre — Kubernetes no deja
      // crear un objeto mientras el anterior sigue "Terminating" (409,
      // hallazgo con K3s real: statusOf() ya lo detecta como no-corriendo,
      // pero el objeto tarda un instante en desaparecer de verdad).
      await this.stopPod(workspaceId);
      await this.k8s.waitForPodGone(podName, POD_GONE_TIMEOUT_MS);
    }

    const runningCount = (await this.listRunningPods()).length;
    if (runningCount >= this.maxConcurrent) {
      throw new TerminalLimitError(this.maxConcurrent);
    }

    const isNewWorkspace = !pvc;
    if (isNewWorkspace) {
      const count = (await this.k8s.listPvcsByLabel(WORKSPACE_SELECTOR)).length;
      if (count >= this.maxWorkspaces) {
        throw new TerminalWorkspaceLimitError(this.maxWorkspaces);
      }
    }

    const ttlSeconds = Math.min(
      Math.max(request.ttlSeconds || this.defaultTtlSeconds, 1),
      this.maxTtlSeconds,
    );
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const namespace = this.k8s.namespace;

    this.logger.log(
      `${isNewWorkspace ? 'Creando' : 'Reanudando'} terminal ${podName} (TTL: ${ttlSeconds}s)`,
    );
    // Única fuente de verdad para `createdAt`: el `creationTimestamp` que
    // Kubernetes le puso al PVC. Usar `now` (con milisegundos) para el caso
    // recién creado hacía que el mismo disco reportara un `createdAt`
    // distinto la próxima vez que se reanudara (K8s trunca a segundos) —
    // hallazgo con K3s real.
    let pvcCreated = pvc;
    try {
      if (isNewWorkspace) {
        pvcCreated = await this.k8s.createPvc(
          buildTerminalWorkspacePvc({
            workspaceId,
            namespace,
            storageSize: this.workspaceStorageSize,
          }),
        );
      }
      await this.k8s.createPod(
        buildTerminalPodSpec({
          workspaceId,
          namespace,
          image: this.image,
          npmRegistryUrl: this.registryUrl,
          expiresAt,
          requestId: request.requestId,
          now,
          ...(request.claudeCode
            ? {
                claudeCode: {
                  proxyUrl: this.claudeEgressUrl,
                  // El proxy de npm y el propio clúster no pasan por el proxy de Anthropic.
                  noProxy: [
                    new URL(this.registryUrl).hostname,
                    '.svc.cluster.local',
                    'localhost',
                    '127.0.0.1',
                  ],
                },
              }
            : {}),
        }),
      );
      await this.k8s.createNetworkPolicy(
        buildTerminalEgressPolicy({
          workspaceId,
          namespace,
          registryNamespace: this.registryNamespace,
          registryPort: this.registryPort,
          ...(request.claudeCode
            ? {
                claudeEgress: {
                  namespace: this.claudeEgressNamespace,
                  port: this.claudeEgressPort,
                },
              }
            : {}),
        }),
      );
      await this.k8s.waitForPodRunning(podName, START_TIMEOUT_MS);
      if (isNewWorkspace && Object.keys(request.files).length > 0) {
        await this.writeFiles(podName, '/workspace', request.files);
      }
    } catch (error) {
      // Nada a medias: un pod que no terminó de armarse no queda vivo. Un
      // disco recién creado en ESTE intento tampoco (no hay nada del owner
      // que perder); uno que ya existía de antes se conserva siempre.
      await this.stopPod(workspaceId);
      if (isNewWorkspace) {
        await this.k8s.deletePvc(terminalWorkspacePvcNameForId(workspaceId));
      }
      throw error;
    }

    return {
      id: workspaceId,
      status: 'running',
      createdAt: isoOf(pvcCreated?.metadata?.creationTimestamp),
      expiresAt: expiresAt.toISOString(),
      requestId: request.requestId ?? null,
      exposure: null,
      lastActivityAt: now.toISOString(),
      claudeCode: request.claudeCode === true,
    };
  }

  /** Todos los workspaces (proyectos con disco propio), corriendo o no. */
  async list(): Promise<TerminalWorkspaceInfo[]> {
    const [allPvcs, pods, exposures] = await Promise.all([
      this.k8s.listPvcsByLabel(WORKSPACE_SELECTOR),
      this.listPods(),
      this.listExposures(),
    ]);
    // Un PVC al que ya se le pidió borrarse (deleteWorkspace) sigue existiendo
    // hasta que el finalizer de protección se libera (el pod que lo usaba
    // tiene que terminar de irse primero) — mismo criterio que con los pods:
    // no cuenta como que el proyecto sigue ahí (hallazgo con K3s real).
    const pvcs = allPvcs.filter(
      (candidate) => !candidate.metadata?.deletionTimestamp,
    );
    const podById = new Map(
      pods.map((pod) => [pod.metadata?.labels?.[SERVICE_ID_LABEL] ?? '', pod]),
    );
    const pvcById = new Map(
      pvcs.map((pvc) => [pvc.metadata?.labels?.[SERVICE_ID_LABEL] ?? '', pvc]),
    );
    const ids = new Set([...pvcById.keys(), ...podById.keys()]);
    ids.delete('');

    return [...ids]
      .map((id) =>
        this.infoFrom(
          id,
          podById.get(id) ?? null,
          pvcById.get(id) ?? null,
          exposures.get(id) ?? null,
        ),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Detiene el pod de un workspace (el disco NO se toca). Nunca lanza: parar
   * algo que ya no existe no es un error real. Orden: primero lo que corta
   * el tráfico y por último el pod.
   */
  async stopPod(workspaceId: string): Promise<void> {
    this.rbacValidator.validate('stopTerminalSession');
    const serviceName = servicePodNameForId(workspaceId);
    await this.k8s.deleteIngressRoute(serviceName);
    await this.k8s.deleteService(serviceName);
    await this.k8s.deleteNetworkPolicy(`${workspaceId}-ingress`);
    await this.k8s.deleteNetworkPolicy(terminalEgressPolicyName(workspaceId));
    await this.k8s.deletePod(terminalPodNameForId(workspaceId));
    this.busy.delete(workspaceId);
    this.lastTouch.delete(workspaceId);
  }

  /**
   * Elimina el disco de un workspace: para el pod si estaba corriendo y
   * borra el PVC. Irreversible — lo que no se trajo al editor se pierde.
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    this.rbacValidator.validate('deleteTerminalWorkspace');
    await this.stopPod(workspaceId);
    await this.k8s.deletePvcOrThrow(terminalWorkspacePvcNameForId(workspaceId));
  }

  // ── Comandos ───────────────────────────────────────────────────────────

  /**
   * Corre un comando y reenvía la salida por `emit` a medida que llega.
   * Siempre termina con un evento `exit` (o `error`). `signal` corta la
   * conexión cuando el cliente se va; el `timeout` del pod mata el proceso.
   */
  async exec(
    workspaceId: string,
    request: ExecTerminalRequest,
    emit: (event: TerminalStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.rbacValidator.validate('runTerminalCommand');
    if (this.busy.has(workspaceId)) throw new TerminalBusyError(workspaceId);
    this.busy.add(workspaceId);
    try {
      await this.requireRunningPod(workspaceId);

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
        terminalPodNameForId(workspaceId),
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
      this.busy.delete(workspaceId);
    }
  }

  // ── Terminal interactiva (PTY) ─────────────────────────────────────────

  /**
   * Comprueba que el workspace tenga un pod corriendo y devuelve su nombre,
   * para abrir una terminal interactiva (`TerminalPtyService`). Mismo permiso
   * RBAC que un comando: la sesión es un canal dentro del pod ya aprobado.
   */
  async requirePodForPty(workspaceId: string): Promise<string> {
    this.rbacValidator.validate('runTerminalCommand');
    await this.requireRunningPod(workspaceId);
    return terminalPodNameForId(workspaceId);
  }

  /**
   * Marca actividad (con el throttle de siempre) para que el reaper no libere
   * por inactividad un pod donde el owner está tecleando o esperando un install.
   * Un fallo acá nunca debe cortar la sesión.
   */
  async notePtyActivity(workspaceId: string): Promise<void> {
    try {
      await this.touchActivity(workspaceId, terminalPodNameForId(workspaceId));
    } catch (error) {
      this.logger.warn(
        `No se pudo anotar actividad de la terminal ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ── Archivos ───────────────────────────────────────────────────────────

  async exportFiles(
    workspaceId: string,
    dir: string,
  ): Promise<TerminalExportResult> {
    await this.requireRunningPod(workspaceId);
    const result = await this.collect(terminalPodNameForId(workspaceId), [
      'node',
      '-e',
      EXPORT_FILES_SCRIPT,
      dir,
    ]);
    if (result.code !== 0) {
      throw new TerminalFileTransferError(
        `No se pudieron leer los archivos del proyecto: ${result.stderr.slice(0, 300)}`,
      );
    }
    try {
      return JSON.parse(result.stdout) as TerminalExportResult;
    } catch (cause) {
      throw new TerminalFileTransferError(
        'La terminal devolvió una lista de archivos ilegible.',
        cause,
      );
    }
  }

  async importFiles(
    workspaceId: string,
    files: Readonly<Record<string, string>>,
  ): Promise<{ written: number }> {
    await this.requireRunningPod(workspaceId);
    await this.writeFiles(
      terminalPodNameForId(workspaceId),
      '/workspace',
      files,
    );
    return { written: Object.keys(files).length };
  }

  // ── Explorador de archivos del pod (2026-09-29) ────────────────────────
  // El disco real del proyecto, un archivo de texto a la vez. Toda la lógica de
  // rutas y topes vive en `FS_SCRIPT` (dentro del pod); acá solo se llama y se
  // traduce su respuesta. La auditoría de escribir/borrar es de Jin_Core.

  fsList(workspaceId: string, path: string): Promise<TerminalFsList> {
    return this.fs<TerminalFsList>(workspaceId, 'list', path);
  }

  fsRead(workspaceId: string, path: string): Promise<TerminalFsFile> {
    return this.fs<TerminalFsFile>(workspaceId, 'read', path);
  }

  fsWrite(workspaceId: string, body: FsWriteBody): Promise<TerminalFsWritten> {
    return this.fs<TerminalFsWritten>(workspaceId, 'write', body.path, {
      content: body.content,
      ...(body.expectedSha256 ? { expectedSha256: body.expectedSha256 } : {}),
      force: body.force,
    });
  }

  async fsMkdir(workspaceId: string, path: string): Promise<void> {
    await this.fs<Record<string, never>>(workspaceId, 'mkdir', path);
  }

  async fsDelete(workspaceId: string, path: string): Promise<void> {
    await this.fs<Record<string, never>>(workspaceId, 'delete', path);
  }

  private async fs<T>(
    workspaceId: string,
    op: 'list' | 'read' | 'write' | 'mkdir' | 'delete',
    path: string,
    input?: unknown,
  ): Promise<T> {
    this.rbacValidator.validate('runTerminalCommand');
    await this.requireRunningPod(workspaceId);
    let stdin: Buffer | undefined;
    if (input !== undefined) {
      const body = JSON.stringify(input);
      stdin = Buffer.from(`${Buffer.byteLength(body)}\n${body}`);
    }
    const result = await this.collect(
      terminalPodNameForId(workspaceId),
      ['node', '-e', FS_SCRIPT, op, path],
      stdin,
      // Un archivo de 512 KB escapado en JSON puede pasar de los 2 MB por defecto.
      { outputLimit: 4 * 1024 * 1024 },
    );
    let parsed: {
      ok: boolean;
      data?: T;
      code?: string;
      message?: string;
      [extra: string]: unknown;
    };
    try {
      parsed = JSON.parse(result.stdout) as typeof parsed;
    } catch (cause) {
      throw new TerminalFileTransferError(
        `El pod devolvió una respuesta ilegible al ${op === 'read' ? 'leer' : 'operar sobre'} el archivo: ${result.stderr.slice(0, 200)}`,
        cause,
      );
    }
    if (!parsed.ok) {
      const { ok: _ok, code, message, ...extra } = parsed;
      throw new TerminalFsError(
        code ?? 'failed',
        message ?? 'No se pudo completar la operación.',
        extra,
      );
    }
    return parsed.data as T;
  }

  // ── Servidores en segundo plano y vista previa ─────────────────────────

  /**
   * Lanza un servidor dentro del workspace (`npm run dev -- --host 0.0.0.0`)
   * que sobrevive al comando, y espera a que el puerto responda. Es código
   * del owner corriendo en su sandbox, como cualquier comando: Jin_Core lo
   * audita antes.
   */
  async startService(
    workspaceId: string,
    request: StartServiceRequest,
  ): Promise<TerminalServiceStart> {
    this.rbacValidator.validate('runTerminalCommand');
    await this.requireRunningPod(workspaceId);
    const result = await this.runServiceScript(workspaceId, [
      'start',
      String(request.port),
      request.command,
    ]);
    return result as unknown as TerminalServiceStart;
  }

  async stopService(workspaceId: string, port: number): Promise<void> {
    await this.requireRunningPod(workspaceId);
    await this.runServiceScript(workspaceId, ['stop', String(port)]);
  }

  async listServices(workspaceId: string): Promise<TerminalServiceInfo[]> {
    await this.requireRunningPod(workspaceId);
    const result = await this.runServiceScript(workspaceId, ['list', '0']);
    return (result.services ?? []) as TerminalServiceInfo[];
  }

  async serviceLogs(workspaceId: string, port: number): Promise<string> {
    await this.requireRunningPod(workspaceId);
    const result = await this.runServiceScript(workspaceId, [
      'logs',
      String(port),
    ]);
    return typeof result.log === 'string' ? result.log : '';
  }

  private async runServiceScript(
    workspaceId: string,
    args: readonly string[],
  ): Promise<Record<string, unknown> & { services?: unknown[] }> {
    const result = await this.collect(terminalPodNameForId(workspaceId), [
      'node',
      '-e',
      SERVICE_SCRIPT,
      ...args,
    ]);
    if (result.code !== 0) {
      throw new TerminalServiceError(
        `No se pudo manejar el servidor del proyecto: ${result.stderr.slice(0, 300)}`,
        502,
      );
    }
    try {
      return JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      throw new TerminalServiceError(
        'La terminal devolvió una respuesta ilegible.',
        502,
      );
    }
  }

  /**
   * Reenvía una petición HTTP al puerto de un servidor del workspace, a
   * través del API server. Solo el workspace del propio owner y solo
   * puertos de usuario.
   */
  async proxy(
    workspaceId: string,
    port: number,
    request: {
      method: string;
      path: string;
      headers: Readonly<Record<string, string>>;
      body?: Buffer | undefined;
    },
  ): Promise<PodProxyResponse> {
    await this.requireRunningPod(workspaceId);
    const podName = terminalPodNameForId(workspaceId);
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
    workspaceId: string,
    request: ExposeTerminalRequest,
  ): Promise<TerminalExposure> {
    this.rbacValidator.validate('exposeTerminalSession');
    await this.requireRunningPod(workspaceId);
    if ((await this.listExposures()).has(workspaceId)) {
      throw new TerminalExposeError(
        'Este proyecto ya publicó un build. Detén la terminal para publicar otro.',
        409,
      );
    }

    const podName = terminalPodNameForId(workspaceId);
    const hasIndex = await this.collect(podName, [
      'sh',
      '-c',
      'test -f "/workspace/$1/index.html"',
      'jin',
      request.dir,
    ]);
    if (hasIndex.code !== 0) {
      throw new TerminalExposeError(
        `No hay ${request.dir}/index.html en la terminal: corre el build primero (por ejemplo npm run build).`,
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
      serviceId: workspaceId,
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
          serviceId: workspaceId,
          namespace,
          port: request.port,
        }),
      );
      await this.k8s.createIngressRoute(
        buildIngressRoute({
          serviceId: workspaceId,
          namespace,
          slug,
          port: request.port,
          tlsSecretName: JINSERVER_TLS_SECRET_NAME,
        }),
      );
    } catch (error) {
      const serviceName = servicePodNameForId(workspaceId);
      await this.k8s.deleteIngressRoute(serviceName);
      await this.k8s.deleteService(serviceName);
      await this.k8s.deleteNetworkPolicy(`${workspaceId}-ingress`);
      throw error;
    }
    return { slug, url: `https://${slug}.jinserver.com` };
  }

  // ── Internos ───────────────────────────────────────────────────────────

  private async listPods(): Promise<V1Pod[]> {
    const pods = await this.k8s.listPodsByLabel(ACTIVE_TERMINAL_SELECTOR);
    // Un pod que se está borrando (`deletionTimestamp`) sigue "Running" unos
    // segundos: no cuenta como corriendo, ni para la lista ni para el límite.
    return pods.filter((pod) => !pod.metadata?.deletionTimestamp);
  }

  private async listRunningPods(): Promise<V1Pod[]> {
    const pods = await this.listPods();
    const now = Date.now();
    return pods.filter((pod) => {
      const phase = statusOf(pod, now);
      return phase === 'running' || phase === 'starting';
    });
  }

  /** id de workspace → link publicado, a partir de los Service que ya existen. */
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

  private infoFrom(
    workspaceId: string,
    pod: V1Pod | null,
    pvc: V1PersistentVolumeClaim | null,
    exposure: TerminalExposure | null,
  ): TerminalWorkspaceInfo {
    const createdAt = isoOf(
      pvc?.metadata?.creationTimestamp ?? pod?.metadata?.creationTimestamp,
    );
    if (!pod) {
      return {
        id: workspaceId,
        status: 'stopped',
        createdAt,
        expiresAt: null,
        requestId: null,
        exposure: null,
        lastActivityAt: null,
        claudeCode: false,
      };
    }
    return {
      id: workspaceId,
      status: statusOf(pod, Date.now()),
      createdAt,
      expiresAt:
        pod.metadata?.annotations?.[SERVICE_EXPIRES_AT_ANNOTATION] ?? null,
      requestId: pod.metadata?.annotations?.[REQUEST_ID_ANNOTATION] ?? null,
      exposure,
      lastActivityAt:
        pod.metadata?.annotations?.[LAST_ACTIVITY_ANNOTATION] ?? null,
      claudeCode: pod.metadata?.labels?.[CLAUDE_LABEL] === CLAUDE_LABEL_VALUE,
    };
  }

  private async readPodOrNull(podName: string): Promise<V1Pod | null> {
    try {
      return await this.k8s.readPod(podName);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async readPvcOrNull(
    workspaceId: string,
  ): Promise<V1PersistentVolumeClaim | null> {
    try {
      return await this.k8s.readPvc(terminalWorkspacePvcNameForId(workspaceId));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Verifica que el workspace tenga un pod corriendo (y de paso anota
   * actividad, con throttle): es el punto de entrada de exec/servicios/
   * archivos/proxy/publicar, así que cubrirlo acá cubre todo lo demás.
   */
  private async requireRunningPod(workspaceId: string): Promise<V1Pod> {
    const podName = terminalPodNameForId(workspaceId);
    const pod = await this.readPodOrNull(podName);
    if (!pod) {
      const exists = (await this.readPvcOrNull(workspaceId)) !== null;
      if (!exists) throw new TerminalWorkspaceNotFoundError(workspaceId);
      throw new TerminalNotRunningError(workspaceId, 'stopped');
    }
    if (pod.metadata?.labels?.[SERVICE_TYPE_LABEL] !== TERMINAL_TYPE_VALUE) {
      throw new TerminalWorkspaceNotFoundError(workspaceId);
    }
    const status = statusOf(pod, Date.now());
    if (status !== 'running') {
      throw new TerminalNotRunningError(workspaceId, status);
    }
    await this.touchActivity(workspaceId, podName);
    return pod;
  }

  private async touchActivity(
    workspaceId: string,
    podName: string,
  ): Promise<void> {
    const now = Date.now();
    const last = this.lastTouch.get(workspaceId) ?? 0;
    if (now - last < TOUCH_THROTTLE_MS) return;
    this.lastTouch.set(workspaceId, now);
    await this.k8s.patchPodAnnotation(
      podName,
      LAST_ACTIVITY_ANNOTATION,
      new Date(now).toISOString(),
    );
  }

  /** Corre un comando corto y junta su salida (subir, exportar, arrancar el servidor). */
  private collect(
    podName: string,
    command: readonly string[],
    stdin?: Buffer,
    options: { readonly outputLimit?: number } = {},
  ): Promise<Collected> {
    return collectExec(this.k8s, podName, TERMINAL_CONTAINER_NAME, command, {
      ...(stdin ? { stdin } : {}),
      ...(options.outputLimit ? { outputLimit: options.outputLimit } : {}),
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
        `No se pudieron copiar los archivos al proyecto: ${result.stderr.slice(0, 300)}`,
      );
    }
  }
}
