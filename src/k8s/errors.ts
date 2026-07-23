import { YormunError } from '../common/errors/yormun-error';

export class PodTimeoutError extends YormunError {
  constructor(podName: string, timeoutMs: number) {
    super(`El pod "${podName}" no terminó dentro de ${timeoutMs}ms.`, {
      code: 'EXECUTOR_POD_TIMEOUT',
      httpStatus: 504,
    });
  }
}
