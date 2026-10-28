import { STATE_LABEL, type EquipmentStatus } from '../api.js';

export function StatusChip({ status }: { status?: EquipmentStatus }) {
  if (!status) return null;
  const [label, cls] = STATE_LABEL[status.state] ?? [status.state, 'chip-warn'];
  return <span className={`chip ${cls}`}>{label}</span>;
}
