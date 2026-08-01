import { z } from 'zod';

/** Contrato de POST /services (Fase 5.5, ADR 0006) — mismo criterio que ExecuteRequestSchema: toda entrada HTTP se valida con Zod, en el borde. */
export const StartPreviewServiceRequestSchema = z.object({
  tool: z.string().min(1),
  // Ruta relativa -> contenido. Sin límite de cantidad acá (el límite
  // real de tamaño lo impone el tope práctico de un env var de K8s,
  // ver tar-payload.ts) — Zod solo valida la forma, no un tope de bytes.
  files: z.record(z.string().min(1), z.string()),
  command: z.array(z.string().min(1)).min(1),
  port: z.number().int().positive().max(65535),
  // Tope de cordura amplio; el cap duro real (24h) lo aplica
  // PreviewServiceLifecycleService contra PREVIEW_SERVICE_MAX_TTL_SECONDS.
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(7 * 24 * 60 * 60),
  slugHint: z.string().optional(),
});

export type StartPreviewServiceRequest = z.infer<
  typeof StartPreviewServiceRequestSchema
>;
