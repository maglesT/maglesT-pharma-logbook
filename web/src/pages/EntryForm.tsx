import { useState, type FormEvent } from 'react';
import { api, ApiError, localInputValue, PERFORMER_SIGNS, TYPE_LABEL, type Entry, type Equipment, type Product, type Settings } from '../api.js';

type Data = Record<string, unknown>;

// Defaults for a new entry of each type.
const EMPTY: Record<string, Data> = {
  equipment_use: { stage: '', remarks: '' },
  equipment_cleaning: { cleaningType: 'batch_to_batch', checklist: {}, remarks: '' },
  maintenance: { kind: 'preventive', description: '', workDone: '', impactAssessment: '' },
  calibration: { result: 'pass', certificateRef: '', nextDue: '', remarks: '', comment: '', deviationRef: '' },
  area_cleaning: { cleaningType: 'daily', agent: '', sporicidal: false, disinfectantLot: '', checklist: {}, remarks: '' },
  general_log: { checklist: {}, notes: '' },
};

const OPTIONS: Record<string, Record<string, [string, string][]>> = {
  equipment_cleaning: { cleaningType: [['batch_to_batch', 'Batch to batch'], ['product_change', 'Product changeover'], ['major', 'Major']] },
  maintenance: { kind: [['preventive', 'Preventive'], ['breakdown', 'Breakdown'], ['repair', 'Repair']] },
  calibration: { result: [['pass', 'Pass'], ['fail', 'Fail']] },
  area_cleaning: { cleaningType: [['daily', 'Daily'], ['weekly', 'Weekly'], ['product_change', 'Product changeover'], ['other', 'Other']] },
};

const TEXT_FIELDS: Record<string, [string, string, boolean?][]> = {
  equipment_use: [['stage', 'Stage'], ['remarks', 'Remarks', true]],
  equipment_cleaning: [['remarks', 'Remarks', true]],
  maintenance: [['description', 'What happened / what is planned', true], ['workDone', 'Work done', true], ['impactAssessment', 'Impact assessment (sterile equipment)', true]],
  calibration: [['certificateRef', 'Certificate / report reference'], ['remarks', 'Remarks', true], ['comment', 'Comment (needed if failed)', true], ['deviationRef', 'Deviation reference (needed if failed)']],
  area_cleaning: [['agent', 'Cleaning / disinfecting agent'], ['disinfectantLot', 'Disinfectant lot'], ['remarks', 'Remarks', true]],
  general_log: [['notes', 'Notes', true]],
};

const HAS_CHECKLIST = new Set(['equipment_cleaning', 'area_cleaning', 'general_log']);
const HAS_END = new Set(['equipment_cleaning', 'maintenance', 'area_cleaning']);

// One form for every core logbook type. With `correcting`, it edits a copy of that version and
// asks for a reason; the server stores a new version (LB-17).
export function EntryForm({
  type,
  equipment,
  settings,
  products,
  correcting,
  onDone,
  onCancel,
}: {
  type: string;
  equipment: Equipment;
  settings: Settings;
  products: Product[];
  correcting?: Entry;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [data, setData] = useState<Data>(correcting ? { ...correcting.data } : { ...EMPTY[type] });
  const [start, setStart] = useState(localInputValue(correcting?.activityStart ?? new Date()));
  const [end, setEnd] = useState(localInputValue(correcting?.activityEnd ?? new Date()));
  const [productId, setProductId] = useState<number | ''>(correcting?.productId ?? '');
  const [batch, setBatch] = useState(correcting?.batch ?? '');
  const [lateReason, setLateReason] = useState('');
  const [reason, setReason] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [needLateReason, setNeedLateReason] = useState(false);

  const signs = Boolean(correcting) || PERFORMER_SIGNS.has(type);
  const set = (k: string, v: unknown) => setData({ ...data, [k]: v });
  const checklist = (data.checklist ?? {}) as Record<string, boolean>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblems([]);
    const body: Record<string, unknown> = {
      activityStart: new Date(start).toISOString(),
      data: type === 'calibration' && data.nextDue ? { ...data, nextDue: new Date(String(data.nextDue)).toISOString() } : data,
    };
    if (HAS_END.has(type) || (correcting && correcting.activityEnd)) body.activityEnd = new Date(end).toISOString();
    if (type === 'equipment_use') Object.assign(body, { productId: productId || undefined, batch: batch || undefined });
    if (signs) body.signature = { username, password };
    try {
      if (correcting) {
        await api('POST', `/api/entries/${correcting.id}/correct`, { ...body, reason });
      } else {
        await api('POST', `/api/equipment/${equipment.id}/entries`, { ...body, logbookType: type, lateReason: lateReason || undefined });
      }
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'late_reason_required') setNeedLateReason(true);
      const msg: Record<string, string> = {
        wrong_credentials: 'User ID or password is wrong. Repeated failures lock your account.',
        late_reason_required: 'This is a late entry: give the reason below.',
        future_time: 'A time cannot be in the future.',
        type_not_configured: 'This logbook type has no approved settings yet.',
        forbidden: 'Your role may not make this entry.',
      };
      const details = err instanceof ApiError ? err.problems : [];
      setProblems([msg[(err as ApiError).code] ?? (err as Error).message, ...details]);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <form className="card dialog wide" onSubmit={submit}>
        <h2>{correcting ? 'Correct' : 'New'}: {TYPE_LABEL[type]} · {equipment.code}</h2>
        {settings.sopRef && <p className="muted">SOP {settings.sopRef}</p>}

        {type === 'equipment_use' && (
          <>
            <label>
              Product
              <select value={productId} onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Choose…</option>
                {products.filter((p) => p.active || p.id === productId).map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
              </select>
            </label>
            <label>Batch number<input value={batch} onChange={(e) => setBatch(e.target.value)} /></label>
          </>
        )}

        <label>{type === 'equipment_use' ? 'Start of use' : HAS_END.has(type) ? 'Start' : 'Date and time'}<input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        {(HAS_END.has(type) || (correcting && correcting.activityEnd)) && (
          <label>End<input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        )}

        {Object.entries(OPTIONS[type] ?? {}).map(([k, opts]) => (
          <label key={k}>
            {k === 'kind' ? 'Type' : k === 'result' ? 'Result' : 'Cleaning type'}
            <select value={String(data[k])} onChange={(e) => set(k, e.target.value)}>
              {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        ))}
        {type === 'calibration' && (
          <label>Next due<input type="date" value={String(data.nextDue ?? '').slice(0, 10)} onChange={(e) => set('nextDue', e.target.value)} /></label>
        )}
        {type === 'area_cleaning' && (
          <label className="check"><input type="checkbox" checked={Boolean(data.sporicidal)} onChange={(e) => set('sporicidal', e.target.checked)} />Sporicidal agent</label>
        )}
        {HAS_CHECKLIST.has(type) && settings.checklist.length > 0 && (
          <fieldset className="checklist">
            <legend>Checklist</legend>
            {settings.checklist.map((item) => (
              <label key={item} className="check">
                <input type="checkbox" checked={checklist[item] === true} onChange={(e) => set('checklist', { ...checklist, [item]: e.target.checked })} />
                {item}
              </label>
            ))}
          </fieldset>
        )}
        {(TEXT_FIELDS[type] ?? []).map(([k, label, long]) =>
          type === 'maintenance' && k === 'impactAssessment' && !equipment.sterile ? null : (
            <label key={k}>
              {label}
              {long ? <textarea value={String(data[k] ?? '')} onChange={(e) => set(k, e.target.value)} /> : <input value={String(data[k] ?? '')} onChange={(e) => set(k, e.target.value)} />}
            </label>
          ),
        )}

        {needLateReason && !correcting && (
          <label>Reason for late entry<input value={lateReason} onChange={(e) => setLateReason(e.target.value)} placeholder="e.g. transcribed from paper form no. …" /></label>
        )}
        {correcting && <label>Reason for correction<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>}

        {signs && (
          <div className="signbox">
            <strong>Sign: {correcting ? 'Corrected' : 'Performed'}</strong>
            <p className="muted">Your electronic signature is the legally binding equivalent of your handwritten signature.</p>
            <label>User ID<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></label>
            <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
          </div>
        )}

        {problems.length > 0 && <ul className="error">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="submit">{signs ? 'Sign and save' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}
