import { z } from 'zod';
import type { Role } from './auth.js';
import { typeByKey, type LogbookSettings } from './logbook-types.js';

// Entry data per built-in logbook type (D-07). Sterile types arrive in S6.
const checklistAnswers = z.record(z.string().max(200), z.boolean()).default({});
const outOfLimit = { comment: z.string().trim().max(1000).default(''), deviationRef: z.string().trim().max(60).default('') };

export const DATA_SCHEMAS: Record<string, z.ZodTypeAny> = {
  equipment_use: z.object({ stage: z.string().trim().max(80).default(''), remarks: z.string().trim().max(1000).default('') }),
  equipment_cleaning: z.object({
    cleaningType: z.enum(['batch_to_batch', 'product_change', 'major']),
    checklist: checklistAnswers,
    remarks: z.string().trim().max(1000).default(''),
  }),
  maintenance: z.object({
    kind: z.enum(['preventive', 'breakdown', 'repair']),
    description: z.string().trim().min(1).max(2000),
    workDone: z.string().trim().max(2000).default(''),
    // A1 5.7: unplanned maintenance of sterility-critical equipment needs a recorded impact assessment.
    impactAssessment: z.string().trim().max(2000).default(''),
  }),
  calibration: z.object({
    result: z.enum(['pass', 'fail']),
    certificateRef: z.string().trim().max(100).default(''),
    nextDue: z.coerce.date(),
    remarks: z.string().trim().max(1000).default(''),
    ...outOfLimit,
  }),
  area_cleaning: z.object({
    cleaningType: z.enum(['daily', 'weekly', 'product_change', 'other']),
    agent: z.string().trim().max(120).default(''),
    sporicidal: z.boolean().default(false),
    disinfectantLot: z.string().trim().max(60).default(''),
    checklist: checklistAnswers,
    remarks: z.string().trim().max(1000).default(''),
  }),
  general_log: z.object({ checklist: checklistAnswers, notes: z.string().trim().max(2000).default('') }),
};

// D-16: types whose performer signs with an e-signature (a clause requires the signature).
const PERFORMER_SIGNS = new Set(['equipment_cleaning', 'maintenance', 'area_cleaning', 'calibration', 'steriliser_cycle', 'steriliser_test']);
export const performerSigns = (type: string) => PERFORMER_SIGNS.has(type);

// LB-03 / LB-11: second-person verification needed for this type under these settings.
export const verificationNeeded = (type: string, settings: LogbookSettings) =>
  Boolean(typeByKey(type)?.alwaysVerified || settings.verificationRequired);

// Who may record each type (LB-21). Admin records nothing.
const RECORDERS: Record<string, Role[]> = {
  equipment_use: ['operator', 'supervisor'],
  equipment_cleaning: ['operator', 'supervisor'],
  area_cleaning: ['operator', 'supervisor'],
  general_log: ['operator', 'supervisor', 'engineering'],
  maintenance: ['operator', 'supervisor', 'engineering'],
  calibration: ['engineering'],
};
export const mayRecord = (type: string, roles: Role[]) => (RECORDERS[type] ?? []).some((r) => roles.includes(r));
export const VERIFIERS: Role[] = ['supervisor', 'qa'];

export interface EquipmentInfo {
  kind: 'equipment' | 'instrument' | 'area';
  sterile: boolean;
  classified: boolean;
}

const HAS_CHECKLIST = new Set(['equipment_cleaning', 'area_cleaning', 'general_log']);

// LB-11 system checks: consistency, completeness and limits. Returns problems shown to the user.
export function checkData(
  type: string,
  data: Record<string, unknown>,
  settings: LogbookSettings,
  equipment: EquipmentInfo,
  activityStart: Date,
): string[] {
  const problems: string[] = [];
  if (HAS_CHECKLIST.has(type)) {
    const checklist = (data.checklist ?? {}) as Record<string, boolean>;
    for (const item of settings.checklist) {
      if (checklist[item] !== true) problems.push(`Checklist item not confirmed: ${item}`);
    }
  }
  if (type === 'maintenance' && data.kind === 'breakdown' && equipment.sterile && !String(data.impactAssessment ?? '').trim()) {
    problems.push('A breakdown of sterile equipment needs an impact assessment (Annex 1 5.7).');
  }
  if (type === 'calibration') {
    if ((data.nextDue as Date).getTime() <= activityStart.getTime()) problems.push('The next due date must be after the calibration date.');
    if (data.result === 'fail' && (!String(data.comment ?? '').trim() || !String(data.deviationRef ?? '').trim())) {
      problems.push('A failed calibration needs a comment and a deviation reference.');
    }
  }
  if (type === 'area_cleaning' && equipment.classified) {
    if (!String(data.agent ?? '').trim()) problems.push('Classified rooms: the cleaning/disinfecting agent is required (Annex 1 4.33).');
    if (!String(data.disinfectantLot ?? '').trim()) problems.push('Classified rooms: the disinfectant lot is required.');
  }
  return problems;
}
