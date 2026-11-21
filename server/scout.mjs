// Notes straight to their session through Scout (https://openscout.app), when it's installed:
// the session that made the work hears a note the moment it's pinned, not with your next
// message there.
//
// Scout knows a Claude Code session by its own id and gives it an address. A session it can
// reach now (its reachability is "live") gets the note as a Scout ask, typed into the terminal
// it runs in. One that's closed (or Scout has never seen) hands the note to a new Claude
// session in the same repo, through Scout, told whose work it was and where that session's
// transcript is. Without Scout the note waits for the notes hook, as before. In config,
// "scout": false turns this off, "scout": "wake" first tries reopening a session Scout can
// resume, and "newSession": false keeps a closed session's notes waiting instead.
//
// The sent file is written before the ask, so the notes hook in that session (which the
// Scout message itself runs) doesn't bring the note in a second time. A send that fails takes
// it back out, and the note waits for the hook.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { CLAUDE, DATA, loadConfig, repoOf } from "./config.mjs";
import { keepImage, which } from "./indexer.mjs";
import { SENT, delivered, noteMessage } from "./notes.mjs";

const log = (s) => console.log(`[rounds] scout: ${s}`);
// the stamp the canvas asks after every few seconds for notes: a pin changes with each step
const changed = () => { try { fs.writeFileSync(path.join(DATA, "noted"), String(Date.now())); } catch {} };

let bin; // undefined until looked for, null when Scout isn't installed
const scoutBin = () => (bin === undefined ? (bin = process.env.ROUNDS_SCOUT_BIN || which("scout")) : bin);
export const scoutOn = () => loadConfig().scout !== false && !!scoutBin();

// Scout with --json: its answer, or why there is none. Scout logs to stderr; stdout is the JSON.
function scout(args, timeout = 30e3) {
  return new Promise((resolve) => {
    execFile(scoutBin(), ["--json", ...args], { timeout, maxBuffer: 8e6 }, (err, out, errOut) => {
      let json = null;
      const s = String(out || "");
      try { json = JSON.parse(s.slice(s.indexOf("{"))); } catch {}
      const why = err ? (json?.error?.message || json?.error || json?.message || String(errOut || err.message).trim().split("\n").pop()) : null;
      // an ask says how it went in its receipt; a session address lookup, at the top
      const refused = json?.receipt?.ok === false ? json.receipt : json?.ok === false ? json : null;
      resolve({ json, why: why || (!json ? "no answer" : refused ? String(refused.error?.message || refused.error || "refused") : null) });
    });
  });
}

// The Claude Code sessions a note's thread stands for: itself, or the ones a desktop thread
// runs on, the latest first.
function sessionsOf(thread, idx) {
  if (!thread) return [];
  if (!thread.startsWith("local_")) return [thread];
  const t = (idx.threads || []).find((x) => x.id === thread);
  return [...(t?.clis || [])].reverse();
}

// The first address Scout can deliver to now, for any of those sessions.
async function addressOf(sessions, wake) {
  const ok = wake ? ["live", "resumable"] : ["live"];
  for (const id of sessions) {
    const { json } = await scout(["session", "address", id], 15e3);
    const all = (json?.addresses || []).filter((a) => a.address && ok.includes(a.reachability));
    const best = all.find((a) => a.reachability === "live") || all[0];
    if (best) return { ...best, session: id };
  }
  return null;
}

const carrying = new Set();
// Looked up at most once a minute per note, so a session Scout can't reach isn't asked about
// on every sweep.
const tried = new Map();
// Each note's trail, kept in ~/.rounds/trail/<id>.json so its pin tells the same story after a
// refresh or a restart: every step Scout took with it, oldest first. A step is
//   { what: "unreachable" | "failed" | "sent" | "new-session" | "working" | "handed-off" | "answered" | "unanswered", at, ... }
// and a step repeated (the sweep finding a session still closed) is written once.
const TRAIL = path.join(DATA, "trail");
export function trailOf(id) {
  try { return JSON.parse(fs.readFileSync(path.join(TRAIL, `${id}.json`), "utf8")); } catch { return []; }
}
function step(id, ev) {
  const list = trailOf(id);
  if (list.at(-1)?.what === ev.what && list.at(-1)?.why === ev.why && list.at(-1)?.task === ev.task) return false;
  list.push({ ...ev, at: ev.at || Date.now() });
  try { fs.mkdirSync(TRAIL, { recursive: true }); fs.writeFileSync(path.join(TRAIL, `${id}.json`), JSON.stringify(list, null, 1)); } catch {}
  changed();
  return true;
}
/** Why a note still waits, from its trail: its last step, if that was a miss. */
export function scoutStatus(id) {
  const last = trailOf(id).at(-1);
  return last && (last.what === "unreachable" || last.what === "failed") ? last : null;
}
const note = (c, what, why) => {
  if (step(c.id, { what, ...(why ? { why } : {}) })) log(`note ${c.id} ${what === "unreachable" ? "waits: Scout can't reach its session (it isn't open, or Scout has never seen it)" : `didn't go (${why})`}`);
};

/** Send one note to its session through Scout. Resolves to how it went; never throws. */
export async function deliver(c, idx) {
  if (!scoutOn() || !c?.id || !c.thread || c.reply || c.state === "kept" || carrying.has(c.id) || delivered(c)) return "skipped";
  if (Date.now() - (tried.get(c.id) || 0) < 60e3) return "skipped";
  tried.set(c.id, Date.now());
  carrying.add(c.id);
  const sent = path.join(SENT, `${c.id}.json`);
  // take back only Scout's own claim, never a delivery the hook made meanwhile
  const unclaim = () => { try { if (JSON.parse(fs.readFileSync(sent, "utf8")).pending) fs.rmSync(sent, { force: true }); } catch {} changed(); };
  try {
    const to = await addressOf(sessionsOf(c.thread, idx), loadConfig().scout === "wake");
    if (!to) {
      if (loadConfig().newSession !== false && (await toNewSession(c, idx, sent))) return "sent";
      note(c, "unreachable");
      return "unreachable";
    }
    if (delivered(c)) return "skipped"; // the hook got there while Scout was asked
    fs.mkdirSync(SENT, { recursive: true });
    fs.writeFileSync(sent, JSON.stringify({ delivery: "scout", pending: true, address: to.address, at: Date.now() }));
    changed();
    const { json, why } = await scout(["ask", "--to", to.address, "--label", "rounds", noteMessage([c])], 60e3);
    if (why) {
      note(c, "failed", why);
      unclaim();
      return "failed";
    }
    // the receipt's ids follow the task: scout wait <task>
    const ids = json?.receipt?.ids || {};
    const task = ids.invocationId || ids.flightId || json?.messageId || null;
    fs.writeFileSync(sent, JSON.stringify({ delivery: "scout", address: to.address, session: to.session, ...(task ? { task } : {}), at: Date.now() }));
    step(c.id, { what: "sent", to: to.address, ...(task ? { task } : {}) });
    tried.delete(c.id);
    log(`note ${c.id} sent to ${to.address}`);
    return "sent";
  } catch (e) {
    note(c, "failed", String(e?.message || e));
    unclaim();
    return "failed";
  } finally {
    carrying.delete(c.id);
  }
}

// The session that made the work is closed, and Scout can't reopen it (its worktree may be gone
// too): a new Claude session in the same repo takes the note, told whose work it was and where
// that session's transcript is, so it can read what was done. The note is still the person's
// own words, so it goes as an ask that Scout follows like any other.
async function toNewSession(c, idx, sent) {
  const t = (idx.threads || []).find((x) => x.id === c.thread);
  const cwd = t?.cwd;
  if (!cwd) return false;
  const repo = repoOf(ownerOf(cwd) || cwd);
  if (!fs.existsSync(repo)) return false;
  const old = sessionsOf(c.thread, idx)[0];
  const transcript = old && findTranscript(old);
  const opener = [
    `The user left a note in Rounds on work a Claude session did${t.title ? ` ("${t.title}")` : ""} in ${cwd}.`,
    `That session is closed, so the note comes to you, in ${repo}.${transcript ? ` Its transcript is ${transcript}: read the end of it to see what it built.` : ""}`,
    cwd !== repo && !fs.existsSync(cwd) ? `Its worktree (${cwd}) is gone; its work is in ${repo} or on its branch.` : "",
    "The note:",
  ].filter(Boolean).join("\n");
  fs.mkdirSync(SENT, { recursive: true });
  fs.writeFileSync(sent, JSON.stringify({ delivery: "scout-new", pending: true, at: Date.now() }));
  changed();
  const { json, why } = await scout(["ask", "--project", repo, "--harness", "claude", "--label", "rounds", noteMessage([c], undefined, { opener, final: true })], 120e3);
  if (why) {
    note(c, "failed", why);
    try { if (JSON.parse(fs.readFileSync(sent, "utf8")).pending) fs.rmSync(sent, { force: true }); } catch {}
    changed();
    return false;
  }
  const ids = json?.receipt?.ids || {};
  const task = ids.invocationId || ids.flightId || null;
  fs.writeFileSync(sent, JSON.stringify({ delivery: "scout-new", project: repo, ...(ids.targetAgentId ? { agent: ids.targetAgentId } : {}), ...(task ? { task } : {}), at: Date.now() }));
  step(c.id, { what: "new-session", project: repo, ...(task ? { task } : {}) });
  log(`note ${c.id}: its session is closed, so a new Claude session in ${repo} took it`);
  return true;
}

// A session that ran in another session's scratchpad (/private/tmp/claude-<uid>/<project>/
// <session id>/scratchpad/...) made its work for that session's project: the folder that
// session ran in, from its transcript. A scratch folder is never where a change belongs.
function ownerOf(dir) {
  const id = String(dir).match(/\/claude-\d+\/[^/]+\/([0-9a-f]{8}-[0-9a-f-]{27})\/scratchpad(?:\/|$)/)?.[1];
  const file = id && findTranscript(id);
  if (!file) return null;
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 400e3);
    for (const line of head.split("\n")) {
      const at = line.indexOf('"cwd":"');
      if (at < 0) continue;
      const cwd = JSON.parse(`"${line.slice(at + 7).match(/^((?:[^"\\]|\\.)*)"/)?.[1] ?? ""}"`);
      if (cwd && !cwd.includes("/scratchpad")) return cwd;
    }
  } catch {}
  return null;
}

// A Claude Code session's transcript, by its id, wherever its project folder is.
function findTranscript(id) {
  const root = path.join(CLAUDE, "projects");
  try { for (const d of fs.readdirSync(root)) { const f = path.join(root, d, `${id}.jsonl`); if (fs.existsSync(f)) return f; } } catch {}
  return null;
}

/** Every note still waiting from the last day, tried again: its session may be open by now. */
export async function sweep(list, idx) {
  if (!scoutOn()) return;
  const day = Date.now() - 864e5;
  for (const c of list) if (c.at > day && c.state === "queued" && c.route !== "relay") await deliver(c, idx);
  await follow(list);
}

// A session Scout gave a note to answers on the Scout task (a new session has no rounds_reply,
// and its final message is the answer). Notes sent through Scout in the last three days with no
// reply yet are looked up there; an answer becomes the note's reply, as if rounds_reply had
// written it, with the screens it names kept in the store before their scratch folder goes.
const COMMENTS = path.join(DATA, "comments.json");
const IMAGE = /(?:file:\/\/)?(\/[^\s)'"`<>]+\.(?:png|jpe?g|webp|gif))/gi;
const looked = new Map();
async function follow(list) {
  const since = Date.now() - 3 * 864e5;
  for (const c of list) {
    if (c.reply || !c.id) continue;
    let s = null;
    try { s = JSON.parse(fs.readFileSync(path.join(SENT, `${c.id}.json`), "utf8")); } catch {}
    if (!s || s.pending || !s.task || !String(s.delivery).startsWith("scout") || (s.at || 0) < since) continue;
    // a note sent before trails were kept gets its first step from its sent file
    if (!trailOf(c.id).some((x) => x.what === "sent" || x.what === "new-session")) {
      step(c.id, s.delivery === "scout-new" ? { what: "new-session", project: s.project, task: s.task, at: s.at } : { what: "sent", to: s.address, task: s.task, at: s.at });
    }
    // a note sent or moved on in the last quarter hour is looked at every few seconds
    const trail = trailOf(c.id);
    const fresh = Date.now() - Math.max(s.at || 0, trail.at(-1)?.at || 0) < FRESH;
    if (Date.now() - (looked.get(c.id) || 0) < (fresh ? 3e3 : 60e3)) continue;
    looked.set(c.id, Date.now());
    // a session that handed the note on is followed to the one that took it
    const task = s.following || s.task;
    const work = await workOf(task);
    if (!work) continue;
    if (WORKING.includes(work.state)) step(c.id, { what: "working", task });
    if (work.state === "completed" && work.answer) {
      const next = await handedTo(String(work.answer), work);
      if (next) {
        step(c.id, { what: "handed-off", task: next.id, ...(next.assignee?.cwd ? { project: next.assignee.cwd } : {}), said: String(work.answer).slice(0, 4000) });
        fs.writeFileSync(path.join(SENT, `${c.id}.json`), JSON.stringify({ ...s, following: next.id }));
        looked.delete(c.id);
        log(`note ${c.id} was handed on to ${next.agentId || next.id}${next.assignee?.cwd ? ` in ${next.assignee.cwd}` : ""}`);
        continue;
      }
      answer(c.id, String(work.answer), work.updatedAt);
    } else if (["failed", "cancelled", "canceled", "expired"].includes(work.state)) step(c.id, { what: "unanswered", why: work.reason || work.state, task });
  }
}

const FRESH = 15 * 60e3;
const WORKING = ["running", "working", "active", "in_progress", "claimed"];
/** Whether any note is under way: sent through Scout lately and not yet answered or given up. */
export function underWay() {
  let names;
  try { names = fs.readdirSync(SENT); } catch { return false; }
  const now = Date.now();
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    try {
      if (now - fs.statSync(path.join(SENT, f)).mtimeMs > 3 * 864e5) continue;
      const last = trailOf(f.slice(0, -5)).at(-1);
      if (last?.what === "answered" || last?.what === "unanswered") continue;
      if (now - Math.max(fs.statSync(path.join(SENT, f)).mtimeMs, last?.at || 0) < FRESH) return true;
    } catch {}
  }
  return false;
}

async function workOf(handle) {
  const { json } = await scout(["status", handle], 30e3);
  return (json?.work || []).find((w) => (w.handles || []).includes(handle) || w.id === handle) || null;
}

// An answer that names another Scout task still under way ("next owner: … (ref:q-c1bkte)") is
// a handoff, not the answer: the note's answer is what that task ends with.
const HANDLE = /\b(?:ref:)?((?:q|flt|inv-request)-[a-z0-9]+(?:-[a-z0-9]+)?)\b/g;
async function handedTo(said, from) {
  const own = new Set([from.id, ...(from.handles || [])]);
  for (const m of said.matchAll(HANDLE)) {
    if (own.has(m[1])) continue;
    const w = await workOf(m[1]);
    if (w && !own.has(w.id) && !["failed", "cancelled", "canceled", "expired"].includes(w.state)) return w;
  }
  return null;
}

function answer(id, said, at = Date.now()) {
  const shots = [];
  for (const m of said.matchAll(IMAGE)) {
    const kept = keepImage(m[1]);
    if (kept && !shots.some((x) => x.hash === kept.hash)) shots.push(kept);
  }
  // the paths themselves mean nothing on the canvas: the screens show under the reply instead
  const text = said.replace(IMAGE, "").replace(/:\s*$/gm, "").replace(/[ \t]+$/gm, "").trim();
  let list;
  try { list = JSON.parse(fs.readFileSync(COMMENTS, "utf8")); } catch { return; }
  const c = list.find((x) => x.id === id);
  if (!c || c.reply) return;
  c.reply = { text, at, via: "scout", ...(shots.length ? { shots } : {}) };
  fs.writeFileSync(COMMENTS, JSON.stringify(list, null, 1));
  step(id, { what: "answered", at, ...(shots.length ? { screens: shots.length } : {}) });
  log(`note ${id} answered${shots.length ? `, with ${shots.length} screen${shots.length === 1 ? "" : "s"}` : ""}`);
}
