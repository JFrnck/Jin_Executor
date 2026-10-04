import { JinError } from '../common/errors/jin-error';

/** Fase 5.5 (ADR 0006): tope de servicios concurrentes alcanzado (`PREVIEW_SERVICE_MAX_CONCURRENT`) — fail-safe, no se crea un pod más hasta que se libere uno. */
export class PreviewServiceLimitError extends JinError {
  constructor(limit: number) {
    super(
      `Ya hay ${limit} pod(s) de servicio activos (límite configurado) — detené uno antes de levantar otro.`,
      { code: 'PREVIEW_SERVICE_LIMIT_REACHED', httpStatus: 429 },
    );
  }
}

export class PreviewServiceNotFoundError extends JinError {
  constructor(serviceId: string) {
    super(`No existe el pod de servicio ${serviceId} (¿venció su TTL?).`, {
      code: 'PREVIEW_SERVICE_NOT_FOUND',
      httpStatus: 404,
    });
  }
}

export class PreviewServiceExportError extends JinError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      code: 'PREVIEW_SERVICE_EXPORT_FAILED',
      httpStatus: 502,
      cause,
    });
  }
}

/** Alargar un pod que ya está en el tope de vida (`PREVIEW_SERVICE_MAX_TTL_SECONDS` desde que se creó). */
export class PreviewServiceTtlCapError extends JinError {
  constructor(maxDays: number) {
    super(
      `Este servicio ya llegó al tope de ${maxDays} día(s) de vida desde que se creó: no se puede alargar más.`,
      { code: 'PREVIEW_SERVICE_TTL_CAP', httpStatus: 409 },
    );
  }
}

/** La cuota de recursos de `agents-sandbox` no deja crear otro pod (CPU/memoria de otras demos o terminales). */
export class PreviewServiceQuotaError extends JinError {
  constructor(detail: string) {
    super(
      `El sandbox no tiene recursos libres para otra demo (${detail}). Espera a que termine una, o detén una demo o terminal que no uses.`,
      { code: 'PREVIEW_SERVICE_QUOTA_EXCEEDED', httpStatus: 429 },
    );
  }
}

/** La demo pide un secreto que el owner no habilitó (`PREVIEW_SERVICE_ALLOWED_SECRETS`). */
export class PreviewServiceSecretNotAllowedError extends JinError {
  constructor(name: string, allowed: readonly string[]) {
    super(
      `El secreto "${name}" no está habilitado para demos${allowed.length > 0 ? ` (habilitados: ${allowed.join(', ')})` : ' (ninguno habilitado)'}.`,
      { code: 'PREVIEW_SERVICE_SECRET_NOT_ALLOWED', httpStatus: 403 },
    );
  }
}
