import { describe, expect, it } from 'vitest';
import {
  getExecutorToolDefinition,
  listExecutorTools,
  type ExecutorToolDefinition,
} from './tool-whitelist';

describe('tool-whitelist', () => {
  it('lista runCode con egressWhitelist vacío y maxTimeoutSeconds=300 (BLUEPRINT 4.4)', () => {
    const tools = listExecutorTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('runCode');
    expect(tools[0]?.egressWhitelist).toEqual([]);
    expect(tools[0]?.maxTimeoutSeconds).toBe(300);
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
      }),
    ).toThrow(TypeError);
  });
});
