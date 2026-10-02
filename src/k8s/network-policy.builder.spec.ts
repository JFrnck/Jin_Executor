import { describe, expect, it } from 'vitest';
import {
  buildPodNetworkPolicy,
  buildServiceIngressNetworkPolicy,
  buildServiceNpmEgressPolicy,
} from './network-policy.builder';

describe('buildPodNetworkPolicy', () => {
  it('selecciona el pod por su run-id, no por nombre', () => {
    const policy = buildPodNetworkPolicy({
      runId: 'abc123',
      namespace: 'agents-sandbox',
      egressCidrs: [],
    });

    expect(policy.spec?.podSelector?.matchLabels).toEqual({
      'jin.io/run-id': 'abc123',
    });
    expect(policy.metadata?.name).toBe('agent-run-abc123');
    expect(policy.metadata?.namespace).toBe('agents-sandbox');
  });

  it('solo declara Egress (el Ingress ya lo bloquea la policy de namespace)', () => {
    const policy = buildPodNetworkPolicy({
      runId: 'r1',
      namespace: 'ns',
      egressCidrs: [],
    });
    expect(policy.spec?.policyTypes).toEqual(['Egress']);
  });

  it('traduce cada CIDR resuelto a una regla ipBlock', () => {
    const policy = buildPodNetworkPolicy({
      runId: 'r1',
      namespace: 'ns',
      egressCidrs: ['203.0.113.0/24', '198.51.100.5/32'],
    });

    expect(policy.spec?.egress?.[0]?.to).toEqual([
      { ipBlock: { cidr: '203.0.113.0/24' } },
      { ipBlock: { cidr: '198.51.100.5/32' } },
    ]);
  });
});

describe('buildServiceNpmEgressPolicy', () => {
  it('selecciona el pod por service-id y solo abre Egress hacia Verdaccio, en su puerto; nada hacia internet', () => {
    const policy = buildServiceNpmEgressPolicy({
      serviceId: 'svc-1',
      namespace: 'agents-sandbox',
      registryNamespace: 'registry-proxy',
      registryPort: 4873,
    });

    expect(policy.metadata?.name).toBe('svc-1-egress');
    expect(policy.spec?.podSelector?.matchLabels).toEqual({
      'jin.io/service-id': 'svc-1',
    });
    expect(policy.spec?.policyTypes).toEqual(['Egress']);
    expect(policy.spec?.egress).toEqual([
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'registry-proxy' },
            },
            podSelector: {
              matchLabels: { 'app.kubernetes.io/name': 'verdaccio' },
            },
          },
        ],
        ports: [{ protocol: 'TCP', port: 4873 }],
      },
    ]);
    expect(JSON.stringify(policy)).not.toContain('ipBlock');
  });
});

describe('buildServiceIngressNetworkPolicy', () => {
  it('selecciona el pod por su service-id, permite Ingress SOLO desde kube-system (Traefik) al puerto expuesto', () => {
    const policy = buildServiceIngressNetworkPolicy({
      serviceId: 'svc-1',
      namespace: 'agents-sandbox',
      port: 3000,
    });

    expect(policy.spec?.podSelector?.matchLabels).toEqual({
      'jin.io/service-id': 'svc-1',
    });
    expect(policy.spec?.policyTypes).toEqual(['Ingress']);
    expect(policy.spec?.ingress?.[0]?._from).toEqual([
      {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
        },
      },
    ]);
    expect(policy.spec?.ingress?.[0]?.ports).toEqual([
      { port: 3000, protocol: 'TCP' },
    ]);
  });

  it('el nombre de la policy deriva del serviceId, distinto de la de egress de pods run-to-completion', () => {
    const policy = buildServiceIngressNetworkPolicy({
      serviceId: 'svc-1',
      namespace: 'ns',
      port: 3000,
    });
    expect(policy.metadata?.name).toBe('svc-1-ingress');
  });
});
