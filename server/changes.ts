import { canonical } from './signatures.js';

// Master-data changes in words for the history card and its exports (S11): the audit trail keeps
// the raw old and new values; people read "Location: Block A → Block B".

const LABEL: Record<string, string> = {
  code: 'ID', name: 'Name', kind: 'Type', location: 'Location', sterile: 'Sterile', classified: 'Classified room',
  cleanHoldHours: 'Clean-hold (hours)', needsCalibration: 'Needs calibration', active: 'Active',
  assetNumber: 'Asset no.', manufacturer: 'Manufacturer', model: 'Model', serialNumber: 'Serial no.', capacity: 'Capacity',
  installationDate: 'Installed', supplier: 'Supplier', qualificationStatus: 'Qualification', iq: 'IQ', oq: 'OQ', pq: 'PQ',
  lastRequalification: 'Last requalification', productContactMoc: 'Product contact / MOC', sopRefs: 'SOPs',
};
const HIDDEN = new Set(['id', 'version', 'createdAt', 'created_at']);
// Fields in the order people read them; unknown fields last.
const ORDER = Object.keys(LABEL);
const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function text(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (v === true) return 'yes';
  if (v === false) return 'no';
  if (isObj(v) && ('date' in v || 'ref' in v)) return [v.date, v.ref].filter((x) => x !== null && x !== undefined && x !== '').join(', ') || '—';
  if (isObj(v) || Array.isArray(v)) return canonical(v);
  return String(v).replaceAll('_', ' ');
}
const empty = (v: unknown) => text(v) === '—';

// Equipment details are stored as { version, details }; the item itself as its columns.
const fields = (v: unknown): Obj => (isObj(v) && isObj(v.details) ? v.details : isObj(v) ? v : {});

export function changeLines(old: unknown, next: unknown): string[] {
  const before = old == null ? null : fields(old);
  const after = fields(next);
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])].filter((k) => !HIDDEN.has(k)).sort((a, b) => rank(a) - rank(b));
  if (!before) return keys.filter((k) => !empty(after[k])).map((k) => `${LABEL[k] ?? k}: ${text(after[k])}`);
  return keys
    .filter((k) => canonical(before[k] ?? null) !== canonical(after[k] ?? null))
    .map((k) => `${LABEL[k] ?? k}: ${text(before[k])} → ${text(after[k])}`);
}
