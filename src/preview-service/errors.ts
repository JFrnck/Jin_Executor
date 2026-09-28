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
