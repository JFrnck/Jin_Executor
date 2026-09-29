import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { TerminalWorkspaceService } from './terminal.service';

/**
 * Barrido de los pods de terminal (ADR 0016 ampliada), cada 5 min como el de
 * previews. Libera un pod (nunca el disco) en dos casos: venció su TTL duro,
 * o pasó `TERMINAL_IDLE_TIMEOUT_SECONDS` sin un comando/servicio/petición.
 * El disco queda intacto: la próxima vez que el owner lo abra, retoma donde
 * lo dejó.
 */
@Injectable()
export class TerminalReaperService {
  private readonly logger = new Logger(TerminalReaperService.name);
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly terminal: TerminalWorkspaceService,
    configService: ConfigService,
  ) {
    this.idleTimeoutMs =
      configService.get<number>('TERMINAL_IDLE_TIMEOUT_SECONDS', 30 * 60) *
      1000;
  }

  @Cron('*/5 * * * *')
  async reapExpired(): Promise<void> {
    const workspaces = await this.terminal.list();
    const now = Date.now();

    for (const workspace of workspaces) {
      if (workspace.status === 'expired' || workspace.status === 'failed') {
        this.logger.log(
          `Reaper: deteniendo terminal ${workspace.id} (${workspace.status}); el disco se conserva`,
        );
        await this.terminal.stopPod(workspace.id);
        continue;
      }
      if (workspace.status === 'running' && workspace.lastActivityAt) {
        const idleMs = now - new Date(workspace.lastActivityAt).getTime();
        if (idleMs > this.idleTimeoutMs) {
          this.logger.log(
            `Reaper: deteniendo terminal ${workspace.id} por inactividad (${Math.round(idleMs / 60_000)} min); el disco se conserva`,
          );
          await this.terminal.stopPod(workspace.id);
        }
      }
    }
  }
}
