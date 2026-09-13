import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSecrets } from './secrets-loader';

const loginMock = vi.fn();
const listSecretsMock = vi.fn();

vi.mock('@infisical/sdk', () => ({
  InfisicalSDK: class {
    auth() {
      return { universalAuth: { login: loginMock } };
    }
    secrets() {
      return { listSecrets: listSecretsMock };
    }
  },
}));

const ALL_REAL_SECRETS = {
  MODAL_TOKEN_ID: 'modal-id-real',
  MODAL_TOKEN_SECRET: 'modal-secret-real',
};

function secretsFrom(values: Record<string, string>) {
  return Object.entries(values).map(([secretKey, secretValue]) => ({
    secretKey,
    secretValue,
  }));
}

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    INFISICAL_ENABLED: 'true',
    INFISICAL_CLIENT_ID: 'client-id',
    INFISICAL_CLIENT_SECRET: 'client-secret',
    INFISICAL_PROJECT_ID: 'project-id',
    INFISICAL_ENVIRONMENT: 'prod',
    ...overrides,
  };
}

describe('loadSecrets', () => {
  beforeEach(() => {
    loginMock.mockReset();
    listSecretsMock.mockReset();
  });

  it('es un no-op si INFISICAL_ENABLED no es "true": no llama al SDK ni toca el env', async () => {
    const env = { INFISICAL_ENABLED: 'false' };

    await loadSecrets(env);

    expect(loginMock).not.toHaveBeenCalled();
    expect(listSecretsMock).not.toHaveBeenCalled();
    expect(env).toEqual({ INFISICAL_ENABLED: 'false' });
  });

  it('con MODAL_TOKEN_ID/SECRET, los vuelca a env y no lanza', async () => {
    loginMock.mockResolvedValue(undefined);
    listSecretsMock.mockResolvedValue({
      secrets: secretsFrom(ALL_REAL_SECRETS),
    });
    const env = baseEnv();

    await loadSecrets(env);

    expect(loginMock).toHaveBeenCalledWith({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
    expect(listSecretsMock).toHaveBeenCalledWith({
      projectId: 'project-id',
      environment: 'prod',
    });
    expect(env.MODAL_TOKEN_ID).toBe('modal-id-real');
    expect(env.MODAL_TOKEN_SECRET).toBe('modal-secret-real');
  });

  it('propaga el error si el login contra Infisical falla (no lo traga)', async () => {
    loginMock.mockRejectedValue(new Error('Infisical unreachable'));

    await expect(loadSecrets(baseEnv())).rejects.toThrow(
      'Infisical unreachable',
    );
    expect(listSecretsMock).not.toHaveBeenCalled();
  });

  it('lanza mencionando la clave exacta si Infisical devuelve un subconjunto incompleto', async () => {
    loginMock.mockResolvedValue(undefined);
    listSecretsMock.mockResolvedValue({
      secrets: secretsFrom({ MODAL_TOKEN_ID: 'modal-id-real' }),
    });

    await expect(loadSecrets(baseEnv())).rejects.toThrow('MODAL_TOKEN_SECRET');
  });
});
