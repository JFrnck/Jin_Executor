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
