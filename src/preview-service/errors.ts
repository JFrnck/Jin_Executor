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
