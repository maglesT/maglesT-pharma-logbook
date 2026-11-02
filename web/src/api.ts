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

export type Role = 'operator' | 'supervisor' | 'engineering' | 'qa' | 'admin';
export const ROLES: Role[] = ['operator', 'supervisor', 'engineering', 'qa', 'admin'];
export const ROLE_LABEL: Record<Role, string> = {
  operator: 'Operator',
  supervisor: 'Supervisor',
  engineering: 'Engineering',
  qa: 'QA',
  admin: 'Admin',
};

export interface Me {
  id: number;
  username: string;
  fullName: string;
  roles: Role[];
}

export interface User {
  id: number;
  username: string;
  fullName: string;
  roles: Role[];
  active: boolean;
  locked: boolean;
  lastLoginAt: string | null;
}

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

export interface Equipment {
  id: number;
  code: string;
  name: string;
  kind: 'equipment' | 'instrument' | 'area';
  location: string;
  sterile: boolean;
  classified: boolean;
  cleanHoldHours: number | null;
  needsCalibration: boolean;
  active: boolean;
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
  steriliser_cycle: 'Sterilisation cycle',
  steriliser_test: 'Steriliser test',
  glove_integrity: 'Glove integrity',
  pressure_reading: 'Pressure reading',
};

// Mirrors the server (D-16): these types are signed by the performer.
export const PERFORMER_SIGNS = new Set(['equipment_cleaning', 'maintenance', 'area_cleaning', 'calibration', 'steriliser_cycle', 'steriliser_test']);

export interface EquipmentStatus {
  equipmentId: number;
  state: string;
  blockers: string[];
  warnings: string[];
  inUse: { entryId: number; productId: number | null; batch: string | null; stage: string; since: string } | null;
  cleanUntil: string | null;
  calibrationDue: string | null;
}

export const STATE_LABEL: Record<string, [string, string]> = {
  in_use: ['In use', 'chip-info'],
  dirty: ['Dirty', 'chip-warn'],
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
  manufacturer: string;
  model: string;
  serialNumber: string;
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
  assetNumber: '', manufacturer: '', model: '', serialNumber: '', capacity: '', installationDate: null, supplier: '',
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
