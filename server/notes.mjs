// How a note reads when it reaches the session that made the work, said once for both ways it
// travels there: the notes hook (with the person's next message) and Scout (at once).
// Only config is imported, so the hook stays quick.
import fs from "node:fs";
import path from "node:path";
import { DATA, POSTS, STORE } from "./config.mjs";

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

export const SENT = path.join(DATA, "sent");

export function readPosts() {
  try { return fs.readdirSync(POSTS).map((f) => read(path.join(POSTS, f), null)).filter(Boolean); } catch { return []; }
}

export const postOf = (c, posts) => posts.find((p) => (p.shots || []).some((s) => s.hash === c.hash) || (p.page && c.hash === p.page.hash));

// A note is delivered once its sent file is written. One Scout is still carrying counts too (the
// Scout message runs the notes hook in that session, and the note would arrive twice), unless
// the send never finished: past two minutes it is the hook's again.
export function delivered(c) {
  if (c.state === "sent") return true;
  const f = path.join(SENT, `${c.id}.json`);
  const s = read(f, null);
  if (!s) return fs.existsSync(f);
  if (!s.pending) return true;
  return Date.now() - (s.at || 0) < 2 * 60e3;
}

// A screen's own record in the store (written when it was kept), for one no post names: a screen
// the session captured on its own.
const shotOf = (hash) => read(path.join(STORE, "img", `${hash}.json`), null);
const setOf = (hash) => (read(path.join(DATA, "index.json"), { sets: [] }).sets || []).find((s) => s.shots?.some((x) => x.hash === hash));

/**
 * The message a session gets for its notes: each one's words, the screen and the point.
 * `opener` replaces the first line (a new session, say, is told whose work it is); with `final`,
 * a session without the Rounds tools answers in its last message instead.
 */
export function noteMessage(notes, posts = readPosts(), { opener, final = false } = {}) {
  const lines = notes.map((c) => {
    const p = postOf(c, posts);
    const shot = p?.shots?.find((s) => s.hash === c.hash) || (String(c.page || "").startsWith("shot-") ? shotOf(c.hash) : null);
    const caption = p?.caption || (shot && setOf(c.hash)?.caption);
    const where = shot
      ? `on the screen ${path.join(STORE, "img", `${shot.hash}.${shot.ext}`)} (${shot.w}x${shot.h}), pinned at x ${Math.round(c.x * shot.w)}, y ${Math.round(c.y * shot.h)}`
      : `on the page ${path.join(STORE, `${c.hash}.html`)}, pinned at x ${Math.round(c.x)}, y ${Math.round(c.y)} on the page at 1280 wide`;
    return `- Note ${c.id}: "${c.text}" ${where}${caption ? `, from when ${p ? "you posted" : "the session said"} "${caption}"` : ""}.`;
  });
  return [
    opener || `The user left ${notes.length === 1 ? "a note" : `${notes.length} notes`} on your work in Rounds:`,
    ...lines,
    final
      ? "Treat each as a request about that screen. Look at it (crop around the pinned point) and act on it. Then answer with rounds_reply and the note's id if you have that tool; otherwise say what you changed in your final message."
      : "Treat each as a request about that screen. Look at it (crop around the pinned point), act on it, then answer with rounds_reply and the note's id.",
  ].join("\n");
}
