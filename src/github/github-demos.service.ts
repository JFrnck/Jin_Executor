import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PreviewServiceLifecycleService } from '../preview-service/preview-service.service';
import { RbacValidatorService } from '../rbac/rbac-validator.service';
import { isSafeRelativePath } from '../preview-service/tar-payload';
import {
  COMMIT_AUTHOR_EMAIL,
  COMMIT_AUTHOR_NAME,
  DEMO_BRANCH_PREFIX,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  REPO_PATTERN,
  SLUG_PATTERN,
} from './github.constants';
import { GithubAppService } from './github-app.service';
import {
  GithubDisabledError,
  GithubInvalidInputError,
  GithubRepoNotAllowedError,
} from './errors';
import { runGit } from './git-runner';

export interface SaveDemoResult {
  readonly repo: string;
  readonly branch: string;
  readonly slug: string;
  /** SHA del commit en la rama tras guardar. */
  readonly commit: string;
  readonly files: number;
  /** `true` si la rama ya existía con exactamente esos archivos: no se creó otro commit. */
  readonly unchanged: boolean;
  readonly skipped: readonly { path: string; reason: string }[];
  readonly url: string;
}

export interface GithubDemoBranch {
  readonly slug: string;
  readonly branch: string;
  readonly commit: string;
}

/**
 * Demos guardadas en GitHub (2026-10-02). Cada demo es una rama HUÉRFANA `demo/<slug>`
 * del repo compartido: sin historia común con las demás, así una demo se puede
 * "graduar" a un repo propio con su historial limpio. Todo lo hace el Executor desde
 * su propio pod: los pods de demo no tienen salida a GitHub ni ven ningún token.
 *
 * Defensas aparte de lo que la App tenga instalado: lista blanca de repos, solo ramas
 * `demo/<slug>`, nunca `--force`, topes de tamaño y archivos de texto.
 */
@Injectable()
export class GithubDemosService {
  private readonly logger = new Logger(GithubDemosService.name);
  private readonly demosRepo: string;
  private readonly allowedRepos: ReadonlySet<string>;
  private readonly remoteBase: string;

  constructor(
    private readonly app: GithubAppService,
    private readonly previews: PreviewServiceLifecycleService,
    private readonly rbacValidator: RbacValidatorService,
    configService: ConfigService,
  ) {
    this.demosRepo = configService.get<string>('GITHUB_DEMOS_REPO', '');
    const allowed = configService
      .get<string>('GITHUB_ALLOWED_REPOS', '')
      .split(',')
      .map((repo) => repo.trim())
      .filter(Boolean);
    this.allowedRepos = new Set(
      this.demosRepo ? [this.demosRepo, ...allowed] : allowed,
    );
    this.remoteBase = configService
      .get<string>('GITHUB_REMOTE_BASE_URL', 'https://github.com')
      .replace(/\/+$/, '');
  }

  /** ¿Está la función encendida? (las tres claves de la App y un repo de demos). */
  get enabled(): boolean {
    return this.app.enabled && this.demosRepo !== '';
  }

  /** Guarda (o actualiza) una demo en `demo/<slug>`. Sin `--force`: una actualización es un commit encima. */
  async save(input: {
    serviceId: string;
    slug: string;
    repo?: string | undefined;
  }): Promise<SaveDemoResult> {
    this.rbacValidator.validate('saveDemoToGithub');
    const repo = this.resolveRepo(input.repo);
    const slug = this.validateSlug(input.slug);
    const branch = `${DEMO_BRANCH_PREFIX}${slug}`;

    const exported = await this.previews.exportFiles(input.serviceId, '.');
    const files = this.validateFiles(exported.files);

    const token = await this.app.installationToken(repo);
    const url = `${this.remoteBase}/${repo}.git`;
    const workdir = await mkdtemp(path.join(tmpdir(), 'jin-github-'));
    const git = (args: string[]) =>
      runGit(args, { cwd: workdir, token, remoteBase: this.remoteBase });
    try {
      const existing = await git([
        'ls-remote',
        '--heads',
        url,
        `refs/heads/${branch}`,
      ]);
      const exists = existing.stdout.trim().length > 0;

      await git(['init', '-q', '-b', branch]);
      if (exists) {
        // Una actualización va ENCIMA de la rama existente (fast-forward, nunca force).
        await git(['fetch', '-q', '--depth', '1', url, `refs/heads/${branch}`]);
        await git(['checkout', '-q', '-B', branch, 'FETCH_HEAD']);
        await git(['rm', '-rq', '--ignore-unmatch', '.']);
      }
      for (const [relative, content] of Object.entries(files)) {
        const target = path.join(workdir, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
      }
      await git(['add', '-A']);

      let unchanged = false;
      try {
        await git(['diff', '--cached', '--quiet']);
        unchanged = exists; // sin cambios en una rama existente; en una nueva no puede pasar con ≥1 archivo
      } catch {
        unchanged = false;
      }
      if (!unchanged) {
        await git([
          '-c',
          `user.name=${COMMIT_AUTHOR_NAME}`,
          '-c',
          `user.email=${COMMIT_AUTHOR_EMAIL}`,
          'commit',
          '-q',
          '-m',
          `${exists ? 'Actualizar' : 'Guardar'} demo ${slug} (${Object.keys(files).length} archivos)`,
        ]);
        // Sin --force: si la rama cambió mientras tanto, git rechaza y se informa.
        await git(['push', '-q', url, `HEAD:refs/heads/${branch}`]);
      }
      const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();

      this.logger.log(
        `Demo ${slug} guardada en ${repo}@${branch} (${Object.keys(files).length} archivos${unchanged ? ', sin cambios' : ''})`,
      );
      return {
        repo,
        branch,
        slug,
        commit,
        files: Object.keys(files).length,
        unchanged,
        skipped: exported.skipped,
        url: `https://github.com/${repo}/tree/${branch}`,
      };
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }

  /** Las demos guardadas (ramas `demo/*` del repo compartido). */
  async list(repoInput?: string): Promise<GithubDemoBranch[]> {
    this.rbacValidator.validate('listGithubDemos');
    const repo = this.resolveRepo(repoInput);
    const token = await this.app.installationToken(repo);
    const workdir = await mkdtemp(path.join(tmpdir(), 'jin-github-'));
    try {
      const { stdout } = await runGit(
        [
          'ls-remote',
          '--heads',
          `${this.remoteBase}/${repo}.git`,
          `refs/heads/${DEMO_BRANCH_PREFIX}*`,
        ],
        { cwd: workdir, token, remoteBase: this.remoteBase },
      );
      return stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length === 2)
        .map(([commit, ref]) => ({
          commit: commit ?? '',
          branch: (ref ?? '').replace('refs/heads/', ''),
        }))
        .filter(({ branch }) => branch.startsWith(DEMO_BRANCH_PREFIX))
        .map(({ commit, branch }) => ({
          slug: branch.slice(DEMO_BRANCH_PREFIX.length),
          branch,
          commit,
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug));
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }

  private resolveRepo(input?: string): string {
    if (!this.enabled) {
      throw new GithubDisabledError(
        this.demosRepo === ''
          ? 'falta GITHUB_DEMOS_REPO'
          : this.app.missing.join(', '),
      );
    }
    const repo = input ?? this.demosRepo;
    if (!REPO_PATTERN.test(repo) || !this.allowedRepos.has(repo)) {
      throw new GithubRepoNotAllowedError(repo);
    }
    return repo;
  }

  private validateSlug(slug: string): string {
    if (!SLUG_PATTERN.test(slug)) {
      throw new GithubInvalidInputError(
        'El nombre de la demo debe ser minúsculas, números y guiones (sin espacios, barras ni "..").',
      );
    }
    return slug;
  }

  private validateFiles(
    files: Readonly<Record<string, string>>,
  ): Record<string, string> {
    const entries = Object.entries(files);
    if (entries.length === 0) {
      throw new GithubInvalidInputError(
        'La demo no tiene archivos de texto que guardar.',
      );
    }
    if (entries.length > MAX_FILES) {
      throw new GithubInvalidInputError(
        `La demo tiene más de ${MAX_FILES} archivos.`,
      );
    }
    let total = 0;
    for (const [relative, content] of entries) {
      if (!isSafeRelativePath(relative)) {
        throw new GithubInvalidInputError(
          `Ruta insegura en la demo: ${relative}`,
        );
      }
      total += Buffer.byteLength(relative) + Buffer.byteLength(content);
    }
    if (total > MAX_TOTAL_BYTES) {
      throw new GithubInvalidInputError(
        `La demo supera ${MAX_TOTAL_BYTES / 1024} KB.`,
      );
    }
    return Object.fromEntries(entries);
  }
}
