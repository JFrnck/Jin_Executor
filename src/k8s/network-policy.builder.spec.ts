import { describe, expect, it } from 'vitest';
import { buildPodNetworkPolicy } from './network-policy.builder';

describe('buildPodNetworkPolicy', () => {
  it('selecciona el pod por su run-id, no por nombre', () => {
    const policy = buildPodNetworkPolicy({
      runId: 'abc123',
      namespace: 'agents-sandbox',
      egressCidrs: [],
    });

    expect(policy.spec?.podSelector.matchLabels).toEqual({
      'yormun.io/run-id': 'abc123',
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
