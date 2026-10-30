import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, MEANING_LABEL, plantTime, TYPE_LABEL, VOICE_LANGUAGE_LABEL, type VoiceConfig, type Entry, type Part, type Equipment, type EquipmentStatus, type LogbookTypeInfo, type Me, type Product, type Settings } from '../api.js';
import { SignDialog } from '../components/SignDialog.js';
import { StatusChip } from '../components/StatusChip.js';
import { EntryForm } from './EntryForm.js';
import { HistoryCard } from './HistoryCard.js';
import { VoiceNoteDialog } from '../components/VoiceNote.js';

const CORE_TYPES = ['equipment_use', 'equipment_cleaning', 'maintenance', 'calibration', 'area_cleaning', 'general_log',
  'steriliser_cycle', 'steriliser_test', 'glove_integrity', 'pressure_reading'];
const STERILE_TYPES = new Set(['steriliser_cycle', 'steriliser_test', 'glove_integrity', 'pressure_reading']);
const APPLIES: Record<string, Equipment['kind'][]> = {
  equipment_use: ['equipment', 'instrument', 'area'],
  equipment_cleaning: ['equipment', 'instrument'],
  maintenance: ['equipment', 'instrument', 'area'],
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
  const [statuses, setStatuses] = useState<EquipmentStatus[]>([]);
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
      <div className="tiles">
        {shown.map((i) => (
          <button key={i.id} className="tile" onClick={() => setSelected(i.id)}>
            <strong>{i.code} <StatusChip status={statuses.find((x) => x.equipmentId === i.id)} /></strong>
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
  const [form, setForm] = useState<{ type: string; correcting?: Entry; completing?: Entry } | null>(null);
  const [tab, setTab] = useState<'log' | 'history'>('log');
  const [verifying, setVerifying] = useState<Entry | null>(null);
  const [releasing, setReleasing] = useState<Entry | null>(null);
  const [status, setStatus] = useState<EquipmentStatus | null>(null);
  const [history, setHistory] = useState<Entry[] | null>(null);
  const [voice, setVoice] = useState<VoiceConfig | undefined>(undefined);
  const [listening, setListening] = useState<number | null>(null);
  useEffect(() => {
    void api<VoiceConfig>('GET', '/api/voice-notes/config').then(setVoice).catch(() => setVoice(undefined));
  }, []);
  const [error, setError] = useState('');

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
  const available = CORE_TYPES.filter((k) => APPLIES[k]!.includes(equipment.kind) && inForce.has(k) && (!STERILE_TYPES.has(k) || equipment.sterile));
  const productName = (id: number | null) => products.find((p) => p.id === id)?.code ?? '';
  const isVerifier = me.roles.includes('supervisor') || me.roles.includes('qa');

  const endUse = async (e: Entry) => {
    setError('');
    const at = new Date().toISOString();
    try {
      await api('POST', `/api/entries/${e.id}/complete`, { activityEnd: at });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'late_reason_required') {
        const reason = window.prompt('This is a late entry. Reason:')?.trim();
        if (reason) {
          await api('POST', `/api/entries/${e.id}/complete`, { activityEnd: at, lateReason: reason }).catch((again: Error) => setError(again.message));
        }
      } else setError((err as Error).message);
    }
    await load();
  };

  return (
    <>
      <button className="link dark" onClick={onBack}>← All equipment</button>
      <h1>{equipment.code} · {equipment.name}</h1>
      <p className="muted">
        {equipment.location} {equipment.sterile && '· Sterile'} {equipment.classified && '· Classified room'} {equipment.cleanHoldHours && `· Clean-hold ${equipment.cleanHoldHours} h`}
      </p>
      {status && (
        <div className={`statusbar ${status.blockers.length ? 'blocked' : 'fit'}`}>
          <StatusChip status={status} />
          {status.inUse && <span>Batch {status.inUse.batch} {status.inUse.stage && `· ${status.inUse.stage}`} since {plantTime(status.inUse.since)}</span>}
          {status.cleanUntil && !status.blockers.length && <span>Clean until {plantTime(status.cleanUntil)}</span>}
          {status.calibrationDue && <span>Calibration due {status.calibrationDue.slice(0, 10)}</span>}
          {[...status.blockers, ...status.warnings].map((b) => <span key={b} className="reason">{b}</span>)}
        </div>
      )}
      <div className="subtabs">
        <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>Logbook</button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History card</button>
      </div>
      {tab === 'history' && <HistoryCard me={me} equipment={equipment} />}
      {tab === 'log' && <>
      <div className="row">
        {available.map((k) => <button key={k} className="primary" onClick={() => setForm({ type: k })}>+ {TYPE_LABEL[k]}</button>)}
        {available.length === 0 && <p className="muted">No logbook types are switched on for this item yet.</p>}
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
                {e.batch && <>{productName(e.productId)} · batch {e.batch}<br /></>}
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
                  </div>
                ))}
                {e.awaitingVerification && <span className="chip chip-warn">Awaiting verification</span>}
              </td>
              <td className="actions-cell">
                {e.inProgress && e.logbookType === 'equipment_use' && <button onClick={() => endUse(e)}>End use</button>}
                {e.inProgress && e.logbookType === 'maintenance' && me.roles.some((r) => r === 'operator' || r === 'supervisor' || r === 'engineering') && (
                  <button onClick={() => setForm({ type: 'maintenance', completing: e })}>Complete repair</button>
                )}
                {e.awaitingVerification && isVerifier && !e.inProgress && <button onClick={() => setVerifying(e)}>Verify</button>}
                {e.logbookType === 'maintenance' && e.data.kind === 'breakdown' && me.roles.includes('qa') &&
                  e.signatures.some((g) => g.meaning === 'verified') && !e.signatures.some((g) => g.meaning === 'released') && (
                    <button onClick={() => setReleasing(e)}>Release to service</button>
                  )}
                {!me.roles.includes('admin') && !e.inProgress && <button onClick={() => setForm({ type: e.logbookType, correcting: e })}>Correct</button>}
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
          voice={voice}
          onCancel={() => setForm(null)}
          onDone={async () => {
            setForm(null);
            await load();
          }}
        />
      )}
      {verifying && (
        <SignDialog
          meaning="verified"
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
      {history && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="card dialog wide">
            <h2>History</h2>
            {history.map((v) => (
              <div key={v.id} className="version">
                <strong>Version {v.version}</strong> · {v.change} by {v.enteredBy}, entered {plantTime(v.enteredAt)}
                {v.correctionReason && <> · reason: {v.correctionReason}</>}
                <div><Summary e={v} full /> <VoiceLinks e={v} onOpen={setListening} /></div>
                <div className="muted">{v.signatures.map((s) => `${MEANING_LABEL[s.meaning]}: ${s.printedName}, ${plantTime(s.signedAt)}`).join(' · ')}</div>
              </div>
            ))}
            <div className="actions"><button onClick={() => setHistory(null)}>Close</button></div>
          </div>
        </div>
      )}
    </>
  );
}

const LABELS: Record<string, string> = {
  stage: 'Stage', remarks: 'Remarks', cleaningType: 'Cleaning', kind: 'Type', description: 'Description', workDone: 'Work done',
  impactAssessment: 'Impact assessment', result: 'Result', certificateRef: 'Certificate', nextDue: 'Next due', comment: 'Comment',
  deviationRef: 'Deviation', agent: 'Agent', sporicidal: 'Sporicidal', disinfectantLot: 'Disinfectant lot', notes: 'Notes',
  cycleType: 'Cycle', cycleId: 'Cycle no.', programme: 'Programme', load: 'Load', controllerRecordRef: 'Controller record',
  indicators: 'Indicators', test: 'Test', port: 'Port', method: 'Method', point: 'Point', value: 'Reading', outOfLimit: 'OUT OF LIMITS',
  occurredAt: 'Occurred', reportedBy: 'Reported by', failureCategory: 'Category', rootCause: 'Root cause', parts: 'Parts', partsNone: 'Parts',
  toolsUsed: 'Tools / consumables', doneBy: 'Done by', vendorName: 'Vendor', serviceReportRef: 'Service report', workOrderRef: 'WO',
  postRepairChecks: 'Post-repair checks', recalibrationNeeded: 'Re-calibration needed',
};

const partsLine = (parts: Part[]) => parts.map((p) => `${p.quantity} × ${p.name}${p.partNumber ? ` (P/N ${p.partNumber})` : ''}${p.lotSerial ? `, lot/SN ${p.lotSerial}` : ''}`).join('; ');
const value = (k: string, v: unknown) =>
  k === 'nextDue' ? String(v).slice(0, 10)
  : k === 'occurredAt' ? plantTime(String(v))
  : k === 'parts' ? partsLine(v as Part[])
  : k === 'partsNone' ? 'none'
  : k === 'doneBy' ? (v === 'vendor' ? 'external vendor' : 'in-house')
  : v === true ? 'yes' : String(v).replaceAll('_', ' ');

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

export function Summary({ e, full = false }: { e: Entry; full?: boolean }) {
  const parts = Object.entries(e.data)
    .filter(([k, v]) => k !== 'checklist' && v !== '' && v !== false && v !== null && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${LABELS[k] ?? k}: ${value(k, v)}`);
  const checklist = Object.entries((e.data.checklist ?? {}) as Record<string, boolean>).filter(([, v]) => v).map(([k]) => k);
  if (full && checklist.length) parts.push(`Checklist confirmed: ${checklist.join('; ')}`);
  return <span>{parts.join(' · ') || '—'}</span>;
}

