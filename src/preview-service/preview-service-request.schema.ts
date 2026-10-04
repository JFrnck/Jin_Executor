import { z } from 'zod';
import { DEMO_DB_ENGINES } from '../k8s/demo-db.builder';
import { validateDemoEnv } from './demo-env';
import { isSafeRelativePath } from './tar-payload';

/** Contrato de POST /services (Fase 5.5, ADR 0006) — mismo criterio que ExecuteRequestSchema: toda entrada HTTP se valida con Zod, en el borde. */
export const StartPreviewServiceRequestSchema = z.object({
  tool: z.string().min(1),
  // Ruta relativa -> contenido. Sin límite de cantidad acá (el límite
  // real de tamaño lo impone el tope práctico de un env var de K8s,
  // ver tar-payload.ts) — Zod solo valida la forma, no un tope de bytes.
  // La clave se rechaza acá con la MISMA función que tar-payload.ts usa
  // internamente (docs/RECOMENDACIONES.md #10, zip-slip): falla rápido
  // con un 400 en el borde HTTP en vez de esperar a que buildTarGzBase64
  // la rechace más tarde, sin duplicar la lógica de qué path es seguro.
  files: z.record(
    z.string().min(1).refine(isSafeRelativePath, {
      message:
        'ruta insegura (absoluta o con ".."): escaparía de /workspace al extraerse',
    }),
    z.string(),
  ),
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
  // El pod puede enviar correo por el proxy `mail-egress` (solo api.brevo.com:443).
  // Lo aprueba el owner con el resto del pedido; sin esto el pod no tiene salida.
  mailEgress: z.boolean().optional(),
  // El backend instala dependencias por el proxy de npm (Verdaccio): el pod recibe
  // las variables de npm y una NetworkPolicy con SOLO esa salida. Los scripts de
  // instalación (preinstall/postinstall) siguen desactivados.
  npm: z.boolean().optional(),
  // Base de datos de DEMO (datos de prueba, no producción): sqlite = archivo en
  // /workspace/data; redis/postgres/mongodb = contenedor auxiliar dentro del mismo
  // pod, solo en 127.0.0.1, con una contraseña aleatoria por demo y datos que viven
  // lo que viva el pod. La app recibe DATABASE_URL / REDIS_URL / MONGODB_URI.
  db: z.enum(DEMO_DB_ENGINES).optional(),
  // Secretos de demo que el pod recibe como variables de entorno (p. ej. "brevo": la clave
  // del correo). Cada nombre es un Secret `demo-secret-<nombre>` en agents-sandbox que crea el
  // owner; el Executor NO lo lee (no tiene permiso): solo lo referencia en el pod. Solo los
  // nombres habilitados en `PREVIEW_SERVICE_ALLOWED_CREDENTIALS`.
  secrets: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}$/))
    .max(5)
    .optional(),
  // Variables de entorno de ESTA demo (valores incluidos): el Executor las guarda en un Secret
  // `demo-env-<id>` ligado al pod, que se borra con él. Nunca se loguean ni se devuelven.
  env: z
    .record(z.string(), z.string())
    .superRefine((env, ctx) => {
      for (const problem of validateDemoEnv(env)) {
        ctx.addIssue({
          code: 'custom',
          message: `${problem.name}: ${problem.reason}`,
        });
      }
    })
    .optional(),
  // Aprobación (HITL) que originó el pod; lo manda Jin_Core para enlazarlo con el audit.
  requestId: z.string().uuid().optional(),
});

export type StartPreviewServiceRequest = z.infer<
  typeof StartPreviewServiceRequestSchema
>;

/** Contrato de POST /services/:id/extend: segundos a SUMAR al vencimiento actual. */
export const ExtendPreviewServiceRequestSchema = z.object({
  extraSeconds: z
    .number()
    .int()
    .positive()
    .max(7 * 24 * 60 * 60),
});

export type ExtendPreviewServiceRequest = z.infer<
  typeof ExtendPreviewServiceRequestSchema
>;
