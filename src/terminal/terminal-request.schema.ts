import { z } from 'zod';
import { isSafeRelativePath } from '../preview-service/tar-payload';

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
  files: FilesSchema.default({}),
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60),
  /** Aprobación (HITL) que abrió la sesión; lo manda Jin_Core para enlazarla con el audit. */
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
