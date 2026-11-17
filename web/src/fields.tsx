import { plantDay, plantTime, VOICE_LANGUAGE_LABEL, type Part } from './api.js';
import { ENTRY_FIELD_LABEL, OUTCOME_LABEL, partsLine as sharedPartsLine, STAGE_LABEL, valueLabel } from '../../server/labels.js';

// Field labels in the order they are shown (shared with the printed copies, D-60).
export const LABELS: Record<string, string> = { ...ENTRY_FIELD_LABEL };
// Master data, users and settings, as named in the audit trail.
Object.assign(LABELS, {
  code: 'ID', name: 'Name', location: 'Location', sterile: 'Sterile', classified: 'Classified room', cleanHoldHours: 'Clean-hold (hours)',
  needsCalibration: 'Needs calibration', active: 'Active', assetNumber: 'Asset no.', manufacturer: 'Manufacturer', model: 'Model',
  serialNumber: 'Serial no.', capacity: 'Capacity', installationDate: 'Installed', supplier: 'Supplier', qualificationStatus: 'Qualification',
  iq: 'IQ', oq: 'OQ', pq: 'PQ', lastRequalification: 'Last requalification', productContactMoc: 'Product contact / MOC', sopRefs: 'SOPs',
  username: 'User ID', fullName: 'Full name', roles: 'Roles', enabled: 'Switched on', sopRef: 'SOP', verificationRequired: 'Second-person verification',
  voiceLanguages: 'Voice languages', pressurePoints: 'Pressure points', limits: 'Limits', effectiveFrom: 'Effective from',
  batch: 'Batch', late: 'Late entry', lateReason: 'Late because', activityStart: 'Activity start', activityEnd: 'Activity end',
  field: 'Field', finalText: 'Confirmed text', edited: 'Edited before signing', transcript: 'Original transcript', translation: 'English translation',
  requestedLanguage: 'Language chosen', detectedLanguage: 'Language detected', durationMs: 'Length', provider: 'Service',
  fromTemporaryPassword: 'From temporary password', entries: 'Entries checked', signatures: 'Signatures checked', problemCount: 'Problems found',
  from: 'From', to: 'To', modelVersion: 'Model',
});
const ORDER = Object.keys(LABELS);
// Requalification values in words (the Qualification product's stage keys and report outcomes).
export { OUTCOME_LABEL, STAGE_LABEL };
const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);

export const partsLine = (parts: Part[]) => sharedPartsLine(parts);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// Anything else the audit trail or a record may hold, shown in words.
const text = (v: unknown): string =>
  v === null || v === undefined || v === '' ? '—'
  : v === true ? 'yes' : v === false ? 'no'
  : isObj(v) && ('date' in v || 'ref' in v) ? [v.date ? plantDay(String(v.date)) : '', v.ref].filter(Boolean).join(', ') || '—'
  : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? plantTime(v)
  : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? plantDay(v)
  : Array.isArray(v) ? (v.every((x) => !isObj(x)) ? v.map(text).join(', ') : `${v.length} item${v.length === 1 ? '' : 's'}`)
  : isObj(v) ? Object.entries(v).map(([k, x]) => `${LABELS[k] ?? k}: ${text(x)}`).join('; ')
  : String(v).replaceAll('_', ' ');
export const fieldValue = (k: string, v: unknown): string =>
  k === 'nextDue' ? plantDay(String(v).slice(0, 10))
  : (k === 'detectedLanguage' || k === 'requestedLanguage') && typeof v === 'string' ? VOICE_LANGUAGE_LABEL[v] ?? v
  : k === 'durationMs' && typeof v === 'number' ? `${(v / 1000).toFixed(1)} s`
  : k === 'occurredAt' ? plantTime(String(v))
  : k === 'parts' ? partsLine(v as Part[])
  : k === 'partsNone' ? 'none'
  // D-60: a picked value in the entry form's words ("Product changeover", "In-house").
  : valueLabel(k, v) ?? text(v);


// Data fields one per line, in reading order, empty ones left out.
export function Fields({ data, extra = [] }: { data: Record<string, unknown>; extra?: [string, string][] }) {
  const parts = Object.entries(data)
    .filter(([k, v]) => k !== 'checklist' && v !== '' && v !== false && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([k, v]): [string, string] => [LABELS[k] ?? k, fieldValue(k, v)]);
  parts.push(...extra);
  if (!parts.length) return <span>—</span>;
  return (
    <dl className="fields">
      {parts.map(([label, v]) => <div key={label}><dt>{label}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}
