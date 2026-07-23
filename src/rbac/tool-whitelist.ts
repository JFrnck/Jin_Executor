/**
 * Whitelist estática de tools que el Executor está autorizado a correr
 * (BLUEPRINT 4.2: "valida contra whitelist de herramientas antes de
 * crear el pod"). Independiente del registry de Yormun_Core
 * (src/tools/registry.ts allá declara hitlLevel, un concepto distinto) —
 * no hay paquetes compartidos entre repos (AGENTS.md 4.5).
 */
export interface ExecutorToolDefinition {
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
  /** Límite duro en segundos — nunca se confía en el `timeout` del request por sí solo (BLUEPRINT 4.4: máx 5 min local). */
  readonly maxTimeoutSeconds: number;
}

const EXECUTOR_TOOL_REGISTRY: readonly ExecutorToolDefinition[] = Object.freeze(
  [
    Object.freeze({
      name: 'runCode',
      description:
        'Ejecuta código TypeScript en un pod Deno aislado (BLUEPRINT 4.4), sin acceso a red.',
      egressWhitelist: Object.freeze([]),
      maxTimeoutSeconds: 300,
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
