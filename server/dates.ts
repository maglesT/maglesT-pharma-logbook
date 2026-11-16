// D-49 (owner): dates as people read them, "30 Jan 2027" in plant time, never ISO ("2027-01-30"). The month names are
// fixed here: browsers and Node spell September "Sep" or "Sept" depending on their version, TrueBatch prints "Sep".
// No Node APIs: the web pages import this file too.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PLANT_TZ = 'Asia/Kolkata';
const PLAIN_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: p.minute! };
}
const day = (y: number, m: number, d: number, withYear: boolean) => `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;

/** A plant day: "30 Jan 2027". A plain "2027-01-30" is that day as written; a time is converted to the plant day. */
export function dayText(v: string | Date | null | undefined, { withYear = true, tz = PLANT_TZ } = {}): string {
  if (v === null || v === undefined || v === '') return '—';
  const plain = typeof v === 'string' ? PLAIN_DAY.exec(v) : null;
  if (plain) return day(Number(plain[1]), Number(plain[2]), Number(plain[3]), withYear);
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = parts(d, tz);
  return day(p.y, p.m, p.d, withYear);
}

/** A moment in plant time with the zone: "30 Jan 2027, 3:05 pm IST". */
export function timeText(v: string | Date | null | undefined, { withYear = true, tz = PLANT_TZ, zone = 'IST' } = {}): string {
  if (v === null || v === undefined || v === '') return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = parts(d, tz);
  return `${day(p.y, p.m, p.d, withYear)}, ${p.h % 12 || 12}:${p.min} ${p.h < 12 ? 'am' : 'pm'}${zone ? ` ${zone}` : ''}`;
}
