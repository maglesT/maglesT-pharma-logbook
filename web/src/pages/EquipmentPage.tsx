import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, cleaningText, daysLeft, joinParts, type Due, can, ApiError, MEANING_LABEL, plantDay, plantTime, sterileLines, mediaFillLine, TYPE_LABEL, VOICE_LANGUAGE_LABEL, type VoiceConfig, type Entry, type Equipment, type EquipmentStatus, type LogbookTypeInfo, type Me, type Product, type Settings } from '../api.js';
import { SignDialog } from '../components/SignDialog.js';
import { StatusChip } from '../components/StatusChip.js';
import { EntryForm } from './EntryForm.js';
import { HistoryCard } from './HistoryCard.js';
import { VoiceNoteDialog } from '../components/VoiceNote.js';
import { AdviceDialog } from '../components/AdviceDialog.js';
import { Fields } from '../fields.js';

const CORE_TYPES = ['equipment_use', 'equipment_cleaning', 'change_over', 'maintenance', 'calibration', 'requalification', 'area_cleaning', 'general_log',
  'steriliser_cycle', 'steriliser_test', 'glove_integrity', 'pressure_reading'];
// Owner 2026-11-12 (slide 3): one "New entry" with an Activity dropdown. Breakdown and preventive maintenance are both
// the maintenance logbook, opened with the kind chosen.
const ACTIVITIES: { key: string; label: string; type: string; preset?: Record<string, unknown> }[] = [
  { key: 'operation', label: 'Operation (use)', type: 'equipment_use' },
  { key: 'cleaning', label: 'Cleaning', type: 'equipment_cleaning' },
  { key: 'area_cleaning', label: 'Cleaning', type: 'area_cleaning' },
  { key: 'change_over', label: 'Change over', type: 'change_over' },
  { key: 'breakdown', label: 'Breakdown', type: 'maintenance', preset: { kind: 'breakdown' } },
  { key: 'pm', label: 'Preventive maintenance', type: 'maintenance', preset: { kind: 'preventive' } },
  { key: 'calibration', label: 'Calibration', type: 'calibration' },
  { key: 'requalification', label: 'Requalification', type: 'requalification' },
  { key: 'others', label: 'Others (general log)', type: 'general_log' },
  { key: 'steriliser_cycle', label: 'Sterilisation cycle', type: 'steriliser_cycle' },
  { key: 'steriliser_test', label: 'Steriliser test', type: 'steriliser_test' },
  { key: 'glove_integrity', label: 'Glove integrity', type: 'glove_integrity' },
  { key: 'pressure_reading', label: 'Pressure reading', type: 'pressure_reading' },
];
const STERILE_TYPES = new Set(['steriliser_cycle', 'steriliser_test', 'glove_integrity', 'pressure_reading']);
const APPLIES: Record<string, Equipment['kind'][]> = {
  equipment_use: ['equipment', 'instrument', 'area'],
  equipment_cleaning: ['equipment', 'instrument'],
  maintenance: ['equipment', 'instrument', 'area'],
  change_over: ['equipment', 'instrument', 'area'],
  requalification: ['equipment', 'instrument', 'area'],
  calibration: ['equipment', 'instrument'],
  area_cleaning: ['area'],
  general_log: ['equipment', 'instrument', 'area'],
  steriliser_cycle: ['equipment'],
  steriliser_test: ['equipment'],
  glove_integrity: ['equipment'],
  pressure_reading: ['area'],
};

// Equipment list, then one equipment item's logbook (FRS screen 2).
export function EquipmentPage({ me, openId }: { me: Me; openId?: number }) {
  const [items, setItems] = useState<Equipment[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<number | undefined>(openId);
  const [statuses, setStatuses] = useState<EquipmentStatus[] | null>(null);
  useEffect(() => {
    void api<Equipment[]>('GET', '/api/equipment').then(setItems);
    void api<EquipmentStatus[]>('GET', '/api/equipment/status').then(setStatuses);
  }, [selected]);
  useEffect(() => setSelected(openId), [openId]);

  const eq = items.find((i) => i.id === selected);
  if (eq) return <Logbook me={me} equipment={eq} onBack={() => setSelected(undefined)} />;

  const shown = items.filter((i) => i.active && `${i.code} ${i.name} ${i.location}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <h1>Equipment and areas</h1>
      <input className="search" placeholder="Search by ID, name or location" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <p className="muted">{shown.length} of {items.filter((i) => i.active).length} logbooks</p>
      {statuses === null && <p className="muted">Loading status…</p>}
      <div className="tiles">
        {shown.map((i) => (
          <button key={i.id} className={`tile state-${statuses?.find((x) => x.equipmentId === i.id)?.state ?? 'loading'}`} onClick={() => setSelected(i.id)}>
            <strong>{i.code} <StatusChip status={statuses?.find((x) => x.equipmentId === i.id)} /></strong>
            <span>{i.name}</span>
            <span className="muted">{i.location}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function Logbook({ me, equipment, onBack }: { me: Me; equipment: Equipment; onBack: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [types, setTypes] = useState<LogbookTypeInfo[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [form, setForm] = useState<{ type: string; correcting?: Entry; completing?: Entry; preset?: Record<string, unknown> } | null>(null);
  const [activity, setActivity] = useState('');
  const [tab, setTab] = useState<'log' | 'history'>('log');
  const [verifying, setVerifying] = useState<Entry | null>(null);
  const [releasing, setReleasing] = useState<Entry | null>(null);
  const [status, setStatus] = useState<EquipmentStatus | null>(null);
  const [history, setHistory] = useState<Entry[] | null>(null);
  const [voice, setVoice] = useState<VoiceConfig | undefined>(undefined);
  const [listening, setListening] = useState<number | null>(null);
  const [advising, setAdvising] = useState<number | null>(null);
  useEffect(() => {
    void api<VoiceConfig>('GET', '/api/voice-notes/config').then(setVoice).catch(() => setVoice(undefined));
  }, []);
  const [error, setError] = useState('');
  const [ending, setEnding] = useState<Entry | null>(null);

  const load = async () => {
    setEntries(await api<Entry[]>('GET', `/api/equipment/${equipment.id}/entries`));
    setStatus(await api<EquipmentStatus>('GET', `/api/equipment/${equipment.id}/status`));
  };
  useEffect(() => {
    void load();
    void api<LogbookTypeInfo[]>('GET', '/api/logbook-types').then(setTypes);
    void api<Product[]>('GET', '/api/products').then(setProducts);
  }, [equipment.id]);

  const inForce = useMemo(() => {
    const m = new Map<string, Settings>();
    for (const t of types) {
      const v = t.versions.find((x) => x.status === 'in force');
      if (v?.settings.enabled) m.set(t.key, v.settings);
    }
    return m;
  }, [types]);
  const switchedOn = CORE_TYPES.filter((k) => APPLIES[k]!.includes(equipment.kind) && inForce.has(k) && (!STERILE_TYPES.has(k) || equipment.sterile));
  // Only what the server accepts from this user: only the types this person's codes record (S11).
  const mayRecord = (k: string) => types.find((t) => t.key === k)?.mayRecord ?? false;
  const available = switchedOn.filter(mayRecord);
  const activities = ACTIVITIES.filter((a) => available.includes(a.type));
  const productName = (id: number | null) => products.find((p) => p.id === id)?.code ?? '';
  const isVerifier = can(me, 'entry.verify');

  // Ends a use (D-49: with its reason, from its dialog, which shows a refusal) or a change over (at once).
  const complete = async (e: Entry, endReason?: string) => {
    setError('');
    const body = { activityEnd: new Date().toISOString(), ...(endReason ? { endReason } : {}) };
    try {
      await api('POST', `/api/entries/${e.id}/complete`, body);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'late_reason_required')) throw err;
      const reason = window.prompt('This is a late entry. Reason:')?.trim();
      if (reason) await api('POST', `/api/entries/${e.id}/complete`, { ...body, lateReason: reason });
    }
  };
  const endChangeOver = async (e: Entry) => {
    await complete(e).catch((err: Error) => setError(err.message));
    await load();
  };
  const endUse = async (e: Entry, endReason: string) => {
    await complete(e, endReason);
    setEnding(null);
    await load();
  };

  return (
    <>
      <button className="link dark" onClick={onBack}>← All equipment</button>
      <h1>{equipment.code} · {equipment.name}</h1>
      <p className="muted">
        {equipment.location} {equipment.sterile && '· Sterile'} {equipment.classified && '· Classified room'} · Cleaning: {cleaningText(equipment)}
        {equipment.pmFrequencyDays ? ` · PM every ${equipment.pmFrequencyDays} days` : ''}{equipment.calibrationFrequencyDays ? ` · calibration every ${equipment.calibrationFrequencyDays} days` : ''}
        {equipment.requalificationFrequencyMonths ? ` · requalification every ${equipment.requalificationFrequencyMonths} months` : ''}
      </p>
      {status && (
        <div className={`statusbar ${status.blockers.length ? 'blocked' : 'fit'}`}>
          <StatusChip status={status} />
          {status.inUse && <span>Batch {status.inUse.batch} {status.inUse.stage && `· ${status.inUse.stage}`}{status.inUse.source !== 'Logbook' && ` · in ${status.inUse.source}`} since {plantTime(status.inUse.since)}</span>}
          {!status.inUse && status.lastTrueBatchUse && <span>Last used by batch {status.lastTrueBatchUse.batch} in {status.lastTrueBatchUse.source}{status.lastTrueBatchUse.step && ` (${status.lastTrueBatchUse.step})`}, ended {plantTime(status.lastTrueBatchUse.endedAt)}</span>}
          {status.cleanUntil && !status.blockers.length && <span>Clean until {plantTime(status.cleanUntil)}</span>}
          {sterileLines(status).map((l) => <span key={l}>{l}</span>)}
          {mediaFillLine(status) && <span>{mediaFillLine(status)}</span>}
          {status.calibrationDue && <span>Calibration due {plantDay(status.calibrationDue)}</span>}
          {[...status.blockers, ...status.warnings].map((b) => <span key={b} className="reason">{b}</span>)}
        </div>
      )}
      {status && <UseCheck status={status} />}
      <div className="subtabs">
        <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>Logbook</button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History card</button>
      </div>
      {tab === 'history' && <HistoryCard me={me} equipment={equipment} />}
      {tab === 'log' && <>
      <div className="row">
        {activities.length > 0 && (
          <form className="new-entry" onSubmit={(ev) => { ev.preventDefault(); const a = ACTIVITIES.find((x) => x.key === activity); if (a) setForm({ type: a.type, preset: a.preset }); }}>
            <label>Activity
              <select value={activity} onChange={(ev) => setActivity(ev.target.value)} aria-label="Activity">
                <option value="">Choose the activity…</option>
                {activities.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </select>
            </label>
            <button className="primary" type="submit" disabled={!activity}>+ New entry</button>
          </form>
        )}
        {switchedOn.length === 0 && <p className="muted">No logbook types are switched on for this item yet.</p>}
      </div>
      {error && <p className="error">{error}</p>}

      <table>
        <thead><tr><th>When</th><th>Type</th><th>Details</th><th>By</th><th>Signatures</th><th /></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className={e.awaitingVerification ? 'pending' : ''}>
              <td>
                {plantTime(e.activityStart)}
                {e.activityEnd && e.activityEnd !== e.activityStart && <><br />to {plantTime(e.activityEnd)}</>}
                {e.inProgress && <><br /><span className="chip chip-warn">In progress</span></>}
              </td>
              <td>{TYPE_LABEL[e.logbookType]}{e.late && <><br /><span className="chip chip-warn" title={e.lateReason ?? ''}>Late entry</span></>}</td>
              <td>
                {e.batch && <>{joinParts([productName(e.productId), `batch ${e.batch}`])}<br /></>}
                <Summary e={e} />
                <VoiceLinks e={e} onOpen={setListening} />
                {e.change === 'corrected' && <><br /><span className="muted">Corrected (version {e.version}): {e.correctionReason}</span></>}
              </td>
              <td>{e.enteredBy}</td>
              <td>
                {e.signatures.map((s) => (
                  <div key={s.meaning}>
                    {MEANING_LABEL[s.meaning]}: {s.printedName}, {plantTime(s.signedAt)}
                    {!s.valid && <span className="chip chip-bad"> invalid</span>}
                    {s.training && <div className={s.trainingTyped ? 'reason' : 'muted'}>{s.training}</div>}
                  </div>
                ))}
                {e.awaitingVerification && <span className="chip chip-warn">Awaiting verification</span>}
              </td>
              <td className="actions-cell">
                {e.inProgress && e.logbookType === 'equipment_use' && <button onClick={() => setEnding(e)}>End use</button>}
                {e.inProgress && e.logbookType === 'change_over' && mayRecord('change_over') && <button onClick={() => endChangeOver(e)}>End change over</button>}
                {e.inProgress && e.logbookType === 'maintenance' && mayRecord('maintenance') && (
                  <button onClick={() => setForm({ type: 'maintenance', completing: e })}>Complete repair</button>
                )}
                {e.logbookType === 'maintenance' && e.data.kind === 'breakdown' && can(me, 'advice.ask') && (
                  <button onClick={() => setAdvising(e.id)}>💡 Suggest from history</button>
                )}
                {e.awaitingVerification && isVerifier && !e.inProgress && <button onClick={() => setVerifying(e)}>Verify</button>}
                {e.logbookType === 'maintenance' && e.data.kind === 'breakdown' && can(me, 'breakdown.release') &&
                  e.signatures.some((g) => g.meaning === 'verified') && !e.signatures.some((g) => g.meaning === 'released') && (
                    <button onClick={() => setReleasing(e)}>Release to service</button>
                  )}
                {e.mayCorrect && !e.inProgress && <button onClick={() => setForm({ type: e.logbookType, correcting: e })}>Correct</button>}
                {e.version > 1 && <button onClick={async () => setHistory(await api<Entry[]>('GET', `/api/entries/${e.id}/versions`))}>History</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      </>}

      {form && inForce.get(form.type) && (
        <EntryForm
          type={form.type}
          equipment={equipment}
          settings={inForce.get(form.type)!}
          products={products}
          correcting={form.correcting}
          completing={form.completing}
          preset={form.preset}
          dirtyUntil={status?.dirtyUntil ?? null}
          voice={voice}
          onCancel={() => setForm(null)}
          onDone={async () => {
            setForm(null);
            await load();
          }}
        />
      )}
      {ending && (
        <EndUseDialog entry={ending} what={`${equipment.code} · batch ${ending.batch}, in use since ${plantTime(ending.activityStart)}`}
          onEnd={(reason) => endUse(ending, reason)} onCancel={() => setEnding(null)} />
      )}
      {verifying && (
        <SignDialog
          meaning="verified"
          trainingFor={verifying.logbookType}
          what={`${TYPE_LABEL[verifying.logbookType]} on ${equipment.code}, ${plantTime(verifying.activityStart)}, entered by ${verifying.enteredBy}`}
          onCancel={() => setVerifying(null)}
          onSign={async (c) => {
            await api('POST', `/api/entries/${verifying.id}/verify`, { ...c, contentHash: verifying.contentHash });
            setVerifying(null);
            await load();
          }}
        >
          <div className="summary-box"><Summary e={verifying} full /></div>
        </SignDialog>
      )}
      {releasing && (
        <SignDialog
          meaning="released"
          what={`Return ${equipment.code} to service after the breakdown of ${plantTime(releasing.activityStart)}`}
          onCancel={() => setReleasing(null)}
          onSign={async (c) => {
            await api('POST', `/api/entries/${releasing.id}/release`, { ...c, contentHash: releasing.contentHash });
            setReleasing(null);
            await load();
          }}
        >
          <div className="summary-box"><Summary e={releasing} full /></div>
        </SignDialog>
      )}
      {listening !== null && <VoiceNoteDialog id={listening} onClose={() => setListening(null)} />}
      {advising !== null && <AdviceDialog versionId={advising} code={equipment.code} onClose={() => setAdvising(null)} />}
      {history && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="card dialog wide">
            <h2>History</h2>
            {history.map((v) => (
              <div key={v.id} className="version">
                <strong>Version {v.version}</strong> · {v.change} by {v.enteredBy}, entered {plantTime(v.enteredAt)}
                {v.correctionReason && <> · reason: {v.correctionReason}</>}
                <div><Summary e={v} full /> <VoiceLinks e={v} onOpen={setListening} /></div>
                <div className="muted">{v.signatures.map((s) => `${MEANING_LABEL[s.meaning]}: ${s.printedName}, ${plantTime(s.signedAt)}${s.training ? ` (${s.training})` : ''}`).join(' · ')}</div>
              </div>
            ))}
            <div className="actions"><button onClick={() => setHistory(null)}>Close</button></div>
          </div>
        </div>
      )}
    </>
  );
}

// D-26: the signed text is shown in the entry; the original voice note opens from here.
export function VoiceLinks({ e, onOpen }: { e: Entry; onOpen: (id: number) => void }) {
  if (!e.voiceNotes?.length) return null;
  return (
    <>
      {e.voiceNotes.map((v) => (
        <button key={v.id} type="button" className="link dark" onClick={() => onOpen(v.id)}>
          🎤 Voice note ({VOICE_LANGUAGE_LABEL[v.language ?? ''] ?? v.language}, {v.field})
        </button>
      ))}
    </>
  );
}

// D-49: "End use" always offers a reason, picked or typed; it is required when the batch is from another product's
// batch records (the server says which: endReasonFrom).
const END_REASONS = ['The batch is done with it', 'Batch finished', 'Batch stopped or cancelled', 'Batch record withdrawn'];
export function EndUseDialog({ entry, what, onEnd, onCancel }: { entry: Entry; what: string; onEnd: (reason: string) => Promise<void>; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const from = entry.endReasonFrom ?? null;
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (from && !reason.trim()) { setError('Give the reason the use ends.'); return; }
    setBusy(true);
    setError('');
    try {
      await onEnd(reason.trim());
    } catch (err) {
      setError(err instanceof ApiError && err.problems.length ? err.problems.join(' ') : (err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <form className="card dialog" onSubmit={submit}>
        <h2>End use</h2>
        <p>{what}</p>
        <label>Why the use ends{from ? '' : ' (optional)'}
          <input list="end-reasons" value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={500} required={Boolean(from)} aria-label="Why the use ends" />
        </label>
        <datalist id="end-reasons">{END_REASONS.map((r) => <option key={r} value={r} />)}</datalist>
        {from && <p className="muted">Required: batch {entry.batch} is from the batch records of {from}.</p>}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="submit" disabled={busy}>End use</button>
        </div>
      </form>
    </div>
  );
}

export function Summary({ e, full = false }: { e: Entry; full?: boolean }) {
  const checklist = Object.entries((e.data.checklist ?? {}) as Record<string, boolean>).filter(([, v]) => v).map(([k]) => k);
  return <Fields data={e.data} extra={full && checklist.length ? [['Checklist confirmed', checklist.join('; ')]] : []} />;
}

// Owner 2026-11-12 (slide 4): what is checked before use, when the item is scanned or opened.
export function UseCheck({ status: s }: { status: EquipmentStatus }) {
  const due = (k: Due['kind']) => s.dues.find((d) => d.kind === k);
  const has = (re: RegExp) => s.blockers.some((b) => re.test(b));
  // Nothing to check (no schedule, not calibrated in the Logbook): a dash, never a green tick.
  const line = (label: string, bad: boolean, warn: boolean, text: string, none = false) => {
    const k = bad ? 'bad' : warn ? 'warn' : none ? 'none' : 'ok';
    return <li className={k}><span aria-hidden="true">{{ bad: '✕', warn: '!', none: '–', ok: '✓' }[k]}</span><b>{label}</b><span>{text}</span></li>;
  };
  const dueText = (d: Due | undefined, none: string) => (d ? `${d.overdue ? 'Overdue since' : 'Due'} ${plantDay(d.due)} (${daysLeft(d.due)})` : none);
  const pm = due('pm');
  const cal = due('calibration');
  const rq = due('requalification');
  const cleaningBad = has(/^(Dirty|Clean-hold|Cleaning overdue)/);
  const calBad = has(/^(Calibration|Not calibrated|Re-calibration)/);
  return (
    <ul className="use-check" aria-label="Before use">
      {line('Cleaning status', cleaningBad, Boolean(s.deadline?.soon), cleaningBad ? s.blockers.find((b) => /^(Dirty|Clean-hold|Cleaning overdue)/.test(b))!
        : s.deadline ? `${s.deadline.kind === 'dirty_hold' ? 'Dirty hold ends' : s.schedule === 'frequency' ? 'Next cleaning due' : 'Clean until'} ${plantTime(s.deadline.at)}` : 'Clean')}
      {line('Preventive maintenance', Boolean(pm?.overdue), Boolean(pm?.soon), dueText(pm, 'No PM schedule in master data'), !pm)}
      {line('Calibration', calBad, Boolean(cal?.soon), calBad ? s.blockers.find((b) => /^(Calibration|Not calibrated|Re-calibration)/.test(b))! : dueText(cal, 'Not calibrated in the Logbook'), !calBad && !cal)}
      {line('Requalification', Boolean(rq?.overdue) || has(/^(Not qualified|Requalification needed)/), Boolean(rq?.soon),
        has(/^(Not qualified|Requalification needed)/) ? s.blockers.find((b) => /^(Not qualified|Requalification needed)/.test(b))! : dueText(rq, 'No requalification date'),
        !rq && !has(/^(Not qualified|Requalification needed)/))}
      {line('Breakdown (QA released)', has(/^Out of service/), false, has(/^Out of service/) ? 'A breakdown is not released by QA' : 'No open breakdown')}
    </ul>
  );
}
