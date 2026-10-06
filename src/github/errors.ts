import { JinError } from '../common/errors/jin-error';

/** Las claves de la GitHub App no están (o están a medias) en Infisical: la función está apagada. */
export class GithubDisabledError extends JinError {
  constructor(detail?: string) {
    super(
      `GitHub no está configurado en el Executor${detail ? ` (${detail})` : ''}. Faltan las claves de la GitHub App en Infisical.`,
      { code: 'GITHUB_DISABLED', httpStatus: 503 },
    );
  }
}

/** Un repo fuera de la lista blanca del Executor (defensa aparte de lo que la App tenga instalado). */
export class GithubRepoNotAllowedError extends JinError {
  constructor(repo: string) {
    super(
      `El repo "${repo}" no está en la lista de repos permitidos del Executor (GITHUB_ALLOWED_REPOS).`,
      { code: 'GITHUB_REPO_NOT_ALLOWED', httpStatus: 403 },
    );
  }
}

export class GithubInvalidInputError extends JinError {
  constructor(message: string) {
    super(message, { code: 'GITHUB_INVALID_INPUT', httpStatus: 422 });
  }
}

/** Falló la autenticación con GitHub (JWT, token de instalación). Nunca incluye el cuerpo de la respuesta. */
export class GithubAuthError extends JinError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: 'GITHUB_AUTH_FAILED', httpStatus: 502, cause });
  }
}

/** `git` terminó con error. El mensaje ya viene sin el token. */
export class GithubGitError extends JinError {
  constructor(message: string) {
    super(message, { code: 'GITHUB_GIT_FAILED', httpStatus: 502 });
  }
}

/** La operación choca con el estado actual (carpeta con archivos, rama que no avanza en fast-forward…). */
export class GithubConflictError extends JinError {
  constructor(message: string) {
    super(message, { code: 'GITHUB_CONFLICT', httpStatus: 409 });
  }
}
