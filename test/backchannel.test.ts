import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BACKCHANNEL_EVENT, oidcSignOn } from '../server/signon.js';
import { call, directory, freshApp, login, seedUser, type TestApp } from './helpers.js';

// PL-01 (shared terminals): when the person signs out at Medhanta core, core sends each product a signed logout token
// (OIDC Back-Channel Logout 1.0) and the Logbook ends that person's sessions at once, instead of at the next renewal.

const ISSUER = 'https://core.test/oidc';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const KID = 'core-1';

function jwt(claims: Record<string, unknown>, o: { key?: KeyObject; alg?: string; kid?: string } = {}) {
  const part = (x: object) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const head = `${part({ alg: o.alg ?? 'RS256', kid: o.kid ?? KID, typ: 'logout+jwt' })}.${part(claims)}`;
  return `${head}.${sign('sha256', Buffer.from(head), o.key ?? privateKey).toString('base64url')}`;
}
const now = () => Math.floor(Date.now() / 1000);
const good = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER, aud: 'logbook', iat: now(), exp: now() + 120, jti: 'j1', sub: 'e-1', sid: 's-1', events: { [BACKCHANNEL_EVENT]: {} }, ...over,
});

describe('logout token check (real verification)', () => {
  const signOn = oidcSignOn({ issuer: ISSUER, clientId: 'logbook', clientSecret: 'x', redirectUri: 'https://logbook.test/cb' });
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url !== `${ISSUER}/jwks`) return new Response('no', { status: 404 });
      return Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' }] });
    }));
  });
  afterEach(() => vi.clearAllMocks());
  afterAll(() => vi.unstubAllGlobals());

  it('accepts a logout token signed by core for this product and names the person', async () => {
    await expect(signOn.verifyLogoutToken(jwt(good()))).resolves.toEqual({ sub: 'e-1' });
  });

  it.each([
    ['another issuer', good({ iss: 'https://evil.test/oidc' })],
    ['another product', good({ aud: 'qms' })],
    ['an old token', good({ iat: now() - 3600 })],
    ['an expired token', good({ exp: now() - 10 })],
    ['no logout event', good({ events: {} })],
    ['a nonce (an ID token, not a logout token)', good({ nonce: 'n' })],
    ['no person', good({ sub: undefined })],
  ])('refuses %s', async (_what, claims) => {
    await expect(signOn.verifyLogoutToken(jwt(claims))).rejects.toThrow(/logout token/);
  });

  it('refuses a token signed with another key, another algorithm or an unknown key id', async () => {
    await expect(signOn.verifyLogoutToken(jwt(good(), { key: other }))).rejects.toThrow(/bad signature/);
    await expect(signOn.verifyLogoutToken(jwt(good(), { alg: 'HS256' }))).rejects.toThrow(/algorithm/);
    await expect(signOn.verifyLogoutToken(jwt(good(), { kid: 'nope' }))).rejects.toThrow(/unknown key/);
    await expect(signOn.verifyLogoutToken('not-a-token')).rejects.toThrow(/malformed/);
  });
});

describe('POST /backchannel-logout', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await freshApp();
    await seedUser(t.owner, 'bclop1', ['operator']);
    await seedUser(t.owner, 'bclop2', ['operator']);
  });
  afterAll(() => t.close());

  const post = (payload: string, type = 'application/x-www-form-urlencoded') =>
    t.app.inject({ method: 'POST', url: '/backchannel-logout', headers: { 'content-type': type }, payload });
  const me = async (cookie: string) => (await call(t.app, cookie, 'GET', '/api/me')).statusCode;

  it('ends every session of the person at once, and only theirs, with an audit entry', async () => {
    const a1 = (await login(t.app, 'bclop1')).cookie;
    const a2 = (await login(t.app, 'bclop1')).cookie;   // the same person on a second terminal
    const b = (await login(t.app, 'bclop2')).cookie;
    expect([await me(a1), await me(a2), await me(b)]).toEqual([200, 200, 200]);

    const res = await post(new URLSearchParams({ logout_token: `logout:${directory.get('bclop1')!.sub}` }).toString());
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect([await me(a1), await me(a2), await me(b)]).toEqual([401, 401, 200]);

    const [row] = await t.owner<{ reason: string }[]>`
      select a.reason from audit_log a join users u on u.id = a.actor_id where a.action = 'logout' and u.username = 'bclop1' order by a.id desc limit 1`;
    expect(row?.reason).toBe('signed out at Medhanta core (2 sessions ended)');
  });

  it('refuses a missing or invalid token and ends nothing', async () => {
    const b = (await login(t.app, 'bclop2')).cookie;
    expect((await post('')).statusCode).toBe(400);
    expect((await post('logout_token=forged')).statusCode).toBe(400);
    expect((await post(JSON.stringify({ logout_token: `logout:${directory.get('bclop2')!.sub}` }), 'application/json')).statusCode).toBe(400);
    expect(await me(b)).toBe(200);
  });

  it('answers 200 when the person has no Logbook session', async () => {
    expect((await post('logout_token=logout:00000000-0000-0000-0000-000000000009')).statusCode).toBe(200);
  });
});
