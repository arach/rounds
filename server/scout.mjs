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
import { which } from "./indexer.mjs";
import { SENT, delivered, noteMessage } from "./notes.mjs";

const log = (s) => console.log(`[rounds] scout: ${s}`);
// the stamp the canvas asks after every few seconds: a note's pin changes with its delivery
const changed = () => { try { fs.writeFileSync(path.join(DATA, "posted"), String(Date.now())); } catch {} };

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
// How each note's last try went, for its pin: "unreachable" (Scout has no open session to give
// it to) or "failed" (Scout refused the send). Gone once it's sent; kept while the server runs.
const outcome = new Map();
export const scoutStatus = (id) => outcome.get(id) || null;
const note = (c, what, why) => {
  if (outcome.get(c.id)?.what !== what) log(`note ${c.id} ${what === "unreachable" ? "waits: Scout can't reach its session (it isn't open, or Scout has never seen it)" : `didn't go (${why})`}`);
  outcome.set(c.id, { what, at: Date.now(), ...(why ? { why } : {}) });
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
      const first = !outcome.has(c.id);
      note(c, "unreachable");
      if (first) changed();
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
    outcome.delete(c.id);
    changed();
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
  const repo = repoOf(cwd);
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
  fs.writeFileSync(sent, JSON.stringify({ delivery: "scout-new", project: repo, ...(ids.targetAgentId ? { agent: ids.targetAgentId } : {}), ...(ids.invocationId || ids.flightId ? { task: ids.invocationId || ids.flightId } : {}), at: Date.now() }));
  outcome.delete(c.id);
  changed();
  log(`note ${c.id}: its session is closed, so a new Claude session in ${repo} took it`);
  return true;
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
}
