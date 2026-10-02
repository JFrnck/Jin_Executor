import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { K8sService } from './k8s.service';

/** K8sService sin kubeconfig: solo lo que `deletePvcOrThrow` toca (coreApi, namespace, logger). */
function k8sWith(options: {
  del: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
}) {
  const k8s = Object.create(K8sService.prototype) as K8sService;
  Object.assign(k8s, {
    coreApi: {
      deleteNamespacedPersistentVolumeClaim: options.del,
      readNamespacedPersistentVolumeClaim: options.read,
    },
    logger: { warn: vi.fn() },
  });
  Object.defineProperty(k8s, 'namespace', { value: 'agents-sandbox' });
  return k8s;
}

const gone = () => vi.fn().mockRejectedValue({ code: 404 });
const terminating = () =>
  vi.fn().mockResolvedValue({ metadata: { deletionTimestamp: new Date() } });
const alive = () => vi.fn().mockResolvedValue({ metadata: { name: 'pvc-1' } });

describe('K8sService.deletePvcOrThrow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('borrado y ya no existe (404 al leer): listo, sin reintentos', async () => {
    const del = vi.fn().mockResolvedValue({});
    await expect(
      k8sWith({ del, read: gone() }).deletePvcOrThrow('pvc-1'),
    ).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('borrado y terminando (deletionTimestamp): listo, sin reintentos', async () => {
    const del = vi.fn().mockResolvedValue({});
    await expect(
      k8sWith({ del, read: terminating() }).deletePvcOrThrow('pvc-1'),
    ).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('un 404 al borrar (ya no estaba) cuenta como borrado', async () => {
    const del = vi.fn().mockRejectedValue({ code: 404 });
    await expect(
      k8sWith({ del, read: gone() }).deletePvcOrThrow('pvc-1'),
    ).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('si el borrado "funcionó" pero el disco sigue vivo, vuelve a pedirlo hasta que desaparece', async () => {
    const del = vi.fn().mockResolvedValue({});
    const read = vi
      .fn()
      .mockResolvedValueOnce({ metadata: { name: 'pvc-1' } })
      .mockResolvedValueOnce({ metadata: { name: 'pvc-1' } })
      .mockRejectedValueOnce({ code: 404 });
    const promise = k8sWith({ del, read }).deletePvcOrThrow('pvc-1');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledTimes(3);
  });

  it('un error pasajero al borrar se reintenta', async () => {
    const del = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({});
    const promise = k8sWith({ del, read: gone() }).deletePvcOrThrow('pvc-1');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledTimes(2);
  });

  it('si el disco sigue vivo en TODOS los intentos, lanza con el motivo (no lo da por borrado)', async () => {
    const del = vi.fn().mockResolvedValue({});
    const promise = k8sWith({ del, read: alive() }).deletePvcOrThrow(
      'pvc-1',
      3,
    );
    await Promise.all([
      expect(promise).rejects.toThrow(/sigue vivo/),
      vi.advanceTimersByTimeAsync(5_000),
    ]);
    expect(del).toHaveBeenCalledTimes(3);
  });

  it('si el API falla siempre, lanza el último error', async () => {
    const del = vi.fn().mockRejectedValue(new Error('API caída'));
    const promise = k8sWith({ del, read: gone() }).deletePvcOrThrow('pvc-1', 3);
    await Promise.all([
      expect(promise).rejects.toThrow('API caída'),
      vi.advanceTimersByTimeAsync(5_000),
    ]);
    expect(del).toHaveBeenCalledTimes(3);
  });
});
