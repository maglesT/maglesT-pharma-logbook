import { useEffect, useState } from 'react';
import { api, type TrainingCheck } from '../api.js';

const skillName = (s: { code: string; title: string }) => (s.title && s.title !== s.code ? `${s.title} (${s.code})` : s.code);

// D-71: only trained people sign. Above the Sign button: the signer's training as Recruitment has it, a refusal in plain
// words, or, while Recruitment is not linked or not reachable, "I am trained in <skill>" to tick. The server checks again.
export function TrainingLine({ logbookType, typed, onTyped }: { logbookType: string; typed: boolean; onTyped: (v: boolean) => void }) {
  const [check, setCheck] = useState<TrainingCheck | null>(null);
  useEffect(() => {
    let live = true;
    api<TrainingCheck>('GET', `/api/training/check?logbookType=${encodeURIComponent(logbookType)}`)
      .then((c) => { if (live) setCheck(c); }).catch(() => { if (live) setCheck(null); });
    return () => { live = false; };
  }, [logbookType]);
  if (!check?.needed) return null;
  if (check.state === 'trained') return <p className="muted">{check.note}</p>;
  if (check.state === 'not_trained') return <p className="error">{check.message}</p>;
  return (
    <>
      <p className="reason">{check.message}</p>
      <label className="check">
        <input type="checkbox" checked={typed} onChange={(e) => onTyped(e.target.checked)} />
        I am trained in {skillName(check.needed)} (the signature is marked "Training typed by hand")
      </label>
    </>
  );
}
