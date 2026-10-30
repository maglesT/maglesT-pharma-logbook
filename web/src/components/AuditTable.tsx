import { MEANING_LABEL, plantTime, TYPE_LABEL } from '../api.js';
import { LABELS, fieldValue } from '../fields.js';

export interface AuditRow {
  id: number;
  at: string;
  actor: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  subject: { code?: string; name?: string; logbookType?: string; entryId?: number; username?: string; version?: number } | null;
}

// LB-18: the audit trail in words. The stored values stay complete under "Technical details".
const ACTION: Record<string, string> = {
  'entry.created': 'Entry made',
  'entry.completed': 'Activity ended',
  'entry.corrected': 'Entry corrected',
  'login': 'Logged in',
  'logout': 'Logged out',
  'login.failed': 'Failed login',
  'password.changed': 'Password changed',
  'signature.failed': 'Signature refused (wrong password)',
  'user.created': 'User created',
  'user.updated': 'User changed',
  'user.locked': 'Account locked (too many wrong passwords)',
  'password.change_failed': 'Password change refused',
  'user.password_reset': 'Temporary password issued',
  'equipment.created': 'Item created',
  'equipment.updated': 'Master data changed',
  'equipment.details_updated': 'Equipment details changed',
  'product.created': 'Product created',
  'product.updated': 'Product changed',
  'settings.drafted': 'Logbook settings drafted',
  'settings.edited': 'Logbook settings draft changed',
  'review.created': 'Period review prepared',
  'site.created': 'Site created',
  'site.updated': 'Site changed',
  'voice_note.created': 'Voice note recorded',
  'voice_note.confirmed': 'Voice note text confirmed',
  'integrity.passed': 'Integrity check passed',
  'integrity.failed': 'Integrity check found problems',
  'alert.acknowledged': 'Security alert acknowledged',
  'breakdown_advice.generated': 'AI breakdown suggestion shown',
};
const actionText = (a: string) =>
  ACTION[a] ?? (a.startsWith('signed.') ? `Signed: ${MEANING_LABEL[a.slice(7)] ?? a.slice(7)}` : a.replaceAll(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()));
const SITE_SETTING: Record<string, string> = { voice_notes: 'Voice notes', breakdown_advice: 'Breakdown suggestions' };
const signed = (a: string) => a.startsWith('signed.');

// Kept for auditors in the technical view, not in the readable lines.
const TECH = new Set(['contentHash', 'signatureId', 'id', 'entryId', 'version', 'requestIds', 'audioSha256', 'audioBytes', 'audioMime', 'enteredAt',
  'enteredBy', 'supersedes', 'settingsId', 'shownHash', 'responseId', 'basedOn', 'versions', 'hash', 'change', 'equipmentId', 'logbookType',
  'entryVersionId', 'requestedAt', 'problems', 'productId', 'model', 'checklist']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
// Entries keep their fields under data, equipment details under details, settings under settings.
const flat = (v: unknown): Obj => {
  if (!isObj(v)) return {};
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) {
    if ((k === 'data' || k === 'details' || k === 'settings') && isObj(x)) Object.assign(out, x);
    else out[k] = x;
  }
  return out;
};
const show = (v: unknown) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0) && !(isObj(v) && !Object.keys(v).length);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const label = (k: string) => LABELS[k] ?? k;

function lines(a: AuditRow): string[] {
  if (signed(a.action)) return [];
  if (a.action === 'breakdown_advice.generated' && isObj(a.newValue)) {
    const n = a.newValue as { modelVersion?: string; basedOn?: number[]; advice?: { summary?: string } };
    return [`Model: ${n.modelVersion ?? '—'}`, `Based on ${n.basedOn?.length ?? 0} past breakdowns`, n.advice?.summary ?? ''].filter(Boolean);
  }
  if (a.action === 'review.created' && isObj(a.newValue)) {
    const n = a.newValue as { from?: string; to?: string; versions?: unknown[] };
    return [`Period ${plantTime(n.from ?? '')} to ${plantTime(n.to ?? '')}`, `${n.versions?.length ?? 0} entry versions`];
  }
  const before = flat(a.oldValue);
  const after = flat(a.newValue);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !TECH.has(k));
  if (a.oldValue != null) {
    return keys.filter((k) => !same(before[k], after[k])).map((k) => `${label(k)}: ${show(before[k]) ? fieldValue(k, before[k]) : '—'} → ${show(after[k]) ? fieldValue(k, after[k]) : '—'}`);
  }
  return keys.filter((k) => show(after[k])).map((k) => `${label(k)}: ${fieldValue(k, after[k])}`);
}

function subjectText(a: AuditRow) {
  const s = a.subject;
  if (!s) return a.objectType === 'system' ? 'System' : `${a.objectType.replaceAll('_', ' ')} ${a.objectId ?? ''}`;
  if (a.objectType === 'user') return `User ${s.username}${s.name ? ` · ${s.name}` : ''}`;
  if (a.objectType === 'settings') return `${TYPE_LABEL[s.logbookType ?? ''] ?? SITE_SETTING[s.logbookType ?? ''] ?? s.logbookType} settings, version ${s.version}`;
  if (a.objectType === 'product') return `Product ${s.code} · ${s.name}`;
  if (a.objectType === 'review') return `Period review · ${s.code}`;
  const what = s.logbookType ? ` · ${TYPE_LABEL[s.logbookType] ?? s.logbookType}${s.entryId ? ` #${s.entryId}` : ''}` : '';
  return `${s.code}${what}${a.objectType === 'voice_note' ? ' · voice note' : ''}`;
}

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  if (!rows.length) return <p className="muted">No audit-trail records for this selection.</p>;
  return (
    <div className="table-wrap">
      <table className="audit">
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>About</th><th>Details</th></tr></thead>
        <tbody>
          {rows.map((a) => {
            const l = lines(a);
            return (
              <tr key={a.id}>
                <td className="nowrap">{plantTime(a.at)}</td>
                <td>{a.actor ?? 'System'}</td>
                <td><span className={`act act-${a.action.split('.')[0]}${a.action.endsWith('failed') ? ' act-bad' : ''}`}>{actionText(a.action)}</span></td>
                <td>{subjectText(a)}</td>
                <td>
                  {a.reason && <div><strong>Reason:</strong> {a.reason}</div>}
                  {l.length > 0 && <ul className="audit-lines">{l.map((x, i) => <li key={i}>{x}</li>)}</ul>}
                  {(a.oldValue != null || a.newValue != null) && (
                    <details className="tech">
                      <summary>Technical details</summary>
                      {a.oldValue != null && <pre>Old: {JSON.stringify(a.oldValue, null, 1)}</pre>}
                      {a.newValue != null && <pre>New: {JSON.stringify(a.newValue, null, 1)}</pre>}
                    </details>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
