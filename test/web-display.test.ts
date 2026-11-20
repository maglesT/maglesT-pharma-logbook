import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Fields } from '../web/src/fields.js';
import { EndUseDialog, UseCheck } from '../web/src/pages/EquipmentPage.js';
import { ApiError, joinParts, plainCode, plantTime, refusalLines, sterileLines, unsignedOlder, type Entry, type EquipmentStatus, type Product } from '../web/src/api.js';
import { entryLines } from '../server/changes.js';
import { dayText, timeText } from '../server/dates.js';

// What the screens show, rendered as the browser gets it (owner 15 Nov 2026, end-to-end run findings).
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const status = (over: Partial<EquipmentStatus> = {}): EquipmentStatus => ({
  equipmentId: 1, state: 'clean', blockers: [], warnings: [], inUse: null, lastTrueBatchUse: null, cleanUntil: null, calibrationDue: null,
  schedule: 'hold', dirtyUntil: null, deadline: null, dues: [], qualification: null, ...over,
});
const line = (html: string, label: string) => new RegExp(`<li class="(\\w+)"><span aria-hidden="true">([^<]*)</span><b>${label}</b>`).exec(html)?.slice(1);

describe('the check before use and the entry details read in words', () => {
  it('LB-05: "Not calibrated in the Logbook" has no green tick: an item with nothing to check shows a dash; a calibration in date keeps its tick', () => {
    const none = renderToStaticMarkup(createElement(UseCheck, { status: status() }));
    expect(line(none, 'Calibration')).toEqual(['none', '–']);
    expect(text(none)).toContain('Calibration Not calibrated in the Logbook');
    expect(line(none, 'Preventive maintenance')).toEqual(['none', '–']);
    expect(line(none, 'Requalification')).toEqual(['none', '–']);
    expect(line(none, 'Cleaning status')).toEqual(['ok', '✓']);
    const due = renderToStaticMarkup(createElement(UseCheck, { status: status({ dues: [{ kind: 'calibration', due: '2099-01-01', frequency: 'every 90 days', soon: false, overdue: false }] }) }));
    expect(line(due, 'Calibration')).toEqual(['ok', '✓']);
    const failed = renderToStaticMarkup(createElement(UseCheck, { status: status({ blockers: ['Not calibrated: no verified calibration on record.'] }) }));
    expect(line(failed, 'Calibration')).toEqual(['bad', '✕']);
  });

  it('LB-02: a requalification entry shows labels and values in words, not stored field names', () => {
    const html = renderToStaticMarkup(createElement(Fields, { data: { source: 'protocol', protocolNumber: 'PRT-2026-0013', stage: 'iq_oq', outcome: 'pass_conditions',
      nextDue: '2027-05-16', doneBy: 'in_house', vendorName: '', reportRef: 'PRT-2026-0013', remarks: 'IQ/OQ of the new coater', comment: '', deviationRef: '' } }));
    const shown = text(html);
    for (const raw of ['source', 'outcome', 'reportRef', 'protocolNumber', 'iq oq', 'pass conditions']) expect(shown).not.toContain(raw);
    expect(shown).toContain('Recorded from Qualification protocol');
    expect(shown).toContain('Protocol PRT-2026-0013');
    expect(shown).toContain('Stage IQ/OQ');
    expect(shown).toContain('Result Pass with conditions');
    expect(shown).toContain('Report PRT-2026-0013');
    expect(text(renderToStaticMarkup(createElement(Fields, { data: { source: 'manual', stage: 'PQ', outcome: 'fail' } })))).toBe('Recorded from Written by hand Stage PQ Result Fail');
    // A use's stage is free text and stays as written.
    expect(text(renderToStaticMarkup(createElement(Fields, { data: { stage: 'Compression' } })))).toBe('Stage Compression');
  });

  it('LB-07: a late cleaning shows why it is late', () => {
    expect(text(renderToStaticMarkup(createElement(Fields, { data: { cleaningType: 'major', delayReason: 'Crew on line clearance' } })))).toBe('Cleaning Major Why late Crew on line clearance');
  });

  it('LB-19: picked values read as the entry form names them, the same as the printed copies (D-60)', () => {
    expect(text(renderToStaticMarkup(createElement(Fields, { data: { kind: 'breakdown', failureCategory: 'instrumentation', doneBy: 'in_house', cleaningType: 'product_change' } }))))
      .toBe('Type Breakdown Failure category Instrumentation Done by In-house Cleaning Product changeover');
    expect(text(renderToStaticMarkup(createElement(Fields, { data: { toBatch: 'B2', remarks: 'ok', fromProduct: 'P1' } })))).toBe('From product P1 To batch B2 Remarks ok');
  });

  it('LB-19: dates read "30 Jan 2027" in plant time, never ISO, with September as "Sep" (D-49)', () => {
    expect(dayText('2027-01-30')).toBe('30 Jan 2027');
    expect(dayText('2027-09-30')).toBe('30 Sep 2027');
    // A moment is shown on its plant day: 20:00 UTC is the next day in India.
    expect(dayText(new Date('2027-09-29T20:00:00Z'))).toBe('30 Sep 2027');
    expect(timeText('2027-09-30T09:35:00Z')).toBe('30 Sep 2027, 15:05 IST');
    expect(timeText('2027-09-29T18:40:00Z')).toBe('30 Sep 2027, 00:10 IST');
    // Screens: the year only when it is not this year; printed copies always (TrueBatch rule).
    const now = new Date('2026-11-20T12:00:00Z');
    expect(timeText('2026-11-16T06:30:00Z', { withYear: 'auto', now })).toBe('16 Nov, 12:00 IST');
    expect(timeText('2025-11-16T06:30:00Z', { withYear: 'auto', now })).toBe('16 Nov 2025, 12:00 IST');
    expect(plantTime(new Date().toISOString())).not.toMatch(/\d{4},/);
    expect(plantTime('2020-01-01T06:30:00Z')).toBe('1 Jan 2020, 12:00 IST');
    expect(dayText(null)).toBe('—');
    const item = text(renderToStaticMarkup(createElement(UseCheck, { status: status({ dues: [
      { kind: 'pm', due: '2027-02-02', frequency: 'every 90 days', soon: false, overdue: false },
      { kind: 'calibration', due: '2027-01-30', frequency: 'every 90 days', soon: false, overdue: false }] }) })));
    expect(item).toContain('Preventive maintenance Due 2 Feb 2027');
    expect(item).toContain('Calibration Due 30 Jan 2027');
    const entry = text(renderToStaticMarkup(createElement(Fields, { data: { result: 'pass', nextDue: '2027-10-31', certificateRef: 'CAL-1' } })));
    expect(entry).toContain('Next due 31 Oct 2027');
    for (const shown of [item, entry]) expect(shown).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('LB-01: "End use" always shows the reason; it is marked required for a batch from another product\'s batch records (D-49)', () => {
    const use = { id: 1, logbookType: 'equipment_use', batch: 'RAB26001', data: {} } as unknown as Entry;
    const dialog = (from: string | null) => text(renderToStaticMarkup(createElement(EndUseDialog,
      { entry: { ...use, endReasonFrom: from }, what: 'EQ-BLS-01 · batch RAB26001', onEnd: async () => {}, onCancel: () => {} })));
    expect(dialog(null)).toContain('Why the use ends (optional)');
    expect(dialog(null)).not.toContain('Required');
    expect(dialog('TrueBatch')).toContain('Why the use ends');
    expect(dialog('TrueBatch')).not.toContain('(optional)');
    expect(dialog('TrueBatch')).toContain('Required: batch RAB26001 is from the batch records of TrueBatch.');
    expect(renderToStaticMarkup(createElement(EndUseDialog, { entry: use, what: '', onEnd: async () => {}, onCancel: () => {} })))
      .toContain('<option value="Batch record withdrawn">');
  });

  it('LB-02: a change over shows its fields by label, not stored names (D-55)', () => {
    const shown = text(renderToStaticMarkup(createElement(Fields, { data: { fromProduct: 'PCM-500', fromBatch: 'TB260001', toProduct: 'IBU-400', toBatch: 'TB260002', checklist: {}, remarks: '' } })));
    expect(shown).toBe('From product PCM-500 From batch TB260001 To product IBU-400 To batch TB260002');
  });

  it('LB-02: an older change over that kept bare product codes shows them with their master-data names (display round 1120)', () => {
    const products = [{ id: 1, code: 'PCM-500', name: 'Paracetamol tablets 500 mg' }, { id: 2, code: 'IBU-400', name: 'Ibuprofen tablets 400 mg' }] as Product[];
    const shown = text(renderToStaticMarkup(createElement(Fields, { products, data: { fromProduct: 'PCM-500', toProduct: 'IBU-400 · Ibuprofen tablets 400 mg', toBatch: 'TB2' } })));
    expect(shown).toBe('From product PCM-500 · Paracetamol tablets 500 mg To product IBU-400 · Ibuprofen tablets 400 mg To batch TB2');
    expect(entryLines({ fromProduct: 'PCM-500', toProduct: 'XX-1' }, new Map([['PCM-500', 'Paracetamol tablets 500 mg']])))
      .toEqual(['From product: PCM-500 · Paracetamol tablets 500 mg', 'To product: XX-1']);
  });

  it('LB-12: an older entry of a signed type made before that type was signed says so instead of an empty signature column', () => {
    expect(unsignedOlder({ logbookType: 'glove_integrity', version: 1, signatures: [] })).toBe(true);
    expect(unsignedOlder({ logbookType: 'glove_integrity', version: 1, signatures: [{}] })).toBe(false);
    expect(unsignedOlder({ logbookType: 'equipment_use', version: 1, signatures: [] })).toBe(false);
    expect(unsignedOlder({ logbookType: 'change_over', version: 2, signatures: [] })).toBe(false);
  });

  it('a refused save shows the server\'s problems, never its bare code ("check_failed")', () => {
    const err = new ApiError(400, 'check_failed', 'Batch TI1: a cycle for a batch is recorded in its batch record.', ['Batch TI1: a cycle for a batch is recorded in its batch record.']);
    expect(refusalLines(err, {})).toEqual(['Batch TI1: a cycle for a batch is recorded in its batch record.']);
    expect(refusalLines(err, { check_failed: 'Not saved:' })).toEqual(['Not saved:', 'Batch TI1: a cycle for a batch is recorded in its batch record.']);
    expect(plainCode('type_not_configured')).toBe('Type not configured.');
  });

  it('a line of parts leaves the empty ones out: no "· ·" (D-55)', () => {
    expect(joinParts(['PCM-500', null, '', ' ', 'in production'])).toBe('PCM-500 · in production');
    expect(joinParts(['', null])).toBe('');
  });
});

describe('sterile validity on the item page (D-64)', () => {
  it('shows each sterile check while it is valid, as a plain line; an expired one only as its blocker', () => {
    expect(sterileLines(status())).toEqual([]);
    expect(sterileLines(status({ sterileDues: [
      { kind: 'decontamination', until: '2026-11-23', overdue: false },
      { kind: 'glove_test', until: '2026-11-20', overdue: false },
      { kind: 'steriliser_test', until: '2026-11-16', overdue: true },
    ] }))).toEqual(['Decontamination valid until 23 Nov 2026', 'Glove test due by 20 Nov 2026']);
  });
});
