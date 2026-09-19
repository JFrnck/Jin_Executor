import { K3sContainer, type StartedK3sContainer } from '@testcontainers/k3s';
import {
  CoreV1Api,
  KubeConfig,
  NetworkingV1Api,
  type V1NetworkPolicy,
} from '@kubernetes/client-node';

// Pinneado (nunca `latest`), misma versión que scripts/bootstrap de
// Jin_Infra (v1.36.2+k3s1 → tag de Docker Hub usa guion, no +).
const K3S_IMAGE = 'rancher/k3s:v1.36.2-k3s1';

export const AGENTS_SANDBOX_NAMESPACE = 'agents-sandbox';
export const JIN_NAMESPACE = 'jin';

export interface TestK3s {
  container: StartedK3sContainer;
  coreApi: CoreV1Api;
  networkingApi: NetworkingV1Api;
  kubeConfigString: string;
  stop: () => Promise<void>;
}

/**
 * Réplica MÍNIMA (no exhaustiva) del aislamiento de red real de
 * Jin_Infra (k8s/base/network-policies/agents-sandbox.yaml):
 * default-deny total + DNS de salida únicamente. Mantener en sync a
 * mano — Executor y Jin_Infra son repos independientes, sin paquete
 * compartido (AGENTS.md 4.5), así que no hay una única fuente de verdad
 * ejecutable entre ambos.
 */
function agentsSandboxNetworkPolicies(): V1NetworkPolicy[] {
  return [
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: 'default-deny-all',
        namespace: AGENTS_SANDBOX_NAMESPACE,
      },
      spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: 'allow-dns-egress',
        namespace: AGENTS_SANDBOX_NAMESPACE,
      },
      spec: {
        podSelector: {},
        policyTypes: ['Egress'],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
                },
              },
            ],
            ports: [
              { protocol: 'UDP', port: 53 },
              { protocol: 'TCP', port: 53 },
            ],
          },
        ],
      },
    },
  ];
}

const CONTAINERD_SOCKET_ADDRESS = '/run/k3s/containerd/containerd.sock';

/**
 * Pre-pull dentro del nodo K3s-en-Docker (mismo mecanismo que
 * scripts/bootstrap/06-prepull-deno.sh de Jin_Infra en producción —
 * BLUEPRINT 4.4: sin esto, el primer pod con esa imagen puede tardar
 * >100s en un containerd anidado, muy por encima de cualquier timeout
 * razonable de test).
 */
const PREPULL_MAX_ATTEMPTS = 3;
const PREPULL_RETRY_DELAY_MS = 5_000;

/**
 * `ctr images pull` contra un registro real puede toparse con timeouts
 * de red transitorios (verificado en la práctica) — reintenta antes de
 * fallar el setup completo del test por una flakiness externa.
 */
async function prepullImage(
  container: StartedK3sContainer,
  image: string,
): Promise<void> {
  let lastOutput = '';
  for (let attempt = 1; attempt <= PREPULL_MAX_ATTEMPTS; attempt++) {
    const result = await container.exec([
      'ctr',
      '--address',
      CONTAINERD_SOCKET_ADDRESS,
      '-n',
      'k8s.io',
      'images',
      'pull',
      image,
    ]);
    if (result.exitCode === 0) {
      return;
    }
    lastOutput = result.output;
    if (attempt < PREPULL_MAX_ATTEMPTS) {
      await new Promise((resolve) =>
        setTimeout(resolve, PREPULL_RETRY_DELAY_MS),
      );
    }
  }
  throw new Error(
    `No se pudo pre-pullear ${image} en el nodo K3s de prueba tras ${PREPULL_MAX_ATTEMPTS} intentos: ${lastOutput}`,
  );
}

/**
 * `imagesToPrepull`: imágenes que los tests van a usar en pods reales
 * (ej. Deno, http-echo). Se pre-pullean en paralelo antes de devolver el
 * clúster listo, para que las aserciones de los tests no compitan contra
 * la latencia de descarga (ver prepullImage).
 */
export async function startTestK3s(
  imagesToPrepull: readonly string[] = [],
): Promise<TestK3s> {
  const container = await new K3sContainer(K3S_IMAGE).start();
  const kubeConfigString = container.getKubeConfig();

  await Promise.all(
    imagesToPrepull.map((image) => prepullImage(container, image)),
  );

  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromString(kubeConfigString);
  const coreApi = kubeConfig.makeApiClient(CoreV1Api);
  const networkingApi = kubeConfig.makeApiClient(NetworkingV1Api);

  // Mismas etiquetas de Pod Security Admission que producción
  // (Jin_Infra k8s/base/namespaces/namespaces.yaml). Sin ellas este harness
  // era MÁS permisivo que el clúster real: pods sin seccompProfile pasaban
  // los tests y habrían sido rechazados en `agents-sandbox` (restricted).
  await coreApi.createNamespace({
    body: {
      metadata: {
        name: AGENTS_SANDBOX_NAMESPACE,
        labels: {
          'pod-security.kubernetes.io/enforce': 'restricted',
          'pod-security.kubernetes.io/warn': 'restricted',
        },
      },
    },
  });
  await coreApi.createNamespace({
    body: {
      metadata: {
        name: JIN_NAMESPACE,
        labels: { 'pod-security.kubernetes.io/enforce': 'baseline' },
      },
    },
  });

  for (const policy of agentsSandboxNetworkPolicies()) {
    await networkingApi.createNamespacedNetworkPolicy({
      namespace: AGENTS_SANDBOX_NAMESPACE,
      body: policy,
    });
  }

  return {
    container,
    coreApi,
    networkingApi,
    kubeConfigString,
    stop: async () => {
      await container.stop();
    },
  };
}
