import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModalClient, NotFoundError, type App, type Image } from 'modal';
import type { ExecutionResult } from '../execute/execution-result';
import type { ExecutorToolDefinition } from '../rbac/tool-whitelist';
import { ModalExecutionError } from './errors';

const MODAL_APP_NAME = 'yormun-executor';
const DATA_SCIENCE_IMAGE_NAME = 'yormun-data-science';

async function readAllText(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let text = '';
  for (;;) {
    // Lectura secuencial de un único stream — no hay nada que paralelizar acá.
    const { done, value } = await reader.read();
    if (done) break;
    text += value;
  }
  return text;
}

/**
 * Cliente real de Modal (BLUEPRINT 4.5, Fase 5.2) para `remote: true` —
 * reemplaza el stub `ModalNotImplementedError` de Fase 2.3. Target: código
 * Python con dependencias científicas (pandas/numpy) que el tier local
 * (Deno, BLUEPRINT 4.4) no puede correr en absoluto.
 */
@Injectable()
export class ModalService {
  private readonly logger = new Logger(ModalService.name);
  private readonly client: ModalClient;
  // Cacheados de forma PEREZOSA (no en onModuleInit): construir la imagen
  // con pandas/numpy si no existe puede tardar varios minutos, y
  // resolverlo en el bootstrap del proceso rompería lint/build/e2e en CI
  // igual que le pasó a GoogleOAuthService en Yormun_Core (Fase 4.2, ver
  // STATUS.md) — no repetir ese error acá. Se resuelve en el primer
  // runRemote() real y queda cacheado para el resto de la vida del pod;
  // si la resolución falla, se limpia el caché para permitir reintento en
  // la siguiente llamada en vez de quedar rota hasta un restart.
  private appPromise: Promise<App> | null = null;
  private imagePromise: Promise<Image> | null = null;

  // Misma razón que k8s.service.ts: la clase real `ConfigService`, no el
  // alias de tipo, es lo que Nest necesita para resolver la inyección.
  constructor(configService: ConfigService) {
    // `getOrThrow` en vez de `get`: Zod ya garantiza un valor en la
    // práctica (env.schema.ts, fail-fast al arrancar), esto es una
    // segunda red de seguridad y evita el `string | undefined` que
    // `exactOptionalPropertyTypes` rechazaría al construir ModalClient.
    this.client = new ModalClient({
      tokenId: configService.getOrThrow<string>('MODAL_TOKEN_ID'),
      tokenSecret: configService.getOrThrow<string>('MODAL_TOKEN_SECRET'),
    });
  }

  async runRemote(
    tool: ExecutorToolDefinition,
    code: string,
    env: Readonly<Record<string, string>>,
  ): Promise<ExecutionResult> {
    try {
      const app = await this.getApp();
      const image = await this.getDataScienceImage(app);
      const timeoutMs = tool.remoteMaxTimeoutSeconds * 1000;

      const sandbox = await this.client.sandboxes.create(app, image, {
        timeoutMs,
        memoryLimitMiB: tool.remoteMemoryLimitMiB,
        // Modal SÍ resuelve dominios directamente (a diferencia del tier
        // local — ver ADR 0003 punto 2, K3s/Flannel no entiende FQDN) —
        // egressWhitelist vacío hoy en runCode, así que bloquea todo.
        blockNetwork: tool.egressWhitelist.length === 0,
        ...(tool.egressWhitelist.length > 0
          ? { outboundDomainAllowlist: [...tool.egressWhitelist] }
          : {}),
      });

      try {
        const proc = await sandbox.exec(['python', '-c', code], {
          timeoutMs,
          env: { ...env },
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          readAllText(proc.stdout),
          readAllText(proc.stderr),
          proc.wait(),
        ]);

        return {
          runId: sandbox.sandboxId,
          succeeded: exitCode === 0,
          logs: stderr ? `${stdout}\n${stderr}` : stdout,
        };
      } finally {
        await sandbox.terminate();
      }
    } catch (err: unknown) {
      if (err instanceof ModalExecutionError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new ModalExecutionError(msg, err);
    }
  }

  private getApp(): Promise<App> {
    if (!this.appPromise) {
      this.appPromise = this.client.apps
        .fromName(MODAL_APP_NAME, { createIfMissing: true })
        .catch((err: unknown) => {
          this.appPromise = null;
          throw err;
        });
    }
    return this.appPromise;
  }

  private getDataScienceImage(app: App): Promise<Image> {
    if (!this.imagePromise) {
      this.imagePromise = this.resolveDataScienceImage(app).catch(
        (err: unknown) => {
          this.imagePromise = null;
          throw err;
        },
      );
    }
    return this.imagePromise;
  }

  private async resolveDataScienceImage(app: App): Promise<Image> {
    try {
      return await this.client.images.fromName(DATA_SCIENCE_IMAGE_NAME);
    } catch (err: unknown) {
      if (!(err instanceof NotFoundError)) throw err;

      this.logger.log(
        `Imagen "${DATA_SCIENCE_IMAGE_NAME}" no existe todavía — construyéndola (puede tardar varios minutos).`,
      );
      const built = await this.client.images
        .fromRegistry('python:3.13')
        .dockerfileCommands(['RUN pip install --no-cache-dir pandas numpy'])
        .build(app);
      await built.publish(DATA_SCIENCE_IMAGE_NAME);
      return built;
    }
  }
}
