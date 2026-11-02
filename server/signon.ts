import { createHash, randomBytes } from 'node:crypto';

// B1-2 (D-29): sign-on through Medhanta core, OIDC code flow with PKCE (platform PL-01). The Logbook keeps no
// passwords; who someone is and which Logbook roles they hold come from core's token and nothing else.

export interface Identity {
  sub: string;            // core employee id
  login: string;
  name: string;
  roles: string[];        // this product's roles in core's permission register
  refreshToken?: string;
  idToken?: string;
}

export interface SignOn {
  authUrl(o: { state: string; challenge: string; prompt?: 'login'; loginHint?: string }): string;
  exchange(code: string, verifier: string): Promise<Identity>;
  // Renews the tokens; throws when the person may no longer sign on (deactivated, locked, grant revoked).
  refresh(refreshToken: string): Promise<Identity>;
  // Where the browser goes after logout, so core's own session ends too (shared terminals).
  logoutUrl(idToken: string | null): string | null;
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
    const c = (await me.json()) as { sub: string; name?: string; preferred_username?: string; roles?: string[] };
    return { sub: c.sub, login: c.preferred_username ?? '', name: c.name ?? '', roles: c.roles ?? [], refreshToken: t.refresh_token, idToken: t.id_token };
  }
  return {
    authUrl: ({ state, challenge, prompt, loginHint }) => `${s.issuer}/auth?${new URLSearchParams({
      client_id: s.clientId, response_type: 'code', redirect_uri: s.redirectUri, scope: 'openid profile roles', state,
      code_challenge: challenge, code_challenge_method: 'S256',
      ...(prompt ? { prompt, max_age: '0' } : {}), ...(loginHint ? { login_hint: loginHint } : {}),
    })}`,
    exchange: (code, verifier) => tokens({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: s.redirectUri }),
    refresh: (refreshToken) => tokens({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    logoutUrl: (idToken) => `${s.issuer}/session/end${idToken ? `?${new URLSearchParams({ id_token_hint: idToken, client_id: s.clientId })}` : ''}`,
  };
}
