import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { V1Pod } from '@kubernetes/client-node';
import { K8sService } from '../k8s/k8s.service';
import {
  buildIngressRoute,
  buildService,
  buildServicePodSpec,
} from '../k8s/service-pod-spec.builder';
import {
  buildServiceIngressNetworkPolicy,
  buildServiceNpmEgressPolicy,
  serviceEgressPolicyName,
} from '../k8s/network-policy.builder';
import {
  DB_ENGINE_ANNOTATION,
  JINSERVER_TLS_SECRET_NAME,
  REQUEST_ID_ANNOTATION,
  SERVICE_EXPIRES_AT_ANNOTATION,
  SERVICE_ID_LABEL,
  SERVICE_SLUG_ANNOTATION,
  SERVICE_TYPE_LABEL,
  SERVICE_TYPE_VALUE,
  servicePodNameForId,
} from '../k8s/labels';
import { ForbiddenToolError } from '../rbac/errors';
import { RbacValidatorService } from '../rbac/rbac-validator.service';
import { isRunToCompletionTool } from '../rbac/tool-whitelist';
import {
  PreviewServiceExportError,
  PreviewServiceLimitError,
  PreviewServiceNotFoundError,
  PreviewServiceQuotaError,
  PreviewServiceSecretNotAllowedError,
  PreviewServiceTtlCapError,
} from './errors';
import { collectExec } from '../k8s/pod-exec';
import { EXPORT_FILES_SCRIPT } from '../terminal/terminal-scripts';
import type { TerminalExportResult } from '../terminal/terminal.types';
import type { StartPreviewServiceRequest } from './preview-service-request.schema';
import { generateSlug } from './slug';
import { buildTarGzBase64 } from './tar-payload';
import type { PreviewServiceInfo } from './preview-service.types';

const ACTIVE_SERVICE_LABEL_SELECTOR = `${SERVICE_TYPE_LABEL}=${SERVICE_TYPE_VALUE}`;

function ingressNetworkPolicyName(serviceId: string): string {
  return `${serviceId}-ingress`;
}

function podToInfo(pod: V1Pod): PreviewServiceInfo {
  const serviceId = pod.metadata?.labels?.[SERVICE_ID_LABEL] ?? '';
  const slug = pod.metadata?.annotations?.[SERVICE_SLUG_ANNOTATION] ?? '';
  const expiresAt =
    pod.metadata?.annotations?.[SERVICE_EXPIRES_AT_ANNOTATION] ??
    new Date(0).toISOString();
  const expired = new Date(expiresAt).getTime() <= Date.now();
  const requestId = pod.metadata?.annotations?.[REQUEST_ID_ANNOTATION];
  const db = pod.metadata?.annotations?.[DB_ENGINE_ANNOTATION];
  return {
    id: serviceId,
    slug,
    url: `https://${slug}.jinserver.com`,
    status: expired ? 'expired' : 'running',
    expiresAt,
    ...(requestId ? { requestId } : {}),
    ...(db ? { db } : {}),
  };
}

/** "requested: limits.cpu=1500m, used: limits.cpu=2200m, limited: limits.cpu=3" → texto corto, o null si no es de cuota. */
function quotaDetail(error: unknown): string | null {
  const text = String(error);
  if (!text.includes('exceeded quota')) return null;
  const match =
    /requested: ([^,\\"]+), used: ([^,\\"]+), limited: ([^,\\"]+)/.exec(text);
  return match
    ? `pide ${match[1]}, en uso ${match[2]}, tope ${match[3]}`
    : 'cuota de agents-sandbox agotada';
}

/**
 * Ciclo de vida de pods de servicio (Fase 5.5, ADR 0006) — opuesto a
 * `PodLifecycleService`: nunca destruye en un `finally`, no espera a un
 * estado terminal. Kubernetes ES el store de estado (ADR 0006 punto 3):
 * sin tabla propia, `list()` lista pods por label y deriva todo de sus
 * labels/annotations.
 */
@Injectable()
export class PreviewServiceLifecycleService {
  private readonly logger = new Logger(PreviewServiceLifecycleService.name);
  private readonly nodeImage: string;
  private readonly defaultTtlSeconds: number;
  private readonly maxTtlSeconds: number;
  private readonly maxConcurrentServices: number;
  private readonly npmRegistryUrl: string;
  private readonly registryNamespace: string;
  private readonly registryPort: number;
  private readonly allowedSecrets: readonly string[];

  constructor(
    private readonly rbacValidator: RbacValidatorService,
    private readonly k8s: K8sService,
    configService: ConfigService,
  ) {
    // Los defaults acá espejan env.schema.ts — Zod ya garantiza un valor
    // en la práctica (mismo comentario que k8s.service.ts/pod-lifecycle.service.ts).
    this.nodeImage = configService.get<string>(
      'PREVIEW_SERVICE_NODE_IMAGE',
      'docker.io/library/node:22-alpine',
    );
    this.defaultTtlSeconds = configService.get<number>(
      'PREVIEW_SERVICE_DEFAULT_TTL_SECONDS',
      4 * 60 * 60,
    );
    this.maxTtlSeconds = configService.get<number>(
      'PREVIEW_SERVICE_MAX_TTL_SECONDS',
      24 * 60 * 60,
    );
    this.maxConcurrentServices = configService.get<number>(
      'PREVIEW_SERVICE_MAX_CONCURRENT',
      3,
    );
    this.npmRegistryUrl = configService.get<string>(
      'PREVIEW_SERVICE_NPM_REGISTRY_URL',
      'http://verdaccio.registry-proxy.svc.cluster.local:4873',
    );
    this.registryNamespace = configService.get<string>(
      'PREVIEW_SERVICE_REGISTRY_NAMESPACE',
      'registry-proxy',
    );
    this.registryPort = Number(new URL(this.npmRegistryUrl).port) || 4873;
    this.allowedSecrets = configService
      .get<string>('PREVIEW_SERVICE_ALLOWED_CREDENTIALS', '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
  }

  async start(
    request: StartPreviewServiceRequest,
  ): Promise<PreviewServiceInfo> {
    const tool = this.rbacValidator.validate(request.tool);
    // Fail-safe simétrico al de PodLifecycleService.run(): una tool
    // run-to-completion nunca debería llegar acá.
    if (isRunToCompletionTool(tool)) {
      throw new ForbiddenToolError(tool.name);
    }

    // Antes de crear NADA: un secreto no habilitado se rechaza sin tocar el clúster.
    for (const name of request.secrets ?? []) {
      if (!this.allowedSecrets.includes(name)) {
        throw new PreviewServiceSecretNotAllowedError(
          name,
          this.allowedSecrets,
        );
      }
    }

    const activePods = await this.listActivePods();
    if (activePods.length >= this.maxConcurrentServices) {
      throw new PreviewServiceLimitError(this.maxConcurrentServices);
    }

    const serviceId = randomUUID();
    const slug = generateSlug(request.slugHint);
    // Nunca se confía en el ttlSeconds del request tal cual (mismo
    // criterio que `Math.min(request.timeout, tool.maxTimeoutSeconds)`
    // en PodLifecycleService) — el cap duro (7 días) se aplica acá, no
    // solo se documenta.
    const ttlSeconds = Math.min(
      Math.max(request.ttlSeconds || this.defaultTtlSeconds, 1),
      this.maxTtlSeconds,
    );
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const namespace = this.k8s.namespace;

    const podSpec = buildServicePodSpec({
      serviceId,
      slug,
      namespace,
      nodeImage: this.nodeImage,
      workspaceTarGzBase64: buildTarGzBase64(request.files),
      command: request.command,
      port: request.port,
      expiresAt,
      requestId: request.requestId,
      mailEgress: request.mailEgress,
      secrets: request.secrets,
      npmRegistryUrl: request.npm ? this.npmRegistryUrl : undefined,
      // Contraseña aleatoria POR DEMO (no es un secreto real: solo evita que otra demo del
      // clúster entre; la base solo escucha en 127.0.0.1 del propio pod).
      db: request.db
        ? { engine: request.db, password: randomBytes(16).toString('hex') }
        : undefined,
    });
    const networkPolicy = buildServiceIngressNetworkPolicy({
      serviceId,
      namespace,
      port: request.port,
    });
    const service = buildService({ serviceId, namespace, port: request.port });
    const ingressRoute = buildIngressRoute({
      serviceId,
      namespace,
      slug,
      port: request.port,
      tlsSecretName: JINSERVER_TLS_SECRET_NAME,
    });

    this.logger.log(
      `Levantando pod de servicio ${servicePodNameForId(serviceId)} (slug: ${slug}, TTL: ${ttlSeconds}s)`,
    );
    try {
      // La salida a npm existe ANTES que el pod: `npm install` es lo primero que corre.
      if (request.npm) {
        await this.k8s.createNetworkPolicy(
          buildServiceNpmEgressPolicy({
            serviceId,
            namespace,
            registryNamespace: this.registryNamespace,
            registryPort: this.registryPort,
          }),
        );
      }
      await this.k8s.createPod(podSpec);
      await this.k8s.createNetworkPolicy(networkPolicy);
      await this.k8s.createService(service);
      await this.k8s.createIngressRoute(ingressRoute);
    } catch (error) {
      // Nada a medias: lo que ya se creó (policies, Service…) no se queda huérfano, y un
      // 403 de cuota llega como un error claro en vez de un 500 opaco.
      await this.stop(serviceId);
      const detail = quotaDetail(error);
      throw detail === null ? error : new PreviewServiceQuotaError(detail);
    }

    return {
      id: serviceId,
      slug,
      url: `https://${slug}.jinserver.com`,
      status: 'running',
      expiresAt: expiresAt.toISOString(),
      ...(request.db ? { db: request.db } : {}),
    };
  }

  /**
   * Alarga la vida de un servicio que sigue activo (2026-10-02): suma
   * `extraSeconds` al vencimiento actual, sin pasar nunca de
   * `PREVIEW_SERVICE_MAX_TTL_SECONDS` contado desde que el pod se creó. Un
   * servicio vencido no se puede renovar (el reaper puede estar destruyéndolo).
   */
  async extend(
    serviceId: string,
    extraSeconds: number,
  ): Promise<PreviewServiceInfo> {
    const pods = await this.listActivePods();
    const pod = pods.find(
      (candidate) =>
        candidate.metadata?.labels?.[SERVICE_ID_LABEL] === serviceId,
    );
    const podName = pod?.metadata?.name;
    if (!pod || !podName) throw new PreviewServiceNotFoundError(serviceId);
    const info = podToInfo(pod);
    if (info.status !== 'running')
      throw new PreviewServiceNotFoundError(serviceId);

    const createdAt = pod.metadata?.creationTimestamp
      ? new Date(pod.metadata.creationTimestamp).getTime()
      : Date.now();
    const hardLimit = createdAt + this.maxTtlSeconds * 1000;
    const current = new Date(info.expiresAt).getTime();
    const next = Math.min(current + extraSeconds * 1000, hardLimit);
    if (next <= current) {
      throw new PreviewServiceTtlCapError(
        Math.round(this.maxTtlSeconds / 86_400),
      );
    }

    const expiresAt = new Date(next).toISOString();
    await this.k8s.replacePodAnnotationStrict(
      podName,
      SERVICE_EXPIRES_AT_ANNOTATION,
      expiresAt,
    );
    this.logger.log(
      `Servicio ${serviceId} (slug: ${info.slug}) alargado hasta ${expiresAt}`,
    );
    return { ...info, expiresAt };
  }

  /**
   * Nunca lanza (mismo criterio que `K8sService.deletePod`/`deleteService`
   * etc., todos ya no-throw): parar un servicio que ya no existe no es
   * un error real. Orden: Route/Service primero (corta tráfico nuevo
   * antes de destruir el pod), NetworkPolicy y Pod al final.
   */
  async stop(serviceId: string): Promise<void> {
    const podName = servicePodNameForId(serviceId);
    await this.k8s.deleteIngressRoute(podName);
    await this.k8s.deleteService(podName);
    await this.k8s.deleteNetworkPolicy(ingressNetworkPolicyName(serviceId));
    await this.k8s.deleteNetworkPolicy(serviceEgressPolicyName(serviceId));
    await this.k8s.deletePod(podName);
  }

  /**
   * Archivos de texto del espacio de trabajo de un pod de servicio, para que el
   * owner los traiga al editor y los edite (o audite). Lee del pod vivo con el
   * mismo programa fijo que la terminal: nunca sale del espacio de trabajo,
   * omite `node_modules`, `.git` y `.jin` (el servidor de Jin), y deja fuera
   * binarios y lo que pase los topes de Publicar. El pod corre código que
   * escribió un agente: lo que devuelve es un dato, no de confianza.
   */
  async exportFiles(
    serviceId: string,
    dir: string,
  ): Promise<TerminalExportResult> {
    const pods = await this.listActivePods();
    const pod = pods.find(
      (candidate) =>
        candidate.metadata?.labels?.[SERVICE_ID_LABEL] === serviceId,
    );
    if (!pod?.metadata?.name || podToInfo(pod).status !== 'running') {
      throw new PreviewServiceNotFoundError(serviceId);
    }
    const result = await collectExec(this.k8s, pod.metadata.name, 'app', [
      'node',
      '-e',
      EXPORT_FILES_SCRIPT,
      dir,
    ]);
    if (result.code !== 0) {
      throw new PreviewServiceExportError(
        `No se pudieron leer los archivos del pod: ${result.stderr.slice(0, 300)}`,
      );
    }
    try {
      return JSON.parse(result.stdout) as TerminalExportResult;
    } catch (cause) {
      throw new PreviewServiceExportError(
        'El pod devolvió una lista de archivos ilegible.',
        cause,
      );
    }
  }

  async list(): Promise<PreviewServiceInfo[]> {
    const pods = await this.listActivePods();
    return pods.map(podToInfo);
  }

  private async listActivePods(): Promise<V1Pod[]> {
    return this.k8s.listPodsByLabel(ACTIVE_SERVICE_LABEL_SELECTOR);
  }
}
