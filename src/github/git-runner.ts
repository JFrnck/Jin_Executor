import { spawn } from 'node:child_process';
import { GithubGitError } from './errors';

const DEFAULT_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 1024 * 1024;

export interface GitRunOptions {
  /** Directorio de trabajo (un temporal que el llamador borra). */
  readonly cwd: string;
  /** Token de instalación: SOLO viaja en el entorno del proceso hijo. */
  readonly token?: string | undefined;
  /** Base del remoto (p. ej. https://github.com): el header de auth solo aplica a esa URL. */
  readonly remoteBase?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Tapa el token y su forma en base64 (Basic) en cualquier texto que vaya a salir. */
export function redactToken(text: string, token: string | undefined): string {
  let safe = text;
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    safe = safe.split(basic).join('[token]').split(token).join('[token]');
  }
  // Defensa por si otro token (distinto del actual) llegara a un mensaje.
  return safe.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[token]');
}

/**
 * Corre `git` como proceso hijo con un entorno CONTROLADO:
 * - el token entra por `GIT_CONFIG_*` (header `Authorization` solo para la URL del
 *   remoto), nunca en `argv` (se vería en `ps`) ni en un archivo de configuración;
 * - sin configuración global/de sistema, sin prompts, sin credential helpers;
 * - con tope de tiempo y de salida; los errores salen YA sin el token.
 * Jamás se usa `--force`: ninguna función de este repo lo recibe como parámetro.
 */
export function runGit(
  args: readonly string[],
  options: GitRunOptions,
): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: options.cwd,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ASKPASS: 'true',
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
  };
  if (options.token && options.remoteBase) {
    const basic = Buffer.from(`x-access-token:${options.token}`).toString(
      'base64',
    );
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `http.${options.remoteBase.replace(/\/+$/, '')}/.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }

  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= OUTPUT_LIMIT) {
        truncated = true;
        return current;
      }
      return current + chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new GithubGitError(
          `git ${args[0] ?? ''} superó el tiempo límite (${(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000} s).`,
        ),
      );
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        new GithubGitError(
          `No se pudo ejecutar git: ${redactToken(error.message, options.token)}`,
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = {
        stdout: redactToken(stdout, options.token),
        stderr: redactToken(stderr, options.token),
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      const reason = result.stderr.trim().split('\n').slice(-2).join(' ');
      reject(
        new GithubGitError(
          `git ${args[0] ?? ''} falló (código ${String(code)})${reason ? `: ${reason}` : ''}${truncated ? ' [salida truncada]' : ''}`,
        ),
      );
    });
  });
}
