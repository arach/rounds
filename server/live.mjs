// What the agent with a note is doing right now, read from its Claude transcript, so the canvas
// can show the work itself and never claim work that isn't happening.
//
// Scout says a task is "running" from the moment a session takes it until it answers, even if
// that session has gone quiet or closed. The transcript is the truth: the session writes to it
// with every step. The one that holds a note is the transcript written since the note went out
// that has the note's id in it, found once and remembered. Its newest step says what the agent
// is doing ("Editing Board.tsx", "Running bun run check") or what it last said. When the file
// was last written says whether it's still at it. (Only the prompt that carried the note
// counts: a session that merely mentions the note's id isn't the one working on it.) A tool call that hasn't come back yet still
// counts as work, so a long build doesn't read as quiet.
import fs from "node:fs";
import path from "node:path";
import { CLAUDE } from "./config.mjs";

const live = new Map(); // note id -> { at, doing, said, running, checked }
const found = new Map(); // note id -> transcript path
const missed = new Map(); // note id -> when it was last looked for and not found

/** The live record for a note, or undefined when there's none yet. */
export const liveOf = (id) => live.get(id);
/** Every live record, for the canvas. */
export const allLive = () => Object.fromEntries(live);
/** A note that's answered or given up needs no watching. */
export const forget = (id) => { live.delete(id); for (const m of [found, missed]) for (const k of m.keys()) if (k === id || k.startsWith(`${id}>`)) m.delete(k); };

const slug = (dir) => String(dir).replace(/[^a-zA-Z0-9]/g, "-");

/**
 * The transcript that holds note `id`: written since `since`, with the note in a prompt. Once a
 * session handed the note on (`handed`, the task it went to), it's the session in that task's
 * repo whose prompt since the handoff names the note: a handoff brief, not the note's own line.
 */
function transcriptOf(id, since, cwd, handed) {
  const key = handed ? `${id}>${handed}` : id;
  if (found.has(key)) return found.get(key);
  if (Date.now() - (missed.get(key) || 0) < 15e3) return null;
  const mark = handed ? id : `- Note ${id}: `;
  const root = path.join(CLAUDE, "projects");
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  // the repo's own folder first; a session started elsewhere can still have it
  const first = cwd ? slug(cwd) : null;
  dirs.sort((a, b) => (b === first) - (a === first));
  // a brief that only names the note could be anyone talking about it: only that repo counts
  if (handed) dirs = dirs.filter((d) => d === first);
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(root, d, f);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs < since) continue;
        // a new session's note is its first prompt; one sent to a running session is near the end
        if (holds(readStart(p, 2 << 20), mark, since) || holds(readEnd(p, st.size, 24 << 20), mark, since)) { found.set(key, p); return p; }
      } catch {}
    }
  }
  missed.set(key, Date.now());
  return null;
}

/**
 * Whether a transcript is the one the note was given to: the note's own line ("- Note <id>: ")
 * arrives in it as a prompt (typed text, not a tool's output) after the note went out. A session
 * that only talks about the note, or reads its files, doesn't count.
 */
export function holds(text, mark, since) {
  let i = text.indexOf(mark);
  while (i !== -1) {
    const start = text.lastIndexOf("\n", i) + 1, end = text.indexOf("\n", i);
    try {
      const e = JSON.parse(text.slice(start, end === -1 ? undefined : end));
      const content = e?.message?.content;
      const typed = typeof content === "string" ? content : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text).join("\n") : "";
      if (e.type === "user" && typed.includes(mark) && Date.parse(e.timestamp || 0) >= since - 60e3) return true;
    } catch {}
    i = text.indexOf(mark, end === -1 ? text.length : end);
  }
  return false;
}

function readStart(p, max) {
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(max), n = fs.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally { fs.closeSync(fd); }
}

function readEnd(p, size, max) {
  const fd = fs.openSync(p, "r");
  try {
    const n = Math.min(size, max), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString("utf8");
  } finally { fs.closeSync(fd); }
}

const base = (p) => (p ? path.basename(String(p)) : "");
const clip = (s, n = 120) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** A tool call in a few words: "Editing Board.tsx". */
export function describe(name, input = {}) {
  const n = String(name || "");
  if (/^(Edit|MultiEdit|NotebookEdit)$/.test(n)) return `Editing ${base(input.file_path || input.notebook_path)}`;
  if (n === "Write") return `Writing ${base(input.file_path)}`;
  if (n === "Read") return `Reading ${base(input.file_path)}`;
  if (n === "Bash") return `Running ${clip(input.description || input.command, 70)}`;
  if (n === "Grep" || n === "Glob") return `Searching for ${clip(input.pattern, 50)}`;
  if (n === "Agent" || n === "Task") return `Handing a part to a helper: ${clip(input.description, 60)}`;
  if (n === "WebSearch") return `Looking up ${clip(input.query, 60)}`;
  if (n === "WebFetch") return `Reading a web page`;
  if (n === "TodoWrite" || n.startsWith("Task")) return "Planning its steps";
  if (/screenshot/i.test(n)) return "Taking a screenshot";
  if (/browser|layer_/i.test(n)) return "Checking it in a browser";
  if (/scout__reply|rounds_reply/.test(n)) return "Writing its answer";
  return `Using ${n.replace(/^mcp__[^_]+__/, "")}`;
}

/** The newest step in a transcript: what it's doing, what it last said, and whether a tool is out. */
export function lastStep(text) {
  const lines = text.split("\n").filter(Boolean);
  const answered = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    const content = e?.message?.content;
    if (e.type === "user" && Array.isArray(content)) {
      for (const c of content) if (c?.type === "tool_result") answered.add(c.tool_use_id);
      continue;
    }
    if (e.type !== "assistant" || !Array.isArray(content)) continue;
    // the last thing in the newest assistant message
    for (let k = content.length - 1; k >= 0; k--) {
      const c = content[k];
      if (c?.type === "tool_use") return { doing: describe(c.name, c.input), running: !answered.has(c.id) };
      if (c?.type === "text" && c.text?.trim()) return { said: clip(c.text.split("\n").find((l) => l.trim()), 160), running: false };
      if (c?.type === "thinking") return { doing: "Thinking", running: false };
    }
  }
  return null;
}

/**
 * Look at the agent working on note `id` (sent at `since`, in `cwd`; or handed on to task
 * `handed` at `since`) and keep what it's doing.
 */
export function watch(id, since, cwd, handed) {
  const now = Date.now();
  const p = transcriptOf(id, since, cwd, handed);
  if (!p) { live.set(id, { ...live.get(id), checked: now, seen: false }); return live.get(id); }
  try {
    const st = fs.statSync(p);
    const prev = live.get(id);
    // read again only when the file moved
    const step = prev?.at === st.mtimeMs ? prev : { ...lastStep(readEnd(p, st.size, 256 << 10)) };
    live.set(id, { doing: step.doing, said: step.said, running: !!step.running, at: st.mtimeMs, checked: now, seen: true });
  } catch { found.delete(handed ? `${id}>${handed}` : id); }
  return live.get(id);
}
