import { ConfigService } from '@nestjs/config';
import { NotFoundError } from 'modal';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorToolDefinition } from '../rbac/tool-whitelist';
import { ModalExecutionError } from './errors';
import { ModalService } from './modal.service';

// AGENTS.md 6.3: mockear la API externa (el SDK `modal`), nunca la
// lógica propia.
const appsFromNameMock = vi.fn();
const imagesFromNameMock = vi.fn();
const dockerfileCommandsMock = vi.fn();
const buildMock = vi.fn();
const publishMock = vi.fn();
const fromRegistryMock = vi.fn();
const sandboxCreateMock = vi.fn();
const sandboxExecMock = vi.fn();
const sandboxTerminateMock = vi.fn();

vi.mock('modal', () => {
  class FakeNotFoundError extends Error {}
  return {
    ModalClient: class {
      apps = { fromName: appsFromNameMock };
      images = { fromName: imagesFromNameMock, fromRegistry: fromRegistryMock };
      sandboxes = { create: sandboxCreateMock };
    },
    NotFoundError: FakeNotFoundError,
  };
});

function makeStream(chunks: readonly string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const NO_EGRESS_TOOL: ExecutorToolDefinition = {
  name: 'runCode',
  description: '',
  egressWhitelist: [],
  maxTimeoutSeconds: 300,
  remoteMaxTimeoutSeconds: 1800,
  remoteMemoryLimitMiB: 4096,
};

const fakeConfigService = new ConfigService({
  MODAL_TOKEN_ID: 'test-token-id',
  MODAL_TOKEN_SECRET: 'test-token-secret',
});

describe('ModalService.runRemote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appsFromNameMock.mockResolvedValue({ appId: 'app-1' });
    imagesFromNameMock.mockResolvedValue({ imageId: 'img-existing' });
    sandboxCreateMock.mockResolvedValue({
      sandboxId: 'sb-1',
      exec: sandboxExecMock,
      terminate: sandboxTerminateMock,
    });
    // Factory, no un valor fijo: cada llamada necesita un ReadableStream
    // nuevo — un stream ya leído queda "locked" y no se puede reusar.
    sandboxExecMock.mockImplementation(() =>
      Promise.resolve({
        stdout: makeStream(['hola']),
        stderr: makeStream([]),
        wait: vi.fn().mockResolvedValue(0),
      }),
    );
    sandboxTerminateMock.mockResolvedValue(undefined);
  });

  it('crea la app y reusa la imagen existente sin reconstruirla', async () => {
    const service = new ModalService(fakeConfigService);

    const result = await service.runRemote(NO_EGRESS_TOOL, 'print("hola")', {});

    expect(appsFromNameMock).toHaveBeenCalledWith('jin-executor', {
      createIfMissing: true,
    });
    expect(imagesFromNameMock).toHaveBeenCalledWith('jin-data-science');
    expect(fromRegistryMock).not.toHaveBeenCalled();
    expect(result).toEqual({ runId: 'sb-1', succeeded: true, logs: 'hola' });
  });

  it('crea el sandbox con blockNetwork:true cuando egressWhitelist está vacío, y los límites remotos de la tool', async () => {
    const service = new ModalService(fakeConfigService);

    await service.runRemote(NO_EGRESS_TOOL, 'print(1)', {});

    expect(sandboxCreateMock).toHaveBeenCalledWith(
      { appId: 'app-1' },
      { imageId: 'img-existing' },
      expect.objectContaining({
        timeoutMs: 1_800_000,
        memoryLimitMiB: 4096,
        blockNetwork: true,
      }),
    );
  });

  it('con egressWhitelist no vacío, pasa outboundDomainAllowlist en vez de bloquear la red', async () => {
    const service = new ModalService(fakeConfigService);
    const toolWithEgress: ExecutorToolDefinition = {
      ...NO_EGRESS_TOOL,
      egressWhitelist: ['api.example.com'],
    };

    await service.runRemote(toolWithEgress, 'print(1)', {});

    expect(sandboxCreateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        blockNetwork: false,
        outboundDomainAllowlist: ['api.example.com'],
      }),
    );
  });

  it('construye y publica la imagen si todavía no existe (primera invocación)', async () => {
    imagesFromNameMock.mockRejectedValueOnce(new NotFoundError('no existe'));
    dockerfileCommandsMock.mockReturnValue({ build: buildMock });
    buildMock.mockResolvedValue({ imageId: 'img-nueva', publish: publishMock });
    publishMock.mockResolvedValue(undefined);
    fromRegistryMock.mockReturnValue({
      dockerfileCommands: dockerfileCommandsMock,
    });

    const service = new ModalService(fakeConfigService);
    await service.runRemote(NO_EGRESS_TOOL, 'print(1)', {});

    expect(fromRegistryMock).toHaveBeenCalledWith('python:3.13');
    expect(dockerfileCommandsMock).toHaveBeenCalledWith([
      'RUN pip install --no-cache-dir pandas numpy',
    ]);
    expect(publishMock).toHaveBeenCalledWith('jin-data-science');
  });

  it('cachea la app y la imagen entre llamadas — no vuelve a resolverlas', async () => {
    const service = new ModalService(fakeConfigService);

    await service.runRemote(NO_EGRESS_TOOL, 'print(1)', {});
    await service.runRemote(NO_EGRESS_TOOL, 'print(2)', {});

    expect(appsFromNameMock).toHaveBeenCalledTimes(1);
    expect(imagesFromNameMock).toHaveBeenCalledTimes(1);
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
  });

  it('termina el sandbox aunque exec falle (try/finally)', async () => {
    sandboxExecMock.mockRejectedValue(new Error('boom'));
    const service = new ModalService(fakeConfigService);

    await expect(
      service.runRemote(NO_EGRESS_TOOL, 'print(1)', {}),
    ).rejects.toThrow(ModalExecutionError);
    expect(sandboxTerminateMock).toHaveBeenCalled();
  });

  it('succeeded:false y logs con stderr cuando el proceso termina con exit code != 0', async () => {
    sandboxExecMock.mockResolvedValue({
      stdout: makeStream(['salida parcial']),
      stderr: makeStream(['Traceback...']),
      wait: vi.fn().mockResolvedValue(1),
    });
    const service = new ModalService(fakeConfigService);

    const result = await service.runRemote(
      NO_EGRESS_TOOL,
      'raise ValueError()',
      {},
    );

    expect(result.succeeded).toBe(false);
    expect(result.logs).toBe('salida parcial\nTraceback...');
  });

  it('envuelve cualquier error del SDK en ModalExecutionError', async () => {
    appsFromNameMock.mockRejectedValue(new Error('token inválido'));
    const service = new ModalService(fakeConfigService);

    await expect(
      service.runRemote(NO_EGRESS_TOOL, 'print(1)', {}),
    ).rejects.toThrow(ModalExecutionError);
  });

  it('si la resolución de la imagen falla, no queda cacheada — la siguiente llamada reintenta', async () => {
    imagesFromNameMock.mockRejectedValueOnce(new Error('fallo transitorio'));
    const service = new ModalService(fakeConfigService);

    await expect(
      service.runRemote(NO_EGRESS_TOOL, 'print(1)', {}),
    ).rejects.toThrow(ModalExecutionError);

    imagesFromNameMock.mockResolvedValueOnce({ imageId: 'img-existing' });
    const result = await service.runRemote(NO_EGRESS_TOOL, 'print(1)', {});
    expect(result.succeeded).toBe(true);
    expect(imagesFromNameMock).toHaveBeenCalledTimes(2);
  });
});
