import { useEffect, useState, type FormEvent } from 'react';
import { api, plantTime, type LogbookTypeInfo, type Me, type Settings, type SettingsVersion } from '../api.js';
import { SignDialog } from '../components/SignDialog.js';

const blank: Settings = { enabled: true, sopRef: '', checklist: [], verificationRequired: false, limits: {}, pressurePoints: [] };

// Pressure points are edited as lines: name; CCS reference; min; max
const pointsToText = (s: Settings) => s.pressurePoints.map((p) => `${p.name}; ${p.ccsRef}; ${p.min}; ${p.max}`).join('\n');
const textToPoints = (text: string) =>
  text
    .split('\n')
    .map((l) => l.split(';').map((x) => x.trim()))
    .filter((p) => p[0])
    .map(([name, ccsRef, min, max]) => ({ name: name!, ccsRef: ccsRef ?? '', min: Number(min), max: Number(max), critical: false as const, unit: 'Pa' }));

export function LogbookSettings({ me }: { me: Me }) {
  const isAdmin = me.roles.includes('admin');
  const isQa = me.roles.includes('qa');
  const [types, setTypes] = useState<LogbookTypeInfo[]>([]);
  const [editing, setEditing] = useState<{ type: LogbookTypeInfo; draftId?: number } | null>(null);
  const [approving, setApproving] = useState<{ type: LogbookTypeInfo; version: SettingsVersion } | null>(null);
  const load = async () => setTypes(await api<LogbookTypeInfo[]>('GET', '/api/logbook-types'));
  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <h1>Logbook settings</h1>
      <p className="muted">Each change is a new version. A version is in force once QA approves it and its effective date has passed.</p>
      {types.map((t) => {
        const current = t.versions.find((v) => v.status === 'in force');
        const draft = t.versions.find((v) => v.status === 'draft');
        return (
          <section key={t.key} className="card">
            <h2>
              {t.label} {t.sterile && <span className="status">Sterile</span>}
            </h2>
            {current ? (
              <p>
                <span className="status in-force">In force</span> version {current.version}, {current.settings.enabled ? 'switched on' : 'switched off'}
                {current.settings.sopRef && ` · SOP ${current.settings.sopRef}`} · approved by {current.approvedBy}, {plantTime(current.approvedAt)}
              </p>
            ) : (
              <p className="muted">No approved settings yet: this logbook type cannot be used.</p>
            )}
            {t.versions.filter((v) => v.status !== 'in force').map((v) => (
              <p key={v.id}>
                <span className="status">{v.status}</span> version {v.version}, effective {plantTime(v.effectiveFrom)}, drafted by {v.createdBy}
                {v.status === 'draft' && isQa && (
                  <button onClick={() => setApproving({ type: t, version: v })}>Approve</button>
                )}
              </p>
            ))}
            {isAdmin && (
              <button onClick={() => setEditing({ type: t, draftId: draft?.id })}>{draft ? 'Edit draft' : 'New version'}</button>
            )}
          </section>
        );
      })}

      {editing && (
        <SettingsEditor
          type={editing.type}
          draftId={editing.draftId}
          onClose={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
      {approving && (
        <SignDialog
          meaning="approved"
          what={`${approving.type.label}, settings version ${approving.version.version}`}
          onCancel={() => setApproving(null)}
          onSign={async (credentials) => {
            await api('POST', `/api/settings/${approving.version.id}/approve`, credentials);
            setApproving(null);
            await load();
          }}
        />
      )}
    </>
  );
}

function SettingsEditor({ type, draftId, onClose }: { type: LogbookTypeInfo; draftId?: number; onClose: () => void }) {
  const start = type.versions.find((v) => v.id === draftId) ?? type.versions.find((v) => v.status === 'in force');
  const [s, setS] = useState<Settings>(start?.settings ?? blank);
  const [checklist, setChecklist] = useState(s.checklist.join('\n'));
  const [points, setPoints] = useState(pointsToText(s));
  const [effective, setEffective] = useState(new Date().toISOString().slice(0, 16));
  const [error, setError] = useState('');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const settings = {
      ...s,
      checklist: checklist.split('\n').map((l) => l.trim()).filter(Boolean),
      pressurePoints: type.key === 'pressure_reading' ? textToPoints(points) : [],
    };
    const effectiveFrom = new Date(effective).toISOString();
    try {
      if (draftId) {
        const reason = window.prompt('Reason for editing the draft:')?.trim();
        if (!reason) return;
        await api('PATCH', `/api/settings/${draftId}`, { settings, effectiveFrom, reason });
      } else {
        await api('POST', '/api/settings', { logbookType: type.key, settings, effectiveFrom });
      }
      onClose();
    } catch {
      setError('Check the fields. Pressure points need: name; CCS reference; min; max.');
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <form className="card dialog" onSubmit={save}>
        <h2>{type.label}: {draftId ? 'edit draft' : 'new version'}</h2>
        <label className="check"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />Switched on at this site</label>
        <label>SOP reference<input value={s.sopRef} onChange={(e) => setS({ ...s, sopRef: e.target.value })} /></label>
        <label>Checklist items (one per line)<textarea value={checklist} onChange={(e) => setChecklist(e.target.value)} /></label>
        {!type.alwaysVerified && (
          <label className="check">
            <input type="checkbox" checked={s.verificationRequired} onChange={(e) => setS({ ...s, verificationRequired: e.target.checked })} />
            Second-person verification required
          </label>
        )}
        {type.key === 'pressure_reading' && (
          <label>Non-critical pressure points (one per line: name; CCS reference; min Pa; max Pa)<textarea value={points} onChange={(e) => setPoints(e.target.value)} /></label>
        )}
        <label>Effective from<input type="datetime-local" value={effective} onChange={(e) => setEffective(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit">Save draft</button>
        </div>
      </form>
    </div>
  );
}
