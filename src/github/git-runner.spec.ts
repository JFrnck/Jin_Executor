import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GithubGitError } from './errors';
import { redactToken, runGit } from './git-runner';

// Construido en ejecución (no un literal con forma de token).
const TOKEN = `ghs_${'x1'.repeat(15)}`;
const BASE = 'https://github.com';

describe('redactToken', () => {
  it('tapa el token y su forma en base64 (Basic), y cualquier otro ghs_/ghp_', () => {
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    const text = `a ${TOKEN} b ${basic} c ghp_${'z'.repeat(25)}`;
    const safe = redactToken(text, TOKEN);
    expect(safe).not.toContain(TOKEN);
    expect(safe).not.toContain(basic);
    expect(safe).not.toContain('ghp_');
    expect(safe).toBe('a [token] b [token] c [token]');
  });

  it('sin token no cambia un texto normal', () => {
    expect(redactToken('hola mundo', undefined)).toBe('hola mundo');
  });
});

describe('runGit', () => {
  let cwd: string;
  beforeAll(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'jin-git-runner-'));
  });
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('el token llega a git por GIT_CONFIG_* (header solo para la URL del remoto) y NO sale en la salida', async () => {
    const { stdout } = await runGit(['config', '--list'], {
      cwd,
      token: TOKEN,
      remoteBase: BASE,
    });
    // Git lo recibió: la clave de config existe…
    expect(stdout).toContain(
      `http.${BASE}/.extraheader=Authorization: Basic [token]`,
    );
    // …pero ni el token ni su base64 salen de runGit.
    expect(stdout).not.toContain(TOKEN);
    expect(stdout).not.toContain(
      Buffer.from(`x-access-token:${TOKEN}`).toString('base64'),
    );
  });

  it('sin token no se configura ningún header de autenticación', async () => {
    const { stdout } = await runGit(['config', '--list'], { cwd });
    expect(stdout).not.toContain('extraheader');
  });

  it('un error de git sale sin el token y como GithubGitError', async () => {
    // git repite el argumento en su mensaje de error: así se prueba que sale tapado.
    await runGit(['init', '-q'], { cwd });
    const error = await runGit(['checkout', TOKEN], {
      cwd,
      token: TOKEN,
      remoteBase: BASE,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GithubGitError);
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).message).toContain('[token]');
  });

  it('no usa la configuración global del usuario ni pregunta credenciales', async () => {
    const { stdout } = await runGit(['config', '--list', '--show-origin'], {
      cwd,
    });
    expect(stdout).not.toMatch(/\.gitconfig/);
    expect(stdout).not.toContain('credential.helper');
  });
});
