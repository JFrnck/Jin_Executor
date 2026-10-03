import {
  createPublicKey,
  createVerify,
  generateKeyPairSync,
} from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GithubAuthError, GithubDisabledError } from './errors';
import { GithubAppService } from './github-app.service';

// La clave se GENERA en el test: nunca un PEM literal en el repo (GitGuardian).
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const service = (overrides: Record<string, unknown> = {}) =>
  new GithubAppService(
    new ConfigService({
      GITHUB_APP_ID: '12345',
      GITHUB_APP_INSTALLATION_ID: '67890',
      GITHUB_APP_PRIVATE_KEY: privateKey,
      ...overrides,
    }),
  );

const decode = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<
    string,
    unknown
  >;

describe('GithubAppService', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('las tres claves o ninguna: a medias está apagada y dice cuáles faltan (sin valores)', () => {
    expect(service().enabled).toBe(true);
    const partial = service({ GITHUB_APP_PRIVATE_KEY: '' });
    expect(partial.enabled).toBe(false);
    expect(partial.missing).toEqual(['GITHUB_APP_PRIVATE_KEY']);
    expect(
      service({ GITHUB_APP_ID: '', GITHUB_APP_INSTALLATION_ID: '' }).missing,
    ).toEqual(['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID']);
    expect(() => partial.createAppJwt()).toThrow(GithubDisabledError);
  });

  it('el JWT es RS256, lo firma la App y se verifica con la clave pública; dura menos de 10 min', () => {
    const now = 1_800_000_000_000;
    const jwt = service().createAppJwt(now);
    const [header, payload, signature] = jwt.split('.') as [
      string,
      string,
      string,
    ];

    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(payload) as { iat: number; exp: number; iss: string };
    expect(claims.iss).toBe('12345');
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(10 * 60);
    expect(claims.iat).toBeLessThan(now / 1000); // tolera relojes desfasados

    const verifier = createVerify('RSA-SHA256').update(`${header}.${payload}`);
    expect(
      verifier.verify(
        createPublicKey(publicKey),
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('acepta la clave con "\\n" literales (como se guarda en una línea en Infisical)', () => {
    const oneLine = privateKey.replace(/\n/g, '\\n');
    expect(() =>
      service({ GITHUB_APP_PRIVATE_KEY: oneLine }).createAppJwt(),
    ).not.toThrow();
  });

  it('una clave inválida da un error claro que NO incluye la clave', () => {
    const bad = service({ GITHUB_APP_PRIVATE_KEY: 'esto no es un pem' });
    const error = (() => {
      try {
        bad.createAppJwt();
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(GithubAuthError);
    expect((error as Error).message).toContain('clave privada');
    expect((error as Error).message).not.toContain('esto no es un pem');
  });

  it('pide el token de instalación SOLO para un repo y con contents:write, autenticado con el JWT', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          token: `ghs_${'a'.repeat(30)}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201 },
      ),
    );

    const token = await service().installationToken('owner/jin-demos');

    expect(token).toBe(`ghs_${'a'.repeat(30)}`);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.github.com/app/installations/67890/access_tokens',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      repositories: ['jin-demos'],
      permissions: { contents: 'write' },
    });
    const auth = (init.headers as Record<string, string>).Authorization ?? '';
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('reusa el token mientras le queden más de 5 min; uno por repo', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            token: `ghs_${'b'.repeat(30)}`,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 201 },
        ),
      ),
    );
    const github = service();

    await github.installationToken('owner/a');
    await github.installationToken('owner/a');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await github.installationToken('owner/b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('un token a punto de vencer (< 5 min) se pide de nuevo', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            token: `ghs_${'c'.repeat(30)}`,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          }),
          { status: 201 },
        ),
      ),
    );
    const github = service();
    await github.installationToken('owner/a');
    await github.installationToken('owner/a');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('si GitHub rechaza, el error lleva solo el código HTTP: nunca el cuerpo de la respuesta', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ message: 'detalle interno que no debe copiarse' }),
        { status: 404 },
      ),
    );

    const error = await service()
      .installationToken('owner/a')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GithubAuthError);
    expect((error as Error).message).toContain('404');
    expect((error as Error).message).not.toContain('detalle interno');
  });
});
