import { createPrivateKey, createSign } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GithubAuthError, GithubDisabledError } from './errors';

/** Un token de instalación vive 1 h; se reusa mientras le queden más de 5 min. */
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url');

/**
 * GitHub App (BLUEPRINT §7.3, no un PAT): firma un JWT RS256 con la clave privada de
 * la App y lo cambia por un **token de instalación** de 1 h, pedido con los permisos
 * mínimos (`contents: write`) y solo para UN repo.
 *
 * El token vive solo en memoria: nunca se loguea, nunca se escribe a disco ni se
 * devuelve por la API del Executor; lo recibe únicamente el proceso `git` hijo.
 * Sin las tres claves la función está apagada (`enabled === false`).
 */
@Injectable()
export class GithubAppService {
  private readonly appId: string;
  private readonly installationId: string;
  private readonly privateKeyPem: string;
  private readonly apiBase: string;
  private readonly cache = new Map<string, CachedToken>();

  constructor(configService: ConfigService) {
    this.appId = configService.get<string>('GITHUB_APP_ID', '');
    this.installationId = configService.get<string>(
      'GITHUB_APP_INSTALLATION_ID',
      '',
    );
    // En Infisical la clave suele guardarse en una línea, con "\n" literales.
    this.privateKeyPem = configService
      .get<string>('GITHUB_APP_PRIVATE_KEY', '')
      .replace(/\\n/g, '\n');
    this.apiBase = configService
      .get<string>('GITHUB_API_BASE_URL', 'https://api.github.com')
      .replace(/\/+$/, '');
  }

  /** Las tres o ninguna: a medias cuenta como apagada. */
  get enabled(): boolean {
    return Boolean(this.appId && this.installationId && this.privateKeyPem);
  }

  /** Qué falta, sin revelar valores (para el mensaje de "apagado"). */
  get missing(): string[] {
    return [
      ['GITHUB_APP_ID', this.appId],
      ['GITHUB_APP_INSTALLATION_ID', this.installationId],
      ['GITHUB_APP_PRIVATE_KEY', this.privateKeyPem],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name as string);
  }

  /** JWT de la App (máx. 10 min de vida, exigido por GitHub). */
  createAppJwt(nowMs: number = Date.now()): string {
    if (!this.enabled) throw new GithubDisabledError(this.missing.join(', '));
    const issuedAt = Math.floor(nowMs / 1000) - 60; // tolera relojes desfasados
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({
        iat: issuedAt,
        exp: issuedAt + 9 * 60,
        iss: this.appId,
      }),
    );
    const signingInput = `${header}.${payload}`;
    try {
      const signature = createSign('RSA-SHA256')
        .update(signingInput)
        .sign(createPrivateKey(this.privateKeyPem));
      return `${signingInput}.${base64url(signature)}`;
    } catch (cause) {
      // El mensaje de OpenSSL puede describir la clave: no se propaga.
      throw new GithubAuthError(
        'La clave privada de la GitHub App no es válida (¿PEM completo?).',
        cause,
      );
    }
  }

  /** Token de instalación para UN repo (`owner/repo`), con `contents: write` y nada más. */
  async installationToken(repo: string): Promise<string> {
    const repoName = repo.split('/')[1] ?? '';
    const cached = this.cache.get(repoName);
    if (cached && cached.expiresAt - Date.now() > TOKEN_REUSE_MARGIN_MS) {
      return cached.token;
    }

    const jwt = this.createAppJwt();
    const response = await fetch(
      `${this.apiBase}/app/installations/${encodeURIComponent(this.installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'jin-executor',
        },
        body: JSON.stringify({
          repositories: [repoName],
          permissions: { contents: 'write' },
        }),
      },
    );
    if (!response.ok) {
      // Solo el código: el cuerpo de GitHub no se copia a ningún mensaje.
      throw new GithubAuthError(
        `GitHub rechazó el token de instalación (HTTP ${response.status}). ¿La App está instalada en ${repo}?`,
      );
    }
    const body = (await response.json()) as {
      token?: string;
      expires_at?: string;
    };
    if (!body.token) {
      throw new GithubAuthError('GitHub no devolvió un token de instalación.');
    }
    this.cache.set(repoName, {
      token: body.token,
      expiresAt: body.expires_at
        ? new Date(body.expires_at).getTime()
        : Date.now() + 50 * 60_000,
    });
    return body.token;
  }
}
