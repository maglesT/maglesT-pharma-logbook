import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, MEANING_LABEL, plantTime, TYPE_LABEL, type Entry, type Equipment, type LogbookTypeInfo, type Me, type Product, type Settings } from '../api.js';
import { SignDialog } from '../components/SignDialog.js';
import { EntryForm } from './EntryForm.js';

const CORE_TYPES = ['equipment_use', 'equipment_cleaning', 'maintenance', 'calibration', 'area_cleaning', 'general_log'];
const APPLIES: Record<string, Equipment['kind'][]> = {
  equipment_use: ['equipment', 'instrument', 'area'],
  equipment_cleaning: ['equipment', 'instrument'],
  maintenance: ['equipment', 'instrument', 'area'],
  calibration: ['equipment', 'instrument'],
  area_cleaning: ['area'],
  general_log: ['equipment', 'instrument', 'area'],
};

// Equipment list, then one equipment item's logbook (FRS screen 2).
export function EquipmentPage({ me, openId }: { me: Me; openId?: number }) {
  const [items, setItems] = useState<Equipment[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<number | undefined>(openId);
  useEffect(() => {
    void api<Equipment[]>('GET', '/api/equipment').then(setItems);
  }, []);
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
            <strong>{i.code}</strong>
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
  const [form, setForm] = useState<{ type: string; correcting?: Entry } | null>(null);
  const [verifying, setVerifying] = useState<Entry | null>(null);
  const [history, setHistory] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');

  const load = async () => setEntries(await api<Entry[]>('GET', `/api/equipment/${equipment.id}/entries`));
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
  const available = CORE_TYPES.filter((k) => APPLIES[k]!.includes(equipment.kind) && inForce.has(k));
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
        if (reason) await api('POST', `/api/entries/${e.id}/complete`, { activityEnd: at, lateReason: reason });
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
                {e.inProgress && <button onClick={() => endUse(e)}>End use</button>}
                {e.awaitingVerification && isVerifier && !e.inProgress && <button onClick={() => setVerifying(e)}>Verify</button>}
                {!me.roles.includes('admin') && !e.inProgress && <button onClick={() => setForm({ type: e.logbookType, correcting: e })}>Correct</button>}
                {e.version > 1 && <button onClick={async () => setHistory(await api<Entry[]>('GET', `/api/entries/${e.id}/versions`))}>History</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {form && inForce.get(form.type) && (
        <EntryForm
          type={form.type}
          equipment={equipment}
          settings={inForce.get(form.type)!}
          products={products}
          correcting={form.correcting}
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
      {history && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="card dialog wide">
            <h2>History</h2>
            {history.map((v) => (
              <div key={v.id} className="version">
                <strong>Version {v.version}</strong> · {v.change} by {v.enteredBy}, entered {plantTime(v.enteredAt)}
                {v.correctionReason && <> · reason: {v.correctionReason}</>}
                <div><Summary e={v} full /></div>
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
};

function Summary({ e, full = false }: { e: Entry; full?: boolean }) {
  const parts = Object.entries(e.data)
    .filter(([k, v]) => k !== 'checklist' && v !== '' && v !== false && v !== null)
    .map(([k, v]) => `${LABELS[k] ?? k}: ${k === 'nextDue' ? String(v).slice(0, 10) : v === true ? 'yes' : String(v).replaceAll('_', ' ')}`);
  const checklist = Object.entries((e.data.checklist ?? {}) as Record<string, boolean>).filter(([, v]) => v).map(([k]) => k);
  if (full && checklist.length) parts.push(`Checklist confirmed: ${checklist.join('; ')}`);
  return <span>{parts.join(' · ') || '—'}</span>;
}

