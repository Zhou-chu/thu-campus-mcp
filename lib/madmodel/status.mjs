/** 免费认证GET真值；从不ensure/login/refresh，不输出身份或认证原文。 */
export async function readSessionStatus({ store, verify, signal, verifySession = true, verifiedAt = 0, retryAt = 0, refreshing = false, lastError = null, now = () => Date.now() }) {
  const time = now(), checkedAt = new Date(time).toISOString();
  const base = { configured: false, disabled: false, expiresAt: null, expired: false, refreshing, lastVerifiedAt: verifiedAt ? new Date(verifiedAt).toISOString() : null, nextRetryAt: retryAt > time ? new Date(retryAt).toISOString() : null, lastError: lastError ? { code: /^[A-Z_]+$/.test(lastError.code || '') ? lastError.code : 'AUTH_CHECK_FAILED' } : null, verified: false, checkedAt, source: 'local:madmodel-auth-store', sessionValidity: 'unverified', code: 'UNVERIFIED' };
  let data, snapshot;
  try { snapshot = await store.load(); data = snapshot.data; }
  catch { return { ...base, code: 'AUTH_STORAGE', sessionValidity: 'unknown' }; }
  const configured = Boolean(data?.token && !data?.disabled);
  const expiresAt = Number.isFinite(data?.expiresAt) ? new Date(data.expiresAt).toISOString() : null;
  const local = { ...base, configured, disabled: Boolean(data?.disabled), expiresAt };
  if (!configured) return { ...local, code: 'AUTH_REQUIRED' };
  if (expiresAt && data.expiresAt <= time) return { ...local, expired: true, code: 'AUTH_EXPIRED', sessionValidity: 'expired' };
  if (!verifySession || typeof verify !== 'function') return local;
  const online = { ...local, source: 'protected-api:madmodel-auth-login' };
  try {
    signal?.throwIfAborted();
    const valid = await verify(data.token, signal);
    if (valid === false) return { ...online, expired: true, code: 'AUTH_EXPIRED', sessionValidity: 'expired' };
    if (valid !== true) return { ...online, code: 'UPSTREAM_PROTOCOL', sessionValidity: 'unknown' };
    const current = await store.load();
    if (current.revision !== snapshot.revision || current.data?.token !== data.token || current.data?.disabled) return { ...online, code: 'AUTH_CHANGED' };
    return { ...online, verified: true, code: 'VERIFIED', sessionValidity: 'verified', lastVerifiedAt: checkedAt, lastError: null };
  } catch (error) {
    const raw = error?.code;
    const code = ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'UPSTREAM_PROTOCOL'].includes(raw) ? raw : 'NETWORK_ERROR';
    return { ...online, expired: code === 'AUTH_EXPIRED', code, sessionValidity: code === 'AUTH_EXPIRED' ? 'expired' : 'unknown', lastError: { code } };
  }
}
