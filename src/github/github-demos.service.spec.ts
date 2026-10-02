import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
import type { PreviewServiceLifecycleService } from '../preview-service/preview-service.service';
import { RbacValidatorService } from '../rbac/rbac-validator.service';
import {
  GithubDisabledError,
  GithubGitError,
  GithubInvalidInputError,
  GithubRepoNotAllowedError,
} from './errors';
import type { GithubAppService } from './github-app.service';
import { GithubDemosService } from './github-demos.service';

// Construido en ejecución (no un literal con forma de token).
const TOKEN = `ghs_${'t9'.repeat(15)}`;
const REPO = 'owner/jin-demos';
const SERVICE_ID = '11111111-1111-4111-8111-111111111111';

let root: string; // base de los "remotos": file://<root>/<owner>/<repo>.git
let remote: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeBare(repo: string): string {
  const dir = path.join(root, `${repo}.git`);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', dir]);
  return dir;
}

function makeService(options: {
  files?: Record<string, string>;
  enabled?: boolean;
  allowed?: string;
}) {
  const exportFiles = vi.fn().mockResolvedValue({
    files: options.files ?? { 'index.html': '<h1>hola</h1>', 'js/app.js': 'x' },
    skipped: [{ path: 'logo.png', reason: 'binario' }],
  });
  const installationToken = vi.fn().mockResolvedValue(TOKEN);
  const app = {
    enabled: options.enabled ?? true,
    missing: [],
    installationToken,
  } as unknown as GithubAppService;
  const config = new ConfigService({
    GITHUB_DEMOS_REPO: REPO,
    GITHUB_ALLOWED_REPOS: options.allowed ?? 'owner/proyecto-serio',
    GITHUB_REMOTE_BASE_URL: `file://${root}`,
  });
  const service = new GithubDemosService(
    app,
    { exportFiles } as unknown as PreviewServiceLifecycleService,
    new RbacValidatorService(),
    config,
  );
  return { service, exportFiles, installationToken };
}

describe('GithubDemosService (git real contra remotos bare locales)', () => {
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'jin-github-remotes-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    remote = makeBare(REPO);
  });

  it('guarda una demo nueva como rama demo/<slug> con sus archivos y devuelve el commit', async () => {
    const { service, exportFiles } = makeService({});

    const result = await service.save({
      serviceId: SERVICE_ID,
      slug: 'reservas',
    });

    expect(exportFiles).toHaveBeenCalledWith(SERVICE_ID, '.');
    expect(result).toMatchObject({
      repo: REPO,
      branch: 'demo/reservas',
      slug: 'reservas',
      files: 2,
      unchanged: false,
      url: `https://github.com/${REPO}/tree/demo/reservas`,
    });
    expect(result.skipped).toEqual([{ path: 'logo.png', reason: 'binario' }]);
    expect(git(remote, 'rev-parse', 'refs/heads/demo/reservas')).toBe(
      result.commit,
    );
    expect(git(remote, 'show', 'demo/reservas:index.html')).toBe(
      '<h1>hola</h1>',
    );
    expect(git(remote, 'show', 'demo/reservas:js/app.js')).toBe('x');
    expect(
      git(remote, 'log', '-1', '--format=%an <%ae>', 'demo/reservas'),
    ).toBe('Jin <jin@users.noreply.github.com>');
  });

  it('cada demo es una rama HUÉRFANA: sin ancestro común con las demás (se puede graduar con su historial limpio)', async () => {
    const { service } = makeService({});
    await service.save({ serviceId: SERVICE_ID, slug: 'demo-a' });
    await service.save({ serviceId: SERVICE_ID, slug: 'demo-b' });

    expect(() =>
      git(remote, 'merge-base', 'demo/demo-a', 'demo/demo-b'),
    ).toThrow();
    expect(git(remote, 'rev-list', '--count', 'demo/demo-a')).toBe('1');
    // Y no se creó ninguna otra rama (nunca main).
    expect(
      git(remote, 'for-each-ref', '--format=%(refname)').split('\n').sort(),
    ).toEqual(['refs/heads/demo/demo-a', 'refs/heads/demo/demo-b']);
  });

  it('actualizar una demo existente añade un commit ENCIMA (nunca reescribe la historia)', async () => {
    const first = makeService({ files: { 'index.html': 'v1' } });
    const a = await first.service.save({
      serviceId: SERVICE_ID,
      slug: 'reservas',
    });

    const second = makeService({
      files: { 'index.html': 'v2', 'nuevo.txt': 'n' },
    });
    const b = await second.service.save({
      serviceId: SERVICE_ID,
      slug: 'reservas',
    });

    expect(b.unchanged).toBe(false);
    expect(b.commit).not.toBe(a.commit);
    expect(git(remote, 'rev-list', '--count', 'demo/reservas')).toBe('2');
    expect(git(remote, 'show', 'demo/reservas:index.html')).toBe('v2');
    expect(git(remote, 'show', 'demo/reservas:nuevo.txt')).toBe('n');
    // El commit anterior sigue siendo ancestro (fast-forward).
    expect(git(remote, 'merge-base', '--is-ancestor', a.commit, b.commit)).toBe(
      '',
    );
  });

  it('un archivo que ya no está en la demo se borra en la nueva versión', async () => {
    await makeService({ files: { 'a.txt': '1', 'b.txt': '2' } }).service.save({
      serviceId: SERVICE_ID,
      slug: 'x',
    });
    await makeService({ files: { 'a.txt': '1' } }).service.save({
      serviceId: SERVICE_ID,
      slug: 'x',
    });

    expect(git(remote, 'ls-tree', '--name-only', 'demo/x').split('\n')).toEqual(
      ['a.txt'],
    );
  });

  it('guardar lo mismo otra vez no crea un commit nuevo (unchanged)', async () => {
    const { service } = makeService({});
    const a = await service.save({ serviceId: SERVICE_ID, slug: 'reservas' });
    const b = await service.save({ serviceId: SERVICE_ID, slug: 'reservas' });

    expect(b.unchanged).toBe(true);
    expect(b.commit).toBe(a.commit);
    expect(git(remote, 'rev-list', '--count', 'demo/reservas')).toBe('1');
  });

  it('list() devuelve solo las ramas demo/*, ordenadas, con su commit', async () => {
    const { service } = makeService({});
    const b = await service.save({ serviceId: SERVICE_ID, slug: 'beta' });
    const a = await service.save({ serviceId: SERVICE_ID, slug: 'alfa' });
    // Una rama ajena en el repo no debe aparecer.
    const work = mkdtempSync(path.join(tmpdir(), 'jin-otra-'));
    git(work, 'init', '-q', '-b', 'main');
    git(
      work,
      '-c',
      'user.name=x',
      '-c',
      'user.email=x@x',
      'commit',
      '--allow-empty',
      '-qm',
      'x',
    );
    git(work, 'push', '-q', remote, 'main');
    rmSync(work, { recursive: true, force: true });

    const demos = await service.list();

    expect(demos).toEqual([
      { slug: 'alfa', branch: 'demo/alfa', commit: a.commit },
      { slug: 'beta', branch: 'demo/beta', commit: b.commit },
    ]);
  });

  it('el token se pide para el repo correcto y jamás sale en el resultado', async () => {
    const { service, installationToken } = makeService({});
    const result = await service.save({
      serviceId: SERVICE_ID,
      slug: 'reservas',
    });

    expect(installationToken).toHaveBeenCalledWith(REPO);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('no deja directorios temporales (ni siquiera si git falla)', async () => {
    const before = readdirSync(tmpdir()).filter((n) =>
      n.startsWith('jin-github-'),
    ).length;
    const { service } = makeService({ allowed: 'owner/otro' });
    await service.save({ serviceId: SERVICE_ID, slug: 'ok' });
    // Repo permitido pero que no existe en el remoto: git falla a mitad.
    const missing = makeService({ allowed: 'owner/no-existe' });
    await expect(
      missing.service.save({
        serviceId: SERVICE_ID,
        slug: 'x',
        repo: 'owner/no-existe',
      }),
    ).rejects.toBeInstanceOf(GithubGitError);

    const after = readdirSync(tmpdir()).filter((n) =>
      n.startsWith('jin-github-'),
    ).length;
    expect(after).toBe(before);
  });

  it('un error de git sale sin el token', async () => {
    const { service } = makeService({ allowed: 'owner/no-existe' });
    const error = await service
      .save({ serviceId: SERVICE_ID, slug: 'x', repo: 'owner/no-existe' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GithubGitError);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  describe('defensas', () => {
    it('apagado (sin las claves de la App): GithubDisabledError y no toca nada', async () => {
      const { service, exportFiles } = makeService({ enabled: false });
      await expect(
        service.save({ serviceId: SERVICE_ID, slug: 'x' }),
      ).rejects.toBeInstanceOf(GithubDisabledError);
      await expect(service.list()).rejects.toBeInstanceOf(GithubDisabledError);
      expect(exportFiles).not.toHaveBeenCalled();
    });

    it('un repo fuera de la lista blanca se rechaza ANTES de pedir token o tocar el pod', async () => {
      const { service, installationToken, exportFiles } = makeService({});
      await expect(
        service.save({
          serviceId: SERVICE_ID,
          slug: 'x',
          repo: 'otro/cualquiera',
        }),
      ).rejects.toBeInstanceOf(GithubRepoNotAllowedError);
      expect(installationToken).not.toHaveBeenCalled();
      expect(exportFiles).not.toHaveBeenCalled();
    });

    it('repo con forma rara (path traversal, espacios, URL) se rechaza', async () => {
      const { service } = makeService({ allowed: 'a/b' });
      for (const repo of [
        '../x/y',
        'a/b/c',
        'https://github.com/a/b',
        'a b/c',
        'a/b;rm',
      ]) {
        await expect(
          service.save({ serviceId: SERVICE_ID, slug: 'x', repo }),
        ).rejects.toBeInstanceOf(GithubRepoNotAllowedError);
      }
    });

    it('slug inválido (barras, "..", mayúsculas, espacios, vacío, demasiado largo) se rechaza', async () => {
      const { service } = makeService({});
      for (const slug of [
        '../main',
        'a/b',
        'Mayus',
        'a b',
        '',
        '-x',
        'x-',
        'a'.repeat(70),
      ]) {
        await expect(
          service.save({ serviceId: SERVICE_ID, slug }),
        ).rejects.toBeInstanceOf(GithubInvalidInputError);
      }
    });

    it('"main" como slug termina en demo/main: jamás en la rama main', async () => {
      const { service } = makeService({});
      const result = await service.save({
        serviceId: SERVICE_ID,
        slug: 'main',
      });
      expect(result.branch).toBe('demo/main');
      expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe(
        'refs/heads/demo/main',
      );
    });

    it('rechaza demos vacías, con demasiados archivos, demasiado grandes o con rutas inseguras', async () => {
      const save = (files: Record<string, string>) =>
        makeService({ files }).service.save({
          serviceId: SERVICE_ID,
          slug: 'x',
        });

      await expect(save({})).rejects.toBeInstanceOf(GithubInvalidInputError);
      await expect(
        save(
          Object.fromEntries(
            Array.from({ length: 51 }, (_, i) => [`f${i}.txt`, 'x']),
          ),
        ),
      ).rejects.toBeInstanceOf(GithubInvalidInputError);
      await expect(
        save({ 'grande.txt': 'x'.repeat(300 * 1024) }),
      ).rejects.toBeInstanceOf(GithubInvalidInputError);
      await expect(save({ '../fuera.txt': 'x' })).rejects.toBeInstanceOf(
        GithubInvalidInputError,
      );
      await expect(save({ '/etc/passwd': 'x' })).rejects.toBeInstanceOf(
        GithubInvalidInputError,
      );
      // Nada de eso llegó al remoto.
      expect(git(remote, 'for-each-ref')).toBe('');
    });
  });
});
