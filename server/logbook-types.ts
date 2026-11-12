import { z } from 'zod';

// Built-in logbook types (D-07). Each type's entry form and status effect arrive in S3/S4;
// here: identity, which equipment kinds it applies to, and what a site may configure.

const limit = z
  .object({ min: z.number().finite().optional(), max: z.number().finite().optional(), unit: z.string().max(20).default('') })
  .refine((l) => l.min === undefined || l.max === undefined || l.min <= l.max, 'min must not exceed max');

// Languages a speaker may use for voice notes (S10, D-26): Sarvam BCP-47 codes.
export const VOICE_LANGUAGES = ['hi-IN', 'mr-IN', 'gu-IN', 'ta-IN', 'te-IN', 'kn-IN', 'ml-IN', 'bn-IN', 'pa-IN', 'od-IN', 'en-IN'] as const;

export const settingsSchema = z.object({
  enabled: z.boolean(),
  sopRef: z.string().trim().max(100).default(''),
  // Site checklist items shown on the entry form.
  checklist: z.array(z.string().trim().min(1).max(200)).max(40).default([]),
  // Whether a second person must sign "Verified" where the rules leave it optional (LB-11).
  verificationRequired: z.boolean().default(false),
  limits: z.record(z.string().max(40), limit).default({}),
  // Pressure-reading points; only non-critical points may be read manually (LB-16).
  pressurePoints: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        critical: z.literal(false),
        ccsRef: z.string().trim().min(1).max(100),
        min: z.number().finite(),
        max: z.number().finite(),
        unit: z.string().max(10).default('Pa'),
      })
      .refine((p) => p.min <= p.max, 'min must not exceed max'),
    )
    .max(100)
    .default([]),
  // Voice notes site setting only: the languages a speaker may use (D-26).
  voiceLanguages: z.array(z.enum(VOICE_LANGUAGES)).max(VOICE_LANGUAGES.length).default([]),
});
export type LogbookSettings = z.infer<typeof settingsSchema>;

export interface LogbookType {
  key: string;
  label: string;
  appliesTo: ('equipment' | 'instrument' | 'area')[];
  sterile: boolean;
  // A second-person check required by a clause regardless of settings (LB-03, LB-12).
  alwaysVerified: boolean;
}

export const LOGBOOK_TYPES: LogbookType[] = [
  { key: 'equipment_use', label: 'Equipment use', appliesTo: ['equipment', 'instrument', 'area'], sterile: false, alwaysVerified: false },
  { key: 'equipment_cleaning', label: 'Equipment cleaning', appliesTo: ['equipment', 'instrument'], sterile: false, alwaysVerified: true },
  { key: 'maintenance', label: 'Maintenance / breakdown', appliesTo: ['equipment', 'instrument', 'area'], sterile: false, alwaysVerified: true },
  { key: 'calibration', label: 'Calibration / check', appliesTo: ['equipment', 'instrument'], sterile: false, alwaysVerified: true },
  { key: 'area_cleaning', label: 'Area cleaning', appliesTo: ['area'], sterile: false, alwaysVerified: true },
  // Owner 2026-11-12 (slides 1-3): change over between products or batches, and requalification.
  { key: 'change_over', label: 'Change over', appliesTo: ['equipment', 'instrument', 'area'], sterile: false, alwaysVerified: true },
  { key: 'requalification', label: 'Requalification', appliesTo: ['equipment', 'instrument', 'area'], sterile: false, alwaysVerified: true },
  { key: 'general_log', label: 'General equipment log', appliesTo: ['equipment', 'instrument', 'area'], sterile: false, alwaysVerified: false },
  { key: 'steriliser_cycle', label: 'Sterilisation / decontamination cycle', appliesTo: ['equipment'], sterile: true, alwaysVerified: true },
  { key: 'steriliser_test', label: 'Steriliser test (leak, air removal)', appliesTo: ['equipment'], sterile: true, alwaysVerified: true },
  { key: 'glove_integrity', label: 'Glove integrity (isolator/RABS)', appliesTo: ['equipment'], sterile: true, alwaysVerified: false },
  { key: 'pressure_reading', label: 'Pressure reading (non-critical points)', appliesTo: ['area'], sterile: true, alwaysVerified: false },
  // A site setting, not a logbook: switches voice notes on and selects the languages (D-26).
  { key: 'voice_notes', label: 'Voice notes (site setting)', appliesTo: [], sterile: false, alwaysVerified: false },
  // A site setting: lets a language model suggest from breakdown history (D-27).
  { key: 'breakdown_advice', label: 'Breakdown suggestions from history (site setting)', appliesTo: [], sterile: false, alwaysVerified: false },
];

export const typeByKey = (key: string) => LOGBOOK_TYPES.find((t) => t.key === key);
