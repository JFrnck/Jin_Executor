import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { K8sService } from './k8s.service';

/** kubeconfig a un API server que no existe: sirve para probar lo que se decide ANTES de la red. */
function service(): K8sService {
  const dir = mkdtempSync(path.join(tmpdir(), 'jin-proxy-kubeconfig-'));
  const file = path.join(dir, 'kubeconfig.yaml');
  writeFileSync(
    file,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters: [{name: c, cluster: {server: "https://127.0.0.1:1", insecure-skip-tls-verify: true}}]',
      'users: [{name: u, user: {token: t}}]',
      'contexts: [{name: x, context: {cluster: c, user: u}}]',
      'current-context: x',
    ].join('\n'),
  );
  return new K8sService(new ConfigService({ KUBECONFIG_PATH: file }));
}

describe('K8sService.proxyToPod: la ruta no puede salir del prefijo del pod', () => {
  const k8s = service();
  const request = { method: 'GET', headers: {} } as const;

  it.each([
    ['/../../../../secrets', 'sube con ..'],
    ['/%2e%2e/%2e%2e/secrets', '.. escapado'],
    ['/a/%2E%2E/b', '.. escapado en mayúsculas'],
    ['/a/..', '.. al final'],
    ['/a\\..\\b', 'barra invertida'],
    ['sin-barra', 'no empieza con /'],
    ['/a\u0000b', 'carácter de control'],
    ['/a\nb', 'salto de línea'],
    ['/%zz', 'mal codificada'],
  ])('rechaza %j (%s) sin tocar la red', async (requestPath) => {
    await expect(
      k8s.proxyToPod('agent-terminal-x', 5173, {
        ...request,
        path: requestPath,
      }),
    ).rejects.toThrow(/ruta/);
  });

  it('una ruta normal sí intenta conectar (falla por la red, no por la validación)', async () => {
    const error = await k8s
      .proxyToPod('agent-terminal-x', 5173, {
        ...request,
        path: '/src/main.js?t=1',
      })
      .catch((e: unknown) => e);
    expect(String(error)).not.toMatch(/ruta/);
  });
});
