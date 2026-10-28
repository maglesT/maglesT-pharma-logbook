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
  passwordChangeRequired: boolean;
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
  versions: SettingsVersion[];
}

export const MEANING_LABEL: Record<string, string> = {
  performed: 'Performed',
  verified: 'Verified',
  released: 'Released',
  reviewed: 'Reviewed',
  approved: 'Approved',
  corrected: 'Corrected',
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
