import { JinError } from '../common/errors/jin-error';

/** Envuelve cualquier fallo real del SDK de Modal (Fase 5.2) — nunca se expone el error crudo del SDK al caller. */
export class ModalExecutionError extends JinError {
  constructor(message: string, cause?: unknown) {
    super(`Error ejecutando en Modal: ${message}`, {
      code: 'MODAL_EXECUTION_ERROR',
      httpStatus: 502,
      cause,
    });
  }
}
