import { useEffect, useState } from 'react';
import { api, plantTime, TYPE_LABEL, type Entry, type Equipment, type EquipmentStatus, type Me } from '../api.js';
import { StatusChip } from '../components/StatusChip.js';

export function Home({ me, onOpen }: { me: Me; onOpen: (equipmentId: number) => void }) {
  const [open, setOpen] = useState<Entry[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [statuses, setStatuses] = useState<EquipmentStatus[]>([]);
  useEffect(() => {
    void api<EquipmentStatus[]>('GET', '/api/equipment/status').then(setStatuses);
    void api<Entry[]>('GET', '/api/entries/open').then(setOpen);
    void api<Equipment[]>('GET', '/api/equipment').then(setEquipment);
  }, []);
  const code = (id: number) => equipment.find((e) => e.id === id)?.code ?? '';
  return (
    <>
      <h1>Home</h1>
      <p className="greeting">Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, {me.fullName.split(' (')[0]}. Here is how the plant stands right now.</p>
      {(() => {
        const active = new Set(equipment.filter((e) => e.active).map((e) => e.id));
        const count = (states: string[]) => statuses.filter((s) => active.has(s.equipmentId) && states.includes(s.state)).length;
        return (
          <div className="stats">
            <div className="stat ok"><b>{count(['clean', 'available'])}</b><span>Ready for use</span></div>
            <div className="stat info"><b>{count(['in_use'])}</b><span>In use</span></div>
            <div className="stat warn"><b>{count(['dirty', 'clean_expired'])}</b><span>Need cleaning</span></div>
            <div className="stat bad"><b>{count(['out_of_service', 'calibration_overdue', 'calibration_failed', 'not_calibrated'])}</b><span>Out of service or calibration</span></div>
            <div className="stat"><b>{open.length}</b><span>Open items</span></div>
          </div>
        );
      })()}
      <h2>Not fit for use</h2>
      {(() => {
        const blocked = statuses.filter((s) => s.blockers.length && s.state !== 'in_use' && equipment.find((e) => e.id === s.equipmentId)?.active);
        return blocked.length === 0 ? (
          <p className="muted">All equipment is fit for use.</p>
        ) : (
          <table>
            <thead><tr><th>Equipment</th><th>Status</th><th>Why</th></tr></thead>
            <tbody>
              {blocked.map((s) => (
                <tr key={s.equipmentId} className="clickable" onClick={() => onOpen(s.equipmentId)}>
                  <td><strong>{code(s.equipmentId)}</strong><br /><span className="muted">{equipment.find((e) => e.id === s.equipmentId)?.name}</span></td><td><StatusChip status={s} /></td><td>{s.blockers.join(' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      })()}
      <h2>Open items</h2>
      {open.length === 0 ? (
        <p className="muted">Nothing open: no equipment in use and nothing awaiting verification.</p>
      ) : (
        <table>
          <thead><tr><th>Equipment</th><th>Entry</th><th>Since</th><th>Open because</th></tr></thead>
          <tbody>
            {open.map((e) => (
              <tr key={e.id} className="clickable" onClick={() => onOpen(e.equipmentId)}>
                <td>{code(e.equipmentId)}</td>
                <td>{TYPE_LABEL[e.logbookType]}{e.batch && ` · batch ${e.batch}`}</td>
                <td>{plantTime(e.activityStart)}</td>
                <td>{e.inProgress ? (e.logbookType === 'maintenance' ? 'Repair not finished' : 'In use (not ended)') : 'Awaiting verification'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
