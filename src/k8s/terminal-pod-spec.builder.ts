import type { V1NetworkPolicy, V1Pod } from '@kubernetes/client-node';
import {
  REQUEST_ID_ANNOTATION,
  SERVICE_EXPIRES_AT_ANNOTATION,
  SERVICE_ID_LABEL,
  SERVICE_TYPE_LABEL,
  TERMINAL_CONTAINER_NAME,
  TERMINAL_TYPE_VALUE,
  terminalPodNameForId,
} from './labels';

export const TERMINAL_WORKSPACE_PATH = '/workspace';
const WORKSPACE_VOLUME = 'workspace';
const TMP_VOLUME = 'tmp';

export interface BuildTerminalPodSpecInput {
  readonly terminalId: string;
  readonly namespace: string;
  readonly image: string;
  /** Proxy de npm del clúster: la única salida de red del pod. */
  readonly npmRegistryUrl: string;
  readonly expiresAt: Date;
  /** Aprobación que lo originó (para enlazarlo con el audit). */
  readonly requestId?: string | undefined;
}

/**
 * Pod de una sesión de terminal (ADR 0016). No corre nada por sí mismo: espera
 * comandos que el Executor le manda con `exec`. Mismas garantías que los pods
 * de servicio (sin root, sin token de ServiceAccount, PSA `restricted`, sin
 * capabilities), con tres diferencias a propósito:
 *
 * - `restartPolicy: Never`: si el contenedor muere (p. ej. por memoria), la
 *   sesión termina en vez de reiniciarse con el disco vacío sin que se note.
 * - El espacio de trabajo es un `emptyDir`, no el PVC compartido `pnpm-store`:
 *   un paquete malicioso no puede envenenar la caché de otros pods.
 * - No hay ni env vars con secretos ni puertos: la sesión no recibe nada del
 *   sistema. Lo único que sabe es la URL del proxy de npm.
 */
export function buildTerminalPodSpec(input: BuildTerminalPodSpecInput): V1Pod {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: terminalPodNameForId(input.terminalId),
      namespace: input.namespace,
      labels: {
        [SERVICE_ID_LABEL]: input.terminalId,
        [SERVICE_TYPE_LABEL]: TERMINAL_TYPE_VALUE,
      },
      annotations: {
        [SERVICE_EXPIRES_AT_ANNOTATION]: input.expiresAt.toISOString(),
        ...(input.requestId
          ? { [REQUEST_ID_ANNOTATION]: input.requestId }
          : {}),
      },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      // Destruir la sesión es inmediato: nada dentro necesita cerrar limpio.
      terminationGracePeriodSeconds: 1,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      volumes: [
        { name: WORKSPACE_VOLUME, emptyDir: { sizeLimit: '1Gi' } },
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

export function terminalEgressPolicyName(terminalId: string): string {
  return `${terminalId}-egress`;
}

export interface BuildTerminalEgressPolicyInput {
  readonly terminalId: string;
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
      name: terminalEgressPolicyName(input.terminalId),
      namespace: input.namespace,
    },
    spec: {
      podSelector: { matchLabels: { [SERVICE_ID_LABEL]: input.terminalId } },
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
