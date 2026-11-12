import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

// B1-2 (D-29): sign-on through Medhanta core, OIDC code flow with PKCE (platform PL-01). The Logbook keeps no
// passwords; who someone is and which Logbook permissions they hold come from core's token and nothing else.

export interface Identity {
  sub: string;            // core employee id
  login: string;
  name: string;
  permissions: string[];  // this product's permission codes in core's register (A10)
  refreshToken?: string;
  idToken?: string;
  authTime?: number;      // when the person last entered their password at core (seconds), from the ID token
}

export interface SignOn {
  authUrl(o: { state: string; challenge: string; prompt?: 'login'; loginHint?: string }): string;
  exchange(code: string, verifier: string): Promise<Identity>;
  // Renews the tokens; throws when the person may no longer sign on (deactivated, locked, grant revoked).
  refresh(refreshToken: string): Promise<Identity>;
  // Where the browser goes after logout, so core's own session ends too (shared terminals).
  logoutUrl(idToken: string | null): string | null;
  // OIDC Back-Channel Logout 1.0: checks a logout token core sent when the person signed out there, and returns whose
  // sessions end. Throws when the token is not a valid logout token from core for this product.
  verifyLogoutToken(token: string): Promise<{ sub: string }>;
}

export const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const LOGOUT_TOKEN_MAX_AGE_S = 300;

interface LogoutClaims { iss?: string; aud?: string | string[]; iat?: number; exp?: number; sub?: string; nonce?: unknown; events?: Record<string, unknown> }

/** The claims a logout token must carry (Back-Channel Logout 1.0 section 2.6), after its signature was checked. */
export function checkLogoutClaims(c: LogoutClaims, issuer: string, clientId: string, nowS = Math.floor(Date.now() / 1000)): { sub: string } {
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== issuer) throw new Error('logout token: wrong issuer');
  if (!aud.includes(clientId)) throw new Error('logout token: not for this product');
  if (typeof c.iat !== 'number' || Math.abs(nowS - c.iat) > LOGOUT_TOKEN_MAX_AGE_S) throw new Error('logout token: too old');
  if (c.exp !== undefined && (typeof c.exp !== 'number' || c.exp < nowS)) throw new Error('logout token: expired');
  if (!c.events || typeof c.events !== 'object' || !(BACKCHANNEL_EVENT in c.events)) throw new Error('logout token: not a logout event');
  if (c.nonce !== undefined) throw new Error('logout token: carries a nonce');
  // The Logbook keeps no core session ids: it ends every session of the person (sub), which core always sends.
  if (typeof c.sub !== 'string' || !c.sub) throw new Error('logout token: names nobody');
  return { sub: c.sub };
}

export const newVerifier = () => randomBytes(32).toString('base64url');
export const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export interface OidcSettings { issuer: string; clientId: string; clientSecret: string; redirectUri: string }

export function oidcSignOn(s: OidcSettings): SignOn {
  const basic = `Basic ${Buffer.from(`${encodeURIComponent(s.clientId)}:${encodeURIComponent(s.clientSecret)}`).toString('base64')}`;
  async function tokens(body: Record<string, string>): Promise<Identity> {
    const res = await fetch(`${s.issuer}/token`, {
      method: 'POST',
      headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`sign-on refused (${res.status})`);
    const t = (await res.json()) as { access_token: string; refresh_token?: string; id_token?: string };
    const me = await fetch(`${s.issuer}/me`, { headers: { authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(10_000) });
    if (!me.ok) throw new Error(`sign-on refused (${me.status})`);
    const c = (await me.json()) as { sub: string; name?: string; preferred_username?: string; permissions?: string[] };
    // The ID token comes straight from core's token endpoint over TLS (OIDC Core 3.1.3.7): its claims are read as is.
    const id = t.id_token ? JSON.parse(Buffer.from(t.id_token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: string; aud?: string | string[]; auth_time?: number } : {};
    if (id.sub !== undefined && id.sub !== c.sub) throw new Error('sign-on refused (token mismatch)');
    return { sub: c.sub, login: c.preferred_username ?? '', name: c.name ?? '', permissions: c.permissions ?? [], refreshToken: t.refresh_token, idToken: t.id_token,
      authTime: id.auth_time };
  }

  // Core's public signing keys (its JWKS), kept for an hour; an unknown key id fetches them again once.
  let jwks: { at: number; keys: (JsonWebKey & { kid?: string })[] } | null = null;
  async function signingKey(kid: string | undefined): Promise<KeyObject> {
    for (const fresh of [false, true]) {
      if (fresh || !jwks || Date.now() - jwks.at > 3_600_000) {
        const res = await fetch(`${s.issuer}/jwks`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`logout token: core keys unavailable (${res.status})`);
        jwks = { at: Date.now(), keys: ((await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] }).keys ?? [] };
      }
      const k = jwks.keys.find((x) => x.kty === 'RSA' && (kid === undefined || x.kid === kid));
      if (k) return createPublicKey({ key: k, format: 'jwk' });
    }
    throw new Error('logout token: unknown key');
  }

  return {
    authUrl: ({ state, challenge, prompt, loginHint }) => `${s.issuer}/auth?${new URLSearchParams({
      client_id: s.clientId, response_type: 'code', redirect_uri: s.redirectUri, scope: 'openid profile permissions', state,
      code_challenge: challenge, code_challenge_method: 'S256',
      ...(prompt ? { prompt, max_age: '0' } : {}), ...(loginHint ? { login_hint: loginHint } : {}),
    })}`,
    exchange: (code, verifier) => tokens({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: s.redirectUri }),
    refresh: (refreshToken) => tokens({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    logoutUrl: (idToken) => `${s.issuer}/session/end${idToken ? `?${new URLSearchParams({ id_token_hint: idToken, client_id: s.clientId })}` : ''}`,
    verifyLogoutToken: async (token) => {
      const [h, p, signature] = token.split('.');
      if (!h || !p || !signature) throw new Error('logout token: malformed');
      const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
      if (header.alg !== 'RS256') throw new Error('logout token: unexpected algorithm');
      const key = await signingKey(header.kid);
      if (!verify('sha256', Buffer.from(`${h}.${p}`), key, Buffer.from(signature, 'base64url'))) throw new Error('logout token: bad signature');
      return checkLogoutClaims(JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as LogoutClaims, s.issuer, s.clientId);
    },
  };
}
