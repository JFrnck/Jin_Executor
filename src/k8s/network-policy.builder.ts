import type { V1NetworkPolicy } from '@kubernetes/client-node';
import { podNameForRun, RUN_ID_LABEL } from './labels';

export interface BuildPodNetworkPolicyInput {
  readonly runId: string;
  readonly namespace: string;
  /**
   * CIDRs YA RESUELTOS (no dominios) a los que este pod puede salir
   * además de DNS. La resolución dominio→CIDR no existe todavía — ver
   * tool-whitelist.ts y rbac/errors.ts::UnresolvedEgressWhitelistError,
   * que impide llegar aquí con una whitelist de dominios sin resolver.
   */
  readonly egressCidrs: readonly string[];
}

/**
 * NetworkPolicy con alcance a UN solo pod (via podSelector por su
 * run-id). Las políticas de Kubernetes son aditivas: esto SUMA permisos
 * sobre lo que ya conceden las policies de namespace de Jin_Infra
 * (default-deny + DNS-only en agents-sandbox) — no las reemplaza. Por
 * eso no repite la regla de DNS aquí: ya está cubierta a nivel de
 * namespace y sería redundante.
 */
export function buildPodNetworkPolicy(
  input: BuildPodNetworkPolicyInput,
): V1NetworkPolicy {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: podNameForRun(input.runId),
      namespace: input.namespace,
    },
    spec: {
      podSelector: { matchLabels: { [RUN_ID_LABEL]: input.runId } },
      policyTypes: ['Egress'],
      egress: [
        {
          to: input.egressCidrs.map((cidr) => ({ ipBlock: { cidr } })),
        },
      ],
    },
  };
}
