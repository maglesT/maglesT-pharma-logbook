import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AREA_TYPES, EQUIPMENT_TYPES, FACILITIES, FAMILY_PROCESSES, FORMS, INSTRUMENT_TYPES, NO_SELECTION, OTHER, PROCESSES, classify, crumbs, expandSpec, facilitiesOf, filterRows,
  formNode, itemMatches, pathsOf, processNode, selectionFromString, selectionToString, typeOf, type Kind, type Node, type Selection } from '../shared/taxonomy.js';
import { addItem, call, freshApp, login, seedUser, type TestApp } from './helpers.js';

// Owner 2026-11-14 (D-42): the Logbooks page filters by kind → facility → dosage form → process (→ step) → grade; every
// master-data type is placed in the tree by shared/taxonomy.ts, which later moves into platform master data unchanged.

const catalogue = JSON.parse(readFileSync(path.join(import.meta.dirname, '../db/demo-taxonomy-items.json'), 'utf8')) as {
  rooms: { code: string; name: string; area: string; grade: string }[];
  equipment: { code: string; name: string; type: string; room: string }[];
  instruments: { code: string; name: string; type: string; room: string }[];
};
const ids = (nodes: Node[], into: string[] = []): string[] => { for (const x of nodes) { into.push(x.id); if (x.children) ids(x.children, into); } return into; };
const FORM_IDS = new Set(ids(FORMS));
const PROCESS_IDS = new Set(ids(PROCESSES));
const sel = (s: Partial<Selection>): Selection => ({ ...NO_SELECTION, ...s });

describe('taxonomy: the tree and the type table (D-42)', () => {
  it('every spec of every type names forms and processes that exist in the tree', () => {
    const tables: [Kind, Record<string, string[]>][] = [['equipment', EQUIPMENT_TYPES], ['instrument', INSTRUMENT_TYPES], ['area', AREA_TYPES]];
    for (const [kind, table] of tables) {
      for (const [type, specs] of Object.entries(table)) {
        for (const spec of specs) {
          const paths = expandSpec(kind, spec);
          expect(paths.length, `${kind} ${type}: ${spec}`).toBeGreaterThan(0);
          for (const p of paths) {
            expect(FORM_IDS.has(p[1]!), `${kind} ${type}: form ${p[1]} (${spec})`).toBe(true);
            if (p[2]) {
              expect(PROCESS_IDS.has(p[2].replace(/\.ipc$/, '')), `${kind} ${type}: process ${p[2]} (${spec})`).toBe(true);
              // The process belongs to the form's family, so "show all categories" lists it under that form.
              expect(FAMILY_PROCESSES[p[1]!.split('.')[0]!], `${type}: family of ${p[1]}`).toContain(p[2].split('.')[0]);
            }
          }
        }
      }
    }
    // Ids are unique and every family process exists.
    expect(new Set(ids(PROCESSES)).size).toBe(ids(PROCESSES).length);
    for (const list of Object.values(FAMILY_PROCESSES)) for (const id of list) expect(processNode(id), id).toBeDefined();
    expect(ids(FACILITIES)).toContain('beta_lactam.cephalosporin');
  });

  it('every demo type and every type already in master data maps somewhere real (not "Other")', () => {
    for (const e of catalogue.equipment) expect(pathsOf({ kind: 'equipment', type: e.type })[0]![1], `${e.code} ${e.type}`).not.toBe(OTHER);
    for (const i of catalogue.instruments) expect(pathsOf({ kind: 'instrument', type: i.type })[0]![1], `${i.code} ${i.type}`).not.toBe(OTHER);
    for (const r of catalogue.rooms) expect(pathsOf({ kind: 'area', type: r.area })[0]![1], `${r.code} ${r.area}`).not.toBe(OTHER);
    // The types the demo master data had before this feature (master_data report views, 14 Nov 2026).
    for (const t of ['AHU', 'Blender', 'Blister packer', 'Cartoner', 'Check weigher', 'Coater', 'Compressor', 'Deduster', 'Dispensing booth', 'Dryer', 'Granulator', 'Mill',
      'Roller compactor', 'Sifter', 'Stability chamber', 'Strip packer', 'Tablet press', 'Vessel', 'Water system']) expect(pathsOf({ kind: 'equipment', type: t })[0]![1], t).not.toBe(OTHER);
    for (const t of ['Balance', 'Disintegration tester', 'Dissolution apparatus', 'Friabilator', 'Hardness tester', 'HPLC', 'Moisture analyser', 'pH meter', 'Spectrophotometer', 'Titrator'])
      expect(pathsOf({ kind: 'instrument', type: t })[0]![1], t).not.toBe(OTHER);
    for (const a of ['Coating', 'Compression', 'Dispensing', 'Granulation', 'Packing', 'QC', 'Utilities', 'Warehouse']) expect(pathsOf({ kind: 'area', type: a })[0]![1], a).not.toBe(OTHER);
    // Most branches of the tree carry at least one demo item.
    const all = [...catalogue.equipment.map((e) => classify({ kind: 'equipment', type: e.type, name: e.name })), ...catalogue.instruments.map((i) => classify({ kind: 'instrument', type: i.type, name: i.name })),
      ...catalogue.rooms.map((r) => classify({ kind: 'area', type: r.area, name: r.name, grade: r.grade }))];
    const empty = ids(FORMS).filter((f) => !all.some((c) => itemMatches(c, sel({ form: f }))));
    expect(empty, 'forms without demo items').toEqual([]);
    const emptyProcesses = ids(PROCESSES).filter((p) => !all.some((c) => c.paths.some((x) => x[2] === p || x[2]?.startsWith(`${p}.`))));
    expect(emptyProcesses.length, `processes without demo items: ${emptyProcesses.join(', ')}`).toBeLessThan(ids(PROCESSES).length * 0.1);
    for (const f of ids(FACILITIES)) expect(all.some((c) => c.facilities.some((x) => x === f || x.startsWith(`${f}.`))), `facility ${f}`).toBe(true);
  });

  it('a type can sit in several places; an unknown type is "Other"; a missing type is read from the name; case does not matter', () => {
    const blender = pathsOf({ kind: 'equipment', type: 'Octagonal blender' });
    expect(blender.map((p) => p.slice(1).join('/'))).toEqual(['osd.tablet/blending.octagonal', 'osd.capsule.hard/blending.octagonal', 'api/blending.octagonal']);
    expect(pathsOf({ kind: 'equipment', type: 'Flux capacitor' })).toEqual([['equipment', OTHER]]);
    expect(pathsOf({ kind: 'instrument', type: '  hplc ' })).toEqual([['instrument', 'qc', 'chromatography.hplc']]);
    expect(typeOf({ kind: 'equipment', type: '', name: 'Double-rotary press, 45 stations (beta-lactam suite)' })).toBe('Double rotary tablet press');
    expect(typeOf({ kind: 'area', name: 'Beta-lactam suite: coating room' })).toBe('Coating');
    expect(typeOf({ kind: 'area', name: 'Room INSP-1' })).toBeNull();
    expect(pathsOf({ kind: 'area', name: 'Room INSP-1' })).toEqual([['area', OTHER]]);
    // "*" means every form family (airlocks and change rooms exist in every block).
    expect(pathsOf({ kind: 'area', type: 'Airlock' }).map((p) => p[1])).toEqual(FORMS.map((f) => f.id));
  });

  it('a bench instrument stands where its room is (IPC), except in the QC laboratory', () => {
    expect(pathsOf({ kind: 'instrument', type: 'Hardness tester', roomArea: 'Compression' })).toEqual([['instrument', 'osd.tablet', 'compression.ipc']]);
    expect(pathsOf({ kind: 'instrument', type: 'Hardness tester', roomArea: 'QC' })).toEqual([['instrument', 'qc', 'physical.hardness']]);
    expect(pathsOf({ kind: 'instrument', type: 'Hardness tester' })).toEqual([['instrument', 'qc', 'physical.hardness']]);
    expect(pathsOf({ kind: 'instrument', type: 'IPC balance', roomArea: 'Powder filling' })).toEqual([['instrument', 'injection.dpi', 'filling.powder.ipc']]);
    // A room without a process (Utilities) gives nothing to stand in: the type's own places.
    expect(pathsOf({ kind: 'instrument', type: 'Balance', roomArea: 'Utilities' })).toEqual([['instrument', 'qc', 'weighing.analytical']]);
  });

  it('the facility comes from the name, else the room name, else the form; the specific beats the branch', () => {
    expect(facilitiesOf({ kind: 'area', type: 'Compression', name: 'Beta-lactam (penicillin) block: compression room' })).toEqual(['beta_lactam.penicillin']);
    expect(facilitiesOf({ kind: 'equipment', type: 'Tablet press', name: 'Rotary tablet press', roomName: 'Oncology OSD block: compression (containment)' })).toEqual(['oncology']);
    expect(facilitiesOf({ kind: 'equipment', type: 'Tablet press', name: 'Rotary tablet press' })).toEqual(['general']);
    expect(facilitiesOf({ kind: 'equipment', type: 'Vial filling machine', name: 'Vial filling machine' })).toEqual(['sterile']);
    expect(facilitiesOf({ kind: 'equipment', type: 'Bioreactor', name: 'Bioreactor 2000 L' })).toEqual(['biologics']);
    expect(facilitiesOf({ kind: 'equipment', type: 'Cyclotron', name: 'Cyclotron 18 MeV' })).toEqual(['radiopharma']);
    expect(facilitiesOf({ kind: 'area', type: 'Airlock', name: 'Beta-lactam suite: airlock' })).toEqual(['beta_lactam']);
    expect(classify({ kind: 'area', type: 'Aseptic filling', name: 'Oncology suite: aseptic filling (isolator)', grade: 'B' }).grade).toBe('B');
    expect(classify({ kind: 'equipment', type: 'Tablet press', grade: 'D' }).grade).toBeNull();
  });

  it('matching: a form branch belongs to every leaf below it; a process branch is "Other / unspecified" among its children', () => {
    const booth = classify({ kind: 'equipment', type: 'Dispensing booth', name: 'Booth' });            // osd dispensing.booth
    const dryer = classify({ kind: 'equipment', type: 'Dryer', name: 'Dryer' });                        // osd.tablet drying (no step)
    const fbd = classify({ kind: 'equipment', type: 'Fluid bed dryer', name: 'FBD' });                   // drying.fbd
    expect(itemMatches(booth, sel({ form: 'osd.capsule.soft' }))).toBe(true);
    expect(itemMatches(booth, sel({ form: 'injection' }))).toBe(false);
    expect(itemMatches(dryer, sel({ form: 'osd.tablet', process: 'drying' }))).toBe(true);
    expect(itemMatches(dryer, sel({ form: 'osd.tablet', process: 'drying.fbd' }))).toBe(false);
    expect(itemMatches(dryer, sel({ form: 'osd.tablet', process: 'drying.other' }))).toBe(true);
    expect(itemMatches(fbd, sel({ form: 'osd.tablet', process: 'drying.other' }))).toBe(false);
    expect(itemMatches(fbd, sel({ kind: 'instrument', form: 'osd.tablet' }))).toBe(false);
    expect(itemMatches(fbd, sel({ facility: 'beta_lactam' }))).toBe(false);
    expect(itemMatches(classify({ kind: 'equipment', type: 'Tablet press', name: 'Press', roomName: 'Beta-lactam (penicillin) block' }), sel({ facility: 'beta_lactam' }))).toBe(true);
  });

  it('rows: each level appears after the previous one, counts say what a click leaves, empty branches hide unless "show all"', () => {
    const items = [
      classify({ kind: 'equipment', type: 'Rapid mixer granulator', name: 'RMG' }), classify({ kind: 'equipment', type: 'Roller compactor', name: 'RC' }),
      classify({ kind: 'equipment', type: 'Tablet press', name: 'Press' }), classify({ kind: 'instrument', type: 'HPLC', name: 'HPLC' }),
      classify({ kind: 'area', type: 'Granulation', name: 'Granulation room', grade: 'D' }), classify({ kind: 'equipment', type: 'Lyophiliser', name: 'Lyo' }),
    ];
    const rows0 = filterRows(items, NO_SELECTION);
    expect(rows0.map((r) => r.key)).toEqual(['kind', 'facility:', 'form:']);                 // no process row before a form is chosen
    const kind = rows0[0]!;
    expect(kind.options.map((o) => [o.id, o.count])).toEqual([['equipment', 4], ['instrument', 1], ['area', 1], ['system', 0]]);
    expect(rows0[2]!.options.map((o) => o.id)).toEqual(['osd', 'injection', 'biologics', 'qc']);   // empty forms hidden (the lyophiliser also serves biologics)
    expect(filterRows(items, NO_SELECTION, true)[2]!.options.map((o) => o.id)).toEqual(FORMS.map((f) => f.id));

    const s1 = kind.options[0]!.to;                                                           // Equipment
    const s2 = filterRows(items, s1).find((r) => r.key === 'form:')!.options.find((o) => o.id === 'osd')!.to;
    const rows2 = filterRows(items, s2);
    expect(rows2.map((r) => r.key)).toEqual(['kind', 'facility:', 'form:', 'form:osd', 'process:']);
    const tablet = rows2.find((r) => r.key === 'form:osd')!.options.find((o) => o.id === 'osd.tablet')!;
    expect(tablet.count).toBe(3);
    const rows3 = filterRows(items, tablet.to);
    const gran = rows3.find((r) => r.key === 'process:')!.options.find((o) => o.id === 'granulation')!;
    expect(rows3.find((r) => r.key === 'process:')!.options.map((o) => [o.id, o.count])).toEqual([['granulation', 2], ['compression', 1]]);
    const rows4 = filterRows(items, gran.to);
    expect(rows4.find((r) => r.key === 'process:granulation')!.options.map((o) => [o.id, o.count])).toEqual([['granulation.wet', 1], ['granulation.dry', 1]]);
    const dry = rows4.find((r) => r.key === 'process:granulation')!.options[1]!;
    const rows5 = filterRows(items, dry.to);
    expect(rows5.find((r) => r.key === 'process:granulation.dry')!.options.map((o) => [o.id, o.count])).toEqual([['granulation.dry.roller_compaction', 1]]);
    expect(items.filter((i) => itemMatches(i, dry.to)).length).toBe(1);
    // Switching the kind to Areas keeps form and process while they still lead somewhere, and adds the grade row.
    const areas = rows5[0]!.options[2]!.to;
    expect(areas).toMatchObject({ kind: 'area', form: 'osd.tablet', process: 'granulation.dry' });
    expect(filterRows(items, { ...areas, process: 'granulation' }).find((r) => r.key === 'grade')!.options.map((o) => [o.id, o.count])).toEqual([['D', 1]]);
    // Breadcrumb goes back up one level at a time.
    expect(crumbs(dry.to).map((c) => c.label)).toEqual(['Equipment', 'Oral solid dosage (OSD)', 'Tablet', 'Granulation', 'Dry granulation']);
    expect(crumbs(dry.to)[2]!.to).toEqual(sel({ kind: 'equipment', form: 'osd.tablet' }));
    expect(formNode('osd.capsule')!.children!.map((c) => c.id)).toEqual(['osd.capsule.hard', 'osd.capsule.soft', 'osd.capsule.liquid_fill']);
  });

  it('the selection survives the URL hash and rejects junk', () => {
    const s = sel({ kind: 'equipment', facility: 'beta_lactam.penicillin', form: 'osd.tablet', process: 'coating.film' });
    expect(selectionToString(s)).toBe('equipment/beta_lactam.penicillin/osd.tablet/coating.film');
    expect(selectionFromString(selectionToString(s))).toEqual(s);
    expect(selectionFromString('area////D')).toEqual(sel({ kind: 'area', grade: 'D' }));
    expect(selectionFromString('bogus/<script>/osd.tablet')).toEqual(sel({ form: 'osd.tablet' }));
    expect(selectionFromString('')).toEqual(NO_SELECTION);
  });
});

describe('GET /api/equipment carries the classification (D-42)', () => {
  let t: TestApp;
  let cookie: string;
  beforeAll(async () => {
    t = await freshApp();
    await seedUser(t.owner, 'op1', ['operator']);
    cookie = (await login(t.app, 'op1')).cookie;
  });
  afterAll(async () => { await t?.close(); });

  it('type, paths, facilities and grade come from master data: the type, the room\'s area and name, the room\'s grade', async () => {
    await addItem(t, { code: 'TX-ROOM', kind: 'area', type: 'Compression', grade: 'D', name: 'Beta-lactam (penicillin) block: compression room' });
    await addItem(t, { code: 'TX-PRESS', type: 'Tablet press', name: 'Rotary tablet press', location: 'TX-ROOM' });
    await addItem(t, { code: 'TX-HT', kind: 'instrument', type: 'Hardness tester', name: 'Hardness tester', location: 'TX-ROOM' });
    await addItem(t, { code: 'TX-UNKNOWN', type: 'Flux capacitor', name: 'Odd machine' });
    await addItem(t, { code: 'TX-NOTYPE', kind: 'instrument', name: 'Vacuum-decay leak tester' });
    const res = await call(t.app, cookie, 'GET', '/api/equipment');
    expect(res.statusCode).toBe(200);
    const by = Object.fromEntries((res.json() as { code: string }[]).map((i) => [i.code, i])) as unknown as Record<string, { type: string | null; paths: string[][]; facilities: string[]; grade: string | null }>;
    expect(by['TX-ROOM']).toMatchObject({ type: 'Compression', grade: 'D', facilities: ['beta_lactam.penicillin'], paths: [['area', 'osd.tablet', 'compression']] });
    expect(by['TX-PRESS']).toMatchObject({ type: 'Tablet press', grade: null, facilities: ['beta_lactam.penicillin'], paths: [['equipment', 'osd.tablet', 'compression.rotary']] });
    expect(by['TX-HT']!.paths).toEqual([['instrument', 'osd.tablet', 'compression.ipc']]);
    expect(by['TX-UNKNOWN']).toMatchObject({ type: 'Flux capacitor', paths: [['equipment', 'other']], facilities: ['general'] });
    expect(by['TX-NOTYPE']).toMatchObject({ type: 'Leak tester', paths: [['instrument', 'osd', 'packing.leak'], ['instrument', 'liquid', 'packing.leak']] });
  });
});

describe('engineering systems (owner 14 Nov)', () => {
  it('LB-21: utility systems (HVAC, water, steam, gases, cooling, power, effluent) form their own group next to equipment, instruments and areas', async () => {
    const { classify } = await import('../shared/taxonomy.js');
    for (const type of ['Purified water system', 'Air handling unit', 'Pure steam generator', 'Chiller', 'Diesel generator']) {
      const c = classify({ kind: 'equipment', type, name: type });
      expect(c.group, type).toBe('system');
      expect(c.paths.every((p) => p[0] === 'system'), type).toBe(true);
    }
    expect(classify({ kind: 'equipment', type: 'Rapid mixer granulator', name: 'RMG' }).group).toBe('equipment');
  });
});

describe('engineering systems from master data (platform D-26)', () => {
  it('LB-21: master data\'s equipment category decides the group; without it the type decides', async () => {
    const { classify } = await import('../shared/taxonomy.js');
    expect(classify({ kind: 'equipment', type: 'Rapid mixer granulator', name: 'RMG', equipmentClass: 'engineering_system' }).group).toBe('system');
    expect(classify({ kind: 'equipment', type: 'Chiller', name: 'Chiller', equipmentClass: 'process' }).group).toBe('equipment');
    expect(classify({ kind: 'equipment', type: 'Chiller', name: 'Chiller' }).group).toBe('system');
  });
});
