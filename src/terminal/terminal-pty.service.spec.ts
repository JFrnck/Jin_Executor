import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { K8sService, PodPty, PodPtyOptions } from '../k8s/k8s.service';
import { TerminalPtyExistsError, TerminalPtyNotFoundError } from './errors';
import {
  TerminalPtyService,
  type PtyStreamEvent,
} from './terminal-pty.service';
import type { TerminalWorkspaceService } from './terminal.service';

// Armado en tiempo de ejecución: un literal con la forma de un token de Anthropic
// lo marcan los escáneres de secretos aunque sea de mentira.
const FAKE_TOKEN = ['sk', 'ant', 'oat01', 'ejemplo'].join('-');
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222';
const SIZE = { cols: 80, rows: 24 };

interface FakePty extends PodPty {
  emit(text: string): void;
  finish(code: number): void;
  fail(message: string): void;
  readonly written: Buffer[];
  readonly sizes: { cols: number; rows: number }[];
  closed: boolean;
}

function fakePty(options: PodPtyOptions): FakePty {
  let resolveExit!: (code: number) => void;
  let rejectExit!: (error: Error) => void;
  const exitCode = new Promise<number>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  exitCode.catch(() => undefined);
  const pty: FakePty = {
    exitCode,
    written: [],
    sizes: [],
    closed: false,
    write: (data) => {
      pty.written.push(data);
    },
    resize: (cols, rows) => {
      pty.sizes.push({ cols, rows });
    },
    close: () => {
      pty.closed = true;
    },
    emit: (text) => options.onData(Buffer.from(text)),
    finish: (code) => resolveExit(code),
    fail: (message) => rejectExit(new Error(message)),
  };
  return pty;
}

/** `null`: la config no define el valor y rige el que trae el servicio por defecto. */
function setup(idleSeconds: number | null = 900) {
  const ptys: FakePty[] = [];
  const openPty = vi.fn((_pod: string, options: PodPtyOptions) => {
    const pty = fakePty(options);
    ptys.push(pty);
    return Promise.resolve(pty);
  });
  const k8s = { openPty } as unknown as K8sService;
  const requirePod = vi.fn((id: string) => Promise.resolve(`pod-${id}`));
  const noteActivity = vi.fn(() => Promise.resolve());
  const terminal = {
    requirePodForPty: requirePod,
    notePtyActivity: noteActivity,
  } as unknown as TerminalWorkspaceService;
  const config = {
    get: (_key: string, fallback: number) => idleSeconds ?? fallback,
  } as unknown as ConfigService;
  const service = new TerminalPtyService(terminal, k8s, config);
  return { service, ptys, openPty, requirePod, noteActivity };
}

function collect(): {
  events: PtyStreamEvent[];
  listener: (e: PtyStreamEvent) => boolean;
} {
  const events: PtyStreamEvent[] = [];
  return {
    events,
    listener: (event) => {
      events.push(event);
      return true;
    },
  };
}

const b64 = (text: string): string => Buffer.from(text).toString('base64');
const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe('TerminalPtyService (ADR 0016 ampliada, terminal interactiva)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('abre con el pod del workspace, el tamaño pedido y el shell en /workspace', async () => {
    const { service, openPty, requirePod } = setup();
    const { ptyId } = await service.open(WORKSPACE, SIZE);

    expect(ptyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(requirePod.mock.calls[0]?.[0]).toBe(WORKSPACE);
    const [pod, options] = openPty.mock.calls[0] as [string, PodPtyOptions];
    expect(pod).toBe(`pod-${WORKSPACE}`);
    expect(options).toMatchObject({ cols: 80, rows: 24 });
    expect(options.command.join(' ')).toContain(
      'cd "${JIN_WORKSPACE:-/workspace}"',
    );
    expect(options.command.join(' ')).toContain('TERM=xterm-256color');
  });

  it('el arranque del shell de verdad: con el archivo exporta el token (sin el salto de línea final); sin el archivo, nada', async () => {
    const { service, openPty } = setup();
    await service.open(WORKSPACE, SIZE);
    const [, options] = openPty.mock.calls[0] as [string, PodPtyOptions];
    // Se corre el MISMO texto, cambiando solo el `exec sh` final por algo que imprima.
    const script = (options.command[2] ?? '').replace(
      'exec sh',
      'printf "%s" "[$CLAUDE_CODE_OAUTH_TOKEN]"',
    );
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'jin-pty-home-')));
    const run = () =>
      spawnSync('sh', ['-c', script], {
        env: { PATH: process.env.PATH, HOME: home, JIN_WORKSPACE: home },
      });

    expect(run().stdout.toString()).toBe('[]');
    writeFileSync(join(home, '.claude-token'), `${FAKE_TOKEN}\n`);
    expect(run().stdout.toString()).toBe(`[${FAKE_TOKEN}]`);
  });

  it('exporta el token de Claude Code desde el disco si el owner lo guardó (no se teclea: no pasa por el audit)', async () => {
    const { service, openPty } = setup();
    await service.open(WORKSPACE, SIZE);
    const [, options] = openPty.mock.calls[0] as [string, PodPtyOptions];
    const script = options.command.join(' ');
    expect(script).toContain('[ -f "$HOME/.claude-token" ]');
    expect(script).toContain(
      'CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/.claude-token")"',
    );
    expect(script).toContain('export CLAUDE_CODE_OAUTH_TOKEN');
    // El shell interactivo se abre DESPUÉS de leer el token.
    expect(script.indexOf('export CLAUDE_CODE_OAUTH_TOKEN')).toBeLessThan(
      script.indexOf('exec sh'),
    );
  });

  it('una sola terminal por workspace; otro workspace no se ve afectado', async () => {
    const { service } = setup();
    await service.open(WORKSPACE, SIZE);
    await expect(service.open(WORKSPACE, SIZE)).rejects.toBeInstanceOf(
      TerminalPtyExistsError,
    );
    await expect(service.open(OTHER_WORKSPACE, SIZE)).resolves.toBeDefined();
  });

  it('dos aperturas casi simultáneas: solo pasa una', async () => {
    const { service } = setup();
    const results = await Promise.allSettled([
      service.open(WORKSPACE, SIZE),
      service.open(WORKSPACE, SIZE),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('si el exec falla al abrir, el workspace queda libre para reintentar', async () => {
    const { service, openPty } = setup();
    openPty.mockRejectedValueOnce(new Error('403 forbidden'));
    await expect(service.open(WORKSPACE, SIZE)).rejects.toThrow('403');
    await expect(service.open(WORKSPACE, SIZE)).resolves.toBeDefined();
  });

  it('la salida anterior a suscribirse se conserva y llega en orden', async () => {
    const { service, ptys } = setup();
    const { ptyId } = await service.open(WORKSPACE, SIZE);
    ptys[0]?.emit('hola ');
    ptys[0]?.emit('mundo');

    const { events, listener } = collect();
    const controller = new AbortController();
    const done = service.subscribe(
      WORKSPACE,
      ptyId,
      listener,
      controller.signal,
    );
    await tick();

    expect(events).toEqual([
      { t: 'out', d: b64('hola ') },
      { t: 'out', d: b64('mundo') },
    ]);

    ptys[0]?.emit('!');
    expect(events.at(-1)).toEqual({ t: 'out', d: b64('!') });
    controller.abort();
    await done;
  });

  it('el exit termina la suscripción y llega como última línea', async () => {
    const { service, ptys } = setup();
    const { ptyId } = await service.open(WORKSPACE, SIZE);
    const { events, listener } = collect();
    const done = service.subscribe(
      WORKSPACE,
      ptyId,
      listener,
      new AbortController().signal,
    );
    await tick();

    ptys[0]?.finish(0);
    await done;
    expect(events.at(-1)).toEqual({ t: 'exit', code: 0 });
  });

  it('la conexión al pod que se cae sin exit llega como error, no como exit', async () => {
    const { service, ptys } = setup();
    const { ptyId } = await service.open(WORKSPACE, SIZE);
    const { events, listener } = collect();
    const done = service.subscribe(
      WORKSPACE,
      ptyId,
      listener,
      new AbortController().signal,
    );
    await tick();

    ptys[0]?.fail('conexión cerrada');
    await done;
    expect(events.at(-1)).toEqual({ t: 'error', message: 'conexión cerrada' });
  });

  it('si Core se desconecta, la sesión sigue viva y se puede volver a suscribir sin perder salida', async () => {
    const { service, ptys } = setup();
    const { ptyId } = await service.open(WORKSPACE, SIZE);

    const first = collect();
    const controller = new AbortController();
    const firstDone = service.subscribe(
      WORKSPACE,
      ptyId,
      first.listener,
      controller.signal,
    );
    await tick();
    controller.abort();
    await firstDone;

    ptys[0]?.emit('mientras no estabas');

    const second = collect();
    const secondController = new AbortController();
    const secondDone = service.subscribe(
      WORKSPACE,
      ptyId,
      second.listener,
      secondController.signal,
    );
    await tick();
    expect(second.events).toEqual([
      { t: 'out', d: b64('mientras no estabas') },
    ]);
    secondController.abort();
    await secondDone;
  });

  it('el backlog sin suscriptor tiene tope: conserva lo más reciente', async () => {
    const { service, ptys } = setup();
    const { ptyId } = await service.open(WORKSPACE, SIZE);
    const chunk = 'x'.repeat(100 * 1024);
    for (let i = 0; i < 6; i += 1) ptys[0]?.emit(`${i}${chunk}`);

    const { events, listener } = collect();
    const controller = new AbortController();
    const done = service.subscribe(
      WORKSPACE,
      ptyId,
      listener,
      controller.signal,
    );
    await tick();
    controller.abort();
    await done;

    const total = events.reduce(
      (sum, e) => sum + (e.t === 'out' ? Buffer.from(e.d, 'base64').length : 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(256 * 1024 + 100 * 1024);
    const last = events.at(-1);
    expect(
      last?.t === 'out' &&
        Buffer.from(last.d, 'base64').toString().startsWith('5'),
    ).toBe(true);
  });

  it('write y resize llegan al pod; un id de otro workspace no sirve', async () => {
    const { service, ptys } = setup();
    const { ptyId } = await service.open(WORKSPACE, SIZE);

    service.write(WORKSPACE, ptyId, Buffer.from('ls\r'));
    service.resize(WORKSPACE, ptyId, { cols: 100, rows: 30 });
    expect(ptys[0]?.written.map(String)).toEqual(['ls\r']);
    expect(ptys[0]?.sizes).toEqual([{ cols: 100, rows: 30 }]);

    expect(() =>
      service.write(OTHER_WORKSPACE, ptyId, Buffer.from('x')),
    ).toThrow(TerminalPtyNotFoundError);
    expect(() =>
      service.write(WORKSPACE, 'no-existe', Buffer.from('x')),
    ).toThrow(TerminalPtyNotFoundError);
  });

  it('write con más bytes que el tope se descarta sin tocar el pod', async () => {
    const { service, ptys } = setup();
    const { ptyId } = await service.open(WORKSPACE, SIZE);
    service.write(WORKSPACE, ptyId, Buffer.alloc(64 * 1024 + 1, 1));
    expect(ptys[0]?.written).toEqual([]);
  });

  it('close cierra el TTY, avisa exit y libera el workspace', async () => {
    const { service, ptys } = setup();
    const { ptyId } = await service.open(WORKSPACE, SIZE);
    const { events, listener } = collect();
    const done = service.subscribe(
      WORKSPACE,
      ptyId,
      listener,
      new AbortController().signal,
    );
    await tick();

    service.close(WORKSPACE, ptyId);
    await done;
    expect(ptys[0]?.closed).toBe(true);
    expect(events.at(-1)).toEqual({ t: 'exit', code: -1 });
    await expect(service.open(WORKSPACE, SIZE)).resolves.toBeDefined();
  });

  it('un consumidor que no da abasto cierra la sesión en vez de acumular memoria', async () => {
    const { service, ptys } = setup();
    const { ptyId } = await service.open(WORKSPACE, SIZE);
    const done = service.subscribe(
      WORKSPACE,
      ptyId,
      () => false,
      new AbortController().signal,
    );
    await tick();

    ptys[0]?.emit('mucha salida');
    await done;
    expect(ptys[0]?.closed).toBe(true);
  });

  it('se cierra sola tras el tiempo sin actividad, y la actividad lo posterga', async () => {
    vi.useFakeTimers();
    const { service, ptys } = setup(60);
    const { ptyId } = await service.open(WORKSPACE, SIZE);

    await vi.advanceTimersByTimeAsync(45_000);
    service.write(WORKSPACE, ptyId, Buffer.from('a'));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(ptys[0]?.closed).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(ptys[0]?.closed).toBe(true);
  });

  it('una sesión abierta pero callada sigue siendo actividad del pod: se anota mientras dure (el reaper no libera el pod con la sesión adentro)', async () => {
    vi.useFakeTimers();
    const { service, ptys, noteActivity } = setup(4 * 60 * 60);
    await service.open(WORKSPACE, SIZE);
    const before = noteActivity.mock.calls.length;

    // 45 minutos sin una sola tecla ni una sola línea de salida.
    await vi.advanceTimersByTimeAsync(45 * 60_000);

    expect(ptys[0]?.closed).toBe(false);
    expect(noteActivity.mock.calls.length).toBeGreaterThan(before + 50);
  });

  it('el tope de inactividad por defecto es el del TTL máximo del pod (4 h), no 15 min', async () => {
    vi.useFakeTimers();
    const { service, ptys } = setup(null);
    await service.open(WORKSPACE, SIZE);

    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(ptys[0]?.closed).toBe(false);

    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(ptys[0]?.closed).toBe(true);
  });

  it('anota actividad en el pod al teclear y al recibir salida (el reaper no lo libera mientras se usa)', async () => {
    const { service, ptys, noteActivity } = setup();
    const { ptyId } = await service.open(WORKSPACE, SIZE);
    const before = noteActivity.mock.calls.length;
    service.write(WORKSPACE, ptyId, Buffer.from('a'));
    ptys[0]?.emit('b');
    expect(noteActivity.mock.calls.length).toBe(before + 2);
  });
});
