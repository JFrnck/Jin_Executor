import { Readable } from 'node:stream';
import type { PodProxyResponse } from './k8s.service';

/** Tope del HTML que se guarda en memoria para deshacer la reescritura. */
const MAX_HTML_BYTES = 5 * 1024 * 1024;

/** Prefijo con el que el API server reescribe los enlaces de un pod que pasa por `pods/proxy`. */
export function podProxyPrefix(
  namespace: string,
  podName: string,
  port: number,
): string {
  return `/api/v1/namespaces/${namespace}/pods/${podName}:${port}/proxy`;
}

/**
 * El API server reescribe los enlaces de las páginas HTML que pasan por
 * `pods/proxy`: un `src="/@vite/client"` sale como
 * `src="/api/v1/namespaces/…/pods/…:5173/proxy/@vite/client"`, y la página del
 * owner deja de funcionar. Esto lo deshace: quita ese prefijo del cuerpo HTML y
 * del `Location` de las redirecciones. Lo que no es HTML pasa sin tocar (el API
 * server tampoco lo reescribe).
 */
export async function undoApiServerRewrite(
  response: PodProxyResponse,
  prefix: string,
): Promise<PodProxyResponse> {
  const headers = { ...response.headers };
  const location = headers.location;
  if (typeof location === 'string' && location.startsWith(prefix)) {
    headers.location = location.slice(prefix.length) || '/';
  }

  const contentType = String(headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('text/html')) {
    return { ...response, headers };
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as string);
    size += buffer.length;
    // Una página HTML de más de 5 MB no es una página: se corta en vez de llenar la memoria.
    if (size > MAX_HTML_BYTES) {
      response.body.destroy();
      throw new Error('la página HTML es demasiado grande');
    }
    chunks.push(buffer);
  }
  const html = Buffer.concat(chunks).toString('utf8').split(prefix).join('');
  const body = Buffer.from(html, 'utf8');
  delete headers['content-encoding'];
  delete headers.etag;
  headers['content-length'] = String(body.length);
  return { status: response.status, headers, body: Readable.from([body]) };
}
