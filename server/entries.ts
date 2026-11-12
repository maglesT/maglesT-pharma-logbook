import { z } from 'zod';
import type { Permission } from './auth.js';
import { typeByKey, type LogbookSettings } from './logbook-types.js';

// Entry data per built-in logbook type (D-07). Sterile types arrive in S6.
const checklistAnswers = z.record(z.string().max(200), z.boolean()).default({});
const isoTime = z.string().datetime({ offset: true }).transform((t) => new Date(t).toISOString());
export const FAILURE_CATEGORIES = ['mechanical', 'electrical', 'utility', 'instrumentation', 'software', 'operator', 'other'] as const;
const part = z.object({
  name: z.string().trim().min(1).max(120),
  partNumber: z.string().trim().max(60).default(''),
  quantity: z.number().positive().max(100_000),
  lotSerial: z.string().trim().max(60).default(''),
});
// What a breakdown report states; completing the repair adds to it but cannot change it (LB-17).
export const REPORTED_FIELDS = ['kind', 'occurredAt', 'reportedBy', 'description', 'failureCategory'] as const;
const isRealDate = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.getUTCFullYear() > 0 && d.toISOString().slice(0, 10) === day;
};
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
    // For a breakdown: the failure or symptom.
    description: z.string().trim().min(1).max(2000),
    workDone: z.string().trim().max(2000).default(''),
    // A1 5.7: unplanned maintenance of sterility-critical equipment needs a recorded impact assessment.
    impactAssessment: z.string().trim().max(2000).default(''),
    // S9 breakdown history (D-25). Optional here so entries made before S9 stay valid; checkData
    // requires them for new breakdowns. The repair start and end are the entry's activity times.
    occurredAt: isoTime.optional(),
    reportedBy: z.string().trim().max(120).default(''),
    failureCategory: z.enum(FAILURE_CATEGORIES).optional(),
    rootCause: z.string().trim().max(2000).default(''),
    parts: z.array(part).max(50).default([]),
    // "No parts used" is stated explicitly, never assumed from an empty list.
    partsNone: z.boolean().default(false),
    toolsUsed: z.string().trim().max(1000).default(''),
    doneBy: z.enum(['in_house', 'vendor']).optional(),
    vendorName: z.string().trim().max(120).default(''),
    serviceReportRef: z.string().trim().max(60).default(''),
    // A CMMS work-order number, kept as a reference only.
    workOrderRef: z.string().trim().max(60).default(''),
    deviationRef: z.string().trim().max(60).default(''),
    postRepairChecks: z.string().trim().max(1000).default(''),
    recalibrationNeeded: z.boolean().default(false),
  }),
  calibration: z.object({
    result: z.enum(['pass', 'fail']),
    certificateRef: z.string().trim().max(100).default(''),
    // Plant-local date YYYY-MM-DD (D-19); a real calendar date (not e.g. 2026-02-30).
    nextDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, 'not a real date'),
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
  // Owner 2026-11-12: change over between products or batches; open until it is ended, like a use.
  change_over: z.object({
    fromProduct: z.string().trim().max(200).default(''),
    fromBatch: z.string().trim().max(80).default(''),
    toProduct: z.string().trim().max(200).default(''),
    toBatch: z.string().trim().max(80).default(''),
    checklist: checklistAnswers,
    remarks: z.string().trim().max(1000).default(''),
  }),
  // Owner 2026-11-12: requalification, pulled from the approved protocol in the Qualification product, or written by
  // hand (e.g. done by a vendor outside it). The protocol's result and next due date are taken from Qualification.
  requalification: z.object({
    source: z.enum(['protocol', 'manual']),
    protocolNumber: z.string().trim().max(40).default(''),
    stage: z.string().trim().max(60).default(''),
    outcome: z.enum(['pass', 'pass_conditions', 'fail']),
    nextDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, 'not a real date').or(z.literal('')).default(''),
    doneBy: z.enum(['in_house', 'vendor']).default('in_house'),
    vendorName: z.string().trim().max(120).default(''),
    reportRef: z.string().trim().max(60).default(''),
    remarks: z.string().trim().max(2000).default(''),
    ...outOfLimit,
  }),
  // Sterile types (S6; Annex 1).
  steriliser_cycle: z.object({
    cycleType: z.enum(['steam', 'dry_heat', 'sip', 'vhp']),
    // A1 8.45: each cycle has a unique identifier (unique per steriliser, checked on save).
    cycleId: z.string().trim().min(1).max(40),
    programme: z.string().trim().max(80).default(''),
    load: z.string().trim().max(500).default(''),
    result: z.enum(['pass', 'fail']),
    // A1 8.50: the controller printout or electronic record is referenced (or attached elsewhere).
    controllerRecordRef: z.string().trim().min(1).max(100),
    indicators: z.string().trim().max(200).default(''),
    remarks: z.string().trim().max(1000).default(''),
    ...outOfLimit,
  }),
  steriliser_test: z.object({
    test: z.enum(['leak', 'air_removal']),
    result: z.enum(['pass', 'fail']),
    remarks: z.string().trim().max(1000).default(''),
    ...outOfLimit,
  }),
  glove_integrity: z.object({
    port: z.string().trim().min(1).max(40),
    method: z.string().trim().max(80).default(''),
    result: z.enum(['pass', 'fail']),
    remarks: z.string().trim().max(1000).default(''),
    ...outOfLimit,
  }),
  pressure_reading: z.object({
    point: z.string().trim().min(1).max(80),
    value: z.number().finite(),
    // Set by the server from the point's limits (LB-16).
    outOfLimit: z.boolean().default(false),
    ...outOfLimit,
  }),
};

// D-16: types whose performer signs with an e-signature (a clause requires the signature).
const PERFORMER_SIGNS = new Set(['equipment_cleaning', 'maintenance', 'area_cleaning', 'calibration', 'steriliser_cycle', 'steriliser_test', 'change_over', 'requalification']);
export const performerSigns = (type: string) => PERFORMER_SIGNS.has(type);

// LB-03 / LB-11: second-person verification needed for this type under these settings.
export const verificationNeeded = (type: string, settings: LogbookSettings) =>
  Boolean(typeByKey(type)?.alwaysVerified || settings.verificationRequired);

// The permission that records each type (LB-21, D-30).
const RECORD_CODE: Record<string, Permission> = {
  equipment_use: 'logbook.entry.record_use',
  equipment_cleaning: 'logbook.entry.record_cleaning',
  area_cleaning: 'logbook.entry.record_cleaning',
  general_log: 'logbook.entry.record_general',
  change_over: 'logbook.entry.record_use',
  requalification: 'logbook.entry.record_requalification',
  maintenance: 'logbook.entry.record_maintenance',
  calibration: 'logbook.entry.record_calibration',
  steriliser_cycle: 'logbook.entry.record_sterile',
  steriliser_test: 'logbook.entry.record_steriliser_test',
  glove_integrity: 'logbook.entry.record_sterile',
  pressure_reading: 'logbook.entry.record_sterile',
};
export const recordCode = (type: string): Permission | undefined => RECORD_CODE[type];
export const mayRecord = (type: string, held: Permission[]) => { const c = RECORD_CODE[type]; return !!c && held.includes(c); };
// D-17: a correction needs the right to record the type, and being the author or holding correct_others.
export const correctCodes = (type: string, own: boolean): Permission[] =>
  [RECORD_CODE[type] ?? 'logbook.entry.record_use', ...(own ? [] : ['logbook.entry.correct_others' as const])];
export const mayCorrect = (type: string, held: Permission[], own: boolean) =>
  !!RECORD_CODE[type] && correctCodes(type, own).every((c) => held.includes(c));

export interface EquipmentInfo {
  kind: 'equipment' | 'instrument' | 'area';
  sterile: boolean;
  classified: boolean;
}

const HAS_CHECKLIST = new Set(['equipment_cleaning', 'area_cleaning', 'general_log', 'change_over']);

// Where the entry stands: the activity end (null while a use or repair is open) and whether it
// continues an entry made before S9, which need not carry the S9 breakdown fields (D-25).
export interface EntryContext {
  end: Date | null;
  legacy: boolean;
}

// LB-02 / LB-06 (D-25): a breakdown states when it occurred and what failed; once the repair has
// ended it also states the parts used (or none) and who did the work.
function checkBreakdown(data: Record<string, unknown>, equipment: EquipmentInfo, activityStart: Date, ctx: EntryContext): string[] {
  const problems: string[] = [];
  const parts = (data.parts ?? []) as unknown[];
  if (data.partsNone && parts.length) problems.push('Either list the parts used or tick "No parts used", not both.');
  if (data.doneBy !== 'vendor' && (String(data.vendorName ?? '') || String(data.serviceReportRef ?? ''))) {
    problems.push('Vendor name and service report are for work done by an external vendor.');
  }
  if (data.doneBy === 'vendor' && !String(data.vendorName ?? '').trim()) problems.push('Give the vendor name.');
  if (data.occurredAt && Date.parse(String(data.occurredAt)) > activityStart.getTime()) {
    problems.push('The breakdown cannot have occurred after the repair started.');
  }
  if (data.recalibrationNeeded && equipment.kind === 'area') problems.push('Areas are not calibrated: untick "Re-calibration needed".');
  if (data.kind !== 'breakdown' || ctx.legacy) return problems;
  if (!data.occurredAt) problems.push('Give the date and time the breakdown occurred.');
  if (!data.failureCategory) problems.push('Choose the failure category.');
  if (ctx.end) {
    if (!parts.length && !data.partsNone) problems.push('List the parts used, or tick "No parts used".');
    if (!data.doneBy) problems.push('State who did the repair (in-house or external vendor).');
  }
  return problems;
}

// LB-11 system checks: consistency, completeness and limits. Returns problems shown to the user.
export function checkData(
  type: string,
  data: Record<string, unknown>,
  settings: LogbookSettings,
  equipment: EquipmentInfo,
  activityStart: Date,
  ctx: EntryContext = { end: activityStart, legacy: false },
): string[] {
  const problems: string[] = [];
  if (type === 'maintenance') problems.push(...checkBreakdown(data, equipment, activityStart, ctx));
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
    const calibrationDay = activityStart.toLocaleDateString('en-CA', { timeZone: process.env.DISPLAY_TZ ?? 'Asia/Kolkata' });
    if (String(data.nextDue) <= calibrationDay) problems.push('The next due date must be after the calibration date.');
    if (data.result === 'fail' && (!String(data.comment ?? '').trim() || !String(data.deviationRef ?? '').trim())) {
      problems.push('A failed calibration needs a comment and a deviation reference.');
    }
  }
  // A failed sterile check needs a comment and a deviation reference (A1 3.2 non-conformities).
  if (['steriliser_cycle', 'steriliser_test', 'glove_integrity'].includes(type) && data.result === 'fail'
      && (!String(data.comment ?? '').trim() || !String(data.deviationRef ?? '').trim())) {
    problems.push('A failed result needs a comment and a deviation reference.');
  }
  if (type === 'pressure_reading') {
    const point = settings.pressurePoints.find((p) => p.name === data.point);
    if (!point) problems.push('Unknown pressure point: choose one of the approved non-critical points.');
    else {
      // LB-16: out-of-limit readings are flagged and need a comment and a deviation reference.
      const value = data.value as number;
      data.outOfLimit = value < point.min || value > point.max;
      if (data.outOfLimit && (!String(data.comment ?? '').trim() || !String(data.deviationRef ?? '').trim())) {
        problems.push(`Reading outside ${point.min}–${point.max} ${point.unit}: give a comment and a deviation reference.`);
      }
    }
  }
  if (type === 'requalification') {
    const day = activityStart.toLocaleDateString('en-CA', { timeZone: process.env.DISPLAY_TZ ?? 'Asia/Kolkata' });
    if (data.source === 'protocol' && !String(data.protocolNumber ?? '').trim()) problems.push('Choose the requalification protocol.');
    if (data.source === 'manual') {
      if (!String(data.reportRef ?? '').trim()) problems.push('Give the requalification report number.');
      if (data.doneBy === 'vendor' && !String(data.vendorName ?? '').trim()) problems.push('Give the vendor name.');
    }
    if (data.nextDue && String(data.nextDue) <= day) problems.push('The next requalification due date must be after this requalification.');
    if (data.outcome === 'fail' && (!String(data.comment ?? '').trim() || !String(data.deviationRef ?? '').trim())) {
      problems.push('A failed requalification needs a comment and a deviation reference.');
    }
  }
  if (type === 'area_cleaning' && equipment.classified) {
    if (!String(data.agent ?? '').trim()) problems.push('Classified rooms: the cleaning/disinfecting agent is required (Annex 1 4.33).');
    if (!String(data.disinfectantLot ?? '').trim()) problems.push('Classified rooms: the disinfectant lot is required.');
  }
  return problems;
}
