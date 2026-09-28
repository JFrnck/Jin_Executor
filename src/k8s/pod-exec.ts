import { StringDecoder } from 'node:string_decoder';
import type { K8sService } from './k8s.service';

export interface CollectedExec {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_LIMIT = 2 * 1024 * 1024;

/**
 * Corre un comando corto dentro de un pod y junta su salida (subir archivos,
 * exportarlos, arrancar el servidor). Con tope de tiempo y de salida: nada de
 * lo que devuelva el pod es de confianza ni debe poder llenar la memoria.
 */
export async function collectExec(
  k8s: K8sService,
  podName: string,
  container: string,
  command: readonly string[],
  options: {
    readonly stdin?: Buffer;
    readonly timeoutMs?: number;
    readonly outputLimit?: number;
  } = {},
): Promise<CollectedExec> {
  const limit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  let stdout = '';
  let stderr = '';
  const decoders = {
    out: new StringDecoder('utf8'),
    err: new StringDecoder('utf8'),
  };
  const execution = await k8s.execInPod(podName, {
    container,
    command,
    ...(options.stdin ? { stdin: options.stdin } : {}),
    onStdout: (chunk) => {
      if (stdout.length < limit) stdout += decoders.out.write(chunk);
    },
    onStderr: (chunk) => {
      if (stderr.length < limit) stderr += decoders.err.write(chunk);
    },
  });
  const watchdog = setTimeout(
    () => execution.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const code = await execution.exitCode;
    return { code, stdout, stderr };
  } finally {
    clearTimeout(watchdog);
  }
}
