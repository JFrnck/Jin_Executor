import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RbacValidatorService } from '../rbac/rbac-validator.service';
import {
  COMMIT_AUTHOR_EMAIL,
  COMMIT_AUTHOR_NAME,
  REPO_PATTERN,
} from './github.constants';
import {
  GithubConflictError,
  GithubDisabledError,
  GithubGitError,
  GithubInvalidInputError,
  GithubRepoNotAllowedError,
} from './errors';
import { GithubAppService, type InstalledRepo } from './github-app.service';
import { runGit, type GitResult } from './git-runner';
import { findSecretPaths } from './secret-files';
import {
  MAX_TAR_BYTES,
  WORKSPACE_FS,
  workspacePath,
  type WorkspaceFs,
} from './workspace-fs';

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
/** Ramas a las que Jin NUNCA sube (además de la rama por defecto del repo). */
const PROTECTED_BRANCHES = new Set(['main', 'master', 'HEAD']);
const CLONE_DEPTH = '100';
const MAX_CHANGED_LISTED = 500;

export interface RepoStatus {
  readonly repo: string;
  readonly branch: string;
  readonly head: string;
  readonly clean: boolean;
  readonly changed: readonly { path: string; status: string }[];
  readonly changedTruncated: boolean;
}

export interface CloneResult {
  readonly repo: string;
  readonly dir: string;
  readonly branch: string;
  readonly head: string;
}

export interface PushResult {
  readonly repo: string;
  readonly branch: string;
  readonly commit: string;
  readonly files: number;
  readonly url: string;
}

interface RepoGit {
  (args: string[], options?: { remote?: boolean }): Promise<GitResult>;
}

/**
 * Clonar, ver el estado, cambiar de rama, actualizar (pull) y subir cambios (push) de un repo de GitHub
 * que vive en el disco del workspace de una terminal (ADR 0022).
 *
 * Todo git corre AQUÍ, en el Executor, sobre una copia temporal del workspace; el pod no tiene git ni
 * salida a GitHub y jamás ve un token. Defensas: solo repos donde la GitHub App está instalada; nunca
 * `--force`; nunca a `main`/`master`/la rama por defecto; archivos que parecen secretos no se suben.
 */
@Injectable()
export class GithubReposService {
  private readonly logger = new Logger(GithubReposService.name);
  private readonly remoteBase: string;

  constructor(
    private readonly app: GithubAppService,
    @Inject(WORKSPACE_FS) private readonly workspaceFs: WorkspaceFs,
    private readonly rbacValidator: RbacValidatorService,
    configService: ConfigService,
  ) {
    this.remoteBase = configService
      .get<string>('GITHUB_REMOTE_BASE_URL', 'https://github.com')
      .replace(/\/+$/, '');
  }

  get enabled(): boolean {
    return this.app.enabled;
  }

  async listRepos(): Promise<InstalledRepo[]> {
    this.requireEnabled();
    return this.app.listRepositories();
  }

  /** Clona `repo` en `dir` del workspace (que debe estar vacío). */
  async clone(input: {
    workspaceId: string;
    repo: string;
    ref?: string | undefined;
    dir?: string | undefined;
  }): Promise<CloneResult> {
    this.rbacValidator.validate('runTerminalCommand');
    this.requireEnabled();
    const repo = this.validateRepo(input.repo);
    const dir = this.validateDir(input.dir);
    const ref =
      input.ref === undefined ? undefined : this.validateBranch(input.ref);
    await this.requireInstalled(repo);
    if (!(await this.workspaceFs.isEmpty(input.workspaceId, dir))) {
      throw new GithubConflictError(
        `La carpeta "${dir}" del proyecto ya tiene archivos. Clona en una carpeta vacía (o en una nueva).`,
      );
    }

    const token = await this.app.installationToken(repo);
    const temp = await mkdtemp(path.join(tmpdir(), 'jin-clone-'));
    const work = path.join(temp, 'work');
    try {
      await runGit(
        [
          'clone',
          '--quiet',
          '--depth',
          CLONE_DEPTH,
          '--no-tags',
          ...(ref ? ['--branch', ref] : []),
          `${this.remoteBase}/${repo}.git`,
          work,
        ],
        {
          cwd: temp,
          token,
          remoteBase: this.remoteBase,
          timeoutMs: 5 * 60_000,
        },
      );
      const git = this.gitIn(work, token);
      const branch = (
        await git(['rev-parse', '--abbrev-ref', 'HEAD'])
      ).stdout.trim();
      const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      const tar = await tarDirectory(work);
      await this.workspaceFs.replaceFromTar(input.workspaceId, dir, tar);
      this.logger.log(
        `Clonado ${repo}@${branch} (${head.slice(0, 7)}) en ${input.workspaceId}:${dir}`,
      );
      return { repo, dir, branch, head };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  async status(input: {
    workspaceId: string;
    dir?: string | undefined;
  }): Promise<RepoStatus> {
    this.rbacValidator.validate('runTerminalCommand');
    this.requireEnabled();
    return this.withCopy(input, false, async ({ git, repo }) => {
      const branch = (
        await git(['rev-parse', '--abbrev-ref', 'HEAD'])
      ).stdout.trim();
      const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      const porcelain = (
        await git(['status', '--porcelain=v1', '--untracked-files=all'])
      ).stdout
        .split('\n')
        .filter(Boolean);
      const changed = porcelain.slice(0, MAX_CHANGED_LISTED).map((line) => ({
        status: line.slice(0, 2).trim() || '?',
        path: line.slice(3),
      }));
      return {
        repo,
        branch,
        head,
        clean: porcelain.length === 0,
        changed,
        changedTruncated: porcelain.length > MAX_CHANGED_LISTED,
      };
    });
  }

  async branches(input: {
    workspaceId: string;
    dir?: string | undefined;
  }): Promise<{ current: string; local: string[]; remote: string[] }> {
    this.rbacValidator.validate('runTerminalCommand');
    this.requireEnabled();
    return this.withCopy(input, false, async ({ git }) => {
      const current = (
        await git(['rev-parse', '--abbrev-ref', 'HEAD'])
      ).stdout.trim();
      const local = (
        await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
      ).stdout
        .split('\n')
        .filter(Boolean);
      const remote = (
        await git(['ls-remote', '--heads', 'origin'], { remote: true })
      ).stdout
        .split('\n')
        .map((line) => line.split('\trefs/heads/')[1]?.trim())
        .filter((name): name is string => Boolean(name));
      return { current, local, remote };
    });
  }

  async checkout(input: {
    workspaceId: string;
    dir?: string | undefined;
    branch: string;
    create?: boolean | undefined;
  }): Promise<{ branch: string; head: string }> {
    this.rbacValidator.validate('runTerminalCommand');
    this.requireEnabled();
    const branch = this.validateBranch(input.branch);
    return this.withCopy(input, true, async ({ git }) => {
      const local = (
        await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
      ).stdout
        .split('\n')
        .filter(Boolean);
      if (input.create) {
        if (local.includes(branch)) {
          throw new GithubConflictError(`La rama "${branch}" ya existe.`);
        }
        await git(['checkout', '-q', '-b', branch]);
      } else if (local.includes(branch)) {
        await git(['checkout', '-q', branch]);
      } else {
        await git(
          [
            'fetch',
            '-q',
            '--depth',
            CLONE_DEPTH,
            'origin',
            `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
          ],
          { remote: true },
        );
        // Un clon superficial es de una sola rama: sin refspec que mapee las demás, --track fallaría; pull ya va explícito.
        await git([
          'checkout',
          '-q',
          '-b',
          branch,
          '--no-track',
          `origin/${branch}`,
        ]);
      }
      const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      return { branch, head };
    });
  }

  /** Actualiza la rama actual desde origin, SOLO en avance rápido (sin merges ni conflictos). */
  async pull(input: {
    workspaceId: string;
    dir?: string | undefined;
  }): Promise<{ branch: string; head: string; updated: boolean }> {
    this.rbacValidator.validate('runTerminalCommand');
    this.requireEnabled();
    return this.withCopy(input, true, async ({ git }) => {
      const branch = (
        await git(['rev-parse', '--abbrev-ref', 'HEAD'])
      ).stdout.trim();
      const before = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      await git(
        [
          'fetch',
          '-q',
          '--depth',
          CLONE_DEPTH,
          'origin',
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ],
        { remote: true },
      );
      try {
        await git(['merge', '--ff-only', '-q', `origin/${branch}`]);
      } catch {
        throw new GithubConflictError(
          'No se pudo actualizar en avance rápido: hay cambios locales que chocan o la rama divergió. Sube tus cambios a otra rama o resuélvelo con la terminal.',
        );
      }
      const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      return { branch, head, updated: head !== before };
    });
  }

  /**
   * Hace commit de todo lo cambiado en una rama NUEVA (o una propia ya existente) y la sube. Sin
   * `--force`; `main`, `master` y la rama por defecto están prohibidas; los archivos que parecen secretos
   * frenan el push (nada se sube a medias).
   */
  async push(input: {
    workspaceId: string;
    dir?: string | undefined;
    branch: string;
    message: string;
  }): Promise<PushResult> {
    this.rbacValidator.validate('runTerminalCommand');
    this.requireEnabled();
    const branch = this.validateBranch(input.branch);
    const message = input.message.trim();
    if (message.length < 1 || message.length > 200) {
      throw new GithubInvalidInputError(
        'El mensaje del commit debe tener entre 1 y 200 caracteres.',
      );
    }
    return this.withCopy(input, true, async ({ git, repo, defaultBranch }) => {
      if (PROTECTED_BRANCHES.has(branch) || branch === defaultBranch) {
        throw new GithubInvalidInputError(
          `Jin no sube a "${branch}": usa una rama nueva y abre un pull request en GitHub.`,
        );
      }
      const porcelain = (
        await git(['status', '--porcelain=v1', '--untracked-files=all'])
      ).stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(3));
      const secrets = findSecretPaths(porcelain);
      if (secrets.length > 0) {
        throw new GithubInvalidInputError(
          `Estos archivos parecen secretos y no se suben: ${secrets.join(', ')}. Agrégalos al .gitignore o bórralos.`,
        );
      }
      await git(['checkout', '-q', '-B', branch]);
      await git(['add', '-A']);
      const staged = (await git(['diff', '--cached', '--name-only'])).stdout
        .split('\n')
        .filter(Boolean);
      if (staged.length === 0) {
        throw new GithubConflictError('No hay cambios que subir.');
      }
      await git([
        '-c',
        `user.name=${COMMIT_AUTHOR_NAME}`,
        '-c',
        `user.email=${COMMIT_AUTHOR_EMAIL}`,
        'commit',
        '-q',
        '-m',
        message,
      ]);
      // Sin --force: si la rama remota existe y no avanza en fast-forward, git lo rechaza.
      await git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], {
        remote: true,
      });
      const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      return {
        repo,
        branch,
        commit,
        files: staged.length,
        url: `${this.remoteBase}/${repo}/tree/${branch}`,
      };
    });
  }

  // ── internos ───────────────────────────────────────────────────────────

  /** Copia el proyecto a un temporal, corre `fn` con git ahí y (si `writeBack`) devuelve el resultado al pod. */
  private async withCopy<T>(
    input: { workspaceId: string; dir?: string | undefined },
    writeBack: boolean,
    fn: (ctx: {
      git: RepoGit;
      repo: string;
      defaultBranch: string;
    }) => Promise<T>,
  ): Promise<T> {
    const dir = this.validateDir(input.dir);
    workspacePath(dir);
    const temp = await mkdtemp(path.join(tmpdir(), 'jin-repo-'));
    const work = path.join(temp, 'work');
    try {
      await mkdir(work, { recursive: true });
      const tar = await this.workspaceFs.exportTar(input.workspaceId, dir);
      if (tar.length > MAX_TAR_BYTES) {
        throw new GithubInvalidInputError(
          'El proyecto es demasiado grande para operar con git.',
        );
      }
      await untarInto(tar, work);
      const plain = this.gitIn(work, undefined);
      let origin: string;
      try {
        origin = (await plain(['remote', 'get-url', 'origin'])).stdout.trim();
      } catch {
        throw new GithubInvalidInputError(
          'Esta carpeta no es un repo clonado desde GitHub (no tiene origin).',
        );
      }
      const repo = this.repoFromOrigin(origin);
      await this.requireInstalled(repo);
      const token = await this.app.installationToken(repo);
      const git = this.gitIn(work, token);
      const defaultBranch = await this.defaultBranchOf(repo);
      const result = await fn({ git, repo, defaultBranch });
      if (writeBack) {
        const out = await tarDirectory(work);
        await this.workspaceFs.replaceFromTar(input.workspaceId, dir, out);
      }
      return result;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  private gitIn(cwd: string, token: string | undefined): RepoGit {
    return (args, options) =>
      runGit(args, {
        cwd,
        ...(options?.remote ? { token, remoteBase: this.remoteBase } : {}),
        timeoutMs: 5 * 60_000,
      });
  }

  private repoFromOrigin(origin: string): string {
    const match =
      /^(?:.*[/:])?([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/.exec(origin);
    const repo = match?.[1];
    if (!repo || !REPO_PATTERN.test(repo)) {
      throw new GithubInvalidInputError(
        'No se pudo reconocer el repo de origin.',
      );
    }
    return repo;
  }

  private async defaultBranchOf(repo: string): Promise<string> {
    const found = (await this.app.listRepositories()).find(
      (candidate) => candidate.fullName.toLowerCase() === repo.toLowerCase(),
    );
    return found?.defaultBranch ?? 'main';
  }

  private async requireInstalled(repo: string): Promise<void> {
    if (!(await this.app.isInstalled(repo)))
      throw new GithubRepoNotAllowedError(repo);
  }

  private requireEnabled(): void {
    if (!this.app.enabled)
      throw new GithubDisabledError(this.app.missing.join(', '));
  }

  private validateRepo(repo: string): string {
    if (!REPO_PATTERN.test(repo))
      throw new GithubInvalidInputError(`Repo no válido: ${repo}`);
    return repo;
  }

  private validateBranch(branch: string): string {
    if (
      !BRANCH_PATTERN.test(branch) ||
      branch.includes('..') ||
      branch.endsWith('/') ||
      branch.endsWith('.lock')
    ) {
      throw new GithubInvalidInputError(`Nombre de rama no válido: ${branch}`);
    }
    return branch;
  }

  private validateDir(dir: string | undefined): string {
    const value = dir === undefined || dir === '' ? '.' : dir;
    workspacePath(value);
    return value;
  }
}

/** tar (sin comprimir) de un directorio local. */
function tarDirectory(directory: string): Promise<Buffer> {
  return runTar(['-cf', '-', '-C', directory, '.']);
}

function untarInto(tar: Buffer, directory: string): Promise<void> {
  return runTar(['-xf', '-', '-C', directory], tar).then(() => undefined);
}

function runTar(args: string[], stdin?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, {
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_TAR_BYTES) {
        child.kill('SIGKILL');
        reject(
          new GithubInvalidInputError(
            'El proyecto es demasiado grande para operar con git.',
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) =>
      reject(new GithubGitError(`tar falló: ${error.message}`)),
    );
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(
            new GithubGitError(
              `tar terminó con código ${String(code)}: ${stderr.slice(0, 200)}`,
            ),
          ),
    );
    if (stdin && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin);
    }
  });
}
