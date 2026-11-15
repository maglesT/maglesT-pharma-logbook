import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Fields } from '../web/src/fields.js';
import { UseCheck } from '../web/src/pages/EquipmentPage.js';
import type { EquipmentStatus } from '../web/src/api.js';

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
    expect(text(renderToStaticMarkup(createElement(Fields, { data: { cleaningType: 'major', delayReason: 'Crew on line clearance' } })))).toBe('Cleaning major Why late Crew on line clearance');
  });
});
