import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TerminalSessionService } from './terminal.service';

/** Barrido de TTL de las sesiones de terminal (ADR 0016), cada 5 min como el de previews. */
@Injectable()
export class TerminalReaperService {
  private readonly logger = new Logger(TerminalReaperService.name);

  constructor(private readonly terminal: TerminalSessionService) {}

  @Cron('*/5 * * * *')
  async reapExpired(): Promise<void> {
    const sessions = await this.terminal.list();
    for (const session of sessions.filter(
      (candidate) =>
        candidate.status === 'expired' || candidate.status === 'failed',
    )) {
      this.logger.log(
        `Reaper: cerrando sesión de terminal ${session.id} (${session.status})`,
      );
      await this.terminal.stop(session.id);
    }
  }
}
