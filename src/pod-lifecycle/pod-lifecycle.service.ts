import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ExecutionResult } from '../execute/execution-result';
import { buildPodSpec } from '../k8s/pod-spec.builder';
import { K8sService } from '../k8s/k8s.service';
import { podNameForRun } from '../k8s/labels';
import { ModalService } from '../modal/modal.service';
import { UnresolvedEgressWhitelistError } from '../rbac/errors';
import { RbacValidatorService } from '../rbac/rbac-validator.service';

export interface RunRequest {
  readonly tool: string;
  readonly code: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeout: number;
  readonly remote: boolean;
}

/**
 * Orquesta el ciclo de vida completo bajo demanda (BLUEPRINT 4.4): sin
 * warm pool — crea el pod al llegar la tarea, ejecuta, recoge el
 * resultado, y SIEMPRE lo destruye (éxito, fallo, o timeout).
 */
@Injectable()
export class PodLifecycleService {
  private readonly logger = new Logger(PodLifecycleService.name);
  private readonly denoImage: string;

  constructor(
    private readonly rbacValidator: RbacValidatorService,
    private readonly k8s: K8sService,
    private readonly modal: ModalService,
    // Ver el comentario equivalente en k8s.service.ts: la clase real
    // `ConfigService`, no el alias de tipo, es lo que Nest necesita para
    // resolver la inyección vía metadata de decoradores.
    configService: ConfigService,
  ) {
    // El default aquí espeja el de env.schema.ts (ver nota equivalente en
    // k8s.service.ts) — Zod ya garantiza un valor en la práctica.
    this.denoImage = configService.get<string>(
      'DENO_IMAGE',
      'docker.io/denoland/deno:distroless-2.9.3',
    );
  }

  async run(request: RunRequest): Promise<ExecutionResult> {
    const tool = this.rbacValidator.validate(request.tool);

    if (tool.egressWhitelist.length > 0) {
      // Fail-safe (AGENTS.md 1.4): mejor rechazar ruidosamente que
      // conceder egreso de forma incorrecta. Ver rbac/tool-whitelist.ts.
      throw new UnresolvedEgressWhitelistError(tool.name, tool.egressWhitelist);
    }

    if (request.remote) {
      return this.modal.runRemote(tool, request.code, request.env);
    }

    const runId = randomUUID();
    const timeoutSeconds = Math.min(request.timeout, tool.maxTimeoutSeconds);
    const podName = podNameForRun(runId);

    const podSpec = buildPodSpec({
      runId,
      tool,
      code: request.code,
      env: request.env,
      timeoutSeconds,
      namespace: this.k8s.namespace,
      denoImage: this.denoImage,
    });

    // egressWhitelist ya está vacío en este punto (chequeado arriba), así
    // que no hace falta crear una NetworkPolicy adicional: las policies
    // de namespace de Yormun_Infra (default-deny + DNS-only) ya cubren
    // exactamente este caso. El mecanismo existe (buildPodNetworkPolicy,
    // k8s.createNetworkPolicy) para cuando exista una tool con egreso
    // real resuelto.
    try {
      this.logger.log(
        `Creando pod ${podName} para tool "${tool.name}" (run ${runId})`,
      );
      await this.k8s.createPod(podSpec);

      const finalPod = await this.k8s.waitForPod(
        podName,
        timeoutSeconds * 1000,
      );
      const logs = await this.k8s.getPodLogs(podName);
      const succeeded = finalPod.status?.phase === 'Succeeded';

      return { runId, succeeded, logs };
    } finally {
      await this.k8s.deletePod(podName);
    }
  }
}
