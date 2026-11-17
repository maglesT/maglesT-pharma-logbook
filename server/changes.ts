import { canonical } from './signatures.js';
import { plantDay, plantTime } from './status.js';
import { ENTRY_FIELD_LABEL, OVERDUE_LABEL, partsLine, valueLabel, type PartUsed } from './labels.js';

// Master-data changes in words for the history card and its exports (S11): the audit trail keeps
// the raw old and new values; people read "Location: Block A → Block B".

const LABEL: Record<string, string> = {
  code: 'ID', name: 'Name', kind: 'Type', location: 'Location', sterile: 'Sterile', classified: 'Classified room',
  cleanHoldHours: 'Clean-hold (hours)', needsCalibration: 'Needs calibration', active: 'Active',
  assetNumber: 'Asset no.', manufacturer: 'Manufacturer', model: 'Model', serialNumber: 'Serial no.', capacity: 'Capacity',
  installationDate: 'Installed', supplier: 'Supplier', qualificationStatus: 'Qualification', iq: 'IQ', oq: 'OQ', pq: 'PQ',
  lastRequalification: 'Last requalification', productContactMoc: 'Product contact / MOC', sopRefs: 'SOPs',
};
const HIDDEN = new Set(['id', 'version', 'createdAt', 'created_at', 'itemId']);
// Fields in the order people read them; unknown fields last.
const ORDER = Object.keys(LABEL);
const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// D-49: days and times in words in plant time ("30 Jan 2027"), never ISO.
const PLAIN_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function text(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (v === true) return 'yes';
  if (v === false) return 'no';
  if (v instanceof Date) return plantTime(v);
  if (typeof v === 'string' && PLAIN_DAY.test(v)) return plantDay(v);
  if (typeof v === 'string' && MOMENT.test(v)) return plantTime(new Date(v));
  if (isObj(v) && ('date' in v || 'ref' in v)) return [v.date ? plantDay(String(v.date)) : '', v.ref].filter((x) => x !== null && x !== undefined && x !== '').join(', ') || '—';
  if (isObj(v) || Array.isArray(v)) return canonical(v);
  return String(v).replaceAll('_', ' ');
}
const empty = (v: unknown) => text(v) === '—';

// Equipment details are stored as { version, details }; the item itself as its columns.
const fields = (v: unknown): Obj => (isObj(v) && isObj(v.details) ? v.details : isObj(v) ? v : {});

export function changeLines(old: unknown, next: unknown, action = ''): string[] {
  // D-60: an overdue record in words; its record number and stored time are internal.
  if (action === 'overdue.recorded' && isObj(next)) {
    const kind = String(next.kind ?? '');
    return [`${OVERDUE_LABEL[kind] ?? text(kind)}${next.dueAt ? `, due ${plantTime(new Date(String(next.dueAt)))}` : ''}`];
  }
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
  postRepairChecks: 'Post-repair checks', partNumber: 'Part no.', lotSerial: 'Lot / serial no.', finalText: 'Confirmed text', lateReason: 'Late because', endReason: 'Why ended',
  transcribe: 'Transcription', translate: 'Translation', data: 'Entry data', partsNone: 'No parts used', cleaningType: 'Cleaning',
};
const keyName = (k: string) => MORE[k] ?? LABEL[k] ?? k.replace(/([a-z])([A-Z])/g, (_m, a: string, b: string) => `${a} ${b.toLowerCase()}`).replace(/^\w/, (c) => c.toUpperCase());
// Identifiers and fingerprints are printed exactly as stored.
const VERBATIM = new Set(['contentHash', 'signatureId', 'audioSha256', 'audioMime', 'responseId', 'modelVersion', 'model', 'transcribe', 'translate', 'hash',
  'transcript', 'translation', 'finalText', 'shownHash']);
// D-60: a picked value in the entry form's words ("Product changeover").
const leafText = (k: string, v: unknown) => valueLabel(k, v) ?? (typeof v === 'string' && VERBATIM.has(k) ? v || '—' : text(v));
export function recordLines(v: unknown, indent = '', names: Record<string, string> = {}): string[] {
  if (!isObj(v)) return [`${indent}${text(v)}`];
  const name = (k: string) => names[k] ?? keyName(k);
  const out: string[] = [];
  for (const [k, x] of Object.entries(v)) {
    // D-60: parts in one plain line, "No parts used" said once.
    if (k === 'parts' && Array.isArray(x) && x.some(isObj)) out.push(`${indent}Parts used: ${partsLine(x as PartUsed[])}`);
    else if (k === 'partsNone' && x === true) out.push(`${indent}No parts used`);
    else if (isObj(x) && !('date' in x || 'ref' in x)) out.push(`${indent}${name(k)}:`, ...recordLines(x, `${indent}  `));
    else if (Array.isArray(x) && x.some(isObj)) x.forEach((item, i) => out.push(`${indent}${name(k)} ${i + 1}:`, ...recordLines(item, `${indent}  `)));
    else out.push(`${indent}${name(k)}: ${Array.isArray(x) ? x.map((y) => leafText(k, y)).join(', ') || '—' : leafText(k, x)}`);
  }
  return out;
}

// D-56: an entry's data for the history card, as labelled lines like the screen shows them (empty fields left out).
// D-60: in the screen's order (From product, From batch, To product, To batch, ...), the checklist as one line.
const ENTRY_ORDER = Object.keys(ENTRY_FIELD_LABEL);
const entryRank = (k: string) => (ENTRY_ORDER.includes(k) ? ENTRY_ORDER.indexOf(k) : ENTRY_ORDER.length);
export function entryLines(data: Record<string, unknown>): string[] {
  const kept = Object.entries(data).filter(([, v]) => v !== '' && v !== false && v !== null && v !== undefined
    && !(Array.isArray(v) && v.length === 0) && !(isObj(v) && Object.keys(v).length === 0)).sort(([a], [b]) => entryRank(a) - entryRank(b));
  const checklist = kept.find(([k]) => k === 'checklist')?.[1];
  const ticked = isObj(checklist) ? Object.entries(checklist).filter(([, v]) => v === true).map(([k]) => k) : [];
  return [...recordLines(Object.fromEntries(kept.filter(([k]) => k !== 'checklist')), '', ENTRY_FIELD_LABEL), ...(ticked.length ? [`Checklist confirmed: ${ticked.join('; ')}`] : [])];
}
