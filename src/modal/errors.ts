import { YormunError } from '../common/errors/yormun-error';

/** Stub explícito (PROMPTS.md 2.3): el cliente real de Modal llega en Fase 5. */
export class ModalNotImplementedError extends YormunError {
  constructor() {
    super(
      'Ejecución remota vía Modal todavía no está implementada (llega en Fase 5).',
      {
        code: 'MODAL_NOT_IMPLEMENTED',
        httpStatus: 501,
      },
    );
  }
}
