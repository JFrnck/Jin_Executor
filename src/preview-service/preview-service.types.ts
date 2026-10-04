export const PREVIEW_SERVICE_STATUSES = ['running', 'expired'] as const;
export type PreviewServiceStatus = (typeof PREVIEW_SERVICE_STATUSES)[number];

export interface PreviewServiceInfo {
  readonly id: string;
  readonly slug: string;
  readonly url: string;
  readonly status: PreviewServiceStatus;
  readonly expiresAt: string;
  /** Aprobación que lo originó; ausente en pods anteriores a este campo. */
  readonly requestId?: string;
  /** Motor de base de datos de la demo (si pidió uno). */
  readonly db?: string;
  /** Nombres de las variables de entorno de la demo (nunca los valores). */
  readonly envNames?: readonly string[];
}
