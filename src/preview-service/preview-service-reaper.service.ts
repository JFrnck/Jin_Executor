import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PreviewServiceLifecycleService } from './preview-service.service';

/**
 * Barrido de TTL (Fase 5.5, ADR 0006) — mismo intervalo que
 * `KillSwitchService.checkRunaway()` en Jin_Core (cada 5 min). `list()`
 * ya deriva `status: 'expired'` comparando la annotation de TTL contra
 * `now` — el reaper no reimplementa esa comparación, solo actúa sobre
 * el resultado.
 */
@Injectable()
export class PreviewServiceReaperService {
  private readonly logger = new Logger(PreviewServiceReaperService.name);

  constructor(
    private readonly previewService: PreviewServiceLifecycleService,
  ) {}

  @Cron('*/5 * * * *')
  async reapExpired(): Promise<void> {
    const services = await this.previewService.list();
    const expired = services.filter((service) => service.status === 'expired');

    for (const service of expired) {
      this.logger.log(
        `Reaper: destruyendo servicio vencido ${service.id} (slug: ${service.slug})`,
      );
      await this.previewService.stop(service.id);
    }
  }
}
