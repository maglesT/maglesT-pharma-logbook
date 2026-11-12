import { canonical } from './signatures.js';

// Master-data changes in words for the history card and its exports (S11): the audit trail keeps
// the raw old and new values; people read "Location: Block A → Block B".

const LABEL: Record<string, string> = {
  code: 'ID', name: 'Name', kind: 'Type', location: 'Location', sterile: 'Sterile', classified: 'Classified room',
  cleanHoldHours: 'Clean-hold (hours)', dirtyHoldHours: 'Dirty-hold (hours)', cleaningFrequencyHours: 'Cleaning frequency (hours)', cleaningBasis: 'Room cleaning', needsCalibration: 'Needs calibration', active: 'Active',
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

// A stored value as labelled lines for printed copies (S13): every key and value, no JSON.
const MORE: Record<string, string> = {
  contentHash: 'Content fingerprint (SHA-256)', signatureId: 'Signature no.', requestIds: 'Service request IDs', audioSha256: 'Audio fingerprint (SHA-256)',
  audioBytes: 'Audio size (bytes)', audioMime: 'Audio format', durationMs: 'Length (ms)', requestedAt: 'Requested at', equipmentId: 'Equipment no.',
  logbookType: 'Logbook', entryVersionId: 'Entry version no.', basedOn: 'Past breakdowns used', modelVersion: 'Model', responseId: 'Model response ID',
  entryId: 'Entry no.', enteredAt: 'Entered at', enteredBy: 'Entered by (user no.)', supersedes: 'Replaces version no.', productId: 'Product no.',
  workDone: 'Work done', rootCause: 'Root cause', description: 'What happened', failureCategory: 'Failure category', occurredAt: 'Occurred',
  postRepairChecks: 'Post-repair checks', partNumber: 'Part no.', lotSerial: 'Lot / serial no.', finalText: 'Confirmed text', lateReason: 'Late because',
  transcribe: 'Transcription', translate: 'Translation', data: 'Entry data', partsNone: 'No parts used', cleaningType: 'Cleaning',
};
const keyName = (k: string) => MORE[k] ?? LABEL[k] ?? k.replace(/([a-z])([A-Z])/g, (_m, a: string, b: string) => `${a} ${b.toLowerCase()}`).replace(/^\w/, (c) => c.toUpperCase());
// Identifiers and fingerprints are printed exactly as stored.
const VERBATIM = new Set(['contentHash', 'signatureId', 'audioSha256', 'audioMime', 'responseId', 'modelVersion', 'model', 'transcribe', 'translate', 'hash',
  'transcript', 'translation', 'finalText', 'shownHash']);
const leafText = (k: string, v: unknown) => (typeof v === 'string' && VERBATIM.has(k) ? v || '—' : text(v));
export function recordLines(v: unknown, indent = ''): string[] {
  if (!isObj(v)) return [`${indent}${text(v)}`];
  const out: string[] = [];
  for (const [k, x] of Object.entries(v)) {
    if (isObj(x) && !('date' in x || 'ref' in x)) out.push(`${indent}${keyName(k)}:`, ...recordLines(x, `${indent}  `));
    else if (Array.isArray(x) && x.some(isObj)) x.forEach((item, i) => out.push(`${indent}${keyName(k)} ${i + 1}:`, ...recordLines(item, `${indent}  `)));
    else out.push(`${indent}${keyName(k)}: ${Array.isArray(x) ? x.map((y) => leafText(k, y)).join(', ') || '—' : leafText(k, x)}`);
  }
  return out;
}
