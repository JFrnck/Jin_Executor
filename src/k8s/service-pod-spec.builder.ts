import type { V1Pod, V1Service } from '@kubernetes/client-node';
import {
  SERVICE_EXPIRES_AT_ANNOTATION,
  SERVICE_ID_LABEL,
  SERVICE_SLUG_ANNOTATION,
  SERVICE_TYPE_LABEL,
  SERVICE_TYPE_VALUE,
  servicePodNameForId,
} from './labels';

// Imagen fija del init container (extrae el workspace) — a diferencia de
// `DENO_IMAGE`/`PREVIEW_SERVICE_NODE_IMAGE`, es un detalle de
// implementación interno que nunca varía por entorno, así que no vive
// en env.schema.ts. Pinneada (nunca `latest`), multi-arch.
const WORKSPACE_EXTRACT_IMAGE = 'docker.io/library/busybox:1.37.0';
const PNPM_STORE_PVC_NAME = 'pnpm-store';
const WORKSPACE_VOLUME = 'workspace';
const PNPM_STORE_VOLUME = 'pnpm-store';
const WORKSPACE_MOUNT_PATH = '/workspace';
const PNPM_STORE_MOUNT_PATH = '/pnpm-store';

export interface BuildServicePodSpecInput {
  readonly serviceId: string;
  readonly slug: string;
  readonly namespace: string;
  readonly nodeImage: string;
  /** tar.gz en base64 (`tar-payload.ts`) — decodificado y extraído por el init container. */
  readonly workspaceTarGzBase64: string;
  readonly command: readonly string[];
  readonly port: number;
  readonly expiresAt: Date;
}

/**
 * Pod de servicio de larga vida (Fase 5.5, ADR 0006). Opuesto al de
 * `pod-spec.builder.ts`: `restartPolicy: Always`, nunca se destruye por
 * `activeDeadlineSeconds` (el reaper lo hace por annotation de TTL), y
 * expone un puerto.
 *
 * El init container decodifica el payload base64 y lo extrae con `tar`
 * dentro de una shell — a diferencia del `data:` URL de `buildPodSpec`
 * (código LLM-generado, ejecutable), acá el payload es SOLO datos
 * codificados en base64: ese alfabeto excluye por construcción cualquier
 * metacaracter de shell (`;`, `$`, backticks, comillas), así que no hay
 * superficie de inyección aunque se pase dentro de `sh -c` — el string
 * de comando en sí es literal y fijo, el payload solo se expande como
 * variable de entorno entre comillas dobles.
 */
export function buildServicePodSpec(input: BuildServicePodSpecInput): V1Pod {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: servicePodNameForId(input.serviceId),
      namespace: input.namespace,
      labels: {
        [SERVICE_ID_LABEL]: input.serviceId,
        [SERVICE_TYPE_LABEL]: SERVICE_TYPE_VALUE,
      },
      annotations: {
        [SERVICE_EXPIRES_AT_ANNOTATION]: input.expiresAt.toISOString(),
        [SERVICE_SLUG_ANNOTATION]: input.slug,
      },
    },
    spec: {
      restartPolicy: 'Always',
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
      },
      volumes: [
        { name: WORKSPACE_VOLUME, emptyDir: {} },
        {
          name: PNPM_STORE_VOLUME,
          persistentVolumeClaim: { claimName: PNPM_STORE_PVC_NAME },
        },
      ],
      initContainers: [
        {
          name: 'extract-workspace',
          image: WORKSPACE_EXTRACT_IMAGE,
          command: [
            'sh',
            '-c',
            `echo "$WORKSPACE_TAR_GZ_BASE64" | base64 -d | tar xz -C ${WORKSPACE_MOUNT_PATH}`,
          ],
          env: [
            {
              name: 'WORKSPACE_TAR_GZ_BASE64',
              value: input.workspaceTarGzBase64,
            },
          ],
          volumeMounts: [
            { name: WORKSPACE_VOLUME, mountPath: WORKSPACE_MOUNT_PATH },
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            privileged: false,
            capabilities: { drop: ['ALL'] },
          },
          // docs/RECOMENDACIONES.md #26: sin esto dependía enteramente de
          // que el LimitRange de agents-sandbox (Jin_Infra, otro repo)
          // cubriera también init containers. Menor que el límite del
          // container `app` — extraer un tar.gz es más liviano que correr
          // el servicio, mismo criterio que pod-spec.builder.ts (runCode).
          resources: {
            requests: { cpu: '250m', memory: '256Mi' },
            limits: { cpu: '500m', memory: '512Mi' },
          },
        },
      ],
      containers: [
        {
          name: 'app',
          image: input.nodeImage,
          command: [...input.command],
          workingDir: WORKSPACE_MOUNT_PATH,
          ports: [{ containerPort: input.port }],
          env: [
            { name: 'PORT', value: String(input.port) },
            { name: 'PNPM_HOME', value: PNPM_STORE_MOUNT_PATH },
            {
              name: 'npm_config_cache',
              value: `${PNPM_STORE_MOUNT_PATH}/npm-cache`,
            },
          ],
          volumeMounts: [
            { name: WORKSPACE_VOLUME, mountPath: WORKSPACE_MOUNT_PATH },
            { name: PNPM_STORE_VOLUME, mountPath: PNPM_STORE_MOUNT_PATH },
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            privileged: false,
            // `readOnlyRootFilesystem: true` (docs/RECOMENDACIONES.md #10,
            // segunda mitad del hallazgo) se intentó en este mismo PR y se
            // REVIRTIÓ: el smoke test de K3s real
            // (preview-service.service.integration.spec.ts, "camino
            // feliz") colgó 180s sin ningún log intermedio — ni siquiera
            // el timeout propio de waitUntilPodRunning (60s) llegó a
            // disparar, lo que apunta a algo más temprano que el pod
            // nunca sirviendo HTTP, no a la flakiness de red ya
            // documentada en ADR 0003 (esa es rápida, de segundos). Sin
            // acceso a un clúster real para diagnosticar la causa exacta,
            // no se fuerza sin verificar. El zip-slip en sí (la parte
            // crítica) queda cerrado igual: se corrige en la capa de
            // datos (tar-payload.ts + schema), no depende de esto.
            // Pendiente: reintentar con logging más granular en el test
            // o acceso a un clúster real para inspeccionar el pod.
            capabilities: { drop: ['ALL'] },
          },
          // Dentro del LimitRange de agents-sandbox (default 512Mi/500m,
          // máx 1Gi/1000m, maxLimitRequestRatio.memory=3) — sin ampliarlo
          // (restricción explícita de PROMPTS.md §5.5). requests.memory en
          // 384Mi, no 256Mi: con el límite en el máximo de 1Gi, 256Mi daba
          // ratio 4 y el LimitRange rechaza el pod (máximo permitido 3).
          resources: {
            requests: { cpu: '250m', memory: '384Mi' },
            limits: { cpu: '1000m', memory: '1Gi' },
          },
        },
      ],
    },
  };
}

export interface BuildServiceInput {
  readonly serviceId: string;
  readonly namespace: string;
  readonly port: number;
}

export function buildService(input: BuildServiceInput): V1Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: servicePodNameForId(input.serviceId),
      namespace: input.namespace,
      labels: { [SERVICE_ID_LABEL]: input.serviceId },
    },
    spec: {
      selector: { [SERVICE_ID_LABEL]: input.serviceId },
      ports: [{ port: input.port, targetPort: input.port }],
    },
  };
}

export interface BuildIngressRouteInput {
  readonly serviceId: string;
  readonly namespace: string;
  readonly slug: string;
  readonly port: number;
  readonly tlsSecretName: string;
}

/**
 * Manifest de `IngressRoute` (CRD de Traefik, ADR 0006 punto 7) —
 * `unknown` tipado a propósito: `@kubernetes/client-node` no conoce este
 * CRD, `K8sService.createIngressRoute` lo trata como objeto opaco.
 */
export function buildIngressRoute(input: BuildIngressRouteInput): unknown {
  const serviceName = servicePodNameForId(input.serviceId);
  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: {
      name: serviceName,
      namespace: input.namespace,
      labels: { [SERVICE_ID_LABEL]: input.serviceId },
    },
    spec: {
      entryPoints: ['websecure'],
      routes: [
        {
          match: `Host(\`${input.slug}.jinserver.com\`)`,
          kind: 'Rule',
          services: [{ name: serviceName, port: input.port }],
        },
      ],
      tls: { secretName: input.tlsSecretName },
    },
  };
}
