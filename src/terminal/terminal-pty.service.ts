import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TERMINAL_CONTAINER_NAME } from '../k8s/labels';
import { K8sService, type PodPty } from '../k8s/k8s.service';
import { TerminalPtyExistsError, TerminalPtyNotFoundError } from './errors';
import { PTY_MAX_INPUT_BYTES } from './terminal-request.schema';
import { TerminalWorkspaceService } from './terminal.service';

/**
 * Evento del stream de salida de una terminal interactiva. `d` va en base64:
 * un chunk puede cortar un carácter UTF-8 a la mitad, y la app (el emulador) es
 * quien reensambla los bytes.
 */
export type PtyStreamEvent =
  | { readonly t: 'out'; readonly d: string }
  | { readonly t: 'exit'; readonly code: number }
  | { readonly t: 'error'; readonly message: string };

/** Devuelve `false` si quien consume no da abasto: la sesión se cierra en vez de acumular memoria. */
export type PtyListener = (event: PtyStreamEvent) => boolean;

/** Shell interactivo en el espacio de trabajo. Sin `-l`: no hay perfil de login en la imagen. */
const PTY_COMMAND = [
  'sh',
  '-c',
  'cd "${JIN_WORKSPACE:-/workspace}" && export TERM=xterm-256color && exec sh',
] as const;

/** Salida que se guarda mientras nadie está suscrito (entre abrir y suscribirse, o en una reconexión). */
const MAX_BACKLOG_BYTES = 256 * 1024;
/** Una sesión que terminó se conserva un momento para que el suscriptor reciba el `exit`. */
const ENDED_LINGER_MS = 30_000;
const IDLE_CHECK_INTERVAL_MS = 30_000;

interface PtySession {
  readonly id: string;
  readonly workspaceId: string;
  readonly pty: PodPty;
  lastActivity: number;
  listener: PtyListener | null;
  backlog: Buffer[];
  backlogBytes: number;
  ended: PtyStreamEvent | null;
  closing: boolean;
  idleTimer: NodeJS.Timeout | null;
  lingerTimer: NodeJS.Timeout | null;
}

/**
 * Terminal interactiva (PTY) de un workspace (ADR 0016 ampliada). El Executor
 * SOLO transporta bytes entre el TTY del pod y Jin_Core: no interpreta ni audita
 * lo que se teclea — eso es de Core, que es quien tiene el audit.
 *
 * Una sesión por workspace. Vive en memoria: si el Executor se reinicia, el pod
 * sigue pero el shell se pierde (el owner abre otra; el disco no se toca).
 */
@Injectable()
export class TerminalPtyService implements OnModuleDestroy {
  private readonly logger = new Logger(TerminalPtyService.name);
  private readonly sessions = new Map<string, PtySession>();
  private readonly byWorkspace = new Map<string, string>();
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly terminal: TerminalWorkspaceService,
    private readonly k8s: K8sService,
    configService: ConfigService,
  ) {
    this.idleTimeoutMs =
      configService.get<number>('TERMINAL_PTY_IDLE_SECONDS', 15 * 60) * 1000;
  }

  async open(
    workspaceId: string,
    size: { readonly cols: number; readonly rows: number },
  ): Promise<{ ptyId: string }> {
    if (this.byWorkspace.has(workspaceId)) {
      throw new TerminalPtyExistsError(workspaceId);
    }
    // Reservar ANTES de cualquier `await`: dos aperturas casi a la vez no deben
    // pasar las dos (Node solo intercala en los `await`).
    const ptyId = randomUUID();
    this.byWorkspace.set(workspaceId, ptyId);

    let session: PtySession | undefined;
    try {
      const podName = await this.terminal.requirePodForPty(workspaceId);
      const pty = await this.k8s.openPty(podName, {
        container: TERMINAL_CONTAINER_NAME,
        command: PTY_COMMAND,
        cols: size.cols,
        rows: size.rows,
        onData: (chunk) => {
          if (session) this.handleData(session, chunk);
        },
      });
      session = {
        id: ptyId,
        workspaceId,
        pty,
        lastActivity: Date.now(),
        listener: null,
        backlog: [],
        backlogBytes: 0,
        ended: null,
        closing: false,
        idleTimer: null,
        lingerTimer: null,
      };
    } catch (error) {
      this.byWorkspace.delete(workspaceId);
      throw error;
    }

    const opened = session;
    this.sessions.set(ptyId, opened);
    opened.idleTimer = setInterval(
      () => this.checkIdle(opened),
      IDLE_CHECK_INTERVAL_MS,
    );
    opened.idleTimer.unref();
    void opened.pty.exitCode.then(
      (code) => this.finish(opened, { t: 'exit', code }),
      (error: unknown) =>
        this.finish(
          opened,
          opened.closing
            ? { t: 'exit', code: -1 }
            : {
                t: 'error',
                message:
                  error instanceof Error
                    ? error.message
                    : 'Se perdió la conexión con el pod.',
              },
        ),
    );
    void this.terminal.notePtyActivity(workspaceId);
    return { ptyId };
  }

  /**
   * Suscribe a la salida. Entrega primero lo acumulado. Resuelve cuando la
   * sesión termina o `signal` se aborta (Core se fue: la sesión sigue viva y
   * puede volver a suscribirse). Un solo suscriptor: el nuevo reemplaza al viejo.
   */
  async subscribe(
    workspaceId: string,
    ptyId: string,
    listener: PtyListener,
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.require(workspaceId, ptyId);
    session.listener = listener;

    const pending = session.backlog;
    session.backlog = [];
    session.backlogBytes = 0;
    for (const chunk of pending) {
      if (!this.deliver(session, { t: 'out', d: chunk.toString('base64') })) {
        return;
      }
    }
    if (session.ended) {
      listener(session.ended);
      return;
    }

    await new Promise<void>((resolve) => {
      const release = (): void => {
        if (session.listener === wrapped) session.listener = null;
        resolve();
      };
      const wrapped: PtyListener = (event) => {
        const ok = listener(event);
        if (event.t !== 'out' || !ok) release();
        return ok;
      };
      session.listener = wrapped;
      signal.addEventListener('abort', release, { once: true });
      if (signal.aborted) release();
    });
  }

  write(workspaceId: string, ptyId: string, data: Buffer): void {
    if (data.length === 0 || data.length > PTY_MAX_INPUT_BYTES) return;
    const session = this.require(workspaceId, ptyId);
    if (session.ended) throw new TerminalPtyNotFoundError(ptyId);
    this.touch(session);
    session.pty.write(data);
  }

  resize(
    workspaceId: string,
    ptyId: string,
    size: { readonly cols: number; readonly rows: number },
  ): void {
    const session = this.require(workspaceId, ptyId);
    if (session.ended) throw new TerminalPtyNotFoundError(ptyId);
    session.pty.resize(size.cols, size.rows);
  }

  close(workspaceId: string, ptyId: string): void {
    const session = this.require(workspaceId, ptyId);
    this.terminate(session);
  }

  onModuleDestroy(): void {
    for (const session of this.sessions.values()) this.terminate(session);
  }

  // ── internos ───────────────────────────────────────────────────────────

  private require(workspaceId: string, ptyId: string): PtySession {
    const session = this.sessions.get(ptyId);
    // El id de sesión solo sirve dentro del workspace que la abrió.
    if (!session || session.workspaceId !== workspaceId) {
      throw new TerminalPtyNotFoundError(ptyId);
    }
    return session;
  }

  private handleData(session: PtySession, chunk: Buffer): void {
    if (session.ended) return;
    this.touch(session);
    if (session.listener) {
      this.deliver(session, { t: 'out', d: chunk.toString('base64') });
      return;
    }
    session.backlog.push(chunk);
    session.backlogBytes += chunk.length;
    while (
      session.backlogBytes > MAX_BACKLOG_BYTES &&
      session.backlog.length > 1
    ) {
      session.backlogBytes -= session.backlog.shift()?.length ?? 0;
    }
  }

  private deliver(session: PtySession, event: PtyStreamEvent): boolean {
    const ok = session.listener?.(event) ?? true;
    if (!ok) {
      this.logger.warn(
        `Terminal ${session.id}: el consumidor no da abasto, se cierra la sesión.`,
      );
      this.terminate(session);
    }
    return ok;
  }

  private finish(session: PtySession, event: PtyStreamEvent): void {
    if (session.ended) return;
    session.ended = event;
    if (session.idleTimer) clearInterval(session.idleTimer);
    session.idleTimer = null;
    session.listener?.(event);
    this.byWorkspace.delete(session.workspaceId);
    // Deja de ser "la sesión del workspace" al instante, pero se conserva un
    // momento para que un suscriptor tardío reciba el `exit`.
    session.lingerTimer = setTimeout(
      () => this.sessions.delete(session.id),
      ENDED_LINGER_MS,
    );
    session.lingerTimer.unref();
  }

  private terminate(session: PtySession): void {
    if (session.ended) return;
    session.closing = true;
    session.pty.close();
    this.finish(session, { t: 'exit', code: -1 });
  }

  private touch(session: PtySession): void {
    session.lastActivity = Date.now();
    void this.terminal.notePtyActivity(session.workspaceId);
  }

  private checkIdle(session: PtySession): void {
    if (Date.now() - session.lastActivity < this.idleTimeoutMs) return;
    this.logger.log(
      `Terminal ${session.id} (${session.workspaceId}): cerrada por inactividad.`,
    );
    this.terminate(session);
  }
}
