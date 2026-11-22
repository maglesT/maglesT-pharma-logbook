import { useEffect, useState } from 'react';
import { api, sopRefsOf, type QmsSop, type QmsSops } from '../api.js';

const sopName = (s: QmsSop) => `${s.number}${s.revision ? ` rev ${s.revision}` : ''}${s.title ? ` · ${s.title}` : ''}`;

/**
 * D-79: an SOP reference field. QMS linked: the SOPs are picked from QMS' effective SOPs (none typed); those already recorded
 * stay as recorded. QMS not answering: read only, with the note. Not linked (standalone): typed, as before.
 */
export function SopPicker({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [qms, setQms] = useState<QmsSops | null>(null);
  useEffect(() => { void api<QmsSops>('GET', '/api/sops').then(setQms).catch(() => setQms(null)); }, []);
  if (!qms?.linked) return <label>{label}<input value={value} onChange={(e) => onChange(e.target.value)} /></label>;
  const refs = sopRefsOf(value);
  const of = (r: string) => qms.sops.find((s) => s.number.toUpperCase() === r.toUpperCase());
  const left = qms.sops.filter((s) => !refs.some((r) => r.toUpperCase() === s.number.toUpperCase()));
  return (
    <fieldset className="sop-picker">
      <legend>{label}</legend>
      <p className={qms.available ? 'muted' : 'error'}>{qms.note}</p>
      {refs.length === 0 ? <p className="muted">None</p> : (
        <ul>
          {refs.map((r) => {
            const s = of(r);
            return (
              <li key={r}>
                {s ? sopName(s) : `${r}${qms.available ? ' (as recorded; not an effective SOP in ASSURE)' : ''}`}
                {qms.available && <> <button type="button" onClick={() => onChange(refs.filter((x) => x !== r).join(', '))}>Remove {r}</button></>}
              </li>
            );
          })}
        </ul>
      )}
      {qms.available && (
        <label>Add an SOP from ASSURE
          <select value="" onChange={(e) => e.target.value && onChange([...refs, e.target.value].join(', '))}>
            <option value="">Pick an SOP</option>
            {left.map((s) => <option key={s.number} value={s.number}>{sopName(s)}</option>)}
          </select>
        </label>
      )}
    </fieldset>
  );
}
