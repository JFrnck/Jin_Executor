export interface YormunErrorOptions {
  /** Código estable para logs/métricas, ej. "RBAC_TOOL_NOT_WHITELISTED". */
  code: string;
  httpStatus?: number;
  cause?: unknown;
}

/**
 * Base de toda excepción de dominio (AGENTS.md 8.1). Duplicada
 * intencionalmente respecto a la de Yormun_Core: no hay paquetes
 * compartidos entre repos (AGENTS.md 4.5) — cada repo es independiente.
 */
export class YormunError extends Error {
  readonly code: string;
  readonly httpStatus: number | undefined;

  constructor(message: string, options: YormunErrorOptions) {
    super(message, { cause: options.cause });
    this.name = this.constructor.name;
    this.code = options.code;
    this.httpStatus = options.httpStatus;
  }
}
