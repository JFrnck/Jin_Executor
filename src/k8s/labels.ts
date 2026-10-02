/** Label compartido entre el Pod y su NetworkPolicy — la correlación entre ambos. */
export const RUN_ID_LABEL = 'jin.io/run-id';

export function podNameForRun(runId: string): string {
  return `agent-run-${runId}`;
}

// Fase 5.5 (ADR 0006): pods de servicio de larga vida — distintos de los
// run-to-completion de arriba, con su propio label de correlación
// Pod/Service/NetworkPolicy/IngressRoute y un label de tipo para que el
// reaper/`listPreviewServices` los liste sin ambigüedad.
export const SERVICE_ID_LABEL = 'jin.io/service-id';
export const SERVICE_TYPE_LABEL = 'jin.io/type';
export const SERVICE_TYPE_VALUE = 'service';
/** Annotation con el timestamp ISO de vencimiento del TTL — lo lee el reaper. */
export const SERVICE_EXPIRES_AT_ANNOTATION = 'jin.io/expires-at';
/** Annotation con el slug real (Kubernetes es el store de estado — ADR 0006 punto 3, sin tabla propia donde guardarlo). */
export const SERVICE_SLUG_ANNOTATION = 'jin.io/slug';
/** Secret de TLS del wildcard `*.jinserver.com` en `agents-sandbox` (Certificate propio, ver ADR 0006 punto 8 — el de namespace `jin` no es visible acá). */
export const JINSERVER_TLS_SECRET_NAME = 'wildcard-jinserver-com-tls';

/**
 * Pod de servicio que puede enviar correo (2026-10-02): lo pone el Executor SOLO
 * si la aprobación pedía `mailEgress`. La NetworkPolicy del proxy `mail-egress`
 * (Jin_Infra) solo acepta pods de servicio con este label.
 */
export const MAIL_EGRESS_LABEL = 'jin.io/mail-egress';
export const MAIL_EGRESS_LABEL_VALUE = 'enabled';

export function servicePodNameForId(serviceId: string): string {
  return `agent-service-${serviceId}`;
}

// ADR 0016 (sesiones de terminal): pod de larga vida donde el owner corre
// comandos (npm, vite). Comparte SERVICE_ID_LABEL con el Service/IngressRoute
// que se crean si publica el build, pero su tipo es distinto: las listas de
// previews (`jin.io/type=service`) no lo ven.
export const TERMINAL_TYPE_VALUE = 'terminal';
/**
 * Pod de terminal abierto con "Habilitar Claude Code" (ADR 0017, 2026-09-29).
 * Lo pone el Executor SOLO cuando el owner lo pidió y aprobó: la NetworkPolicy
 * del proxy de salida a Anthropic (Jin_Infra, `claude-egress`) solo acepta
 * pods que tengan este label.
 */
export const CLAUDE_LABEL = 'jin.io/claude';
export const CLAUDE_LABEL_VALUE = 'enabled';
export const TERMINAL_CONTAINER_NAME = 'main';

export function terminalPodNameForId(workspaceId: string): string {
  return `agent-terminal-${workspaceId}`;
}

// Disco persistente por proyecto (2026-09-28, ADR 0016 ampliada): el `id` es
// ahora el id ESTABLE del proyecto (lo genera la app), no uno al azar por
// sesión — así el disco sobrevive a que el pod se destruya y se vuelva a
// crear. `WORKSPACE_TYPE_VALUE` distingue el PVC en las listas por label del
// resto (pods de servicio/terminal usan SERVICE_TYPE_LABEL con otro valor).
export const WORKSPACE_TYPE_VALUE = 'workspace';

export function terminalWorkspacePvcNameForId(workspaceId: string): string {
  return `terminal-ws-${workspaceId}`;
}

/** Última vez que el owner mandó un comando/servicio/petición: lo usa el reaper para liberar por inactividad. */
export const LAST_ACTIVITY_ANNOTATION = 'jin.io/last-activity-at';

/**
 * Annotation con el `requestId` de la aprobación (HITL) que originó el pod.
 * Lo pone Jin_Core, que es quien sabe de dónde viene: sirve para enlazar el
 * pod con su fila del audit. Ausente en pods anteriores a este campo.
 */
export const REQUEST_ID_ANNOTATION = 'jin.io/request-id';
