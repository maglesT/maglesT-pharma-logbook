import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, can, LEAK_UNITS, localInputValue, plantTime, type LogbookTypeInfo, type Me, type Settings, type SettingsVersion, type TrainingSkills, VOICE_LANGUAGE_LABEL } from '../api.js';

// D-71: the site settings that are not a logbook take no training.
const SITE_SETTINGS = ['voice_notes', 'breakdown_advice'];
const skillName = (s: { code: string; title: string }) => (s.title && s.title !== s.code ? `${s.title} (${s.code})` : s.code);
import { SignDialog } from '../components/SignDialog.js';
import { SopPicker } from '../components/SopPicker.js';

const blank: Settings = { enabled: true, sopRef: '', checklist: [], verificationRequired: false, limits: {}, pressurePoints: [] };

// Pressure points are edited as lines: name; CCS reference; min; max
const pointsToText = (s: Settings) => s.pressurePoints.map((p) => `${p.name}; ${p.ccsRef}; ${p.min}; ${p.max}`).join('\n');
const textToPoints = (text: string) =>
  text
    .split('\n')
    .map((l) => l.split(';').map((x) => x.trim()))
    .filter((p) => p[0])
    .map(([name, ccsRef, min, max]) => ({
      name: name!,
      ccsRef: ccsRef ?? '',
      min: min ? Number(min) : NaN,
      max: max ? Number(max) : NaN,
      critical: false as const,
      unit: 'Pa',
    }));

export function LogbookSettings({ me }: { me: Me }) {
  const isAdmin = can(me, 'settings.draft');
  const isQa = can(me, 'settings.approve');
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
            await api('POST', `/api/settings/${approving.version.id}/approve`, { ...credentials, contentHash: approving.version.contentHash });
            setApproving(null);
            await load();
          }}
        >
          <SettingsSummary v={approving.version} />
        </SignDialog>
      )}
    </>
  );
}

function SettingsEditor({ type, draftId, onClose }: { type: LogbookTypeInfo; draftId?: number; onClose: () => void }) {
  const start = type.versions.find((v) => v.id === draftId) ?? type.versions.find((v) => v.status === 'in force');
  const [s, setS] = useState<Settings>(start?.settings ?? blank);
  const [checklist, setChecklist] = useState(s.checklist.join('\n'));
  const [points, setPoints] = useState(pointsToText(s));
  // D-83: the steriliser leak-test limit (largest allowed leak rate and its unit); empty: no limit.
  const [leakMax, setLeakMax] = useState(s.leakLimit ? String(s.leakLimit.max) : '');
  const [leakUnit, setLeakUnit] = useState(s.leakLimit?.unit ?? LEAK_UNITS[0]!);
  // Editing a draft keeps its planned date; a new version starts at now (local time).
  const draft = type.versions.find((v) => v.id === draftId);
  const [effective, setEffective] = useState(localInputValue(draft?.effectiveFrom ?? new Date()));
  const [error, setError] = useState('');
  const [draftReason, setDraftReason] = useState('');
  // D-71: the training signers need, picked from Recruitment's skills (typed while Recruitment is not linked or not reachable).
  const [skills, setSkills] = useState<TrainingSkills | null>(null);
  useEffect(() => {
    if (!SITE_SETTINGS.includes(type.key)) void api<TrainingSkills>('GET', '/api/training/skills').then(setSkills).catch(() => setSkills(null));
  }, [type.key]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const pressurePoints = type.key === 'pressure_reading' ? textToPoints(points) : [];
    if (pressurePoints.some((p) => !p.ccsRef || !Number.isFinite(p.min) || !Number.isFinite(p.max) || p.min > p.max)) {
      return setError('Each pressure point needs: name; CCS reference; min; max (min not above max).');
    }
    const max = leakMax.trim() === '' ? null : Number(leakMax.trim().replace(',', '.'));
    if (type.key === 'steriliser_test' && max !== null && !(Number.isFinite(max) && max > 0)) return setError('The leak limit must be a number above 0.');
    const { training, leakLimit: _old, ...rest } = s;
    const settings = {
      ...(type.key === 'steriliser_test' && max !== null ? { leakLimit: { max, unit: leakUnit } } : {}),
      ...rest,
      ...(training?.code.trim() ? { training: { code: training.code.trim(), title: training.title.trim() } } : {}),
      checklist: checklist.split('\n').map((l) => l.trim()).filter(Boolean),
      pressurePoints,
    };
    const effectiveFrom = new Date(effective).toISOString();
    try {
      if (draftId) {
        const reason = draftReason.trim();
        if (!reason) return setError('Give the reason for editing the draft.');
        await api('PATCH', `/api/settings/${draftId}`, { settings, effectiveFrom, reason });
      } else {
        await api('POST', '/api/settings', { logbookType: type.key, settings, effectiveFrom });
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.problems.length ? err.problems.join(' ') : err instanceof ApiError && err.code === 'connection_off' ? err.message : 'Check the fields. Pressure points need: name; CCS reference; min; max.');
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <form className="card dialog" onSubmit={save}>
        <h2>{type.label}: {draftId ? 'edit draft' : 'new version'}</h2>
        {draftId && <label>Reason for editing the draft<input value={draftReason} onChange={(e) => setDraftReason(e.target.value)} /></label>}
        <label className="check"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />Switched on at this site</label>
        <SopPicker label="SOP reference" value={s.sopRef} onChange={(sopRef) => setS({ ...s, sopRef })} />
        <label>Checklist items (one per line)<textarea value={checklist} onChange={(e) => setChecklist(e.target.value)} /></label>
        {!type.alwaysVerified && (
          <label className="check">
            <input type="checkbox" checked={s.verificationRequired} onChange={(e) => setS({ ...s, verificationRequired: e.target.checked })} />
            Second-person verification required
          </label>
        )}
        {type.key === 'voice_notes' && (
          <fieldset className="checklist">
            <legend>Languages allowed for voice notes (D-26: sends audio to the Sarvam AI service; needs the supplier assessment and staff consent)</legend>
            {Object.entries(VOICE_LANGUAGE_LABEL).filter(([k]) => k !== 'unknown').map(([k, l]) => (
              <label key={k} className="check">
                <input type="checkbox" checked={(s.voiceLanguages ?? []).includes(k)}
                  onChange={(e) => setS({ ...s, voiceLanguages: e.target.checked ? [...(s.voiceLanguages ?? []), k] : (s.voiceLanguages ?? []).filter((x) => x !== k) })} />
                {l}
              </label>
            ))}
          </fieldset>
        )}
        {type.key === 'breakdown_advice' && (
          <p className="muted">D-27: when switched on, the text of related past breakdowns (machines, failures, repairs and parts, no people's names) is sent to Google Gemini, which suggests causes, checks and parts. Advice only: it is never part of an entry. Needs the supplier assessment.</p>
        )}
        {type.key === 'pressure_reading' && (
          <label>Non-critical pressure points (one per line: name; CCS reference; min Pa; max Pa)<textarea value={points} onChange={(e) => setPoints(e.target.value)} /></label>
        )}
        {type.key === 'steriliser_test' && (
          <fieldset>
            <legend>Vacuum leak test limit (leave empty for none: the person then records pass or fail)</legend>
            <label>Largest allowed leak rate<input inputMode="decimal" value={leakMax} onChange={(e) => setLeakMax(e.target.value)} /></label>
            <label>Unit (the reading is taken in this unit)
              <select value={leakUnit} onChange={(e) => setLeakUnit(e.target.value)}>
                {LEAK_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </label>
          </fieldset>
        )}
        {skills && (skills.linked ? (
          <label>Training needed to sign (Recruitment)
            <select value={s.training?.code ?? ''} onChange={(e) => {
              const k = skills.skills.find((x) => x.code === e.target.value);
              setS({ ...s, training: k ? { code: k.code, title: k.title } : undefined });
            }}>
              <option value="">None</option>
              {s.training && !skills.skills.some((x) => x.code === s.training!.code) && <option value={s.training.code}>{skillName(s.training)} (not in Recruitment)</option>}
              {skills.skills.map((k) => <option key={k.code} value={k.code}>{skillName(k)}</option>)}
            </select>
          </label>
        ) : (
          <fieldset>
            <legend>Training needed to sign</legend>
            <p className="muted">{skills.note}</p>
            <label>Skill code<input value={s.training?.code ?? ''} onChange={(e) => setS({ ...s, training: { code: e.target.value, title: s.training?.title ?? '' } })} /></label>
            <label>Skill title<input value={s.training?.title ?? ''} onChange={(e) => setS({ ...s, training: { code: s.training?.code ?? '', title: e.target.value } })} /></label>
          </fieldset>
        ))}
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

function SettingsSummary({ v }: { v: SettingsVersion }) {
  const s = v.settings;
  return (
    <dl className="summary">
      <dt>Switched on</dt><dd>{s.enabled ? 'Yes' : 'No'}</dd>
      <dt>SOP</dt><dd>{s.sopRef || '—'}</dd>
      <dt>Effective from</dt><dd>{plantTime(v.effectiveFrom)} (or the approval time, if later)</dd>
      <dt>Second-person verification</dt><dd>{s.verificationRequired ? 'Required' : 'As the rules require'}</dd>
      {s.leakLimit && (<><dt>Leak test limit</dt><dd>not more than {s.leakLimit.max} {s.leakLimit.unit}</dd></>)}
      {s.training && (<><dt>Training needed to sign</dt><dd>{skillName(s.training)}</dd></>)}
      {s.checklist.length > 0 && (<><dt>Checklist</dt><dd><ul>{s.checklist.map((c) => <li key={c}>{c}</li>)}</ul></dd></>)}
      {(s.voiceLanguages ?? []).length > 0 && (
        <><dt>Voice-note languages</dt><dd>{s.voiceLanguages!.map((l) => VOICE_LANGUAGE_LABEL[l] ?? l).join(', ')}</dd></>
      )}
      {s.pressurePoints.length > 0 && (
        <><dt>Pressure points</dt><dd><ul>{s.pressurePoints.map((p) => <li key={p.name}>{p.name}: {p.min}–{p.max} {p.unit} ({p.ccsRef})</li>)}</ul></dd></>
      )}
    </dl>
  );
}
