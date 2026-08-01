import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { V1Pod } from '@kubernetes/client-node';
import { K8sService } from '../k8s/k8s.service';
import {
  buildIngressRoute,
  buildService,
  buildServicePodSpec,
} from '../k8s/service-pod-spec.builder';
import { buildServiceIngressNetworkPolicy } from '../k8s/network-policy.builder';
import {
  JINSERVER_TLS_SECRET_NAME,
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
import { PreviewServiceLimitError } from './errors';
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
  return {
    id: serviceId,
    slug,
    url: `https://${slug}.jinserver.com`,
    status: expired ? 'expired' : 'running',
    expiresAt,
  };
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

    const activePods = await this.listActivePods();
    if (activePods.length >= this.maxConcurrentServices) {
      throw new PreviewServiceLimitError(this.maxConcurrentServices);
    }

    const serviceId = randomUUID();
    const slug = generateSlug(request.slugHint);
    // Nunca se confía en el ttlSeconds del request tal cual (mismo
    // criterio que `Math.min(request.timeout, tool.maxTimeoutSeconds)`
    // en PodLifecycleService) — el cap duro de 24h se aplica acá, no
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
    await this.k8s.createPod(podSpec);
    await this.k8s.createNetworkPolicy(networkPolicy);
    await this.k8s.createService(service);
    await this.k8s.createIngressRoute(ingressRoute);

    return {
      id: serviceId,
      slug,
      url: `https://${slug}.jinserver.com`,
      status: 'running',
      expiresAt: expiresAt.toISOString(),
    };
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
    await this.k8s.deletePod(podName);
  }

  async list(): Promise<PreviewServiceInfo[]> {
    const pods = await this.listActivePods();
    return pods.map(podToInfo);
  }

  private async listActivePods(): Promise<V1Pod[]> {
    return this.k8s.listPodsByLabel(ACTIVE_SERVICE_LABEL_SELECTOR);
  }
}
