import { JinError } from '../common/errors/jin-error';

/** ADR 0016 ampliada: tope de pods de terminal corriendo A LA VEZ. */
export class TerminalLimitError extends JinError {
  constructor(limit: number) {
    super(
      `Ya hay ${limit} terminal(es) corriendo (límite configurado): detén una antes de abrir otra.`,
      { code: 'TERMINAL_LIMIT_REACHED', httpStatus: 429 },
    );
  }
}

/** Tope de proyectos con disco propio (workspaces), corriendo o no. */
export class TerminalWorkspaceLimitError extends JinError {
  constructor(limit: number) {
    super(
      `Ya hay ${limit} proyectos con disco propio (límite configurado): elimina uno antes de crear otro.`,
      { code: 'TERMINAL_WORKSPACE_LIMIT_REACHED', httpStatus: 429 },
    );
  }
}

/** No existe el disco de este proyecto (nunca se creó, o se eliminó). */
export class TerminalWorkspaceNotFoundError extends JinError {
  constructor(workspaceId: string) {
    super(`No hay una terminal para el proyecto ${workspaceId}.`, {
      code: 'TERMINAL_WORKSPACE_NOT_FOUND',
      httpStatus: 404,
    });
  }
}

/** El disco existe pero no hay pod corriendo: hace falta iniciarlo. */
export class TerminalNotRunningError extends JinError {
  constructor(workspaceId: string, phase: string) {
    super(
      `La terminal de este proyecto no está corriendo (${phase}). Inícala primero.`,
      { code: 'TERMINAL_NOT_RUNNING', httpStatus: 409 },
    );
    void workspaceId;
  }
}

/** Un comando a la vez por proyecto: la salida de dos mezclada no se puede leer. */
export class TerminalBusyError extends JinError {
  constructor(workspaceId: string) {
    super(
      `Esta terminal ya está ejecutando un comando: espera a que termine.`,
      { code: 'TERMINAL_BUSY', httpStatus: 409 },
    );
    void workspaceId;
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

export class TerminalServiceError extends JinError {
  constructor(message: string, httpStatus = 422) {
    super(message, { code: 'TERMINAL_SERVICE_FAILED', httpStatus });
  }
}

export class TerminalProxyError extends JinError {
  constructor(message: string, httpStatus = 502, cause?: unknown) {
    super(message, { code: 'TERMINAL_PROXY_FAILED', httpStatus, cause });
  }
}

/** Ya hay una terminal interactiva abierta en este proyecto (una por workspace). */
export class TerminalPtyExistsError extends JinError {
  constructor(workspaceId: string) {
    super(
      'Este proyecto ya tiene una terminal interactiva abierta: reconéctate a ella o ciérrala primero.',
      { code: 'TERMINAL_PTY_EXISTS', httpStatus: 409 },
    );
    void workspaceId;
  }
}

/** La terminal interactiva no existe (se cerró, venció o el Executor se reinició). */
export class TerminalPtyNotFoundError extends JinError {
  constructor(ptyId: string) {
    super('No hay una terminal interactiva abierta con ese id.', {
      code: 'TERMINAL_PTY_NOT_FOUND',
      httpStatus: 404,
    });
    void ptyId;
  }
}

const FS_STATUS: Readonly<Record<string, number>> = {
  not_found: 404,
  outside: 400,
  symlink: 422,
  not_file: 422,
  not_text: 422,
  too_large: 413,
  conflict: 409,
  exists: 409,
  not_empty: 409,
};

/**
 * Una operación del explorador de archivos del pod que no se pudo hacer por
 * algo que el owner puede entender y corregir (no existe, cambió, es binario,
 * pasa el tope). `fsCode` es el que devuelve `FS_SCRIPT`; la app lo usa para
 * distinguir un conflicto de un error.
 */
export class TerminalFsError extends JinError {
  constructor(
    readonly fsCode: string,
    message: string,
    readonly extra: Readonly<Record<string, unknown>> = {},
  ) {
    super(message, {
      code: `TERMINAL_FS_${fsCode.toUpperCase()}`,
      httpStatus: FS_STATUS[fsCode] ?? 502,
    });
  }
}
