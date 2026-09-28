export const TERMINAL_STATUSES = [
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

export interface TerminalSessionInfo {
  readonly id: string;
  readonly status: TerminalStatus;
  readonly expiresAt: string;
  /** Aprobación que abrió la sesión (enlace con el audit); null en sesiones anteriores. */
  readonly requestId: string | null;
  /** Presente si el owner publicó un build de esta sesión. */
  readonly exposure: TerminalExposure | null;
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
