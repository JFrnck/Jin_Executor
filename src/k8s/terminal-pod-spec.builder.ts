import type {
  V1NetworkPolicy,
  V1PersistentVolumeClaim,
  V1Pod,
} from '@kubernetes/client-node';
import {
  LAST_ACTIVITY_ANNOTATION,
  REQUEST_ID_ANNOTATION,
  SERVICE_EXPIRES_AT_ANNOTATION,
  SERVICE_ID_LABEL,
  SERVICE_TYPE_LABEL,
  TERMINAL_CONTAINER_NAME,
  TERMINAL_TYPE_VALUE,
  WORKSPACE_TYPE_VALUE,
  terminalPodNameForId,
  terminalWorkspacePvcNameForId,
} from './labels';

export const TERMINAL_WORKSPACE_PATH = '/workspace';
const WORKSPACE_VOLUME = 'workspace';
const TMP_VOLUME = 'tmp';

export interface BuildTerminalWorkspacePvcInput {
  /** Id ESTABLE del proyecto (lo genera la app) — no cambia entre sesiones. */
  readonly workspaceId: string;
  readonly namespace: string;
  /** Cuota del disco, ej. "3Gi". */
  readonly storageSize: string;
}

/**
 * El disco de un proyecto (2026-09-28, ADR 0016 ampliada): sobrevive a que su
 * pod se destruya y se vuelva a crear. `local-path` (default del clúster,
 * `WaitForFirstConsumer`) lo deja `Pending` hasta que un pod lo reclame — es
 * el comportamiento esperado, no un error.
 */
export function buildTerminalWorkspacePvc(
  input: BuildTerminalWorkspacePvcInput,
): V1PersistentVolumeClaim {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: terminalWorkspacePvcNameForId(input.workspaceId),
      namespace: input.namespace,
      labels: {
        [SERVICE_ID_LABEL]: input.workspaceId,
        [SERVICE_TYPE_LABEL]: WORKSPACE_TYPE_VALUE,
      },
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: input.storageSize } },
    },
  };
}

export interface BuildTerminalPodSpecInput {
  /** Id ESTABLE del proyecto: nombra el pod Y el disco que monta. */
  readonly workspaceId: string;
  readonly namespace: string;
  readonly image: string;
  /** Proxy de npm del clúster: la única salida de red del pod. */
  readonly npmRegistryUrl: string;
  readonly expiresAt: Date;
  /** Aprobación que lo originó (para enlazarlo con el audit). */
  readonly requestId?: string | undefined;
  readonly now: Date;
}

/**
 * Pod de la terminal de un proyecto (ADR 0016). No corre nada por sí mismo:
 * espera comandos que el Executor le manda con `exec`. Mismas garantías que
 * los pods de servicio (sin root, sin token de ServiceAccount, PSA
 * `restricted`, sin capabilities), con tres diferencias a propósito:
 *
 * - `restartPolicy: Never`: si el contenedor muere (p. ej. por memoria), el
 *   pod termina en vez de reiniciarse con el disco a medio escribir sin que
 *   se note.
 * - El espacio de trabajo es el PVC propio del proyecto (`workspaceId`), no
 *   el PVC compartido `pnpm-store` de los previews: un paquete malicioso en
 *   un proyecto no puede envenenar el disco de otro.
 * - No hay ni env vars con secretos ni puertos: el pod no recibe nada del
 *   sistema. Lo único que sabe es la URL del proxy de npm.
 */
export function buildTerminalPodSpec(input: BuildTerminalPodSpecInput): V1Pod {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: terminalPodNameForId(input.workspaceId),
      namespace: input.namespace,
      labels: {
        [SERVICE_ID_LABEL]: input.workspaceId,
        [SERVICE_TYPE_LABEL]: TERMINAL_TYPE_VALUE,
      },
      annotations: {
        [SERVICE_EXPIRES_AT_ANNOTATION]: input.expiresAt.toISOString(),
        // Valor inicial: patchPodAnnotation() más adelante solo sabe
        // REEMPLAZAR, nunca crear — la clave tiene que existir desde ya.
        [LAST_ACTIVITY_ANNOTATION]: input.now.toISOString(),
        ...(input.requestId
          ? { [REQUEST_ID_ANNOTATION]: input.requestId }
          : {}),
      },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      // Destruir el pod es inmediato: nada dentro necesita cerrar limpio.
      terminationGracePeriodSeconds: 1,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      volumes: [
        {
          name: WORKSPACE_VOLUME,
          persistentVolumeClaim: {
            claimName: terminalWorkspacePvcNameForId(input.workspaceId),
          },
        },
        { name: TMP_VOLUME, emptyDir: { sizeLimit: '512Mi' } },
      ],
      containers: [
        {
          name: TERMINAL_CONTAINER_NAME,
          image: input.image,
          // `exec` para que `tail` sea PID 1 y reciba la señal de borrado.
          command: ['sh', '-c', 'exec tail -f /dev/null'],
          workingDir: TERMINAL_WORKSPACE_PATH,
          env: [
            { name: 'HOME', value: '/tmp' },
            { name: 'npm_config_registry', value: input.npmRegistryUrl },
            // corepack (pnpm/yarn) también sale por el proxy, no a npmjs.org.
            { name: 'COREPACK_NPM_REGISTRY', value: input.npmRegistryUrl },
            { name: 'npm_config_cache', value: '/tmp/.npm' },
            // Sin llamadas extra: el proxy no las necesita y solo agregan ruido.
            { name: 'npm_config_audit', value: 'false' },
            { name: 'npm_config_fund', value: 'false' },
            { name: 'npm_config_update_notifier', value: 'false' },
            // Pocas conexiones a la vez y más reintentos: el proxy es uno solo
            // y una ráfaga de 15 conexiones nuevas lo saturaba.
            { name: 'npm_config_maxsockets', value: '8' },
            { name: 'npm_config_fetch_retries', value: '5' },
            { name: 'CI', value: 'true' },
          ],
          volumeMounts: [
            { name: WORKSPACE_VOLUME, mountPath: TERMINAL_WORKSPACE_PATH },
            { name: TMP_VOLUME, mountPath: '/tmp' },
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            privileged: false,
            capabilities: { drop: ['ALL'] },
          },
          // Dentro del LimitRange de agents-sandbox (máx 1Gi/1000m, ratio de
          // memoria ≤ 3): un `vite build` entra en 1Gi.
          resources: {
            requests: { cpu: '250m', memory: '384Mi' },
            limits: { cpu: '1000m', memory: '1Gi' },
          },
        },
      ],
    },
  };
}

export function terminalEgressPolicyName(workspaceId: string): string {
  return `${workspaceId}-egress`;
}

export interface BuildTerminalEgressPolicyInput {
  readonly workspaceId: string;
  readonly namespace: string;
  readonly registryNamespace: string;
  readonly registryPort: number;
}

/**
 * La ÚNICA salida de una sesión (además de DNS, que ya concede la policy del
 * namespace): el pod del proxy de npm, en su puerto. Aditiva sobre el
 * default-deny de `agents-sandbox`, como las demás policies de este archivo.
 * No hay regla hacia internet: si algo que no sea el proxy responde, es un
 * bug de esta función.
 */
export function buildTerminalEgressPolicy(
  input: BuildTerminalEgressPolicyInput,
): V1NetworkPolicy {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: terminalEgressPolicyName(input.workspaceId),
      namespace: input.namespace,
    },
    spec: {
      podSelector: { matchLabels: { [SERVICE_ID_LABEL]: input.workspaceId } },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: {
                  'kubernetes.io/metadata.name': input.registryNamespace,
                },
              },
              podSelector: {
                matchLabels: { 'app.kubernetes.io/name': 'verdaccio' },
              },
            },
          ],
          ports: [{ protocol: 'TCP', port: input.registryPort }],
        },
      ],
    },
  };
}
