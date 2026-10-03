/**
 * Whitelist estática de tools que el Executor está autorizado a correr
 * (BLUEPRINT 4.2: "valida contra whitelist de herramientas antes de
 * crear el pod"). Independiente del registry de Jin_Core
 * (src/tools/registry.ts allá declara hitlLevel, un concepto distinto) —
 * no hay paquetes compartidos entre repos (AGENTS.md 4.5).
 */
interface ExecutorToolDefinitionBase {
  readonly name: string;
  readonly description: string;
  /**
   * Dominios a los que el pod puede salir además de DNS (AGENTS.md 5.5).
   * LIMITACIÓN CONOCIDA: NetworkPolicy de Kubernetes no entiende nombres
   * de dominio, solo IPs/CIDRs/selectores — K3s usa Flannel por defecto,
   * sin soporte FQDN (a diferencia de Cilium). Hoy ninguna tool stub
   * necesita egreso real, así que queda vacío en todas. Cuando exista la
   * primera tool con egreso real (Fase 5), resolver esto con IPs
   * resueltas al crear el pod o un proxy de egreso con ACL por dominio.
   */
  readonly egressWhitelist: readonly string[];
}

/** Tools run-to-completion (Fase 2.3/5.2): `PodLifecycleService`. */
export interface RunToCompletionToolDefinition extends ExecutorToolDefinitionBase {
  readonly isServiceTool?: false;
  /** Límite duro en segundos para el tier LOCAL (pods Deno) — nunca se confía en el `timeout` del request por sí solo (BLUEPRINT 4.4: máx 5 min). */
  readonly maxTimeoutSeconds: number;
  /**
   * Límite duro en segundos para el tier de escalado (Modal, Fase 5.2,
   * BLUEPRINT 4.5) — deliberadamente mayor al local (esa es la razón de
   * escalar), pero sigue siendo un hard cap de costo/seguridad, no algo
   * que el caller pueda extender.
   */
  readonly remoteMaxTimeoutSeconds: number;
  /** Límite duro de memoria en MiB para el sandbox de Modal. */
  readonly remoteMemoryLimitMiB: number;
}

/**
 * Tools de pods de servicio, de larga vida (Fase 5.5, ADR 0006):
 * `PreviewServiceLifecycleService`. "Corre y termina" no aplica — el TTL
 * vive en `config/env.schema.ts` (`PREVIEW_SERVICE_*`), no acá.
 */
export interface ServiceToolDefinition extends ExecutorToolDefinitionBase {
  readonly isServiceTool: true;
}

export type ExecutorToolDefinition =
  RunToCompletionToolDefinition | ServiceToolDefinition;

const EXECUTOR_TOOL_REGISTRY: readonly ExecutorToolDefinition[] = Object.freeze(
  [
    Object.freeze({
      name: 'runCode',
      description:
        'Ejecuta código TypeScript en un pod Deno aislado (BLUEPRINT 4.4, sin acceso a red) o código Python en un sandbox de Modal (BLUEPRINT 4.5, para dependencias científicas como pandas).',
      egressWhitelist: Object.freeze([]),
      maxTimeoutSeconds: 300,
      remoteMaxTimeoutSeconds: 1800,
      remoteMemoryLimitMiB: 4096,
    }),
    // Fase 5.5 (ADR 0006): pods de servicio, de larga vida. Egreso vacío
    // por el mismo criterio de mínimo privilegio que el resto de la
    // whitelist — la resolución dominio→CIDR sigue sin existir (ADR
    // 0003 punto 2), declarar un dominio real acá activaría
    // `UnresolvedEgressWhitelistError` hasta que esa resolución exista
    // (deliberado, no un olvido: `npm install` corre sin egreso real
    // hasta entonces, usando lo que ya esté cacheado en el PVC pnpm).
    Object.freeze({
      name: 'startPreviewService',
      description:
        'Levanta un pod de servicio de larga vida (ej. npm run dev) expuesto bajo https://<slug>.jinserver.com.',
      egressWhitelist: Object.freeze([]),
      isServiceTool: true,
    }),
    Object.freeze({
      name: 'stopPreviewService',
      description: 'Detiene y destruye un pod de servicio activo.',
      egressWhitelist: Object.freeze([]),
      isServiceTool: true,
    }),
    Object.freeze({
      name: 'listPreviewServices',
      description: 'Lista los pods de servicio activos y su TTL restante.',
      egressWhitelist: Object.freeze([]),
      isServiceTool: true,
    }),
    // ADR 0016: sesiones de terminal del owner. Egreso vacío acá a propósito:
    // la única salida (el proxy de npm del clúster) es una NetworkPolicy por
    // sesión con destino fijo, no un dominio de la whitelist. Jin_Core no las
    // expone al modelo: son tools virtuales que solo inicia el owner.
    Object.freeze({
      name: 'startTerminalSession',
      description:
        'Levanta un pod de terminal aislado (solo sale al proxy de npm del clúster).',
      egressWhitelist: Object.freeze([]),
      isServiceTool: true,
    }),
    Object.freeze({
      name: 'runTerminalCommand',
      description: 'Ejecuta un comando dentro de una sesión de terminal.',
      egressWhitelist: Object.freeze([]),
      isServiceTool: true,
    }),
    Object.freeze({
      name: 'exposeTerminalSession',
      description:
        'Publica un directorio de la sesión (build) bajo https://<slug>.jinserver.com.',
      egressWhitelist: Object.freeze([]),
      isServiceTool: true,
    }),
    Object.freeze({
      name: 'stopTerminalSession',
      description:
        'Detiene el pod de la terminal de un proyecto (el disco no se toca).',
      egressWhitelist: Object.freeze([]),
      isServiceTool: true,
    }),
    Object.freeze({
      name: 'deleteTerminalWorkspace',
      description:
        'Elimina el disco de la terminal de un proyecto (irreversible).',
      egressWhitelist: Object.freeze([]),
      isServiceTool: true,
    }),
    // Demos en GitHub (2026-10-02, ADR 0019): las ejecuta el propio Executor con `git`
    // (no un pod), así que no hay egreso de pod que declarar.
    Object.freeze({
      name: 'saveDemoToGithub',
      description:
        'Guarda una demo (pod de servicio) en una rama huérfana demo/<slug> del repo compartido de demos.',
      egressWhitelist: Object.freeze([]),
      isServiceTool: true,
    }),
    Object.freeze({
      name: 'listGithubDemos',
      description:
        'Lista las ramas demo/* guardadas en el repo de demos. Solo lectura.',
      egressWhitelist: Object.freeze([]),
      isServiceTool: true,
    }),
  ] satisfies ExecutorToolDefinition[],
);

const EXECUTOR_TOOL_REGISTRY_BY_NAME: ReadonlyMap<
  string,
  ExecutorToolDefinition
> = new Map(EXECUTOR_TOOL_REGISTRY.map((tool) => [tool.name, tool]));

export function getExecutorToolDefinition(
  name: string,
): ExecutorToolDefinition | undefined {
  return EXECUTOR_TOOL_REGISTRY_BY_NAME.get(name);
}

export function listExecutorTools(): readonly ExecutorToolDefinition[] {
  return EXECUTOR_TOOL_REGISTRY;
}

/** Type guard reusado por `PodLifecycleService`/`ModalService` y los tests — narrowing explícito, sin non-null assertions (AGENTS.md 3.2). */
export function isRunToCompletionTool(
  tool: ExecutorToolDefinition,
): tool is RunToCompletionToolDefinition {
  return !tool.isServiceTool;
}
