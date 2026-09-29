export const TERMINAL_STATUSES = [
  /** El disco existe pero no hay pod corriendo: hay que iniciarlo para usarlo. */
  'stopped',
  'starting',
  'running',
  'expired',
  'failed',
] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export interface TerminalExposure {
  readonly slug: string;
  readonly url: string;
}

/**
 * Un workspace = un proyecto (2026-09-28, ADR 0016 ampliada): su disco
 * (`createdAt`) sobrevive a que el pod se destruya y se vuelva a crear.
 * `status: 'stopped'` es el reposo normal, no un error — nada de esto es
 * visible mientras no haya pod: `expiresAt`/`requestId`/`exposure` son del
 * pod ACTUAL, si lo hay.
 */
export interface TerminalWorkspaceInfo {
  readonly id: string;
  readonly status: TerminalStatus;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  /** Aprobación que abrió el pod actual (enlace con el audit); null si no hay pod o es anterior a este campo. */
  readonly requestId: string | null;
  /** Presente si el owner publicó un build de esta sesión del pod. */
  readonly exposure: TerminalExposure | null;
  /** Último comando/servicio/petición al pod actual; null si no hay pod. Lo usa el reaper para liberar por inactividad. */
  readonly lastActivityAt: string | null;
}

/** Una línea del stream NDJSON de `exec` (una por chunk de salida, y una final). */
export type TerminalStreamEvent =
  | { readonly t: 'out'; readonly d: string }
  | { readonly t: 'err'; readonly d: string }
  | { readonly t: 'exit'; readonly code: number; readonly truncated: boolean }
  | { readonly t: 'error'; readonly message: string };

export interface TerminalExportResult {
  readonly files: Record<string, string>;
  readonly skipped: readonly { path: string; reason: string }[];
}

/** Un servidor en segundo plano dentro de la sesión (`npm run dev`…). */
export interface TerminalServiceInfo {
  readonly port: number;
  readonly command: string;
  readonly startedAt: string;
  readonly running: boolean;
  readonly listening: boolean;
}

export type TerminalServiceStart =
  | {
      readonly status: 'listening' | 'already-running';
      readonly port: number;
      readonly log: string;
    }
  | {
      readonly status: 'exited';
      readonly port: number;
      readonly code: number;
      readonly log: string;
    }
  | { readonly status: 'timeout'; readonly port: number; readonly log: string };

export interface TerminalFsEntry {
  readonly name: string;
  readonly type: 'file' | 'dir' | 'link' | 'other';
  readonly size: number;
  readonly mtimeMs: number;
}

export interface TerminalFsList {
  readonly entries: readonly TerminalFsEntry[];
  readonly truncated: boolean;
}

export interface TerminalFsFile {
  readonly content: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

export interface TerminalFsWritten {
  readonly sha256: string;
  readonly size: number;
  readonly mtimeMs: number;
}
