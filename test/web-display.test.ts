import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UseCheck } from '../web/src/pages/EquipmentPage.js';
import type { EquipmentStatus } from '../web/src/api.js';

// What the screens show, rendered as the browser gets it (owner 15 Nov 2026, end-to-end run findings).
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const status = (over: Partial<EquipmentStatus> = {}): EquipmentStatus => ({
  equipmentId: 1, state: 'clean', blockers: [], warnings: [], inUse: null, lastTrueBatchUse: null, cleanUntil: null, calibrationDue: null,
  schedule: 'hold', dirtyUntil: null, deadline: null, dues: [], qualification: null, ...over,
});
const line = (html: string, label: string) => new RegExp(`<li class="(\\w+)"><span aria-hidden="true">([^<]*)</span><b>${label}</b>`).exec(html)?.slice(1);

describe('the check before use reads right', () => {
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
});
