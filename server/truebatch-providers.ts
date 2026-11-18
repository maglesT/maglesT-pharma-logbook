// D-75: every TrueBatch product the Logbook reads, in one list. Each one is a platform provider (`id`) whose link gives the
// Logbook `<ID>_DATABASE_URL` (e.g. TRUEBATCH_CAPSULES_DATABASE_URL) only while the link is on; no URL: the product is not
// read, and nothing is wrong. All publish the same views with the same columns:
// - a bulk product (`packing: false`): report.batch_fact_v1 (its batches, D-45, D-61) and report.equipment_use_v1 (its
//   machine and room uses, read with its batches: a use of a batch no longer in production does not hold the item, D-46);
// - a packing product (`packing: true`): report.packing_batch_v1 (its batches, without a strength, D-61) and
//   report.equipment_use_v1 (its uses, read without its batches: an open use holds the item until packing ends it, D-47).
// `name` is how the Logbook names the product in its lists and messages. A new TrueBatch product is one line here (and its
// "reads" in the platform manifest). The order is kept: batches are looked up in the bulk products first, then in the
// packing ones (a number in two products is the first one's), and uses are read in this order.
export const TRUEBATCH_PROVIDERS = [
  { id: 'truebatch', name: 'TrueBatch', packing: false },                                         // Tablets, D-45, D-46
  { id: 'truebatch_packing', name: 'TrueBatch Packing', packing: true },                          // D-47, D-61
  { id: 'truebatch_injectables', name: 'TrueBatch Injectables', packing: false },                 // D-52, D-61
  { id: 'truebatch_injectables_packing', name: 'TrueBatch Injectables Packing', packing: true },  // D-54, D-61
  { id: 'truebatch_capsules', name: 'TrueBatch Capsules', packing: false },                       // D-75
  { id: 'truebatch_capsules_packing', name: 'TrueBatch Capsules Packing', packing: true },        // D-75
  { id: 'truebatch_liquids', name: 'TrueBatch Oral Liquids', packing: false },                    // D-75
  { id: 'truebatch_liquids_packing', name: 'TrueBatch Oral Liquids Packing', packing: true },     // D-75
  { id: 'truebatch_api', name: 'TrueBatch API', packing: false },                                 // D-75: packing is its last stage
] as const;

export type TrueBatchProvider = (typeof TRUEBATCH_PROVIDERS)[number];
/** The name of a TrueBatch product, as the Logbook shows it. */
export type TrueBatchName = TrueBatchProvider['name'];
export type TrueBatchUrlKey = `${Uppercase<TrueBatchProvider['id']>}_DATABASE_URL`;
/** The variable that holds the product's database URL while its platform link is on. */
export const trueBatchUrlKey = (p: TrueBatchProvider) => `${p.id.toUpperCase()}_DATABASE_URL` as TrueBatchUrlKey;
