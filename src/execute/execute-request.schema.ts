import { z } from 'zod';

/**
 * Contrato del endpoint POST /execute (BLUEPRINT 4.2). Toda entrada HTTP
 * se valida con Zod (AGENTS.md 3.4) — nunca se confía en el shape del
 * body sin verificarlo en runtime.
 */
export const ExecuteRequestSchema = z.object({
  tool: z.string().min(1),
  code: z.string().min(1),
  // Reemplaza el `remote: boolean` de Fase 2.3 (placeholder sin lógica
  // real): BLUEPRINT 4.5 dice explícitamente que la decisión remote vs.
  // local es "automática por el Executor", no algo que decida el
  // caller. El tier local es Deno — no puede correr Python en absoluto —
  // así que `language` es la señal determinística que PodLifecycleService
  // usa para rutear (Fase 5.2).
  language: z.enum(['typescript', 'python']),
  env: z.record(z.string(), z.string()).default({}),
  // Tope de cordura amplio (evita valores absurdos/negativos); el límite
  // real lo aplica PodLifecycleService contra tool.maxTimeoutSeconds
  // (local, BLUEPRINT 4.4) o tool.remoteMaxTimeoutSeconds (Modal,
  // BLUEPRINT 4.5).
  timeout: z.number().int().positive().max(3600),
});

export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;
