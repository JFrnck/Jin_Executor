import { z } from 'zod';

/**
 * Contrato del endpoint POST /execute (BLUEPRINT 4.2). Toda entrada HTTP
 * se valida con Zod (AGENTS.md 3.4) — nunca se confía en el shape del
 * body sin verificarlo en runtime.
 */
export const ExecuteRequestSchema = z.object({
  tool: z.string().min(1),
  code: z.string().min(1),
  env: z.record(z.string(), z.string()).default({}),
  // Tope de cordura amplio (evita valores absurdos/negativos); el límite
  // real de 5 min para ejecución local lo aplica PodLifecycleService
  // contra tool.maxTimeoutSeconds (BLUEPRINT 4.4) — Modal (remote:true)
  // puede necesitar más, aunque el cliente real llega en Fase 5.
  timeout: z.number().int().positive().max(3600),
  remote: z.boolean().default(false),
});

export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;
