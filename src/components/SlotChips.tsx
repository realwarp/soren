import { useEffect, useState, useSyncExternalStore } from "react";
import { ageHue, ago, getPieces, subscribePieces } from "../flowPieces";
import { usePref } from "../prefs";

/**
 * The containers kept in the number slots, as small numbered chips in the top bar. A chip's colour is the slot's age on a
 * smooth slide from green through yellow to red (the three ages are set in Settings), and hovering it says what is
 * stored and how long ago.
 */
export function SlotChips() {
  const kept = useSyncExternalStore(subscribePieces, getPieces);
  const freshDays = usePref("slotFreshDays");
  const yellowDays = usePref("slotYellowDays");
  const redDays = usePref("slotRedDays");
  // Age moves on its own, so the colours are redrawn once a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const filled = Array.from({ length: 9 }, (_, i) => i + 1).flatMap((n) => (kept.slots[String(n)] ? [{ n, slot: kept.slots[String(n)] }] : []));
  if (filled.length === 0) return null;
  return (
    <span className="slot-chips" role="group" aria-label="Stored containers">
      {filled.map(({ n, slot }) => {
        const age = Math.max(0, now - slot.storedAt);
        const hue = ageHue(age / 86_400_000, { freshDays, yellowDays, redDays });
        return (
          <span
            key={n}
            className="slot-chip"
            style={{ "--slot-hue": hue.toFixed(1) } as React.CSSProperties}
            title={`${slot.name}, stored ${ago(age)}. Press ${n} on the canvas to paste it.`}
          >
            {n}
          </span>
        );
      })}
    </span>
  );
}
