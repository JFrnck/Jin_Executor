import { describe, expect, it } from 'vitest';
import {
  getExecutorToolDefinition,
  isRunToCompletionTool,
  listExecutorTools,
  type ExecutorToolDefinition,
} from './tool-whitelist';

describe('tool-whitelist', () => {
  it('lista runCode con egressWhitelist vacío y maxTimeoutSeconds=300 (BLUEPRINT 4.4)', () => {
    const tools = listExecutorTools();
    expect(tools).toHaveLength(4);
    const runCode = tools.find((t) => t.name === 'runCode');
    expect(runCode?.egressWhitelist).toEqual([]);
    if (!runCode || !isRunToCompletionTool(runCode)) {
      throw new Error('runCode debe existir y ser una tool run-to-completion');
    }
    expect(runCode.maxTimeoutSeconds).toBe(300);
  });

  it('runCode trae límites duros separados para el tier remoto (Modal, BLUEPRINT 4.5)', () => {
    const runCode = getExecutorToolDefinition('runCode');
    if (!runCode || !isRunToCompletionTool(runCode)) {
      throw new Error('runCode debe existir y ser una tool run-to-completion');
    }
    expect(runCode.remoteMaxTimeoutSeconds).toBe(1800);
    expect(runCode.remoteMemoryLimitMiB).toBe(4096);
  });

  it('lista las 3 tools de pods de servicio (Fase 5.5, ADR 0006) con isServiceTool=true', () => {
    for (const name of [
      'startPreviewService',
      'stopPreviewService',
      'listPreviewServices',
    ]) {
      const tool = getExecutorToolDefinition(name);
      expect(tool?.isServiceTool).toBe(true);
      expect(tool && isRunToCompletionTool(tool)).toBe(false);
    }
  });

  it('getExecutorToolDefinition devuelve undefined para una tool no registrada', () => {
    expect(getExecutorToolDefinition('deleteCluster')).toBeUndefined();
  });

  it('el registry está Object.freeze()-ado: mutar en runtime lanza TypeError', () => {
    const tools = listExecutorTools() as ExecutorToolDefinition[];
    expect(() =>
      tools.push({
        name: 'x',
        description: '',
        egressWhitelist: [],
        maxTimeoutSeconds: 1,
        remoteMaxTimeoutSeconds: 1,
        remoteMemoryLimitMiB: 1,
      }),
    ).toThrow(TypeError);
  });
});
