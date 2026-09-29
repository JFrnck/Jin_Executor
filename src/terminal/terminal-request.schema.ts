import { z } from 'zod';
import { isSafeRelativePath } from '../preview-service/tar-payload';

/**
 * Id de proyecto que manda la app (2026-09-28, ADR 0016 ampliada): nombra el
 * pod Y el PVC en Kubernetes, así que se valida ESTRICTO antes de tocar
 * cualquier nombre de recurso — sin esto, un id fuera de forma podría colar
 * caracteres inválidos (o, con nombres compuestos, apuntar a un recurso que
 * no le pertenece). Un UUID cualquiera (mayúsculas o minúsculas) alcanza; se
 * normaliza a minúsculas, que es lo único que Kubernetes acepta en nombres.
 */
export const WorkspaceIdSchema = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    'id de proyecto inválido',
  )
  .transform((id) => id.toLowerCase());

/** Mismos topes que Publicar (ADR 0015): una app de pocos archivos, no un repo. */
export const TERMINAL_MAX_FILES = 50;
export const TERMINAL_MAX_TOTAL_BYTES = 256 * 1024;
export const TERMINAL_MAX_COMMAND_LENGTH = 4096;
export const TERMINAL_MAX_TIMEOUT_SECONDS = 600;
export const TERMINAL_DEFAULT_TIMEOUT_SECONDS = 120;
export const TERMINAL_MAX_SERVER_SOURCE_BYTES = 64 * 1024;

const SafePath = z.string().min(1).max(200).refine(isSafeRelativePath, {
  message:
    'ruta insegura (absoluta o con ".."): escaparía del espacio de trabajo',
});

const FilesSchema = z
  .record(SafePath, z.string())
  .refine((files) => Object.keys(files).length <= TERMINAL_MAX_FILES, {
    message: `máximo ${TERMINAL_MAX_FILES} archivos`,
  })
  .refine(
    (files) =>
      Object.entries(files).reduce(
        (sum, [path, text]) =>
          sum + Buffer.byteLength(path) + Buffer.byteLength(text),
        0,
      ) <= TERMINAL_MAX_TOTAL_BYTES,
    { message: `el proyecto supera ${TERMINAL_MAX_TOTAL_BYTES / 1024} KB` },
  );

export const StartTerminalRequestSchema = z.object({
  /** Solo se escriben la primera vez que se crea el disco del proyecto (nunca sobre uno que ya existe). */
  files: FilesSchema.default({}),
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60),
  /** Aprobación (HITL) que abrió el pod; lo manda Jin_Core para enlazarla con el audit. */
  requestId: z.string().uuid().optional(),
});
export type StartTerminalRequest = z.infer<typeof StartTerminalRequestSchema>;

export const ExecTerminalRequestSchema = z.object({
  command: z.string().min(1).max(TERMINAL_MAX_COMMAND_LENGTH),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(TERMINAL_MAX_TIMEOUT_SECONDS)
    .default(TERMINAL_DEFAULT_TIMEOUT_SECONDS),
});
export type ExecTerminalRequest = z.infer<typeof ExecTerminalRequestSchema>;

export const ExportTerminalQuerySchema = z.object({
  dir: z.union([z.literal('.'), SafePath]).default('.'),
});
export type ExportTerminalQuery = z.infer<typeof ExportTerminalQuerySchema>;

export const ImportTerminalRequestSchema = z.object({ files: FilesSchema });
export type ImportTerminalRequest = z.infer<typeof ImportTerminalRequestSchema>;

export const ExposeTerminalRequestSchema = z.object({
  /** Directorio del build dentro del espacio de trabajo (`dist` en Vite). */
  dir: SafePath.default('dist'),
  slugHint: z.string().optional(),
  port: z.number().int().positive().max(65535).default(8080),
  /** El servidor estático fijo de Jin (lo manda Jin_Core, donde vive su código). */
  serverSource: z.string().min(1).max(TERMINAL_MAX_SERVER_SOURCE_BYTES),
});
export type ExposeTerminalRequest = z.infer<typeof ExposeTerminalRequestSchema>;

/** Puertos de usuario: nada por debajo de 1024 (no son de un servidor de desarrollo). */
export const TERMINAL_MIN_PORT = 1024;
const PortSchema = z.number().int().min(TERMINAL_MIN_PORT).max(65535);

export const StartServiceRequestSchema = z.object({
  command: z.string().min(1).max(TERMINAL_MAX_COMMAND_LENGTH),
  port: PortSchema,
});
export type StartServiceRequest = z.infer<typeof StartServiceRequestSchema>;

/** `:port` de la URL del proxy y de `DELETE`/`logs`. */
export function parsePort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= TERMINAL_MIN_PORT && port <= 65535 ? port : null;
}

/** Terminal interactiva (PTY, ADR 0016 ampliada): tamaño de la ventana y entrada del teclado. */
export const PTY_MIN_COLS = 20;
export const PTY_MAX_COLS = 300;
export const PTY_MIN_ROWS = 5;
export const PTY_MAX_ROWS = 100;
/** Tope de bytes de UN mensaje de teclado (un pegado grande); la app parte lo que pase. */
export const PTY_MAX_INPUT_BYTES = 64 * 1024;

export const PtyIdSchema = z.string().uuid();

export const OpenPtyRequestSchema = z.object({
  cols: z.number().int().min(PTY_MIN_COLS).max(PTY_MAX_COLS),
  rows: z.number().int().min(PTY_MIN_ROWS).max(PTY_MAX_ROWS),
});
export type OpenPtyRequest = z.infer<typeof OpenPtyRequestSchema>;

export const ResizePtyRequestSchema = OpenPtyRequestSchema;
export type ResizePtyRequest = OpenPtyRequest;

/** Bytes del teclado en base64 (pueden no ser UTF-8 válido por sí solos: Ctrl+C, secuencias de flechas). */
export const PtyInputRequestSchema = z.object({
  data: z
    .string()
    .min(1)
    .max(Math.ceil((PTY_MAX_INPUT_BYTES * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'base64 inválido'),
});
export type PtyInputRequest = z.infer<typeof PtyInputRequestSchema>;
