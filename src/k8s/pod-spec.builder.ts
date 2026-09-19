import type { V1Pod } from '@kubernetes/client-node';
import type { ExecutorToolDefinition } from '../rbac/tool-whitelist';
import { podNameForRun, RUN_ID_LABEL } from './labels';

export interface BuildPodSpecInput {
  readonly runId: string;
  readonly tool: ExecutorToolDefinition;
  readonly code: string;
  readonly env: Readonly<Record<string, string>>;
  /** Ya acotado contra tool.maxTimeoutSeconds por el caller. */
  readonly timeoutSeconds: number;
  readonly namespace: string;
  readonly denoImage: string;
}

/**
 * Construye el manifest del pod efímero (BLUEPRINT 4.4).
 *
 * IMPORTANTE: usa `deno run`, NUNCA `deno eval` — se verificó
 * empíricamente (Deno 2.9) que `deno eval` tiene "implicit access to all
 * permissions": ignora por completo `--allow-net` y cualquier otro flag
 * de permisos, sin importar si se pasan o no. Usarlo habría dejado el
 * sandbox completamente abierto pese a la apariencia de estar
 * restringido. `deno run` sí respeta el modelo deny-by-default de Deno.
 *
 * `deno run` necesita un módulo (archivo o URL), no código inline. Para
 * evitar (a) un ConfigMap con el código — prohibido: el RBAC del
 * Executor no tiene acceso a ConfigMaps (BLUEPRINT 4.2) — y (b) una
 * shell para escribirlo a un archivo temporal — la imagen distroless no
 * tiene shell, y reintroduciría superficie de inyección — el código se
 * pasa como un `data:` URL en base64. `args` de Kubernetes nunca pasa
 * por una shell, así que esto sigue sin riesgo de inyección: el string
 * final es un solo argv literal.
 *
 * Sin `--allow-net` en absoluto cuando `egressWhitelist` está vacío: es
 * el default seguro de Deno (deny-all), no una whitelist vacía ambigua.
 * Verificado con K3s real: sin el flag, un intento de red falla con
 * `NotCapable`; con el flag, la conexión se permite.
 */
export function buildPodSpec(input: BuildPodSpecInput): V1Pod {
  const allowNetArg =
    input.tool.egressWhitelist.length > 0
      ? [`--allow-net=${input.tool.egressWhitelist.join(',')}`]
      : [];

  const codeDataUrl = `data:application/typescript;base64,${Buffer.from(input.code, 'utf-8').toString('base64')}`;

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podNameForRun(input.runId),
      namespace: input.namespace,
      labels: {
        [RUN_ID_LABEL]: input.runId,
        'jin.io/tool': input.tool.name,
      },
    },
    spec: {
      restartPolicy: 'Never',
      // Respaldo a nivel de clúster del timeout aplicativo (PodLifecycleService):
      // si el proceso del Executor muriera a mitad de espera, K8s igual mata el pod.
      activeDeadlineSeconds: input.timeoutSeconds,
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
      },
      containers: [
        {
          name: 'agent',
          image: input.denoImage,
          command: ['deno', 'run', ...allowNetArg, codeDataUrl],
          env: Object.entries(input.env).map(([name, value]) => ({
            name,
            value,
          })),
          securityContext: {
            allowPrivilegeEscalation: false,
            privileged: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
          // Alineado con el LimitRange de agents-sandbox (Jin_Infra
          // k8s/base/namespaces/agents-sandbox-limitrange.yaml): default
          // 512Mi/500m, máximo 1Gi/1000m, límite ≤ 3× el request.
          resources: {
            requests: { cpu: '250m', memory: '256Mi' },
            limits: { cpu: '500m', memory: '512Mi' },
          },
        },
      ],
    },
  };
}
