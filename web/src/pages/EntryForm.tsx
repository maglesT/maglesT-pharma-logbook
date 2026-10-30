import { Fragment, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, FAILURE_CATEGORIES, localInputValue, PERFORMER_SIGNS, TYPE_LABEL, VOICE_LANGUAGE_LABEL, type Entry, type Equipment, type Part, type Product, type Settings, type VoiceConfig, type VoiceDraft } from '../api.js';
import { VoiceButton } from '../components/VoiceNote.js';

type Data = Record<string, unknown>;

// Defaults for a new entry of each type.
const EMPTY: Record<string, Data> = {
  equipment_use: { stage: '', remarks: '' },
  equipment_cleaning: { cleaningType: 'batch_to_batch', checklist: {}, remarks: '' },
  maintenance: {
    kind: 'preventive', description: '', workDone: '', impactAssessment: '', reportedBy: '', failureCategory: '', rootCause: '', parts: [],
    partsNone: false, toolsUsed: '', doneBy: '', vendorName: '', serviceReportRef: '', workOrderRef: '', deviationRef: '', postRepairChecks: '', recalibrationNeeded: false,
  },
  calibration: { result: 'pass', certificateRef: '', nextDue: '', remarks: '', comment: '', deviationRef: '' },
  area_cleaning: { cleaningType: 'daily', agent: '', sporicidal: false, disinfectantLot: '', checklist: {}, remarks: '' },
  general_log: { checklist: {}, notes: '' },
  steriliser_cycle: { cycleType: 'steam', cycleId: '', programme: '', load: '', result: 'pass', controllerRecordRef: '', indicators: '', remarks: '', comment: '', deviationRef: '' },
  steriliser_test: { test: 'air_removal', result: 'pass', remarks: '', comment: '', deviationRef: '' },
  glove_integrity: { port: '', method: '', result: 'pass', remarks: '', comment: '', deviationRef: '' },
  pressure_reading: { point: '', value: '', comment: '', deviationRef: '' },
};

const OPTIONS: Record<string, Record<string, [string, string][]>> = {
  equipment_cleaning: { cleaningType: [['batch_to_batch', 'Batch to batch'], ['product_change', 'Product changeover'], ['major', 'Major']] },
  maintenance: { kind: [['preventive', 'Preventive'], ['breakdown', 'Breakdown'], ['repair', 'Repair']] },
  calibration: { result: [['pass', 'Pass'], ['fail', 'Fail']] },
  area_cleaning: { cleaningType: [['daily', 'Daily'], ['weekly', 'Weekly'], ['product_change', 'Product changeover'], ['other', 'Other']] },
  steriliser_cycle: { cycleType: [['steam', 'Steam (autoclave)'], ['dry_heat', 'Dry heat / depyrogenation'], ['sip', 'Steam in place'], ['vhp', 'VHP bio-decontamination']], result: [['pass', 'Pass'], ['fail', 'Fail']] },
  steriliser_test: { test: [['air_removal', 'Air removal (Bowie-Dick)'], ['leak', 'Leak (vacuum) test']], result: [['pass', 'Pass'], ['fail', 'Fail']] },
  glove_integrity: { result: [['pass', 'Pass'], ['fail', 'Fail']] },
};

const TEXT_FIELDS: Record<string, [string, string, boolean?][]> = {
  equipment_use: [['stage', 'Stage'], ['remarks', 'Remarks', true]],
  equipment_cleaning: [['remarks', 'Remarks', true]],
  // Maintenance has its own field layout (MaintenanceFields, S9).
  maintenance: [],
  calibration: [['certificateRef', 'Certificate / report reference'], ['remarks', 'Remarks', true], ['comment', 'Comment (needed if failed)', true], ['deviationRef', 'Deviation reference (needed if failed)']],
  area_cleaning: [['agent', 'Cleaning / disinfecting agent'], ['disinfectantLot', 'Disinfectant lot'], ['remarks', 'Remarks', true]],
  general_log: [['notes', 'Notes', true]],
  steriliser_cycle: [['cycleId', 'Cycle number'], ['programme', 'Programme'], ['load', 'Load', true], ['controllerRecordRef', 'Controller printout / record reference'], ['indicators', 'Indicators (BI/CI) used'], ['remarks', 'Remarks', true], ['comment', 'Comment (needed if failed)', true], ['deviationRef', 'Deviation reference (needed if failed)']],
  steriliser_test: [['remarks', 'Remarks', true], ['comment', 'Comment (needed if failed)', true], ['deviationRef', 'Deviation reference (needed if failed)']],
  glove_integrity: [['port', 'Glove port'], ['method', 'Test method'], ['remarks', 'Remarks', true], ['comment', 'Comment (needed if failed)', true], ['deviationRef', 'Deviation reference (needed if failed)']],
  pressure_reading: [['comment', 'Comment (needed if out of limits)', true], ['deviationRef', 'Deviation reference (needed if out of limits)']],
};

const OPTION_LABEL: Record<string, string> = { kind: 'Type', result: 'Result', cleaningType: 'Cleaning type', cycleType: 'Cycle type', test: 'Test' };

const HAS_CHECKLIST = new Set(['equipment_cleaning', 'area_cleaning', 'general_log']);
const HAS_END = new Set(['equipment_cleaning', 'maintenance', 'area_cleaning', 'steriliser_cycle']);

const BREAKDOWN_ONLY = ['occurredAt', 'reportedBy', 'failureCategory', 'rootCause'];

// Maintenance data as the server takes it: empty choices left out, quantities as numbers. An
// occurrence time the user did not touch is sent exactly as stored (review S9).
function maintenancePayload(data: Data, occurredLocal: string, storedOccurred: { local: string; iso: unknown }): Data {
  const out: Data = { ...data, parts: ((data.parts ?? []) as Part[]).map((p) => ({ ...p, quantity: Number(String(p.quantity).replace(',', '.')) })) };
  if (data.kind === 'breakdown' && storedOccurred.iso && occurredLocal === storedOccurred.local) out.occurredAt = storedOccurred.iso;
  else if (data.kind === 'breakdown' && occurredLocal) out.occurredAt = new Date(occurredLocal).toISOString();
  else delete out.occurredAt;
  for (const k of ['failureCategory', 'doneBy']) if (!out[k]) delete out[k];
  if (out.doneBy !== 'vendor') Object.assign(out, { vendorName: '', serviceReportRef: '' });
  if (data.kind !== 'breakdown') for (const k of BREAKDOWN_ONLY) delete out[k];
  return out;
}

// One form for every core logbook type. With `correcting`, it edits a copy of that version and
// asks for a reason; the server stores a new version (LB-17). With `completing`, it finishes an
// open breakdown repair: the reported part stays as reported (D-25).
export function EntryForm({
  type,
  equipment,
  settings,
  products,
  correcting,
  completing,
  voice,
  onDone,
  onCancel,
}: {
  type: string;
  equipment: Equipment;
  settings: Settings;
  products: Product[];
  correcting?: Entry;
  completing?: Entry;
  // D-26: voice notes, when the site has them switched on.
  voice?: VoiceConfig;
  onDone: () => void;
  onCancel: () => void;
}) {
  const source = correcting ?? completing;
  const [data, setData] = useState<Data>(source ? { ...EMPTY[type], ...source.data } : { ...EMPTY[type] });
  // A new breakdown defaults to now; one recorded before S9 has no occurrence time, and none is invented.
  const storedOccurred = { iso: source?.data.occurredAt, local: source?.data.occurredAt ? localInputValue(String(source.data.occurredAt)) : '' };
  const [occurredLocal, setOccurredLocal] = useState(source ? storedOccurred.local : localInputValue());
  // A new breakdown may be reported before the repair has ended.
  const [repairEnded, setRepairEnded] = useState(true);
  const [start, setStart] = useState(localInputValue(source?.activityStart ?? new Date()));
  const [initialEnd] = useState(localInputValue(correcting?.activityEnd ?? new Date()));
  const [end, setEnd] = useState(initialEnd);
  const [productId, setProductId] = useState<number | ''>(correcting?.productId ?? '');
  const [batch, setBatch] = useState(correcting?.batch ?? '');
  const [lateReason, setLateReason] = useState('');
  const [reason, setReason] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  // Voice-note drafts per field, with the text the field had before; signed on save (D-26).
  const [drafts, setDrafts] = useState<Record<string, VoiceDraft & { previous: string }>>({});
  const [voiceUser, setVoiceUser] = useState('');
  const [voicePassword, setVoicePassword] = useState('');
  const [needLateReason, setNeedLateReason] = useState(false);

  const signs = Boolean(correcting) || PERFORMER_SIGNS.has(type);
  const voiceDrafts = Object.entries(drafts);
  // The voice-note button, or the draft notice once a voice note filled the field.
  const voiceSlot = (k: string): ReactNode => {
    const d = drafts[k];
    if (d) {
      return (
        <div className="voice-draft" role="status">
          <strong>Draft from a voice note ({VOICE_LANGUAGE_LABEL[d.detectedLanguage ?? ''] ?? d.detectedLanguage ?? 'detected language'}).</strong>{' '}
          Read and correct the English text above; it becomes part of the entry only when you sign below.
          <div className="muted" lang={d.detectedLanguage ?? undefined}>You said: {d.transcript}</div>
          <button type="button" onClick={() => {
            setData({ ...data, [k]: d.previous });
            const { [k]: _gone, ...rest } = drafts;
            setDrafts(rest);
          }}>Discard voice note</button>
        </div>
      );
    }
    if (!voice?.enabled || !(voice.fields[type] ?? []).includes(k)) return null;
    return (
      <VoiceButton config={voice} equipmentId={equipment.id} logbookType={type} field={k}
        onDraft={(v) => {
          setData((current) => ({ ...current, [k]: v.translation }));
          setDrafts((current) => ({ ...current, [k]: { ...v, previous: String(data[k] ?? '') } }));
        }} />
    );
  };
  const openBreakdown = type === 'maintenance' && data.kind === 'breakdown' && !correcting && !completing && !repairEnded;
  // A correction keeps an open repair open (D-25).
  const showEnd = completing ? true : correcting ? Boolean(correcting.activityEnd) : HAS_END.has(type) && !openBreakdown;
  const set = (k: string, v: unknown) => setData({ ...data, [k]: v });
  const checklist = (data.checklist ?? {}) as Record<string, boolean>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblems([]);
    const body: Record<string, unknown> = {
      activityStart: new Date(start).toISOString(),
      // The server decides whether a reading is out of limits.
      data: type === 'maintenance' ? maintenancePayload(data, occurredLocal, storedOccurred) : type === 'pressure_reading'
        ? {
            point: data.point,
            // An empty field is sent as missing, never as 0; a decimal comma is accepted (review S6-3).
            value: String(data.value ?? '').trim() === '' ? null : Number(String(data.value).trim().replace(',', '.')),
            comment: data.comment,
            deviationRef: data.deviationRef,
          }
        : data,
    };
    // Completing with the end left as offered means "now", to the second, as "End use" does (review S9).
    if (showEnd) body.activityEnd = completing && end === initialEnd ? new Date().toISOString() : new Date(end).toISOString();
    if (type === 'equipment_use') Object.assign(body, { productId: productId || undefined, batch: batch || undefined });
    if (signs) body.signature = { username, password };
    if (voiceDrafts.length) {
      if (!voiceUser.trim() || !voicePassword) return setProblems(['Sign to confirm the voice-note text: enter your user ID and password.']);
      body.voiceNotes = voiceDrafts.map(([field, d]) => ({ id: d.id, field, finalText: String(data[field] ?? '') }));
      body.voiceSignature = { username: voiceUser, password: voicePassword };
    }
    try {
      if (completing) {
        await api('POST', `/api/entries/${completing.id}/complete`, { activityEnd: body.activityEnd, data: body.data, signature: body.signature,
          voiceNotes: body.voiceNotes, voiceSignature: body.voiceSignature, lateReason: lateReason || undefined });
      } else if (correcting) {
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
        not_fit_for_use: 'This equipment is not fit for use:',
        in_use: 'The equipment is in use.',
        forbidden: 'Your role may not make this entry.',
        voice_signature_required: 'Sign to confirm the voice-note text.',
        voice_confirmation_required: 'Confirm the voice-note text with your signature first.',
        voice_check_failed: 'The voice note cannot be confirmed:',
      };
      const details = err instanceof ApiError ? err.problems : [];
      setProblems([msg[(err as ApiError).code] ?? (err as Error).message, ...details]);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <form className="card dialog wide" onSubmit={submit}>
        <h2>{completing ? 'Complete repair' : correcting ? 'Correct' : 'New'}: {TYPE_LABEL[type]} · {equipment.code}</h2>
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

        {type === 'maintenance' ? (
          <MaintenanceFields data={data} set={set} setData={setData} equipment={equipment} occurredLocal={occurredLocal} setOccurredLocal={setOccurredLocal}
            reportedLocked={Boolean(completing)} start={start} setStart={setStart} end={end} setEnd={setEnd} showEnd={showEnd}
            newEntry={!correcting && !completing} repairEnded={repairEnded} setRepairEnded={setRepairEnded} voiceSlot={voiceSlot} />
        ) : (
          <>
            <label>{type === 'equipment_use' ? 'Start of use' : HAS_END.has(type) ? 'Start' : 'Date and time'}<input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
            {showEnd && <label>End<input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label>}
          </>
        )}

        {Object.entries(type === 'maintenance' ? {} : (OPTIONS[type] ?? {})).map(([k, opts]) => (
          <label key={k}>
            {OPTION_LABEL[k] ?? k}
            <select value={String(data[k])} onChange={(e) => set(k, e.target.value)}>
              {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        ))}
        {type === 'calibration' && (
          <label>Next due<input type="date" value={String(data.nextDue ?? '').slice(0, 10)} onChange={(e) => set('nextDue', e.target.value)} /></label>
        )}
        {type === 'pressure_reading' && (
          <>
            <label>
              Pressure point
              <select value={String(data.point)} onChange={(e) => set('point', e.target.value)}>
                <option value="">Choose…</option>
                {settings.pressurePoints.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.min}–{p.max} {p.unit})</option>)}
              </select>
            </label>
            <label>Reading (Pa)<input inputMode="decimal" value={String(data.value ?? '')} onChange={(e) => set('value', e.target.value)} /></label>
          </>
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
            <Fragment key={k}>
              <label>
                {label}
                {long ? <textarea value={String(data[k] ?? '')} onChange={(e) => set(k, e.target.value)} /> : <input value={String(data[k] ?? '')} onChange={(e) => set(k, e.target.value)} />}
              </label>
              {voiceSlot(k)}
            </Fragment>
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
        {voiceDrafts.length > 0 && voice && (
          <div className="signbox">
            <strong>Sign: Voice note confirmed</strong>
            <p>“{voice.statement}”</p>
            <p className="muted">This covers the English text of: {voiceDrafts.map(([f]) => f).join(', ')}. The audio and the original-language transcript are kept with the entry.</p>
            <label>Voice note user ID<input value={voiceUser} onChange={(e) => setVoiceUser(e.target.value)} autoComplete="off" /></label>
            <label>Voice note password<input type="password" value={voicePassword} onChange={(e) => setVoicePassword(e.target.value)} autoComplete="current-password" /></label>
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

const FAILURE_LABEL: Record<string, string> = {
  mechanical: 'Mechanical', electrical: 'Electrical', utility: 'Utility', instrumentation: 'Instrumentation', software: 'Software', operator: 'Operator', other: 'Other',
};

// Maintenance and breakdown fields (S9, D-25): the report (when it occurred, what failed), the repair
// times, and what was done and used.
function MaintenanceFields({
  data, set, setData, equipment, occurredLocal, setOccurredLocal, reportedLocked, start, setStart, end, setEnd, showEnd, newEntry, repairEnded, setRepairEnded, voiceSlot,
}: {
  data: Data;
  set: (k: string, v: unknown) => void;
  setData: (d: Data) => void;
  equipment: Equipment;
  occurredLocal: string;
  setOccurredLocal: (v: string) => void;
  reportedLocked: boolean;
  start: string;
  setStart: (v: string) => void;
  end: string;
  setEnd: (v: string) => void;
  showEnd: boolean;
  newEntry: boolean;
  repairEnded: boolean;
  setRepairEnded: (v: boolean) => void;
  voiceSlot: (k: string) => ReactNode;
}) {
  const breakdown = data.kind === 'breakdown';
  const parts = (data.parts ?? []) as Part[];
  const setPart = (i: number, k: keyof Part, v: string) => set('parts', parts.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  const text = (k: string, label: string, long = false, locked = false) => (
    <Fragment key={k}>
      <label>
        {label}
        {long
          ? <textarea value={String(data[k] ?? '')} onChange={(e) => set(k, e.target.value)} disabled={locked} />
          : <input value={String(data[k] ?? '')} onChange={(e) => set(k, e.target.value)} disabled={locked} />}
      </label>
      {!locked && voiceSlot(k)}
    </Fragment>
  );
  // Completing a repair: the report stays as reported (D-25).
  const locked = reportedLocked;
  return (
    <>
      <label>
        Type
        <select value={String(data.kind)} onChange={(e) => set('kind', e.target.value)} disabled={locked}>
          {OPTIONS.maintenance!.kind!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      {breakdown && (
        <fieldset className="checklist">
          <legend>Breakdown report</legend>
          <label>Breakdown occurred at<input type="datetime-local" value={occurredLocal} onChange={(e) => setOccurredLocal(e.target.value)} disabled={locked} /></label>
          {text('reportedBy', 'Reported by', false, locked)}
          <label>
            Failure category
            <select value={String(data.failureCategory ?? '')} onChange={(e) => set('failureCategory', e.target.value)} disabled={locked}>
              <option value="">Choose…</option>
              {FAILURE_CATEGORIES.map((c) => <option key={c} value={c}>{FAILURE_LABEL[c]}</option>)}
            </select>
          </label>
          {text('description', 'Failure / symptom', true, locked)}
        </fieldset>
      )}
      {!breakdown && text('description', 'What happened / what is planned', true)}
      <label>{breakdown ? 'Repair start' : 'Start'}<input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} disabled={locked} /></label>
      {breakdown && newEntry && (
        <label className="check"><input type="checkbox" checked={repairEnded} onChange={(e) => setRepairEnded(e.target.checked)} />Repair finished (untick to report an open breakdown)</label>
      )}
      {showEnd && <label>{breakdown ? 'Repair end' : 'End'}<input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label>}
      {breakdown && text('rootCause', 'Root cause', true)}
      {text('workDone', 'Work done', true)}
      <fieldset className="checklist">
        <legend>Parts / spares used</legend>
        {parts.map((p, i) => (
          <div key={i} className="row part">
            <input aria-label={`Part ${i + 1} name`} placeholder="Part name" value={p.name} onChange={(e) => setPart(i, 'name', e.target.value)} />
            <input aria-label={`Part ${i + 1} number`} placeholder="Part number" value={p.partNumber} onChange={(e) => setPart(i, 'partNumber', e.target.value)} />
            <input aria-label={`Part ${i + 1} quantity`} placeholder="Qty" inputMode="decimal" value={String(p.quantity)} onChange={(e) => setPart(i, 'quantity', e.target.value)} />
            <input aria-label={`Part ${i + 1} lot or serial`} placeholder="Lot / serial" value={p.lotSerial} onChange={(e) => setPart(i, 'lotSerial', e.target.value)} />
            <button type="button" onClick={() => set('parts', parts.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <div className="row">
          <button type="button" onClick={() => setData({ ...data, partsNone: false, parts: [...parts, { name: '', partNumber: '', quantity: '1', lotSerial: '' }] })}>+ Add part</button>
          <label className="check"><input type="checkbox" checked={Boolean(data.partsNone)} onChange={(e) => set('partsNone', e.target.checked)} />No parts used</label>
        </div>
      </fieldset>
      {text('toolsUsed', 'Tools, consumables or lubricants used')}
      <label>
        Done by
        <select value={String(data.doneBy ?? '')} onChange={(e) => set('doneBy', e.target.value)}>
          <option value="">Choose…</option>
          <option value="in_house">In-house</option>
          <option value="vendor">External vendor</option>
        </select>
      </label>
      {data.doneBy === 'vendor' && <>{text('vendorName', 'Vendor name')}{text('serviceReportRef', 'Service report reference')}</>}
      {text('workOrderRef', 'Work order reference (e.g. CMMS WO number)')}
      {text('deviationRef', 'Deviation reference')}
      {text('postRepairChecks', 'Post-repair checks done (e.g. test run)', true)}
      {equipment.kind !== 'area' && (
        <label className="check"><input type="checkbox" checked={Boolean(data.recalibrationNeeded)} onChange={(e) => set('recalibrationNeeded', e.target.checked)} />Re-calibration needed before use</label>
      )}
      {equipment.sterile && text('impactAssessment', 'Impact assessment (sterile equipment)', true)}
    </>
  );
}
