import { describe, expect, it } from 'vitest';
import type { ExecutorToolDefinition } from '../rbac/tool-whitelist';
import { buildPodSpec } from './pod-spec.builder';

const NO_EGRESS_TOOL: ExecutorToolDefinition = {
  name: 'runCode',
  description: '',
  egressWhitelist: [],
  maxTimeoutSeconds: 300,
  remoteMaxTimeoutSeconds: 1800,
  remoteMemoryLimitMiB: 4096,
};

const WITH_EGRESS_TOOL: ExecutorToolDefinition = {
  name: 'toolConEgreso',
  description: '',
  egressWhitelist: ['api.example.com'],
  maxTimeoutSeconds: 60,
  remoteMaxTimeoutSeconds: 60,
  remoteMemoryLimitMiB: 1024,
};

describe('buildPodSpec', () => {
  it('nombra el pod como agent-run-<runId> y lo etiqueta con el run-id', () => {
    const pod = buildPodSpec({
      runId: 'abc123',
      tool: NO_EGRESS_TOOL,
      code: 'console.log(1)',
      env: {},
      timeoutSeconds: 30,
      namespace: 'agents-sandbox',
      denoImage: 'docker.io/denoland/deno:distroless-2.9.3',
    });

    expect(pod.metadata?.name).toBe('agent-run-abc123');
    expect(pod.metadata?.namespace).toBe('agents-sandbox');
    expect(pod.metadata?.labels?.['jin.io/run-id']).toBe('abc123');
  });

  it('usa "deno run" (nunca "eval": eval ignora TODOS los permisos en Deno 2.9)', () => {
    const pod = buildPodSpec({
      runId: 'r1',
      tool: NO_EGRESS_TOOL,
      code: 'x',
      env: {},
      timeoutSeconds: 30,
      namespace: 'ns',
      denoImage: 'img',
    });

    const command = pod.spec?.containers[0]?.command ?? [];
    expect(command[0]).toBe('deno');
    expect(command[1]).toBe('run');
    expect(command).not.toContain('eval');
  });

  it('codifica el código como data: URL en base64, como UN solo argv (sin shell, sin riesgo de inyección)', () => {
    const maliciousCode = '"; rm -rf / #';
    const pod = buildPodSpec({
      runId: 'r1',
      tool: NO_EGRESS_TOOL,
      code: maliciousCode,
      env: {},
      timeoutSeconds: 30,
      namespace: 'agents-sandbox',
      denoImage: 'deno-image',
    });

    const command = pod.spec?.containers[0]?.command ?? [];
    const lastArg = command.at(-1) ?? '';
    expect(lastArg).toMatch(/^data:application\/typescript;base64,/);

    const base64Part = lastArg.split(',')[1] ?? '';
    expect(Buffer.from(base64Part, 'base64').toString('utf-8')).toBe(
      maliciousCode,
    );
  });

  it('sin egressWhitelist, NO incluye --allow-net (deny-all por defecto de Deno)', () => {
    const pod = buildPodSpec({
      runId: 'r1',
      tool: NO_EGRESS_TOOL,
      code: 'x',
      env: {},
      timeoutSeconds: 30,
      namespace: 'ns',
      denoImage: 'img',
    });

    const command = pod.spec?.containers[0]?.command ?? [];
    expect(command.some((arg) => arg.startsWith('--allow-net'))).toBe(false);
  });

  it('con egressWhitelist, incluye --allow-net con los dominios declarados', () => {
    const pod = buildPodSpec({
      runId: 'r1',
      tool: WITH_EGRESS_TOOL,
      code: 'x',
      env: {},
      timeoutSeconds: 30,
      namespace: 'ns',
      denoImage: 'img',
    });

    const command = pod.spec?.containers[0]?.command ?? [];
    expect(command).toContain('--allow-net=api.example.com');
  });

  it('activeDeadlineSeconds del pod = timeoutSeconds (respaldo a nivel de clúster)', () => {
    const pod = buildPodSpec({
      runId: 'r1',
      tool: NO_EGRESS_TOOL,
      code: 'x',
      env: {},
      timeoutSeconds: 42,
      namespace: 'ns',
      denoImage: 'img',
    });

    expect(pod.spec?.activeDeadlineSeconds).toBe(42);
  });

  it('nunca es privileged ni corre como root', () => {
    const pod = buildPodSpec({
      runId: 'r1',
      tool: NO_EGRESS_TOOL,
      code: 'x',
      env: {},
      timeoutSeconds: 30,
      namespace: 'ns',
      denoImage: 'img',
    });

    expect(pod.spec?.securityContext?.runAsNonRoot).toBe(true);
    expect(pod.spec?.containers[0]?.securityContext?.privileged).toBe(false);
    expect(
      pod.spec?.containers[0]?.securityContext?.allowPrivilegeEscalation,
    ).toBe(false);
    expect(
      pod.spec?.containers[0]?.securityContext?.capabilities?.drop,
    ).toEqual(['ALL']);
  });

  it('propaga las variables de entorno declaradas', () => {
    const pod = buildPodSpec({
      runId: 'r1',
      tool: NO_EGRESS_TOOL,
      code: 'x',
      env: { TASK_ID: '42' },
      timeoutSeconds: 30,
      namespace: 'ns',
      denoImage: 'img',
    });

    expect(pod.spec?.containers[0]?.env).toEqual([
      { name: 'TASK_ID', value: '42' },
    ]);
  });
});
