import { plantTime, VOICE_LANGUAGE_LABEL, type Part } from './api.js';

// Field labels in the order they are shown; a breakdown reads top to bottom from failure to repair.
export const LABELS: Record<string, string> = {
  kind: 'Type', occurredAt: 'Occurred', reportedBy: 'Reported by', failureCategory: 'Failure category', description: 'What happened',
  impactAssessment: 'Impact assessment', rootCause: 'Root cause', workDone: 'Work done', parts: 'Parts used', partsNone: 'Parts used',
  toolsUsed: 'Tools / consumables', doneBy: 'Done by', vendorName: 'Vendor', serviceReportRef: 'Service report', workOrderRef: 'Work order',
  postRepairChecks: 'Post-repair checks', recalibrationNeeded: 'Re-calibration needed',
  stage: 'Stage', cleaningType: 'Cleaning', agent: 'Agent', sporicidal: 'Sporicidal', disinfectantLot: 'Disinfectant lot',
  cycleType: 'Cycle', cycleId: 'Cycle no.', programme: 'Programme', load: 'Load', controllerRecordRef: 'Controller record', indicators: 'Indicators',
  test: 'Test', port: 'Port', method: 'Method', point: 'Point', value: 'Reading', outOfLimit: 'OUT OF LIMITS',
  result: 'Result', certificateRef: 'Certificate', nextDue: 'Next due', notes: 'Notes', remarks: 'Remarks', comment: 'Comment', deviationRef: 'Deviation',
};
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
const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);

export const partsLine = (parts: Part[]) => parts.map((p) => `${p.quantity} × ${p.name}${p.partNumber ? ` (P/N ${p.partNumber})` : ''}${p.lotSerial ? `, lot/SN ${p.lotSerial}` : ''}`).join('; ');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// Anything else the audit trail or a record may hold, shown in words.
const text = (v: unknown): string =>
  v === null || v === undefined || v === '' ? '—'
  : v === true ? 'yes' : v === false ? 'no'
  : isObj(v) && ('date' in v || 'ref' in v) ? [v.date, v.ref].filter(Boolean).join(', ') || '—'
  : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? plantTime(v)
  : Array.isArray(v) ? (v.every((x) => !isObj(x)) ? v.map(text).join(', ') : `${v.length} item${v.length === 1 ? '' : 's'}`)
  : isObj(v) ? Object.entries(v).map(([k, x]) => `${LABELS[k] ?? k}: ${text(x)}`).join('; ')
  : String(v).replaceAll('_', ' ');
export const fieldValue = (k: string, v: unknown): string =>
  k === 'nextDue' ? String(v).slice(0, 10)
  : (k === 'detectedLanguage' || k === 'requestedLanguage') && typeof v === 'string' ? VOICE_LANGUAGE_LABEL[v] ?? v
  : k === 'durationMs' && typeof v === 'number' ? `${(v / 1000).toFixed(1)} s`
  : k === 'occurredAt' ? plantTime(String(v))
  : k === 'parts' ? partsLine(v as Part[])
  : k === 'partsNone' ? 'none'
  : k === 'doneBy' ? (v === 'vendor' ? 'external vendor' : 'in-house')
  : text(v);


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
