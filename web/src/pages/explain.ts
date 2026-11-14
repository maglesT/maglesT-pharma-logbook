// Owner 2026-11-14: exceptions and abnormal readings from the batch records, explained in plain words: what the
// problem is, what happened, why it matters and what to do. Fixed, explainable text by the record's type (advice only;
// the batch record in Batchwright is the evidence).

export interface ExcLike { type: string; category: string; severity: string; step: string | null; stepTitle: string | null; description: string | null; status: string; disposition: string | null }
export interface ReadingLike { checkKind?: string; item?: string | null; tag?: string; value: string | null; unit: string | null; lower: string | null; upper: string | null; result?: string; withinLimits?: boolean | null; stepTitle?: string | null; step?: string | null }
export interface Explained { problem: string; happened: string; why: string; todo: string; status: string; tone: 'bad' | 'warn' | 'ok' }

const step = (e: { stepTitle?: string | null; step?: string | null }) => e.stepTitle ? `"${e.stepTitle}"` : e.step ? `step ${e.step.replace(/^p-/, '').replace(/@$/, '').replaceAll('-', ' ')}` : 'the step';
// Material or value names as the record writes them (dispApi, pkForming, blister.seal_temp_C) in plain words.
const NAME: Record<string, string> = { dispApi: 'the active ingredient', dispMcc: 'microcrystalline cellulose', dispLac: 'lactose', dispPvp: 'povidone',
  dispIpa: 'isopropyl alcohol', dispCcs: 'croscarmellose sodium', dispSio: 'colloidal silica', dispMgs: 'magnesium stearate', pkForming: 'the forming foil' };
const nice = (s: string) => NAME[s] ?? s.replace(/^blister\./, 'blister ').replace(/_C$/, ' (°C)').replace(/_bar$/, ' (bar)').replace(/_s$/, ' (s)').replaceAll('_', ' ');
function itemOf(d: string | null): string | null {
  if (!d) return null;
  const c = d.match(/^The (\w[\w ]*?) check at p-/);
  if (c) return `${c[1]} check`;
  const m = d.match(/^A weight for (\S+) at/) ?? d.match(/^(\S+) at p-[\w-]+@ was keyed/);
  return m ? nice(m[1]!) : null;
}
function statusOf(e: ExcLike): { status: string; tone: Explained['tone'] } {
  if (e.status === 'OPEN') return { status: 'Open: waiting for a decision (disposition) by QA', tone: /ACTION|CRITICAL|MAJOR/i.test(e.severity) ? 'bad' : 'warn' };
  if (e.disposition === 'NO_IMPACT') return { status: 'Closed by QA: no impact on the product', tone: 'ok' };
  if (e.disposition === 'DEVIATION_RAISED') return { status: 'Closed by QA: a deviation was raised', tone: 'ok' };
  return { status: `${e.status.toLowerCase().replaceAll('_', ' ')}${e.disposition ? ` (${e.disposition.toLowerCase().replaceAll('_', ' ')})` : ''}`, tone: 'ok' };
}

export function explainException(e: ExcLike): Explained {
  const st = statusOf(e);
  const what = itemOf(e.description);
  switch (e.type) {
    case 'MANUAL_ENTRY_FALLBACK':
      return { ...st, problem: 'Weight typed by hand',
        happened: `The weight${what ? ` of ${what}` : ''} at ${step(e)} was typed in by the operator, because the balance did not send it to the batch record by itself.`,
        why: 'A typed weight has no electronic proof from the balance and can contain a typing mistake, so GMP needs a second person to check it.',
        todo: 'Check that the second person verified the weight. Find out why the balance was not read (cable, interface, balance not ready) and fix it, so weights are read automatically next time.' };
    case 'PROCESS_MANUAL_FALLBACK':
      return { ...st, problem: 'Machine value typed by hand',
        happened: `The process value${what ? ` "${what}"` : ''} at ${step(e)} was typed in, because the machine did not send it to the batch record.`,
        why: 'Without the automatic value there is no electronic proof of the process condition, and a typing mistake is possible.',
        todo: 'Check the typed value against the machine printout or screen. Get the machine-to-system connection checked by engineering.' };
    case 'IPC_MANUAL_ENTRY':
      return { ...st, problem: 'In-process check typed by hand',
        happened: `The ${what ?? 'in-process check'} at ${step(e)} was typed in instead of being taken from the testing instrument.`,
        why: 'A typed result has no electronic proof from the instrument; a second person must confirm it.',
        todo: 'Confirm the second-person check. Check the instrument connection (balance, hardness tester) used at this step.' };
    case 'IPC_CHECK_FAILED':
      return { ...st, problem: 'In-process check outside its limits',
        happened: `A check at ${step(e)} gave a result outside the limits written in the master record. Batchwright held the next steps until QA decides.`,
        why: 'The product made at that time may not meet its specification (for tablets: hardness, weight or thickness affect dissolution and dose).',
        todo: 'Look at the failed values (see abnormal readings), adjust the machine (e.g. compression force), re-test, and decide with QA whether a deviation is needed.' };
    case 'OPERATOR_RAISED':
      return { ...st, problem: 'Problem reported by the operator',
        happened: e.description ?? `The operator reported a problem at ${step(e)}.`,
        why: 'The operator saw something not covered by the instructions; QA must judge the effect on the batch.',
        todo: 'Read the operator\'s note, check the step, and record the decision (no impact, or raise a deviation).' };
    case 'YIELD_OUT_OF_LIMITS':
      return { ...st, problem: 'Yield outside its limits',
        happened: `The yield calculated at ${step(e)} is outside the range set in the master record.`,
        why: 'Material may have been lost, mixed up or weighed wrongly; the batch cannot move on without an explanation.',
        todo: 'Reconcile the weights (input, output, rejects, samples). Investigate the difference and raise a deviation if it is not explained.' };
    default:
      return { ...st, problem: e.type.toLowerCase().replaceAll('_', ' '), happened: e.description ?? `Recorded at ${step(e)}.`,
        why: 'Recorded by Batchwright as an exception to the normal process.', todo: 'Check the record in Batchwright and record QA\'s decision.' };
  }
}

const num = (s: string | null) => (s === null || s === '' || isNaN(Number(s)) ? null : Number(s));
const CHECK_ADVICE: [RegExp, string, string][] = [
  [/hard|breaking/i, 'Tablets that are too soft can break or crumble; too hard can dissolve slowly.', 'Check the main compression force and punch settings, then re-test hardness and friability on fresh samples.'],
  [/weight/i, 'Wrong tablet weight means a wrong dose.', 'Check the fill depth and feeder; re-check the weight of 20 tablets after adjusting.'],
  [/thick/i, 'Wrong thickness affects packing and can point to a force or weight problem.', 'Check compression force and weight together.'],
  [/friab/i, 'High friability means tablets may break in packing and transport.', 'Check hardness and granule moisture.'],
  [/disinteg|dissol/i, 'The tablet may not release the drug as intended.', 'Check hardness, lubricant time and coating.'],
  [/temp/i, 'A temperature outside its range can harm the product or the seal.', 'Check the heater and its set point; check the affected units.'],
  [/press/i, 'Pressure outside its range can give poor seals or poor product.', 'Check the machine setting and the gauge calibration.'],
  [/moist|lod/i, 'Moisture outside its range affects flow, compression and stability.', 'Check drying time and inlet temperature; re-test LOD.'],
];
export function explainReading(r: ReadingLike): { problem: string; happened: string; why: string; todo: string } {
  const name = r.item ?? r.tag ?? r.checkKind ?? 'value';
  const v = num(r.value), lo = num(r.lower), hi = num(r.upper);
  const u = r.unit ? ` ${r.unit}` : '';
  const side = v !== null && lo !== null && v < lo ? `below the lower limit ${lo}${u}` : v !== null && hi !== null && v > hi ? `above the upper limit ${hi}${u}` : 'outside its limits';
  const [, why, todo] = CHECK_ADVICE.find(([re]) => re.test(`${name} ${r.checkKind ?? ''}`)) ?? [null, 'The product at that moment may be out of specification.', 'Check the machine setting, re-test, and decide with QA.'];
  const fail = r.result === 'FAIL' || r.withinLimits === false;
  return { problem: `${name.charAt(0).toUpperCase()}${name.slice(1)} ${fail ? 'out of limits' : 'on alert'}`,
    happened: `${name} measured ${r.value ?? '—'}${u}, ${side} (limits ${r.lower ?? '–'} to ${r.upper ?? '–'}${u})${r.stepTitle ? ` at "${r.stepTitle}"` : ''}.`, why, todo };
}
