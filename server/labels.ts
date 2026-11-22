// D-60: stored values in the words people pick on the entry form, the same on the screens and in every printed
// copy ("Product changeover", not "product change"). One list for the pages and the server.
// No Node APIs: the web pages import this file too.

export const TYPE_LABEL: Record<string, string> = {
  equipment_use: 'Equipment use',
  equipment_cleaning: 'Equipment cleaning',
  maintenance: 'Maintenance / breakdown',
  calibration: 'Calibration / check',
  area_cleaning: 'Area cleaning',
  general_log: 'General equipment log',
  change_over: 'Change over',
  requalification: 'Requalification',
  steriliser_cycle: 'Sterilisation cycle',
  steriliser_test: 'Steriliser test',
  glove_integrity: 'Glove integrity',
  pressure_reading: 'Pressure reading',
  room_move: 'Move to another room',
};

// D-16: these types are signed by the performer (one list for the server and the pages).
export const PERFORMER_SIGNS = new Set(['equipment_cleaning', 'maintenance', 'area_cleaning', 'calibration', 'steriliser_cycle', 'steriliser_test', 'glove_integrity', 'pressure_reading', 'change_over', 'requalification', 'room_move']);

// Signature meanings in words (screens and printed copies).
export const MEANING_LABEL: Record<string, string> = {
  performed: 'Performed',
  verified: 'Verified',
  released: 'Released',
  reviewed: 'Reviewed',
  approved: 'Approved',
  corrected: 'Corrected',
  voice_confirmed: 'Voice note confirmed',
  closed: 'Closed',
};

// Entry fields in the order they are shown; a breakdown reads top to bottom from failure to repair.
export const ENTRY_FIELD_LABEL: Record<string, string> = {
  // Change over (D-55): from which product and batch to which, first (D-60).
  fromProduct: 'From product', fromBatch: 'From batch', toProduct: 'To product', toBatch: 'To batch',
  kind: 'Type', occurredAt: 'Occurred', reportedBy: 'Reported by', failureCategory: 'Failure category', description: 'What happened',
  impactAssessment: 'Impact assessment', rootCause: 'Root cause', workDone: 'Work done', parts: 'Parts used', partsNone: 'Parts used',
  toolsUsed: 'Tools / consumables', doneBy: 'Done by', vendorName: 'Vendor', serviceReportRef: 'Service report', workOrderRef: 'Work order',
  postRepairChecks: 'Post-repair checks', recalibrationNeeded: 'Re-calibration needed',
  source: 'Recorded from', protocolNumber: 'Protocol', stage: 'Stage', outcome: 'Result', reportRef: 'Report', cleaningType: 'Cleaning', agent: 'Agent', sporicidal: 'Sporicidal', disinfectantLot: 'Disinfectant lot',
  cycleType: 'Cycle', cycleId: 'Cycle no.', programme: 'Programme', load: 'Load', controllerRecordRef: 'Controller record', indicators: 'Indicators',
  // D-84: a move to another room.
  fromRoom: 'From room', toRoom: 'To room', reason: 'Why moved',
  test: 'Test', leakRate: 'Leak rate', leakUnit: 'Unit', leakMax: 'Limit (not more than)', testPackLot: 'Test pack lot', port: 'Port', method: 'Method', point: 'Point', value: 'Reading', outOfLimit: 'OUT OF LIMITS',
  result: 'Result', certificateRef: 'Certificate', nextDue: 'Next due', notes: 'Notes', remarks: 'Remarks', comment: 'Comment', deviationRef: 'Deviation',
  // D-46: why a cleaning ended after its dirty hold ran out.
  delayReason: 'Why late',
  // D-49: why a use ended ("End use").
  endReason: 'Why ended',
  // D-69: a batch typed by hand (not from the batch records), and why; D-70: a use the Qualification product did not check.
  batchTyped: 'Typed by hand', qualNotChecked: 'Qualification not checked',
  // D-78: a cycle recorded while TrueBatch Injectables did not answer (not checked against its batches).
  batchNotChecked: 'Batch not checked',
};

export const FAILURE_CATEGORY_LABEL: Record<string, string> = {
  mechanical: 'Mechanical', electrical: 'Electrical', utility: 'Utility', instrumentation: 'Instrumentation', software: 'Software', operator: 'Operator', other: 'Other',
};
// Requalification values (the Qualification product's stage keys and report outcomes).
export const STAGE_LABEL: Record<string, string> = { iq: 'IQ', oq: 'OQ', pq: 'PQ', iq_oq: 'IQ/OQ', dq: 'DQ', urs: 'URS', periodic_review: 'Periodic review', csv: 'CSV' };
export const OUTCOME_LABEL: Record<string, string> = { pass: 'Pass', pass_conditions: 'Pass with conditions', fail: 'Fail' };

// Picked values per field, as the entry form names them.
export const VALUE_LABEL: Record<string, Record<string, string>> = {
  cleaningType: { daily: 'Daily', weekly: 'Weekly', batch_to_batch: 'Batch to batch', product_change: 'Product changeover', major: 'Major', other: 'Other' },
  kind: { preventive: 'Preventive', breakdown: 'Breakdown', repair: 'Repair' },
  result: { pass: 'Pass', fail: 'Fail' },
  cycleType: { steam: 'Steam (autoclave)', dry_heat: 'Dry heat / depyrogenation', sip: 'Steam in place', vhp: 'VHP bio-decontamination' },
  test: { air_removal: 'Air removal (Bowie-Dick)', leak: 'Leak (vacuum) test' },
  failureCategory: FAILURE_CATEGORY_LABEL,
  doneBy: { in_house: 'In-house', vendor: 'External vendor' },
  source: { protocol: 'EQUIP protocol', manual: 'Written by hand' },
  stage: STAGE_LABEL,
  outcome: OUTCOME_LABEL,
};
/** D-55 change over products: older entries kept the bare product code ("FG-PCM500"); shown with the master-data name
 *  ("FG-PCM500 · Paracetamol tablets 500 mg") like newer ones. The stored value is not changed. */
export const PRODUCT_FIELDS = new Set(['fromProduct', 'toProduct']);
export const withProductName = (v: unknown, nameOf: (code: string) => string | undefined): unknown => {
  if (typeof v !== 'string' || !v || v.includes(' · ')) return v;
  const name = nameOf(v.trim());
  return name ? `${v.trim()} · ${name}` : v;
};
/** The form's word for a picked value, or undefined when the field has no pick list (or the value is not on it). */
export const valueLabel = (field: string, v: unknown): string | undefined => (typeof v === 'string' ? VALUE_LABEL[field]?.[v] : undefined);
/** The form's choices for a field, in the form's order. */
export const choices = (field: string, values: string[]): [string, string][] => values.map((v) => [v, VALUE_LABEL[field]?.[v] ?? v]);

export interface PartUsed { name: string; partNumber: string; quantity: number | string; lotSerial: string }
export const partsLine = (parts: PartUsed[]) =>
  parts.map((p) => `${p.quantity} × ${p.name}${p.partNumber ? ` (P/N ${p.partNumber})` : ''}${p.lotSerial ? `, lot/SN ${p.lotSerial}` : ''}`).join('; ');

// An item's state, as its status chip names it.
export const STATE_NAME: Record<string, string> = {
  in_use: 'In use', in_change_over: 'Change over', sterile_expired: 'Sterile status expired', dirty: 'Dirty', dirty_expired: 'Dirty hold expired',
  cleaning_due: 'Cleaning overdue', pm_overdue: 'PM overdue', requalification_overdue: 'Requalification overdue', not_qualified: 'Not qualified',
  clean: 'Clean', clean_expired: 'Clean expired', out_of_service: 'Out of service', calibration_overdue: 'Calibration overdue',
  calibration_failed: 'Calibration failed', not_calibrated: 'Not calibrated', available: 'Available',
};

// What was missed, for the overdue record (LB-21).
export const OVERDUE_LABEL: Record<string, string> = {
  dirty_hold: 'Dirty hold expired', clean_hold: 'Clean hold expired', frequency: 'Scheduled cleaning missed',
  pm: 'Preventive maintenance overdue', calibration: 'Calibration overdue', requalification: 'Requalification overdue',
};

// Audit-trail actions on an item, as the history card names them.
export const ITEM_ACTION_LABEL: Record<string, string> = {
  'equipment.created': 'Item created', 'equipment.added': 'Item added from master data', 'equipment.updated': 'Master data changed',
  'equipment.details_updated': 'Equipment details changed', 'overdue.recorded': 'Overdue recorded',
  'exception.closed': 'Missed limit closed in the Logbook', 'exception.sent': 'Missed limit sent to DIVE',
  'reservation.created': 'Equipment reserved', 'reservation.cancelled': 'Reservation cancelled',
};

// LB-18: the audit trail in words, on the screen and in the PDF copy (the CSV keeps the stored codes).
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  'entry.created': 'Entry made',
  'entry.completed': 'Activity ended',
  'entry.corrected': 'Entry corrected',
  'login': 'Logged in',
  'logout': 'Logged out',
  'login.failed': 'Failed login',
  'password.changed': 'Password changed',
  'signature.failed': 'Signature refused',
  'user.created': 'User created',
  'user.updated': 'User changed',
  'user.locked': 'Account locked (too many wrong passwords)',
  'password.change_failed': 'Password change refused',
  'user.password_reset': 'Temporary password issued',
  'equipment.created': 'Item created',
  'equipment.updated': 'Master data changed',
  'equipment.details_updated': 'Equipment details changed',
  'product.created': 'Product created',
  'product.updated': 'Product changed',
  'settings.drafted': 'Logbook settings drafted',
  'settings.edited': 'Logbook settings draft changed',
  'review.created': 'Period review prepared',
  'site.created': 'Site created',
  'site.updated': 'Site changed',
  'voice_note.created': 'Voice note recorded',
  'voice_note.confirmed': 'Voice note text confirmed',
  'integrity.passed': 'Integrity check passed',
  'integrity.failed': 'Integrity check found problems',
  'alert.acknowledged': 'Security alert acknowledged',
  'breakdown_advice.generated': 'AI breakdown suggestion shown',
  'equipment.added': 'Item added from master data',
  'overdue.recorded': 'Overdue recorded',
  'exception.closed': 'Missed limit closed in the Logbook',
  'exception.sent': 'Missed limit sent to DIVE',
  'reservation.created': 'Equipment reserved',
  'reservation.cancelled': 'Reservation cancelled',
  'workorder.raised': 'Work order raised',
  'workorder.assigned': 'Work order assigned',
  'workorder.started': 'Work started',
  'workorder.work_recorded': 'Work done recorded',
  'workorder.done': 'Work order marked done',
  'workorder.closed': 'Work order closed',
};
export const auditActionText = (a: string) =>
  AUDIT_ACTION_LABEL[a] ?? (a.startsWith('signed.') ? `Signed: ${MEANING_LABEL[a.slice(7)] ?? a.slice(7)}` : a.replaceAll(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()));

// Engineering work orders: kinds and statuses in words.
export const WO_KIND_LABEL: Record<string, string> = { breakdown: 'Breakdown', preventive: 'Preventive maintenance', calibration: 'Calibration', other: 'Other' };
export const WO_STATUS_LABEL: Record<string, string> = { open: 'Open', in_progress: 'In progress', done: 'Done', closed: 'Closed' };
