import { AuthStore } from './auth.js';
import type { Config } from './config.js';
import type { RainClient } from './client.js';

/** 只读basic-info验证；从不登录、扫码、进入课堂或清理认证。 */
export async function rainStatus(config: Config, client: Pick<RainClient, 'user'>, { verify = true, store = new AuthStore(config.stateDir) } = {}) {
  const base = { mode: config.mock ? 'mock' : 'real', verified: false, checkedAt: new Date().toISOString(), source: 'local:rain-auth-store', sessionValidity: 'unverified', code: 'UNVERIFIED' };
  if (config.mock) return { ...base, state: 'mock', source: 'mock:hetang', code: 'MOCK_MODE', authentication: { configured: true, simulation: true } };
  let configured = false;
  try {
    configured = Boolean((await store.status()).configured);
    const authentication = { configured };
    if (!configured) return { ...base, authentication, code: 'AUTH_REQUIRED' };
    if (!verify) return { ...base, authentication };
    await client.user();
    return { ...base, authentication, source: 'protected-api:rain-basic-info', sessionValidity: 'verified', verified: true, code: 'VERIFIED' };
  } catch (error) {
    const raw = (error as any)?.code;
    const code = raw === 'AUTH_REQUIRED' ? (configured ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED') : raw === 'AUTH_CHANGED' ? 'AUTH_CHANGED' : ['AUTH_STORAGE', 'AUTH_PLATFORM'].includes(raw) ? raw : 'NETWORK_ERROR';
    return { ...base, authentication: { configured }, source: configured && verify ? 'protected-api:rain-basic-info' : base.source, code, sessionValidity: code === 'AUTH_EXPIRED' ? 'expired' : 'unknown' };
  }
}
