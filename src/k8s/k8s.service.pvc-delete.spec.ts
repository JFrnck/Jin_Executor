import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { K8sService } from './k8s.service';

/** K8sService sin kubeconfig: solo lo que `deletePvcOrThrow` toca (coreApi, namespace, logger). */
function k8sWith(deleteImpl: ReturnType<typeof vi.fn>) {
  const k8s = Object.create(K8sService.prototype) as K8sService;
  Object.assign(k8s, {
    coreApi: { deleteNamespacedPersistentVolumeClaim: deleteImpl },
    logger: { warn: vi.fn() },
  });
  Object.defineProperty(k8s, 'namespace', { value: 'agents-sandbox' });
  return k8s;
}

describe('K8sService.deletePvcOrThrow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('un 404 (ya no estaba) cuenta como borrado, sin reintentos', async () => {
    const del = vi.fn().mockRejectedValue({ code: 404 });
    await expect(
      k8sWith(del).deletePvcOrThrow('pvc-1'),
    ).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('un error pasajero se reintenta y, si luego funciona, no falla', async () => {
    const del = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({});
    const promise = k8sWith(del).deletePvcOrThrow('pvc-1');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledTimes(3);
  });

  it('si TODOS los intentos fallan, lanza el último error (no lo traga)', async () => {
    const del = vi.fn().mockRejectedValue(new Error('API caída'));
    const promise = k8sWith(del).deletePvcOrThrow('pvc-1', 3);
    await Promise.all([
      expect(promise).rejects.toThrow('API caída'),
      vi.advanceTimersByTimeAsync(5_000),
    ]);
    expect(del).toHaveBeenCalledTimes(3);
  });
});
