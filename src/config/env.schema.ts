import { z } from 'zod';

// Única fuente de verdad de qué variables de entorno existen y su forma
// (AGENTS.md 8.4). Nada más en el repo debe leer `process.env` directo.
export const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  // Namespace donde el Executor crea/destruye pods — el único que su
  // ServiceAccount tiene permitido tocar (BLUEPRINT 4.2).
  AGENTS_SANDBOX_NAMESPACE: z.string().min(1).default('agents-sandbox'),
  // Ausente en producción (kubeConfig.loadFromCluster() usa el
  // ServiceAccount montado del pod). Solo se usa en desarrollo local
  // apuntando a un kubeconfig real.
  KUBECONFIG_PATH: z.string().optional(),
  // Pinneada (nunca `latest`) — debe coincidir con la que
  // scripts/bootstrap/06-prepull-deno.sh de Jin_Infra pre-descarga.
  DENO_IMAGE: z
    .string()
    .min(1)
    .default('docker.io/denoland/deno:distroless-2.9.3'),
  // src/modal: requeridas, no opcionales (AGENTS.md 8.4 fail-fast) —
  // Fase 5.2, tier de escalado (BLUEPRINT 4.5).
  MODAL_TOKEN_ID: z
    .string()
    .min(1, 'MODAL_TOKEN_ID es requerida (token de Modal)'),
  MODAL_TOKEN_SECRET: z
    .string()
    .min(1, 'MODAL_TOKEN_SECRET es requerida (token secret de Modal)'),
  // src/preview-service (Fase 5.5, ADR 0006): guardas duras de pods de
  // servicio. Pinneada como DENO_IMAGE — multi-arch, verificada ARM64
  // (VM OCI de este proyecto es Ampere/ARM64).
  PREVIEW_SERVICE_NODE_IMAGE: z
    .string()
    .min(1)
    .default('docker.io/library/node:22-alpine'),
  // Default corto a propósito (requisito del owner) — el cap DURO de 24h
  // se valida también en código (previewServiceMaxTtlSeconds), no solo
  // acá, para que un env mal configurado no pueda saltárselo.
  PREVIEW_SERVICE_DEFAULT_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(4 * 60 * 60),
  PREVIEW_SERVICE_MAX_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60, 'El cap duro de PROMPTS.md §5.5 es 24h')
    .default(24 * 60 * 60),
  PREVIEW_SERVICE_MAX_CONCURRENT: z.coerce.number().int().positive().default(3),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuración de entorno inválida:\n${issues}`);
  }
  return result.data;
}
