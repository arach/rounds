export type Version = { at: number; hash: string };
export type Page = { id: string; url: string; title: string; thread: string | null; project: string; at: number; versions: Version[]; topic?: string; posted?: boolean };
/** A thread gone from this Mac (its transcript cleaned up, its desktop record deleted) keeps its work on the canvas. */
export type Thread = { id: string; title: string; cwd: string; archived: boolean; at: number; recap: string; project: string; days?: Record<string, number>; gone?: boolean };
export type Comment = {
  id: string; page: string; hash: string; x: number; y: number; text: string; at: number;
  thread: string | null; state: "queued" | "sent" | "kept"; delivery?: string;
  /** how it reaches its session: the desktop relay, the notes hook, Scout (while it carries it), or not at all */
  route?: "relay" | "hook" | "scout" | "kept"; threadTitle?: string | null;
  /** while it waits: Scout's last try ("unreachable": no open session; "failed": the send was refused), whether Scout is on, whether the notes hook is installed */
  scout?: "unreachable" | "failed"; scoutOn?: boolean; hook?: boolean;
  /** the repo a new session took it in, when the session that made the work was closed */
  sentTo?: string;
  reply?: { text: string; at: number; via?: string; shots?: Shot[] };
  /** every step Scout took with it, oldest first, kept in ~/.rounds/trail */
  trail?: TrailStep[];
};
export type TrailStep = {
  what: "unreachable" | "failed" | "sent" | "new-session" | "handed-off" | "answered" | "unanswered";
  at: number; why?: string; to?: string; project?: string; task?: string; screens?: number; said?: string;
};
export type Shot = { hash: string; ext: string; w: number; h: number; name: string };
/** A set of screens a thread showed him in one go, with the caption it gave them. */
export type Commit = { sha: string; subject: string };
/** A set of screens a thread showed him (or posted), with the caption it gave them. A change carries
 *  its commits, and screens can carry their before, one per screen in the same order. */
export type ShotSet = {
  id: string; thread: string | null; project: string; at: number; caption: string; shots: Shot[];
  topic?: string; kind?: "screens" | "page" | "change" | "push"; before?: Shot[]; commits?: Commit[]; files?: string[];
};
/** What a project's screens were about, across sends and days; filed by Claude. */
export type Topic = { id: string; title: string; sets: string[] };
export type Index = { builtAt: number; projects: Record<string, string>; threads: Thread[]; pages: Page[]; sets: ShotSet[]; topics?: Record<string, Topic[]>; comments: Comment[]; previews?: boolean };

export async function loadIndex(fresh = false): Promise<Index> {
  const r = await fetch(`/api/index${fresh ? "?fresh" : ""}`);
  if (!r.ok) throw new Error(`index: ${r.status}`);
  return r.json();
}

export const shot = (hash: string, full = false) => `/api/shot/${hash}${full ? "-full" : ""}.png`;
export const thumb = (hash: string) => `/api/thumb/${hash}.jpg`;
/** A kept screen, at a width the canvas can afford, or the original. */
export const img = (s: Shot, w?: 240 | 480 | 960 | 1600) => `/api/img/${s.hash}.${s.ext}${w ? `@${w}.jpg` : ""}`;
export const pageSrc = (hash: string) => `/api/page/${hash}`;
export const threadLink = (id: string) => `claude://claude.ai/epitaxy/${id}`;

export async function postComment(c: { page: string; hash: string; x: number; y: number; text: string; set?: string }): Promise<Comment> {
  const r = await fetch("/api/comments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) });
  if (!r.ok) throw new Error(`comment not saved: ${r.status}`);
  return r.json();
}

const DAY = 864e5;
export function when(at: number) {
  const d = new Date(at);
  const age = Date.now() - at;
  if (age < DAY && d.getDate() === new Date().getDate()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// What he has looked at, per page, kept in this browser only. On the first visit, anything
// published in the last two days counts as new.
const SEEN = "wb.seen.v1";
export function readSeen(): { since: number; pages: Record<string, number> } {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN) || "null");
    if (v && typeof v.since === "number") return v;
  } catch {}
  const v = { since: Date.now() - 2 * 864e5, pages: {} };
  try { localStorage.setItem(SEEN, JSON.stringify(v)); } catch {}
  return v;
}
export function markSeen(id: string) {
  const v = readSeen();
  v.pages[id] = Date.now();
  try { localStorage.setItem(SEEN, JSON.stringify(v)); } catch {}
  return v;
}

/** Titles as he would write them: no em dashes. */
export const clean = (t: string) => t.replace(/\s*[\u2014\u2013]\s*/g, ": ").replace(/\s*\u00b7\s*/g, ", ");
