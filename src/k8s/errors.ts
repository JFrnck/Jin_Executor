import { JinError } from '../common/errors/jin-error';

export class PodTimeoutError extends JinError {
  constructor(podName: string, timeoutMs: number) {
    super(`El pod "${podName}" no terminó dentro de ${timeoutMs}ms.`, {
      code: 'EXECUTOR_POD_TIMEOUT',
      httpStatus: 504,
    });
  }
}
