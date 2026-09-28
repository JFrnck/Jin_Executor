import {
  All,
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  ExecTerminalRequestSchema,
  ExportTerminalQuerySchema,
  ExposeTerminalRequestSchema,
  ImportTerminalRequestSchema,
  StartServiceRequestSchema,
  parsePort,
  type StartServiceRequest,
  StartTerminalRequestSchema,
  type ExecTerminalRequest,
  type ExportTerminalQuery,
  type ExposeTerminalRequest,
  type ImportTerminalRequest,
  type StartTerminalRequest,
} from './terminal-request.schema';
import { TerminalSessionService } from './terminal.service';
import type {
  TerminalServiceInfo,
  TerminalServiceStart,
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

  // ── Servidores en segundo plano y vista previa ───────────────────────

  @Post(':id/services')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Lanza un servidor en segundo plano dentro de la sesión y espera a que el puerto responda',
  })
  async startService(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(StartServiceRequestSchema))
    body: StartServiceRequest,
  ): Promise<TerminalServiceStart> {
    return this.terminal.startService(id, body);
  }

  @Get(':id/services')
  @ApiOperation({ summary: 'Servidores en segundo plano de la sesión' })
  async listServices(@Param('id') id: string): Promise<TerminalServiceInfo[]> {
    return this.terminal.listServices(id);
  }

  @Delete(':id/services/:port')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Detiene un servidor en segundo plano (mata su grupo de procesos)',
  })
  async stopService(
    @Param('id') id: string,
    @Param('port') rawPort: string,
  ): Promise<void> {
    await this.terminal.stopService(id, this.portOrFail(rawPort));
  }

  @Get(':id/services/:port/logs')
  @ApiOperation({ summary: 'Últimas líneas de la salida de un servidor' })
  async serviceLogs(
    @Param('id') id: string,
    @Param('port') rawPort: string,
  ): Promise<{ log: string }> {
    return {
      log: await this.terminal.serviceLogs(id, this.portOrFail(rawPort)),
    };
  }

  /**
   * Reenvía la petición al puerto de un servidor de la sesión (vista previa en
   * vivo). Solo lo llama Jin_Core, con el JWT del owner ya verificado.
   */
  @All([':id/proxy/:port', ':id/proxy/:port/*rest'])
  @ApiOperation({
    summary: 'Proxy HTTP a un puerto de un servidor de la sesión',
  })
  async proxy(
    @Param('id') id: string,
    @Param('port') rawPort: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const port = this.portOrFail(rawPort);
    const prefix = `/terminal/sessions/${encodeURIComponent(id)}/proxy/${rawPort}`;
    const rest = req.originalUrl.startsWith(prefix)
      ? req.originalUrl.slice(prefix.length)
      : '';
    const path = rest === '' || rest.startsWith('?') ? `/${rest}` : rest;

    const upstream = await this.terminal.proxy(id, port, {
      method: req.method,
      path,
      headers: forwardedRequestHeaders(req, port),
      body: await requestBody(req),
    });

    res.status(upstream.status);
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value !== undefined && RESPONSE_HEADERS.has(name.toLowerCase())) {
        res.setHeader(name, value);
      }
    }
    upstream.body.on('error', () => res.destroy());
    res.on('close', () => upstream.body.destroy());
    upstream.body.pipe(res);
  }

  private portOrFail(raw: string): number {
    const port = parsePort(raw);
    if (port === null)
      throw new BadRequestException('Puerto no válido (1024–65535).');
    return port;
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

/** Cabeceras que se reenvían al servidor: el resto (cookies, autorización, host) no. */
const REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'range',
  'user-agent',
];
/** Cabeceras de la respuesta que se devuelven. Sin `set-cookie`, sin las de conexión. */
const RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'location',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'x-content-type-options',
]);
/** Tope del cuerpo de una petición reenviada. */
const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;

function forwardedRequestHeaders(
  req: Request,
  port: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    // El servidor de desarrollo ve una petición local: Vite rechaza otros `Host`.
    host: `localhost:${port}`,
    // Sin compresión: el cliente recibe el cuerpo tal cual.
    'accept-encoding': 'identity',
  };
  for (const name of REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}

/** Cuerpo de la petición: el JSON que Nest ya leyó, o el stream crudo (con tope). */
async function requestBody(req: Request): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  if (
    req.body !== undefined &&
    req.body !== null &&
    typeof req.body === 'object' &&
    Object.keys(req.body as object).length > 0
  ) {
    return Buffer.from(JSON.stringify(req.body));
  }
  if (req.readableEnded || req.complete === false) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_PROXY_BODY_BYTES)
      throw new BadRequestException('Cuerpo demasiado grande.');
    chunks.push(buffer);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}
