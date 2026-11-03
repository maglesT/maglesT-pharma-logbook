import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { SESSION_COOKIE, asPermissions, loadSession, newSessionId, requirePermission, sessionKey } from '../auth.js';
import { challengeOf, newVerifier, type SignOn } from '../signon.js';
import { MEANINGS, makeProof } from '../signatures.js';

// B1-2 (D-29): sign-on through Medhanta core (platform PL-01). /login sends the browser to core, /cb comes back
// with a code; the Logbook permissions come from core's token only. A person without a Logbook permission is refused.

// A started sign-on lives in a short cookie on this browser only (state + PKCE verifier): /cb accepts only the
// state this browser started (no login CSRF), and nothing is kept on the server.
const PENDING_COOKIE = 'signon';
const PENDING_SECONDS = 600;
const page = (title: string, text: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#333}a{color:#e8590c}</style>
</head><body><h1>${title}</h1><p>${text}</p><p><a href="/login">Sign in again</a></p></body></html>`;

// Hands the outcome to the sign dialog that opened this window, then closes it.
// The page holds a proof: never cached.
const signPage = (msg: { signProof: string } | { signError: string }) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Cache-Control" content="no-store"><title>Signature</title></head><body><p>${'signError' in msg ? msg.signError : 'Password confirmed.'} You can close this window.</p>
<script>if (window.opener) { window.opener.postMessage(${JSON.stringify(msg).replace(/</g, '\\u003c')}, location.origin); window.close(); }</script>
</body></html>`;

export function authRoutes(app: FastifyInstance, sql: Sql, signOn: SignOn) {
  app.get('/login', async (req, reply) => {
    const q = z.object({ login_hint: z.string().max(40).optional() }).parse(req.query);
    const state = newVerifier();
    const verifier = newVerifier();
    // Lax: the cookie must come back on core's top-level redirect to /cb.
    void reply.setCookie(PENDING_COOKIE, `${state}.${verifier}`, { path: '/cb', httpOnly: true, sameSite: 'lax', secure: app.cookieSecure, maxAge: PENDING_SECONDS });
    return reply.redirect(signOn.authUrl({ state, challenge: challengeOf(verifier), loginHint: q.login_hint }));
  });

  // B1-4 (PL-05): a signature starts here, in a small window the sign dialog opens. Core asks the signed-in person
  // for their password again (prompt=login, max_age=0); /cb then hands the dialog a short signing proof.
  app.get('/sign', async (req, reply) => {
    // The meanings the person is about to sign, as the sign dialog shows them; the proof is good for those only.
    const q = z.object({ meanings: z.string().regex(/^[a-z_]+(,[a-z_]+){0,1}$/) }).safeParse(req.query);
    if (!q.success || !q.data.meanings.split(',').every((m) => (MEANINGS as readonly string[]).includes(m))) {
      return reply.code(400).header('cache-control', 'no-store').type('text/html').send(signPage({ signError: 'Unknown signature meaning.' }));
    }
    const sid = req.cookies[SESSION_COOKIE];
    const user = sid ? await loadSession(sql, signOn, sid) : null;
    if (!user) return reply.code(401).header('cache-control', 'no-store').type('text/html').send(signPage({ signError: 'Your session has ended. Sign in again.' }));
    const state = newVerifier();
    const verifier = newVerifier();
    void reply.setCookie(PENDING_COOKIE, `${state}.${verifier}.sign.${Date.now()}.${q.data.meanings}`, { path: '/cb', httpOnly: true, sameSite: 'lax', secure: app.cookieSecure, maxAge: PENDING_SECONDS });
    return reply.redirect(signOn.authUrl({ state, challenge: challengeOf(verifier), prompt: 'login', loginHint: user.username }));
  });

  app.get('/cb', async (req, reply) => {
    const q = z.object({ code: z.string().min(1), state: z.string().min(1) }).safeParse(req.query);
    const [state, verifier, mode, startedAt, meanings] = (req.cookies[PENDING_COOKIE] ?? '').split('.');
    void reply.clearCookie(PENDING_COOKIE, { path: '/cb' });
    if (!q.success || !state || !verifier || state !== q.data.state) {
      return reply.code(400).type('text/html').send(page('Sign-in expired', 'This sign-in link is no longer valid.'));
    }
    let who;
    try {
      who = await signOn.exchange(q.data.code, verifier);
    } catch {
      if (mode === 'sign') return reply.header('cache-control', 'no-store').type('text/html').send(signPage({ signError: 'Your password was not confirmed.' }));
      return reply.code(401).type('text/html').send(page('Sign-in failed', 'The sign-in service did not confirm who you are.'));
    }
    // The signature itself checks that this is the signed-in person, holding the code it needs (authenticateSigner).
    if (mode === 'sign') {
      // PL-05: core must have asked for the password after this signature started (prompt=login, max_age=0 are only
      // a request; the ID token's auth_time shows what core did). One second's leeway: auth_time has whole seconds.
      if (!who.authTime || who.authTime * 1000 < Number(startedAt) - 1000) {
        return reply.header('cache-control', 'no-store').type('text/html').send(signPage({ signError: 'Your password was not asked for again. Try again.' }));
      }
      return reply.header('cache-control', 'no-store').type('text/html').send(signPage({ signProof: makeProof(app.proofKey, who, (meanings ?? '').split(',')) }));
    }
    const permissions = asPermissions(who.permissions);
    const name = who.name.trim() || who.login;
    const outcome = await sql.begin(async (tx) => {
      // The id map: one users row per core employee, made at first sign-on (D-29). The login never changes in core.
      // A login the id map cannot take: one a local account not yet moved still holds, or outside its pattern.
      const [taken] = await tx`select 1 from users where username = ${who.login} and employee_id is distinct from ${who.sub}`;
      if (taken || !/^[a-z0-9._-]{3,40}$/.test(who.login)) return { refused: 'login' as const };
      const [u] = await tx<{ id: number }[]>`
        insert into users (employee_id, username, full_name, password_hash, must_change_password)
        values (${who.sub}, ${who.login}, ${name}, '-', false)
        on conflict (employee_id) do update set full_name = excluded.full_name
        returning id::int`;
      if (!u) return { refused: 'login' as const };
      if (!permissions.length) {
        await audit(tx, { actorId: u.id, action: 'login.failed', objectType: 'user', objectId: u.id, reason: 'no Logbook permission' });
        return { refused: 'role' as const };
      }
      const sessionId = newSessionId();
      await tx`insert into sessions (id, user_id, permissions, refresh_token, id_token)
               values (${sessionKey(sessionId)}, ${u.id}, ${permissions}, ${who.refreshToken ?? null}, ${who.idToken ?? null})`;
      await tx`update users set last_login_at = now() where id = ${u.id}`;
      await audit(tx, { actorId: u.id, action: 'login', objectType: 'user', objectId: u.id, new: { permissions } });
      return { sessionId };
    }).catch((e: { code?: string }) => {
      // Two people signing on with one login at once, or a value the id map refuses.
      if (e.code === '23505' || e.code === '23514') return { refused: 'login' as const };
      throw e;
    });
    if ('refused' in outcome) {
      return reply.code(403).type('text/html').send(outcome.refused === 'role'
        ? page('No access', 'You have no right to use the Pharma Logbook. Ask your administrator.')
        : page('Login cannot be used', 'This login cannot be used in the Pharma Logbook. Ask your administrator.'));
    }
    void reply.setCookie(SESSION_COOKIE, outcome.sessionId, { path: '/', httpOnly: true, sameSite: 'strict', secure: app.cookieSecure });
    return reply.redirect('/');
  });

  // Ends the Logbook session and returns where the browser goes to end the core session too.
  app.post('/api/logout', async (req, reply) => {
    let idToken: string | null = null;
    if (req.user) {
      await sql.begin(async (tx) => {
        const [s] = await tx<{ id_token: string | null }[]>`delete from sessions where id = ${sessionKey(req.user!.sessionId)} returning id_token`;
        idToken = s?.id_token ?? null;
        await audit(tx, { actorId: req.user!.id, action: 'logout', objectType: 'user', objectId: req.user!.id });
      });
    }
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true, logoutUrl: signOn.logoutUrl(idToken) };
  });

  app.get('/api/me', { preHandler: requirePermission() }, async (req) => {
    const u = req.user!;
    return { id: u.id, username: u.username, fullName: u.fullName, permissions: u.permissions };
  });
}
