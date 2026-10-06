import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigService } from '@nestjs/config';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { RbacValidatorService } from '../rbac/rbac-validator.service';
import {
  GithubConflictError,
  GithubDisabledError,
  GithubInvalidInputError,
  GithubRepoNotAllowedError,
} from './errors';
import type { GithubAppService } from './github-app.service';
import { GithubReposService } from './github-repos.service';
import { PRESERVED_NAMES, type WorkspaceFs } from './workspace-fs';

// Construido en ejecución (no un literal con forma de token).
const TOKEN = `ghs_${'k7'.repeat(15)}`;
const REPO = 'acme/app';
const WS = '22222222-2222-4222-8222-222222222222';

let root: string; // remotos: file://<root>/<owner>/<repo>.git
let bare: string;
let disk: string; // "discos" de workspaces: <disk>/<workspaceId>/<dir>

const run = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=t@t.t', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();

/** WorkspaceFs sobre un directorio local (sin Kubernetes), con la misma semántica que el del pod. */
class DirWorkspaceFs implements WorkspaceFs {
  private dirOf(workspaceId: string, dir: string): string {
    return path.join(disk, workspaceId, dir === '.' ? '' : dir);
  }
  exportTar(workspaceId: string, dir: string): Promise<Buffer> {
    const target = this.dirOf(workspaceId, dir);
    mkdirSync(target, { recursive: true });
    const excludes = PRESERVED_NAMES.flatMap((n) => ['--exclude', `./${n}`]);
    return Promise.resolve(
      execFileSync('tar', ['-cf', '-', ...excludes, '-C', target, '.'], {
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  }
  replaceFromTar(workspaceId: string, dir: string, tar: Buffer): Promise<void> {
    const target = this.dirOf(workspaceId, dir);
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(target)) {
      if ((PRESERVED_NAMES as readonly string[]).includes(entry)) continue;
      rmSync(path.join(target, entry), { recursive: true, force: true });
    }
    execFileSync('tar', ['-xf', '-', '-C', target], { input: tar });
    return Promise.resolve();
  }
  isEmpty(workspaceId: string, dir: string): Promise<boolean> {
    const target = this.dirOf(workspaceId, dir);
    if (!existsSync(target)) return Promise.resolve(true);
    return Promise.resolve(
      readdirSync(target).filter(
        (n) => !(PRESERVED_NAMES as readonly string[]).includes(n),
      ).length === 0,
    );
  }
}

function makeService(
  options: { enabled?: boolean; installed?: string[] } = {},
) {
  const installed = options.installed ?? [REPO];
  const tokenMock = vi.fn().mockResolvedValue(TOKEN);
  const app = {
    enabled: options.enabled ?? true,
    missing: ['GITHUB_APP_ID'],
    installationToken: tokenMock,
    listRepositories: vi.fn().mockImplementation(() =>
      Promise.resolve(
        installed.map((fullName) => ({
          fullName,
          private: true,
          defaultBranch: 'main',
          description: null,
        })),
      ),
    ),
    isInstalled: vi
      .fn()
      .mockImplementation((repo: string) =>
        Promise.resolve(installed.includes(repo)),
      ),
  } as unknown as GithubAppService;
  const rbac = { validate: vi.fn() } as unknown as RbacValidatorService;
  const config = new ConfigService({
    GITHUB_REMOTE_BASE_URL: `file://${root}`,
  });
  return {
    service: new GithubReposService(app, new DirWorkspaceFs(), rbac, config),
    tokenMock,
  };
}

const wsFile = (...parts: string[]): string => path.join(disk, WS, ...parts);

/** Remoto con un primer commit en main (README, src/a.txt, .gitignore). */
function seedRemote(): void {
  bare = path.join(root, `${REPO}.git`);
  mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = mkdtempSync(path.join(tmpdir(), 'seed-'));
  run(seed, 'clone', '-q', bare, '.');
  run(seed, 'checkout', '-q', '-B', 'main');
  writeFileSync(path.join(seed, 'README.md'), '# app\n');
  mkdirSync(path.join(seed, 'src'));
  writeFileSync(path.join(seed, 'src/a.txt'), 'uno\n');
  writeFileSync(path.join(seed, '.gitignore'), 'node_modules\n.env\n');
  run(seed, 'add', '-A');
  run(seed, 'commit', '-q', '-m', 'inicial');
  run(seed, 'push', '-q', 'origin', 'main');
  rmSync(seed, { recursive: true, force: true });
}

describe('GithubReposService (git real contra un remoto bare local)', () => {
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'jin-repos-'));
    disk = mkdtempSync(path.join(tmpdir(), 'jin-disk-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(disk, { recursive: true, force: true });
  });
  beforeEach(() => {
    rmSync(bare ?? root, { recursive: true, force: true });
    rmSync(path.join(disk, WS), { recursive: true, force: true });
    seedRemote();
  });

  it('clona en una carpeta vacía y deja los archivos y el .git; no guarda el token en ningún lado', async () => {
    const { service, tokenMock } = makeService();
    const result = await service.clone({ workspaceId: WS, repo: REPO });
    expect(result).toMatchObject({ repo: REPO, dir: '.', branch: 'main' });
    expect(result.head).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(wsFile('src/a.txt'), 'utf8')).toBe('uno\n');
    expect(existsSync(wsFile('.git/HEAD'))).toBe(true);
    expect(readFileSync(wsFile('.git/config'), 'utf8')).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(tokenMock).toHaveBeenCalledWith(REPO);
  });

  it('rechaza: función apagada, repo sin la App instalada, carpeta con archivos y datos inválidos', async () => {
    await expect(
      makeService({ enabled: false }).service.clone({
        workspaceId: WS,
        repo: REPO,
      }),
    ).rejects.toThrow(GithubDisabledError);
    await expect(
      makeService({ installed: [] }).service.clone({
        workspaceId: WS,
        repo: REPO,
      }),
    ).rejects.toThrow(GithubRepoNotAllowedError);
    await expect(
      makeService().service.clone({ workspaceId: WS, repo: 'no es un repo' }),
    ).rejects.toThrow(GithubInvalidInputError);
    await expect(
      makeService().service.clone({
        workspaceId: WS,
        repo: REPO,
        dir: '../fuera',
      }),
    ).rejects.toThrow(GithubInvalidInputError);

    const { service } = makeService();
    await service.clone({ workspaceId: WS, repo: REPO });
    await expect(
      service.clone({ workspaceId: WS, repo: REPO }),
    ).rejects.toThrow(GithubConflictError);
  });

  it('clona en una subcarpeta y respeta node_modules y carpetas del entorno', async () => {
    const { service } = makeService();
    mkdirSync(wsFile('node_modules/x'), { recursive: true });
    await service.clone({ workspaceId: WS, repo: REPO, dir: 'proyectos/app' });
    expect(existsSync(wsFile('proyectos/app/README.md'))).toBe(true);
    expect(existsSync(wsFile('node_modules/x'))).toBe(true);
  });

  it('status: limpio, luego con un cambio y un archivo nuevo', async () => {
    const { service } = makeService();
    await service.clone({ workspaceId: WS, repo: REPO });
    expect(await service.status({ workspaceId: WS })).toMatchObject({
      repo: REPO,
      branch: 'main',
      clean: true,
      changed: [],
    });

    writeFileSync(wsFile('src/a.txt'), 'dos\n');
    writeFileSync(wsFile('src/b.txt'), 'nuevo\n');
    const status = await service.status({ workspaceId: WS });
    expect(status.clean).toBe(false);
    expect(status.changed).toEqual(
      expect.arrayContaining([
        { status: 'M', path: 'src/a.txt' },
        { status: '??', path: 'src/b.txt' },
      ]),
    );
  });

  it('push: sube a una rama nueva, main queda intacta y el workspace queda en esa rama', async () => {
    const { service } = makeService();
    await service.clone({ workspaceId: WS, repo: REPO });
    const mainBefore = run(bare, 'rev-parse', 'refs/heads/main');
    writeFileSync(wsFile('src/a.txt'), 'dos\n');
    writeFileSync(wsFile('src/nuevo.js'), 'export {};\n');

    const pushed = await service.push({
      workspaceId: WS,
      branch: 'jin/cambios',
      message: 'Cambios desde Jin',
    });
    expect(pushed).toMatchObject({
      repo: REPO,
      branch: 'jin/cambios',
      files: 2,
    });
    expect(pushed.url).toContain('/acme/app/tree/jin/cambios');
    expect(run(bare, 'rev-parse', 'refs/heads/jin/cambios')).toBe(
      pushed.commit,
    );
    expect(run(bare, 'rev-parse', 'refs/heads/main')).toBe(mainBefore);
    expect(
      run(bare, 'log', '-1', '--format=%an|%s', 'refs/heads/jin/cambios'),
    ).toBe('Jin|Cambios desde Jin');
    expect(JSON.stringify(pushed)).not.toContain(TOKEN);

    const status = await service.status({ workspaceId: WS });
    expect(status).toMatchObject({ branch: 'jin/cambios', clean: true });
  });

  it('push: main, master y la rama por defecto están prohibidas; sin cambios no hay commit', async () => {
    const { service } = makeService();
    await service.clone({ workspaceId: WS, repo: REPO });
    writeFileSync(wsFile('src/a.txt'), 'dos\n');
    for (const branch of ['main', 'master']) {
      await expect(
        service.push({ workspaceId: WS, branch, message: 'x' }),
      ).rejects.toThrow(GithubInvalidInputError);
    }
    await expect(
      service.push({ workspaceId: WS, branch: 'ok', message: '   ' }),
    ).rejects.toThrow(GithubInvalidInputError);
    await expect(
      service.push({ workspaceId: WS, branch: '../mal', message: 'x' }),
    ).rejects.toThrow(GithubInvalidInputError);
    expect(run(bare, 'branch', '--list')).not.toContain('ok');

    rmSync(wsFile('src/a.txt'));
    writeFileSync(wsFile('src/a.txt'), 'uno\n'); // igual al original
    await expect(
      service.push({ workspaceId: WS, branch: 'vacio', message: 'x' }),
    ).rejects.toThrow(GithubConflictError);
  });

  it('push: un archivo que parece secreto frena TODO el push, sin repetir su contenido', async () => {
    const { service } = makeService();
    await service.clone({ workspaceId: WS, repo: REPO });
    const content = ['no', 'subir', String(Math.random())].join('-');
    writeFileSync(wsFile('src/a.txt'), 'dos\n');
    writeFileSync(wsFile('server.key'), content); // no está en .gitignore
    const error = await service
      .push({ workspaceId: WS, branch: 'con-secreto', message: 'x' })
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(GithubInvalidInputError);
    expect((error as Error).message).toContain('server.key');
    expect((error as Error).message).not.toContain(content);
    expect(run(bare, 'branch', '--list')).not.toContain('con-secreto');

    // Un .env SÍ ignorado por .gitignore no estorba ni se sube.
    rmSync(wsFile('server.key'));
    writeFileSync(wsFile('.env'), `K=${content}`);
    const ok = await service.push({
      workspaceId: WS,
      branch: 'sin-secreto',
      message: 'ok',
    });
    expect(ok.files).toBe(1);
    expect(
      run(bare, 'ls-tree', '-r', '--name-only', 'refs/heads/sin-secreto'),
    ).not.toContain('.env');
  });

  it('branches y checkout: lista local/remota, crea una rama y trae una remota en un clon nuevo', async () => {
    const { service } = makeService();
    await service.clone({ workspaceId: WS, repo: REPO });
    writeFileSync(wsFile('src/a.txt'), 'dos\n');
    await service.push({ workspaceId: WS, branch: 'jin/uno', message: 'uno' });

    const info = await service.branches({ workspaceId: WS });
    expect(info.current).toBe('jin/uno');
    expect(info.local).toEqual(expect.arrayContaining(['main', 'jin/uno']));
    expect(info.remote).toEqual(expect.arrayContaining(['main', 'jin/uno']));

    await service.checkout({ workspaceId: WS, branch: 'main' });
    expect(readFileSync(wsFile('src/a.txt'), 'utf8')).toBe('uno\n');
    await expect(
      service.checkout({ workspaceId: WS, branch: 'main', create: true }),
    ).rejects.toThrow(GithubConflictError);
    await service.checkout({
      workspaceId: WS,
      branch: 'trabajo',
      create: true,
    });
    expect((await service.branches({ workspaceId: WS })).current).toBe(
      'trabajo',
    );

    const WS2 = '33333333-3333-4333-8333-333333333333';
    await service.clone({ workspaceId: WS2, repo: REPO });
    const remote = await service.checkout({
      workspaceId: WS2,
      branch: 'jin/uno',
    });
    expect(remote.branch).toBe('jin/uno');
    expect(readFileSync(path.join(disk, WS2, 'src/a.txt'), 'utf8')).toBe(
      'dos\n',
    );
    rmSync(path.join(disk, WS2), { recursive: true, force: true });
  });

  it('pull: trae lo nuevo de origin en avance rápido; si hay choque no toca el workspace', async () => {
    const { service } = makeService();
    await service.clone({ workspaceId: WS, repo: REPO });

    // Alguien sube a main desde otro clon.
    const other = mkdtempSync(path.join(tmpdir(), 'other-'));
    run(other, 'clone', '-q', bare, '.');
    writeFileSync(path.join(other, 'src/a.txt'), 'desde otro\n');
    run(other, 'commit', '-qam', 'otro');
    run(other, 'push', '-q', 'origin', 'main');

    const pulled = await service.pull({ workspaceId: WS });
    expect(pulled.updated).toBe(true);
    expect(readFileSync(wsFile('src/a.txt'), 'utf8')).toBe('desde otro\n');
    expect((await service.pull({ workspaceId: WS })).updated).toBe(false);

    // Cambio local sin commit en el mismo archivo + otro cambio remoto = choque.
    writeFileSync(wsFile('src/a.txt'), 'mi cambio local\n');
    writeFileSync(path.join(other, 'src/a.txt'), 'otro cambio remoto\n');
    run(other, 'commit', '-qam', 'otro 2');
    run(other, 'push', '-q', 'origin', 'main');
    await expect(service.pull({ workspaceId: WS })).rejects.toThrow(
      GithubConflictError,
    );
    expect(readFileSync(wsFile('src/a.txt'), 'utf8')).toBe('mi cambio local\n');
    rmSync(other, { recursive: true, force: true });
  });

  it('una carpeta que no es un repo clonado da un error claro', async () => {
    const { service } = makeService();
    mkdirSync(wsFile('suelta'), { recursive: true });
    writeFileSync(wsFile('suelta/x.txt'), 'x');
    await expect(
      service.status({ workspaceId: WS, dir: 'suelta' }),
    ).rejects.toThrow(/no es un repo/);
  });
});
