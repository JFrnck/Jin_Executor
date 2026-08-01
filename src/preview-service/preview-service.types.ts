export const PREVIEW_SERVICE_STATUSES = ['running', 'expired'] as const;
export type PreviewServiceStatus = (typeof PREVIEW_SERVICE_STATUSES)[number];

export interface PreviewServiceInfo {
  readonly id: string;
  readonly slug: string;
  readonly url: string;
  readonly status: PreviewServiceStatus;
  readonly expiresAt: string;
}
