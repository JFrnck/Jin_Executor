import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { podProxyPrefix, undoApiServerRewrite } from './pod-proxy';
import type { PodProxyResponse } from './k8s.service';

const PREFIX = podProxyPrefix('agents-sandbox', 'agent-terminal-x', 5173);

function response(
  body: string,
  headers: Record<string, string>,
  status = 200,
): PodProxyResponse {
  return { status, headers, body: Readable.from([Buffer.from(body)]) };
}

async function read(res: PodProxyResponse): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of res.body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

describe('undoApiServerRewrite', () => {
  it('el prefijo lleva el namespace, el pod y el puerto', () => {
    expect(PREFIX).toBe(
      '/api/v1/namespaces/agents-sandbox/pods/agent-terminal-x:5173/proxy',
    );
  });

  it('deshace la reescritura del HTML: src, href y cualquier enlace vuelven a ser los del servidor', async () => {
    const rewritten = `<script type="module" src="${PREFIX}/@vite/client"></script><link href="${PREFIX}/favicon.svg"><a href="${PREFIX}/">inicio</a>`;
    const result = await undoApiServerRewrite(
      response(rewritten, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(rewritten.length),
        etag: 'W/"x"',
      }),
      PREFIX,
    );
    expect(await read(result)).toBe(
      '<script type="module" src="/@vite/client"></script><link href="/favicon.svg"><a href="/">inicio</a>',
    );
    // El largo ya no es el de antes y el etag del original ya no corresponde.
    expect(result.headers['content-length']).toBe(
      String(
        Buffer.byteLength(
          '<script type="module" src="/@vite/client"></script><link href="/favicon.svg"><a href="/">inicio</a>',
        ),
      ),
    );
    expect(result.headers.etag).toBeUndefined();
  });

  it('lo que no es HTML (JS, JSON, imágenes) pasa sin tocar aunque contenga el prefijo', async () => {
    const js = `fetch("${PREFIX}/api")`;
    const result = await undoApiServerRewrite(
      response(js, { 'content-type': 'text/javascript' }),
      PREFIX,
    );
    expect(await read(result)).toBe(js);
  });

  it('el Location de una redirección pierde el prefijo; uno externo no se toca', async () => {
    const internal = await undoApiServerRewrite(
      response('', { location: `${PREFIX}/login` }, 302),
      PREFIX,
    );
    expect(internal.headers.location).toBe('/login');
    const root = await undoApiServerRewrite(
      response('', { location: PREFIX }, 302),
      PREFIX,
    );
    expect(root.headers.location).toBe('/');
    const external = await undoApiServerRewrite(
      response('', { location: 'https://otro.com/x' }, 302),
      PREFIX,
    );
    expect(external.headers.location).toBe('https://otro.com/x');
  });

  it('un HTML sin reescribir queda igual, con caracteres no ASCII intactos', async () => {
    const html = '<h1>ñandú 🎉 — página</h1>';
    const result = await undoApiServerRewrite(
      response(html, { 'content-type': 'text/html' }),
      PREFIX,
    );
    expect(await read(result)).toBe(html);
  });

  it('un HTML de más de 5 MB se rechaza en vez de llenar la memoria', async () => {
    const big = 'a'.repeat(5 * 1024 * 1024 + 1);
    await expect(
      undoApiServerRewrite(
        response(big, { 'content-type': 'text/html' }),
        PREFIX,
      ),
    ).rejects.toThrow(/demasiado grande/);
  });
});
