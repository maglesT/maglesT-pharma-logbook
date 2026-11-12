export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    // Validation problems listed by the server, shown to the user.
    public problems: string[] = [],
  ) {
    super(message ?? code);
  }
}

// background: polls that must not keep an idle session alive (server checks this header).
export async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, body?: object, background = false): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...(background ? { 'x-background-poll': '1' } : {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message, data.problems ?? []);
  return data as T;
}

// This product's permission codes from core (D-30); the server checks every action again.
export interface Me {
  id: number;
  username: string;
  fullName: string;
  permissions: string[];
}
export const can = (me: Me, code: string) => me.permissions.includes(`logbook.${code}`);

export interface Alert {
  id: number;
  kind: string;
  message: string;
  createdAt: string;
}

// LB-19: times are shown in plant time with the zone label.
export function plantTime(iso: string | null): string {
  if (!iso) return '—';
  const s = new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  return `${s} IST`;
}

export interface Equipment extends Care {
  id: number;
  code: string;
  name: string;
  kind: 'equipment' | 'instrument' | 'area';
  location: string;
  sterile: boolean;
  classified: boolean;
  needsCalibration: boolean;
  active: boolean;
  // Master data (D-29 3).
  make: string | null;
  model: string | null;
  serial: string | null;
}

// Platform D-24: maintenance, cleaning and requalification parameters, master data's (read only here).
export interface Care {
  cleanHoldHours: number | null;
  dirtyHoldHours: number | null;
  cleaningBasis: 'operation' | 'frequency' | null;
  cleaningFrequencyHours: number | null;
  pmFrequencyDays: number | null;
  calibrationFrequencyDays: number | null;
  requalificationFrequencyMonths: number | null;
}
export interface Candidate extends Care {
  itemId: string; code: string; name: string; kind: Equipment['kind']; location: string; make: string | null; model: string | null; serial: string | null;
  qualification: string | null; nextReviewDue: string | null; selectable: boolean;
}
export const QUAL_LABEL: Record<string, string> = {
  qualified: 'Qualified', qualified_conditions: 'Qualified with conditions', requalification_needed: 'Requalification needed',
  not_qualified: 'Not qualified', not_in_qualification: 'Not in the Qualification system',
};
// Cleaning in words: "Dirty hold 8 h · clean hold 72 h", "Every 24 h (frequency-based room)".
export function cleaningText(c: Care & { kind: Equipment['kind'] }): string {
  if (c.kind === 'area' && c.cleaningBasis === 'frequency') return c.cleaningFrequencyHours ? `Every ${c.cleaningFrequencyHours} h (frequency-based room)` : 'Frequency-based room';
  const parts = [c.dirtyHoldHours ? `dirty hold ${c.dirtyHoldHours} h` : '', c.cleanHoldHours ? `clean hold ${c.cleanHoldHours} h` : ''].filter(Boolean).join(' · ');
  const text = parts ? parts.charAt(0).toUpperCase() + parts.slice(1) : '—';
  return c.kind === 'area' ? `${text} (operation-based room)` : text;
}

export interface Product {
  id: number;
  code: string;
  name: string;
  active: boolean;
}

export interface Settings {
  enabled: boolean;
  sopRef: string;
  checklist: string[];
  verificationRequired: boolean;
  limits: Record<string, { min?: number; max?: number; unit: string }>;
  pressurePoints: { name: string; critical: false; ccsRef: string; min: number; max: number; unit: string }[];
  voiceLanguages?: string[];
}

export interface SettingsVersion {
  id: number;
  version: number;
  settings: Settings;
  effectiveFrom: string;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  status: string;
  // Hash of exactly this content; sent back when signing (LB-19).
  contentHash: string;
}

export interface LogbookTypeInfo {
  key: string;
  label: string;
  sterile: boolean;
  alwaysVerified: boolean;
  // Whether the logged-in user may record this type (S11).
  mayRecord: boolean;
  versions: SettingsVersion[];
}

export const MEANING_LABEL: Record<string, string> = {
  performed: 'Performed',
  verified: 'Verified',
  released: 'Released',
  reviewed: 'Reviewed',
  approved: 'Approved',
  corrected: 'Corrected',
  voice_confirmed: 'Voice note confirmed',
};

// Value for a datetime-local input, in the browser's local time.
export function localInputValue(iso: string | Date = new Date()): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export interface EntrySignature {
  printedName: string;
  meaning: string;
  signedAt: string;
  valid: boolean;
}

export interface Entry {
  id: number;
  entryId: number;
  version: number;
  change: 'created' | 'completed' | 'corrected';
  equipmentId: number;
  logbookType: string;
  activityStart: string;
  activityEnd: string | null;
  productId: number | null;
  batch: string | null;
  data: Record<string, unknown>;
  late: boolean;
  lateReason: string | null;
  correctionReason: string | null;
  enteredBy: string;
  enteredAt: string;
  contentHash: string;
  signatures: EntrySignature[];
  awaitingVerification?: boolean;
  inProgress?: boolean;
  // Whether the logged-in user may correct this entry (D-17), on an equipment logbook (S11).
  mayCorrect?: boolean;
  // D-26: voice notes whose signed English text is in this version.
  voiceNotes?: { id: number; field: string; language: string | null; edited: boolean; carried: boolean }[];
}

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
};

// Mirrors the server (D-16): these types are signed by the performer.
export const PERFORMER_SIGNS = new Set(['equipment_cleaning', 'maintenance', 'area_cleaning', 'calibration', 'steriliser_cycle', 'steriliser_test', 'change_over', 'requalification']);

export interface EquipmentStatus {
  equipmentId: number;
  state: string;
  blockers: string[];
  warnings: string[];
  inUse: { entryId: number; productId: number | null; batch: string | null; stage: string; since: string } | null;
  cleanUntil: string | null;
  calibrationDue: string | null;
  schedule: 'hold' | 'frequency' | null;
  dirtyUntil: string | null;
  deadline: CleaningDeadline | null;
  dues: Due[];
  qualification: string | null;
}
export interface CleaningDeadline { kind: 'dirty_hold' | 'clean_hold' | 'frequency'; at: string; hours: number; soon: boolean; overdue: boolean }
export interface Due { kind: 'pm' | 'calibration' | 'requalification'; due: string; frequency: string; soon: boolean; overdue: boolean }
export const DEADLINE_LABEL: Record<CleaningDeadline['kind'], string> = { dirty_hold: 'Dirty hold', clean_hold: 'Clean hold', frequency: 'Scheduled cleaning' };
export const DUE_LABEL: Record<Due['kind'], string> = { pm: 'Preventive maintenance', calibration: 'Calibration', requalification: 'Requalification' };
// Time left until (or past) a moment, in words: "2 h 15 min", "3 days 4 h".
export function timeLeft(iso: string, now = Date.now()): string {
  const m = Math.round(Math.abs(new Date(iso).getTime() - now) / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.floor(h / 24)} days${h % 24 ? ` ${h % 24} h` : ''}`;
}
// Days until (or past) a plant date, in words.
export function daysLeft(date: string): string {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const d = Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
  return d === 0 ? 'today' : d > 0 ? `in ${d} day${d === 1 ? '' : 's'}` : `${-d} day${d === -1 ? '' : 's'} overdue`;
}

export const STATE_LABEL: Record<string, [string, string]> = {
  in_use: ['In use', 'chip-info'],
  in_change_over: ['Change over', 'chip-info'],
  dirty: ['Dirty', 'chip-warn'],
  dirty_expired: ['Dirty hold expired', 'chip-bad'],
  cleaning_due: ['Cleaning overdue', 'chip-bad'],
  pm_overdue: ['PM overdue', 'chip-bad'],
  requalification_overdue: ['Requalification overdue', 'chip-bad'],
  not_qualified: ['Not qualified', 'chip-bad'],
  clean: ['Clean', 'chip-ok'],
  clean_expired: ['Clean expired', 'chip-warn'],
  out_of_service: ['Out of service', 'chip-bad'],
  calibration_overdue: ['Calibration overdue', 'chip-bad'],
  calibration_failed: ['Calibration failed', 'chip-bad'],
  not_calibrated: ['Not calibrated', 'chip-bad'],
  available: ['Available', 'chip-ok'],
};

// S9 (D-25): breakdown history, equipment details and history card.
export const FAILURE_CATEGORIES = ['mechanical', 'electrical', 'utility', 'instrumentation', 'software', 'operator', 'other'] as const;
export const BREAKDOWN_STATUS_LABEL: Record<string, [string, string]> = {
  open: ['Open (repair not finished)', 'chip-bad'],
  awaiting_verification: ['Awaiting verification', 'chip-warn'],
  awaiting_release: ['Awaiting QA release', 'chip-warn'],
  released: ['Released', 'chip-ok'],
};

export interface Part { name: string; partNumber: string; quantity: number | string; lotSerial: string }

export interface BreakdownItem {
  versionId: number;
  entryId: number;
  equipmentId: number;
  code: string;
  name: string;
  location: string;
  occurredAt: string;
  repairStart: string;
  repairEnd: string | null;
  releasedAt: string | null;
  downtimeMinutes: number;
  downtimeFinal: boolean;
  failureCategory: string | null;
  description: string;
  rootCause: string;
  workDone: string;
  partsText: string;
  doneBy: string;
  workOrderRef: string;
  status: string;
}

export interface MachineStats { equipmentId: number; code: string; name: string; failures: number; downtimeHours: number; mttrHours: number | null; mtbfHours: number | null }

export interface Register {
  items: BreakdownItem[];
  stats: { machines: MachineStats[]; categories: { category: string; failures: number }[] };
}

export const downtimeText = (b: { downtimeMinutes: number; downtimeFinal: boolean }) =>
  `${Math.floor(b.downtimeMinutes / 60)} h ${b.downtimeMinutes % 60} min${b.downtimeFinal ? '' : ' (so far)'}`;

export interface QualificationStep { date: string | null; ref: string }
export interface Details {
  assetNumber: string;
  capacity: string;
  installationDate: string | null;
  supplier: string;
  qualificationStatus: 'not_qualified' | 'in_qualification' | 'qualified' | 'requalification_due';
  iq: QualificationStep;
  oq: QualificationStep;
  pq: QualificationStep;
  lastRequalification: string | null;
  productContactMoc: string;
  sopRefs: string;
}
export const EMPTY_DETAILS: Details = {
  assetNumber: '', capacity: '', installationDate: null, supplier: '',
  qualificationStatus: 'not_qualified', iq: { date: null, ref: '' }, oq: { date: null, ref: '' }, pq: { date: null, ref: '' },
  lastRequalification: null, productContactMoc: '', sopRefs: '',
};
export const QUALIFICATION_LABEL: Record<Details['qualificationStatus'], string> = {
  not_qualified: 'Not qualified', in_qualification: 'In qualification', qualified: 'Qualified', requalification_due: 'Requalification due',
};

export interface DetailsVersion { id: number; version: number; details: Details; reason: string; changedBy: string; changedAt: string }

export interface EquipmentCard {
  equipment: Equipment;
  details: DetailsVersion | null;
  detailsVersions: DetailsVersion[];
  locationHistory: { at: string; by: string | null; from: string | null; to: string; reason: string | null }[];
  status: EquipmentStatus;
}

export type HistoryEvent =
  | { kind: 'entry'; at: string; entry: Entry & { latest: boolean }; breakdown?: { downtime: string; parts: string; status: string } }
  | { kind: 'review'; at: string; review: { id: number; periodFrom: string; periodTo: string; reviewedBy: string | null; reviewedAt: string | null; superseded: boolean; valid: boolean } }
  | { kind: 'masterdata'; at: string; actor: string | null; action: string; old: unknown; new: unknown; reason: string | null; lines: string[] };

// S10 voice notes (D-26).
export const VOICE_LANGUAGE_LABEL: Record<string, string> = {
  'hi-IN': 'Hindi', 'mr-IN': 'Marathi', 'gu-IN': 'Gujarati', 'ta-IN': 'Tamil', 'te-IN': 'Telugu', 'kn-IN': 'Kannada', 'ml-IN': 'Malayalam',
  'bn-IN': 'Bengali', 'pa-IN': 'Punjabi', 'od-IN': 'Odia', 'en-IN': 'Indian English', unknown: 'Detect automatically',
};
export interface VoiceConfig { enabled: boolean; switchedOn: boolean; configured: boolean; languages: string[]; fields: Record<string, string[]>; maxClipMs: number; statement: string }
export interface VoiceDraft { id: number; transcript: string; translation: string; detectedLanguage: string | null; shownHash: string }
export interface VoiceNote {
  id: number;
  field: string;
  speaker: string;
  requestedLanguage: string;
  detectedLanguage: string | null;
  audioMime: string;
  audioBytes: number;
  audioSha256: string;
  durationMs: number | null;
  transcript: string;
  translation: string;
  provider: string;
  model: string;
  requestedAt: string;
  statement: string;
  confirmation: { entryVersionId: number; finalText: string; edited: boolean; confirmedAt: string; signedBy: string | null; signedAt: string | null } | null;
}

// S12 breakdown suggestions (D-27).
export interface SimilarBreakdown {
  entryId: number;
  equipmentId: number;
  code: string;
  name: string;
  relation: 'same_machine' | 'same_model' | 'same_type' | 'same_failure_type';
  relationLabel: string;
  occurredAt: string;
  failureCategory: string | null;
  description: string;
  rootCause: string;
  workDone: string;
  partsText: string;
  doneBy: string;
  downtime: string;
  status: string;
}
export interface Advice {
  summary: string;
  likelyCauses: { cause: string; basis: number[] }[];
  checks: { step: string; basis: number[] }[];
  parts: { name: string; partNumber: string; basis: number[] }[];
  preventive: string;
  confidence: 'low' | 'medium' | 'high';
  enoughHistory: boolean;
}
export interface AdviceResponse { entryId: number; similar: SimilarBreakdown[]; advice: Advice | null; adviceNote: string | null; model?: string; generatedAt?: string }

// B1-4 (D-29, PL-05): every signature starts with the person entering their password again at Medhanta core, in a
// small window opened on the Sign click. Core's answer comes back as a short signing proof for this one save.
export function getSignProof(meanings: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = window.open(`/sign?meanings=${meanings.join(',')}`, 'medhanta-sign', 'width=480,height=640');
    if (!w) return reject(new Error('Allow pop-up windows for this site to sign.'));
    const done = (fn: () => void) => { window.removeEventListener('message', onMessage); clearInterval(timer); fn(); };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== w) return;
      const m = e.data as { signProof?: string; signError?: string };
      if (m.signProof) done(() => resolve(m.signProof!));
      else if (m.signError) done(() => reject(new Error(m.signError)));
    };
    window.addEventListener('message', onMessage);
    const timer = setInterval(() => { if (w.closed) done(() => reject(new Error('Signing was cancelled.'))); }, 500);
  });
}
