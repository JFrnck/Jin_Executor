/** Ramas de demos: SIEMPRE `demo/<slug>`; nada más (ni `main` ni ramas ajenas) se toca. */
export const DEMO_BRANCH_PREFIX = 'demo/';
/** Mismos topes que "Publicar" desde el editor: una app de pocos archivos, no un repo. */
export const MAX_FILES = 50;
export const MAX_TOTAL_BYTES = 256 * 1024;

/** slug de una demo: minúsculas, números y guiones; sin `..`, barras ni espacios. */
export const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
/** owner/repo de GitHub. */
export const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export const COMMIT_AUTHOR_NAME = 'Jin';
export const COMMIT_AUTHOR_EMAIL = 'jin@users.noreply.github.com';
