import { useState } from 'react';
import type { Equipment } from '../api.js';
import { crumbs, filterRows, itemMatches, NO_SELECTION, selectionFromString, selectionIsEmpty, selectionToString, type Option, type Row, type Selection } from '../../../shared/taxonomy.js';

// Owner 2026-11-14 (D-42): the Logbooks page narrows the list level by level: kind (Equipment / Instruments / Areas),
// facility (general, sterile, oncology, beta-lactam → penicillin / cephalosporin / carbapenem …), dosage form (Capsule
// opens Hard / Soft gelatin / Liquid-fill), process (as deep as the tree goes), cleanroom grade for areas. Every level
// may stay at "All", the search works within the selection, and the counts say what each choice would leave.
// Empty branches are hidden unless "Show all categories" is on.

type Classified = Pick<Equipment, 'paths' | 'facilities' | 'grade'>;
const HASH_KEY = 'logbooks';
const STORE_KEY = 'logbook-filter';
const SHOW_ALL_KEY = 'logbook-filter-show-all';

/** The remembered selection: the URL hash first (#logbooks=equipment//osd.tablet/granulation.dry), else this browser's last one. */
export function rememberedSelection(): Selection {
  try {
    const m = new RegExp(`(?:^#|&)${HASH_KEY}=([^&]*)`).exec(window.location.hash);
    if (m) return selectionFromString(decodeURIComponent(m[1]!));
    const stored = window.localStorage.getItem(STORE_KEY);
    if (stored) return selectionFromString(stored);
  } catch { /* private window, blocked storage */ }
  return NO_SELECTION;
}
export function rememberSelection(s: Selection) {
  const text = selectionToString(s);
  try { window.localStorage.setItem(STORE_KEY, text); } catch { /* ignore */ }
  try {
    const hash = text ? `#${HASH_KEY}=${encodeURIComponent(text)}` : '';
    if (window.location.hash !== hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
  } catch { /* ignore */ }
}

/** Narrows the items to the selection (not the search). */
export const inSelection = <T extends Classified>(items: T[], s: Selection) => items.filter((i) => itemMatches(i, s));

export function LogbookFilter<T extends Classified>({ items, value, onChange }: { items: T[]; value: Selection; onChange: (s: Selection) => void }) {
  const [showAll, setShowAll] = useState(() => { try { return window.localStorage.getItem(SHOW_ALL_KEY) === '1'; } catch { return false; } });
  const toggleShowAll = (on: boolean) => { setShowAll(on); try { window.localStorage.setItem(SHOW_ALL_KEY, on ? '1' : '0'); } catch { /* ignore */ } };
  const rows = filterRows(items, value, showAll);
  const kindRow = rows[0]!;
  const trail = crumbs(value);
  // Clicking the chosen value again goes back to "All" of that row.
  const pick = (row: Row, o: Option) => onChange(row.current === o.id ? row.all.to : o.to);

  return (
    <div className="lb-filter" aria-label="Choose logbooks">
      <div className="lb-filter-head">
        <div className="seg" role="group" aria-label="Kind">
          <button type="button" className={kindRow.current === null ? 'on' : ''} aria-pressed={kindRow.current === null} onClick={() => onChange(kindRow.all.to)}>
            All <small>{kindRow.all.count}</small>
          </button>
          {kindRow.options.map((o) => (
            <button key={o.id} type="button" className={kindRow.current === o.id ? 'on' : ''} aria-pressed={kindRow.current === o.id} onClick={() => pick(kindRow, o)}>
              {o.label} <small>{o.count}</small>
            </button>
          ))}
        </div>
        <label className="check show-all"><input type="checkbox" checked={showAll} onChange={(e) => toggleShowAll(e.target.checked)} /> Show all categories</label>
      </div>

      {rows.slice(1).map((row) => (
        <div className="filter-row" key={row.key} role="group" aria-label={row.label}>
          <span className="row-label">{row.label}</span>
          <Chip option={row.all} on={row.current === null} onClick={() => onChange(row.all.to)} plain />
          {row.options.map((o) => <Chip key={o.id} option={o} on={row.current === o.id} onClick={() => pick(row, o)} />)}
        </div>
      ))}

      <nav className="crumbs" aria-label="Current selection">
        <button type="button" onClick={() => onChange(NO_SELECTION)} {...(selectionIsEmpty(value) ? { 'aria-current': 'page' as const } : {})}>All items</button>
        {trail.map((c, i) => (
          <span key={i}>
            <span className="sep" aria-hidden="true">›</span>
            <button type="button" onClick={() => onChange(c.to)} {...(i === trail.length - 1 ? { 'aria-current': 'page' as const } : {})}>{c.label}</button>
          </span>
        ))}
        {trail.length > 0 && <button type="button" className="clear" onClick={() => onChange(NO_SELECTION)}>Clear</button>}
      </nav>
    </div>
  );
}

function Chip({ option, on, onClick, plain = false }: { option: Option; on: boolean; onClick: () => void; plain?: boolean }) {
  return (
    <button type="button" className={`fchip${on ? ' on' : ''}${option.count === 0 ? ' empty' : ''}`} aria-pressed={on} onClick={onClick}>
      {option.label}
      {!plain && <b>{option.count}</b>}
    </button>
  );
}
