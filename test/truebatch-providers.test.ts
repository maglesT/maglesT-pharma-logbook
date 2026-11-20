import { describe, expect, it } from 'vitest';
import { trueBatchReaders } from '../server/batches.js';
import { loadConfig } from '../server/config.js';
import type { Sql } from '../server/db.js';
import { TRUEBATCH_PROVIDERS, trueBatchUrlKey } from '../server/truebatch-providers.js';

// D-75: the TrueBatch products the Logbook reads are one list; each is read when its platform link gives its URL.
const env = { LOGBOOK_DATABASE_URL: 'postgres://app:pw@db:5432/logbook', MASTER_DATA_DATABASE_URL: 'postgres://app:pw@db:5432/master_data',
  OIDC_ISSUER: 'https://site.test/oidc', OIDC_CLIENT_SECRET: 'x', OIDC_REDIRECT_URI: 'https://logbook.site.test/cb' };
// The readers query only when asked: building them needs no database.
const q = {} as Sql;
const link = (id: string) => ({ provider: TRUEBATCH_PROVIDERS.find((p) => p.id === id)!, q });

describe('the TrueBatch products the Logbook reads (D-75)', () => {
  it('one list: each product\'s platform provider, name, kind and URL variable', () => {
    expect(TRUEBATCH_PROVIDERS.map((p) => [p.id, p.name, p.packing ? 'packing' : 'bulk', trueBatchUrlKey(p)])).toEqual([
      ['truebatch', 'TrueBatch', 'bulk', 'TRUEBATCH_DATABASE_URL'],
      ['truebatch_packing', 'TrueBatch Packing', 'packing', 'TRUEBATCH_PACKING_DATABASE_URL'],
      ['truebatch_injectables', 'TrueBatch Injectables', 'bulk', 'TRUEBATCH_INJECTABLES_DATABASE_URL'],
      ['truebatch_injectables_packing', 'TrueBatch Injectables Packing', 'packing', 'TRUEBATCH_INJECTABLES_PACKING_DATABASE_URL'],
      ['truebatch_capsules', 'TrueBatch Capsules', 'bulk', 'TRUEBATCH_CAPSULES_DATABASE_URL'],
      ['truebatch_capsules_packing', 'TrueBatch Capsules Packing', 'packing', 'TRUEBATCH_CAPSULES_PACKING_DATABASE_URL'],
      ['truebatch_liquids', 'TrueBatch Liquids', 'bulk', 'TRUEBATCH_LIQUIDS_DATABASE_URL'],
      ['truebatch_liquids_packing', 'TrueBatch Liquids Packing', 'packing', 'TRUEBATCH_LIQUIDS_PACKING_DATABASE_URL'],
      ['truebatch_api', 'TrueBatch API', 'bulk', 'TRUEBATCH_API_DATABASE_URL'],
    ]);
  });

  it('PL-08: the configuration takes each product\'s URL; absent or empty, the product is off without an error', () => {
    const none = loadConfig(env);
    for (const p of TRUEBATCH_PROVIDERS) expect(none[trueBatchUrlKey(p)]).toBeUndefined();
    const some = loadConfig({ ...env, TRUEBATCH_CAPSULES_DATABASE_URL: 'postgres://app:pw@db:5432/truebatch_capsules', TRUEBATCH_API_DATABASE_URL: '',
      TRUEBATCH_DATABASE_URL: 'postgres://app:pw@db:5432/truebatch' });
    expect(some.TRUEBATCH_CAPSULES_DATABASE_URL).toBe('postgres://app:pw@db:5432/truebatch_capsules');
    expect(some.TRUEBATCH_DATABASE_URL).toBe('postgres://app:pw@db:5432/truebatch');
    expect(some.TRUEBATCH_API_DATABASE_URL).toBeUndefined();
    expect(() => loadConfig({ ...env, TRUEBATCH_LIQUIDS_DATABASE_URL: 'not a url' })).toThrow();
  });

  it('no link: no batch records and no uses (the batch is typed, as before)', () => {
    expect(trueBatchReaders([])).toEqual({ batches: null, uses: [] });
  });

  it('the readers keep the order of the four products linked before: batches bulk first, then packing; uses in the list\'s order', () => {
    const four = trueBatchReaders(['truebatch_injectables_packing', 'truebatch_packing', 'truebatch_injectables', 'truebatch'].map(link));
    expect(four.batches!.source).toBe('TrueBatch, TrueBatch Injectables, TrueBatch Packing, TrueBatch Injectables Packing');
    expect(four.uses.map((u) => u.source)).toEqual(['TrueBatch', 'TrueBatch Packing', 'TrueBatch Injectables', 'TrueBatch Injectables Packing']);
    const all = trueBatchReaders(TRUEBATCH_PROVIDERS.map((p) => link(p.id)));
    expect(all.batches!.source).toBe('TrueBatch, TrueBatch Injectables, TrueBatch Capsules, TrueBatch Liquids, TrueBatch API, '
      + 'TrueBatch Packing, TrueBatch Injectables Packing, TrueBatch Capsules Packing, TrueBatch Liquids Packing');
    expect(all.uses.map((u) => u.source)).toEqual(TRUEBATCH_PROVIDERS.map((p) => p.name));
    expect(trueBatchReaders([link('truebatch_capsules')]).batches!.source).toBe('TrueBatch Capsules');
  });
});
