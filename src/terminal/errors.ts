import { JinError } from '../common/errors/jin-error';

/** ADR 0016: tope de sesiones de terminal simultáneas alcanzado. */
export class TerminalLimitError extends JinError {
  constructor(limit: number) {
    super(
      `Ya hay ${limit} sesión(es) de terminal activas (límite configurado): cierra una antes de abrir otra.`,
      { code: 'TERMINAL_LIMIT_REACHED', httpStatus: 429 },
    );
  }
}

export class TerminalNotFoundError extends JinError {
  constructor(terminalId: string) {
    super(`No existe la sesión de terminal ${terminalId} (¿venció su TTL?).`, {
      code: 'TERMINAL_NOT_FOUND',
      httpStatus: 404,
    });
  }
}

export class TerminalNotRunningError extends JinError {
  constructor(terminalId: string, phase: string) {
    super(
      `La sesión de terminal ${terminalId} no está corriendo (${phase}). Abre una nueva.`,
      { code: 'TERMINAL_NOT_RUNNING', httpStatus: 409 },
    );
  }
}

/** Un comando a la vez por sesión: la salida de dos mezclada no se puede leer. */
export class TerminalBusyError extends JinError {
  constructor(terminalId: string) {
    super(
      `La sesión ${terminalId} ya está ejecutando un comando: espera a que termine.`,
      { code: 'TERMINAL_BUSY', httpStatus: 409 },
    );
  }
}

export class TerminalExposeError extends JinError {
  constructor(message: string, httpStatus = 422) {
    super(message, { code: 'TERMINAL_EXPOSE_FAILED', httpStatus });
  }
}

export class TerminalFileTransferError extends JinError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      code: 'TERMINAL_FILE_TRANSFER_FAILED',
      httpStatus: 502,
      cause,
    });
  }
}
