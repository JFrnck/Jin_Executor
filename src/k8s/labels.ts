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

export function servicePodNameForId(serviceId: string): string {
  return `agent-service-${serviceId}`;
}
