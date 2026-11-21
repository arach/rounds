// What the agent with a note is doing right now, from the server's read of its transcript.
// Asked every few seconds, and only while some note on screen is out with an agent.
import { useEffect, useState } from "react";

export type Live = { at?: number; doing?: string; said?: string; running?: boolean; checked?: number; seen?: boolean };

let data: Record<string, Live> = {};
let skew = 0; // server clock minus ours
const subs = new Set<() => void>();
let timer = 0;

async function poll() {
  try {
    const r = await fetch("/api/live");
    if (r.ok) {
      const j = await r.json();
      skew = (j.now ?? Date.now()) - Date.now();
      data = j.notes ?? {};
      subs.forEach((f) => f());
    }
  } catch {}
}

/** The live record for note `id`, kept fresh while `on`. Rerenders each second too, for the clocks. */
export function useLive(id: string, on: boolean): Live | undefined {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const f = () => tick((n) => n + 1);
    subs.add(f);
    if (subs.size === 1) { poll(); timer = window.setInterval(poll, 2500); }
    const clock = window.setInterval(f, 1000);
    return () => {
      subs.delete(f);
      clearInterval(clock);
      if (!subs.size) clearInterval(timer);
    };
  }, [on]);
  return on ? data[id] : undefined;
}

/** Now on the server's clock, to compare with times the server wrote. */
export const serverNow = () => Date.now() + skew;

// Quiet for longer than this and the agent isn't shown at work, unless a tool call it made
// hasn't come back yet (a long build writes nothing until it ends).
const QUIET = 90e3;
const STUCK = 20 * 60e3;

export type Activity =
  | { kind: "active"; line: string; for: number } // writing now: the line is what it's doing
  | { kind: "quiet"; for: number; line?: string } // took the note, but nothing lately
  | { kind: "unseen" }; // Scout says it's running, but its work can't be seen

/** Whether the agent is visibly at work, from its live record. */
export function activity(l: Live | undefined): Activity {
  if (!l?.seen || !l.at) return { kind: "unseen" };
  const since = serverNow() - l.at;
  const line = l.doing || (l.said ? `“${l.said}”` : "Working");
  if (since < QUIET || (l.running && since < STUCK)) return { kind: "active", line, for: since };
  return { kind: "quiet", for: since, line };
}

/** "42s", "4m", "1h 05m". */
export function span(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : m ? `${m}m` : `${s}s`;
}
