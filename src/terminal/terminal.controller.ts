import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  ExecTerminalRequestSchema,
  ExportTerminalQuerySchema,
  ExposeTerminalRequestSchema,
  ImportTerminalRequestSchema,
  StartTerminalRequestSchema,
  type ExecTerminalRequest,
  type ExportTerminalQuery,
  type ExposeTerminalRequest,
  type ImportTerminalRequest,
  type StartTerminalRequest,
} from './terminal-request.schema';
import { TerminalSessionService } from './terminal.service';
import type {
  TerminalExportResult,
  TerminalExposure,
  TerminalSessionInfo,
  TerminalStreamEvent,
} from './terminal.types';

/** ADR 0016. Solo lo llama Jin_Core (`allow-from-jin`): nunca el modelo ni el owner directo. */
@ApiTags('terminal')
@Controller('terminal/sessions')
export class TerminalController {
  constructor(private readonly terminal: TerminalSessionService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Abre una sesión de terminal aislada (ADR 0016)' })
  async start(
    @Body(new ZodValidationPipe(StartTerminalRequestSchema))
    body: StartTerminalRequest,
  ): Promise<TerminalSessionInfo> {
    return this.terminal.start(body);
  }

  @Get()
  @ApiOperation({ summary: 'Sesiones de terminal activas' })
  async list(): Promise<TerminalSessionInfo[]> {
    return this.terminal.list();
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cierra una sesión y destruye su pod' })
  async stop(@Param('id') id: string): Promise<void> {
    await this.terminal.stop(id);
  }

  /**
   * Corre un comando y devuelve la salida como NDJSON (`application/x-ndjson`):
   * una línea JSON por evento (`out`, `err`) y una final (`exit` o `error`).
   */
  @Post(':id/exec')
  @ApiOperation({
    summary: 'Ejecuta un comando en la sesión (salida en streaming NDJSON)',
  })
  async exec(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ExecTerminalRequestSchema))
    body: ExecTerminalRequest,
    @Res() res: Response,
  ): Promise<void> {
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    let started = false;
    const emit = (event: TerminalStreamEvent): void => {
      if (!started) {
        started = true;
        res.status(200);
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
      }
      res.write(`${JSON.stringify(event)}\n`);
    };

    // Los errores anteriores al primer byte (404, 409, 400) salen como HTTP
    // normal por el filtro global; la excepción se relanza mientras no haya
    // empezado el stream.
    try {
      await this.terminal.exec(id, body, emit, controller.signal);
    } catch (error) {
      if (started) {
        emit({
          t: 'error',
          message: error instanceof Error ? error.message : 'Falló el comando.',
        });
      } else {
        throw error;
      }
    }
    if (!started) {
      emit({ t: 'error', message: 'El comando no produjo resultado.' });
    }
    res.end();
  }

  @Get(':id/files')
  @ApiOperation({
    summary:
      'Archivos de texto del espacio de trabajo (para traerlos al editor)',
  })
  async exportFiles(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(ExportTerminalQuerySchema))
    query: ExportTerminalQuery,
  ): Promise<TerminalExportResult> {
    return this.terminal.exportFiles(id, query.dir);
  }

  @Put(':id/files')
  @ApiOperation({ summary: 'Copia archivos del editor al espacio de trabajo' })
  async importFiles(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ImportTerminalRequestSchema))
    body: ImportTerminalRequest,
  ): Promise<{ written: number }> {
    return this.terminal.importFiles(id, body.files);
  }

  @Post(':id/expose')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Publica un directorio de la sesión bajo https://<slug>.jinserver.com',
  })
  async expose(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ExposeTerminalRequestSchema))
    body: ExposeTerminalRequest,
  ): Promise<TerminalExposure> {
    return this.terminal.expose(id, body);
  }
}
