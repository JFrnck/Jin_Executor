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
