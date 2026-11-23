// Pen test PH-01: the API gate works on the decoded path, so encoding and case tricks never reach a route or skip the
// JSON-only and session handling.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasEncodedUnreserved, isApiUrl } from '../server/path-gate.js';
import { freshApp, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => { t = await freshApp(); });
afterAll(async () => { await t.app.close(); await t.close(); });

describe('PH-01 path gate', () => {
  for (const url of ['/%61pi/me', '/%61%70%69/health', '/API/me', '/Api/health', '//api/me', '/api/./me', '/api%2Fme', '/api%2fhealth', '/%2e/api/me', '/%5capi/me', '/%2561pi/me', '/api/%68ealth'])
    it(`GET ${url} is never 200`, async () => {
      const r = await t.app.inject({ method: 'GET', url });
      expect([400, 401, 404], url).toContain(r.statusCode);
    });
  it('a non-JSON write to an encoded API path is refused, not routed', async () => {
    for (const url of ['/%61pi/login', '/API/login', '//api/login']) {
      const r = await t.app.inject({ method: 'POST', url, headers: { 'content-type': 'text/plain' }, payload: 'x' });
      expect([400, 404, 415], url).toContain(r.statusCode);
    }
  });
  it('the plain API path still works', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/health?x=a%20b' })).statusCode).toBe(200);
  });
  it('helpers', () => {
    expect(isApiUrl('/%61pi/me')).toBe(true);
    expect(isApiUrl('/API/me?x=1')).toBe(true);
    expect(isApiUrl('//api/me')).toBe(true);
    expect(isApiUrl('/batches/12')).toBe(false);
    expect(hasEncodedUnreserved('/%61pi/me')).toBe(true);
    expect(hasEncodedUnreserved('/api/a%20b')).toBe(false);
    expect(hasEncodedUnreserved('/api/x?q=%61')).toBe(false);
  });
});

describe('PH-02 csv injection', () => {
  it('defuses formula cells, also after spaces, tab or line break', async () => {
    const { csvText } = await import('../server/routes/exports.js');
    const line = csvText(['h'], [['=1+1'], ['+SUM(A1)'], ['-2'], ['@cmd'], ['\t=1'], [' =1'], ['say "hi", ok']]).split('\r\n');
    expect(line.slice(1, 8)).toEqual([`"'=1+1"`, `"'+SUM(A1)"`, `"'-2"`, `"'@cmd"`, `"'\t=1"`, `"' =1"`, '"say ""hi"", ok"']);
  });
});
