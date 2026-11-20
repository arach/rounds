// Reads the desktop app's thread records and every Claude Code transcript on this Mac,
// and rebuilds each published page at every publish by replaying Write and Edit calls.
// Output: index.json in the Rounds data folder, plus content-addressed snapshots in its store.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline";
import { execFileSync } from "node:child_process";

import { HOME, DATA, STORE, IMG, POSTS, PUSHES, CLAUDE, DESKTOP_SESSIONS, projects, loadConfig } from "./config.mjs";
import { filePostTopics } from "./topics.mjs";
export { DATA, STORE, IMG };
const TRANSCRIPTS = path.join(CLAUDE, "projects");

const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

// A program on PATH, or null. Looked for by hand, so nothing is spawned to find out.
export function which(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const f = path.join(dir, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}
// sips is macOS's own image tool. Elsewhere there is none, and nothing asks it.
let sips;
export const hasSips = () => (sips ??= !!which("sips"));

function walk(dir, test, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, test, out);
    else if (test(e.name)) out.push(p);
  }
  return out;
}

function readThreads(P) {
  const threads = new Map();
  const byCli = new Map();
  for (const file of walk(DESKTOP_SESSIONS, (n) => n.startsWith("local_") && n.endsWith(".json"))) {
    let s;
    try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (!s.sessionId || !s.title) continue;
    const recap = s.turnWrapUp?.description || s.postTurnSummary?.status_detail || "";
    const t = {
      id: s.sessionId,
      title: s.title,
      cwd: s.cwd || "",
      archived: !!s.isArchived,
      at: Number(s.lastActivityAt || s.createdAt || 0),
      recap,
      clis: [s.cliSessionId, s.lastAssistantCliSessionId].filter(Boolean),
    };
    if (P.isPrivate(t.title, t.cwd)) continue;
    threads.set(t.id, t);
    for (const cli of [s.cliSessionId, s.lastAssistantCliSessionId]) if (cli) byCli.set(cli, t.id);
  }
  return { threads, byCli };
}

function applyEdit(text, input) {
  if (text == null) return null;
  const { old_string: a, new_string: b, replace_all } = input;
  if (typeof a !== "string" || typeof b !== "string" || !text.includes(a)) return null;
  return replace_all ? text.split(a).join(b) : text.replace(a, () => b);
}

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+/;

const DAY_RE = /"timestamp":"([0-9T:.\-]+Z)"/;
// The day in this Mac's own time zone, so a late-night prompt counts for that evening.
const localDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/;
// A Rounds post made through the MCP server: the result names the post it made.
const POST_RE = /\bpost ([a-f0-9]{16})\b/;

// A few screens a turn at most: the last of each subject, which is how it ended up.
const CAPTURES_PER_TURN = 3;
// What the session told the person at the end of the turn, as a caption: its first paragraph,
// plain, a couple of sentences long.
function captionOf(text) {
  const p = String(text || "").split(/\n\s*\n/).map((s) => s.trim()).find((s) => s && !/^(```|\||#|-{3})/.test(s)) || "";
  const plain = p.replace(/\*\*|__|`|^#+\s*|\[([^\]]+)\]\([^)]+\)/gm, "$1").replace(/\s+/g, " ").trim();
  if (!plain) return "Captured while working";
  return plain.length > 280 ? `${plain.slice(0, 277).replace(/\s+\S*$/, "")}…` : plain;
}

async function readTranscript(file, onPublish, onDay, onSend, onMeta = () => {}, onPost = () => {}) {
  const files = new Map(); // path -> reconstructed text, or null when unknown
  const posting = new Set(); // tool_use ids of Rounds posts
  const meta = { cwd: "", title: "", summary: "", at: 0 };
  let lastLine = "";
  const pending = new Map(); // tool_use id -> publish
  const sending = new Map(); // tool_use id -> a set of screens shown to him

  // Screens the session captured on its own, with no one asking it to show them: a screenshot,
  // an image it opened to look at. Every tool result that carries an image is a candidate (the
  // transcript keeps the image itself, so it outlives the file it was saved to). A turn ends
  // when the person speaks again; then the last screen of each subject (a page's address, or
  // the folder an image came from) is kept, a few at most, captioned with what the session
  // last told the person. A subject kept earlier in the session gives the before.
  const captures = loadConfig().captures !== false;
  const uses = new Map(); // tool_use id -> { name, file }
  const seenResults = new Set();
  let turn = new Map(); // subject -> candidate, in the order last seen
  let said = "";
  const lastOf = new Map(); // subject -> the last screen kept for it
  const flush = () => {
    if (turn.size) {
      const kept = [...turn.values()].slice(-CAPTURES_PER_TURN);
      const before = kept.map((k) => { const p = lastOf.get(k.subject); return p && p.hash !== k.hash ? p.img : null; });
      onSend({ id: `capture:${kept[0].id}`, shots: kept.map((k) => k.img), ...(before.every(Boolean) ? { before } : {}), caption: captionOf(said), cwd: meta.cwd, at: kept[kept.length - 1].at, captured: true });
      for (const k of kept) { lastOf.delete(k.subject); lastOf.set(k.subject, k); }
      while (lastOf.size > 40) lastOf.delete(lastOf.keys().next().value);
    }
    turn = new Map();
    said = "";
  };
  const candidate = (c, img, row) => {
    const use = uses.get(c.tool_use_id) || {};
    if (c.is_error || /rounds_|workbench_|SendUserFile/.test(use.name || "")) return; // counted on their own
    const buf = Buffer.from(img.source.data, "base64");
    const d = dims(buf, "");
    if (!d || d.w < 320 || d.h < 200) return; // icons, thumbnails, crops
    const text = c.content.filter((x) => x.type === "text").map((x) => x.text || "").join("\n");
    const url = text.match(/"url"\s*:\s*"([^"]+)"/)?.[1];
    let subject = "";
    try { if (url) { const u = new URL(url); subject = u.host + u.pathname; } } catch {}
    subject ||= use.file ? path.dirname(use.file) : use.name || "screen";
    // the original when it's still on disk (full size); else the copy the transcript keeps
    const saved = text.match(/"outputPath"\s*:\s*"([^"]+)"/)?.[1];
    const source = text.match(/\[Image: source: ([^\]]+)\]/)?.[1];
    const orig = [saved, use.file, source].find((f) => f && /\.(png|jpe?g|webp)$/i.test(f) && fs.existsSync(f));
    const ext = { "image/png": "png", "image/webp": "webp" }[img.source.media_type] || "jpg";
    const name = path.basename(orig || saved || use.file || "capture").replace(/\.[^.]+$/, "");
    turn.delete(subject);
    turn.set(subject, { id: c.tool_use_id, subject, hash: sha(img.source.data), at: Date.parse(row.timestamp) || 0, img: orig || { buf, ext, name } });
  };

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    // A prompt he typed: a user row that is not a tool result. Counted per day, cheaply.
    if (line.startsWith('{"parentUuid"') || line.includes('"type":"user"')) {
      if (line.includes('"type":"user"') && !line.includes("tool_result") && !line.includes('"isMeta":true')) {
        flush();
        const m = line.match(DAY_RE);
        if (m) onDay(localDay(m[1]));
        // a session with no desktop record is named for its first prompt
        if (!meta.title) {
          try {
            const r = JSON.parse(line);
            const c = r.message?.content;
            const t = typeof c === "string" ? c : Array.isArray(c) ? c.find((x) => x.type === "text")?.text : "";
            // not a command (/compact) or a pasted block; a person's first words
            if (t && !/^\s*[</]/.test(t)) meta.title = t.replace(/\s+/g, " ").trim().slice(0, 64);
          } catch {}
        }
      }
    }
    if (!meta.cwd) { const m = line.match(CWD_RE); if (m) meta.cwd = JSON.parse(`"${m[1]}"`); }
    lastLine = line;
    if (line.startsWith('{"type":"summary"')) { try { meta.summary = JSON.parse(line).summary || meta.summary; } catch {} }
    // what the session says to the person: the last of it in a turn captions its screens
    if (captures && line.includes('"role":"assistant"') && line.includes('"type":"text"')) {
      try { for (const c of JSON.parse(line).message?.content || []) if (c.type === "text" && c.text?.trim()) said = c.text; } catch {}
    }
    if (!line.includes("tool_")) continue;
    // the request copy of a turn repeats its tool results; the transcript's own row has the time
    if (line.startsWith('{"type":"api-request-blob"')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (captures && c.type === "tool_result" && Array.isArray(c.content) && !seenResults.has(c.tool_use_id)) {
        const img = c.content.find((x) => x.type === "image" && x.source?.type === "base64" && x.source.data);
        if (img) { seenResults.add(c.tool_use_id); candidate(c, img, row); }
      }
      if (c.type === "tool_use") {
        const i = c.input || {};
        if (captures) uses.set(c.id, { name: c.name, file: typeof i.file_path === "string" ? i.file_path : typeof i.path === "string" ? i.path : "" });
        if (c.name === "Write" && i.file_path && typeof i.content === "string") files.set(i.file_path, i.content);
        else if (c.name === "Edit" && i.file_path) files.set(i.file_path, applyEdit(files.get(i.file_path), i));
        else if (c.name === "MultiEdit" && i.file_path) {
          let t = files.get(i.file_path);
          for (const e of i.edits || []) t = applyEdit(t, e);
          files.set(i.file_path, t);
        } else if (c.name === "SendUserFile" && Array.isArray(i.files)) {
          const cwd = row.cwd || "";
          const shots = i.files
            .filter((f) => typeof f === "string" && /\.(png|jpe?g|webp)$/i.test(f))
            .map((f) => (f.startsWith("~") ? path.join(HOME, f.slice(1)) : path.isAbsolute(f) ? f : path.join(cwd, f)));
          if (shots.length) sending.set(c.id, { id: c.id, shots, caption: typeof i.caption === "string" ? i.caption : "", cwd, at: Date.parse(row.timestamp) || 0 });
        } else if (/(rounds|workbench)_(post|change)$/.test(c.name || "")) {
          posting.add(c.id);
        } else if (c.name === "Artifact" && i.file_path && /\.html?$/i.test(i.file_path) && !i.asset && (!i.action || i.action === "publish")) {
          pending.set(c.id, {
            filePath: i.file_path,
            url: typeof i.url === "string" ? i.url : null,
            text: files.has(i.file_path) ? files.get(i.file_path) : null,
            at: Date.parse(row.timestamp) || 0,
          });
        }
      } else if (c.type === "tool_result" && posting.has(c.tool_use_id)) {
        posting.delete(c.tool_use_id);
        const body = typeof c.content === "string" ? c.content : JSON.stringify(c.content || "");
        const m = body.match(POST_RE);
        if (m && !c.is_error) onPost(m[1]);
      } else if (c.type === "tool_result" && sending.has(c.tool_use_id)) {
        const send = sending.get(c.tool_use_id);
        sending.delete(c.tool_use_id);
        if (!c.is_error) onSend(send);
      } else if (c.type === "tool_result" && pending.has(c.tool_use_id)) {
        const p = pending.get(c.tool_use_id);
        pending.delete(c.tool_use_id);
        const body = typeof c.content === "string" ? c.content : JSON.stringify(c.content || "");
        if (c.is_error || /refused|rejected|conflict/i.test(body.slice(0, 200))) continue;
        const m = body.match(ARTIFACT_URL);
        p.url = p.url || (m && m[0]);
        if (p.url) onPublish(p);
      }
    }
  }
  flush();
  { const m = lastLine.match(DAY_RE); if (m) meta.at = Date.parse(m[1]) || 0; }
  onMeta(meta);
}

// Width and height from the file's own header (PNG, JPEG), else from sips where there is one.
function dims(buf, file) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length - 9) {
      if (buf[o] !== 0xff) { o++; continue; }
      const m = buf[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(o + 7), h: buf.readUInt16BE(o + 5) };
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  if (!file || !hasSips()) return null; // bytes with no file behind them: only the header can say
  try {
    const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" });
    return { w: Number(out.match(/pixelWidth: (\d+)/)[1]), h: Number(out.match(/pixelHeight: (\d+)/)[1]) };
  } catch { return null; }
}

// A screen a session showed, copied into the store by its content so it outlives the scratchpad
// it was saved to.
// A file's path, or a screen read out of a transcript: { buf, name, ext }.
export function keepImage(file) {
  let buf;
  if (file && typeof file === "object") {
    buf = file.buf;
    if (!buf?.length || buf.length > 40e6) return null;
  } else try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 40e6) return null;
    buf = fs.readFileSync(file);
  } catch { return null; }
  const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
  const ext = typeof file === "object" ? file.ext : path.extname(file).slice(1).toLowerCase().replace("jpeg", "jpg");
  if (typeof file === "object") file = file.name;
  const dest = path.join(IMG, `${hash}.${ext}`);
  const metaFile = path.join(IMG, `${hash}.json`);
  if (fs.existsSync(metaFile)) {
    try { return JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch {}
  }
  const d = dims(buf, file);
  if (!d || !d.w || !d.h) return null;
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
  const meta = { hash, ext, w: d.w, h: d.h, name: path.basename(file, path.extname(file)) };
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  return meta;
}

const readDir = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); } catch { return []; } };

// Posts the MCP server wrote (see server/mcp.mjs). Screens become a set; a page becomes a version
// of the page at that path, so posting the same file again makes a before and after; a change
// becomes a set of after screens, each with its before. Pushes the git hook saw become text.
function readPosts(P, threads, postThread, pages, sets) {
  const posts = readDir(POSTS).sort((a, b) => a.at - b.at);
  const byId = new Map(posts.map((p) => [p.id, p]));
  for (const p of posts) {
    const threadId = postThread.get(p.id) || null;
    const thread = threadId ? threads.get(threadId) : null;
    if (P.isPrivate(p.caption, p.cwd, thread?.title)) continue;
    const project = thread ? P.of([thread.title], thread.cwd) : P.of([p.caption], p.cwd);
    if (p.page) {
      const id = `post-${p.page.key}`;
      const page = pages.get(id) || { id, url: "", filePath: p.page.path, thread: threadId, versions: [], project, cwd: p.cwd, posted: true };
      page.title = p.page.title || page.title;
      page.topic = p.topic || page.topic;
      page.versions.push({ at: p.at, text: (() => { try { return fs.readFileSync(path.join(STORE, `${p.page.hash}.html`), "utf8"); } catch { return null; } })() });
      if (threadId) page.thread = threadId;
      pages.set(id, page);
    }
    if (!p.shots?.length) continue;
    // before screens: given with the post, or the screens of the post it replaces, by position
    const prev = p.replaces ? byId.get(p.replaces) : null;
    const before = p.before?.length ? p.before : prev?.shots || [];
    sets.push({
      id: p.id, thread: threadId, project, at: p.at, caption: p.caption || "", topic: p.topic || "",
      kind: p.kind, shots: p.shots, ...(before.length ? { before } : {}), ...(p.commits ? { commits: p.commits } : {}),
    });
  }
  for (const x of readDir(PUSHES)) {
    if (P.isPrivate(x.repo, ...(x.commits || []).map((c) => c.subject))) continue;
    // the session recorded this push itself, with screens: keep that one
    const same = (a, b) => a.startsWith(b) || b.startsWith(a);
    if (posts.some((p) => p.kind === "change" && (x.commits || []).length && x.commits.every((c) => (p.commits || []).some((pc) => same(c.sha, pc.sha))))) continue;
    sets.push({ id: x.id, thread: null, project: P.of([], x.repo), at: x.at, caption: x.summary || `Pushed to ${x.branch}`, topic: "Changes", kind: "push", shots: [], commits: x.commits, files: x.files });
  }
  return posts.length;
}

const titleOf = (html) => {
  const m = html && html.match(/<title>([^<]{1,120})<\/title>/i);
  return m ? m[1].trim().replace(/&amp;/g, "&") : null;
};

// Rounds keeps what it has seen. Claude Code deletes a terminal session's transcript after
// cleanupPeriodDays (30 by default), and a desktop thread's record goes when the thread is
// deleted; the screens and pages they showed are already in the store. So each index starts from
// the last one: a send or a page read from a transcript that's gone carries on, and so do a
// session's name and its days. A session no longer on this Mac is marked gone: its work stays
// on the canvas, but there's nothing left in Claude to open or send a note to. Posts and pushes
// keep their own records in the data folder and are read from there. What the config now keeps
// private still leaves.
function keepSeen(index, P) {
  let prev;
  try { prev = JSON.parse(fs.readFileSync(path.join(DATA, "index.json"), "utf8")); } catch { return 0; }
  const threads = new Map(index.threads.map((t) => [t.id, t]));
  // a send's session as it is now, or as the last index knew it (to judge a session gone private)
  const was = new Map((prev.threads || []).map((t) => [t.id, t]));
  const whose = (id) => (id && (threads.get(id) || was.get(id))) || null;
  let kept = 0;
  for (const t of prev.threads || []) {
    const now = threads.get(t.id);
    if (now) {
      // its days are counted from its transcript: the ones counted before stay counted
      for (const [d, n] of Object.entries(t.days || {})) if (!(now.days[d] >= n)) now.days[d] = n;
      continue;
    }
    if (P.isPrivate(t.title, t.cwd)) continue;
    const g = { ...t, gone: true, project: P.of([t.title], t.cwd) };
    index.threads.push(g);
    threads.set(t.id, g);
  }
  // a post tied to the Claude Code session inside a desktop thread that's gone finds that thread
  const byCli = new Map();
  for (const t of index.threads) if (t.gone) for (const c of t.clis || []) byCli.set(c, t.id);
  for (const x of [...index.sets, ...index.pages]) if (x.thread && !threads.has(x.thread) && byCli.has(x.thread)) x.thread = byCli.get(x.thread);

  const inStore = (sh) => fs.existsSync(path.join(IMG, `${sh.hash}.${sh.ext}`));
  const have = new Set(index.sets.map((x) => x.id));
  for (const x of prev.sets || []) {
    if (x.kind || have.has(x.id)) continue; // only sends read from transcripts have no kind
    const t = x.thread ? threads.get(x.thread) : null, w = whose(x.thread);
    if (P.isPrivate(x.caption, w?.title, w?.cwd)) continue;
    const shots = x.shots.filter(inStore);
    if (!shots.length) continue;
    index.sets.push({ ...x, thread: t ? x.thread : null, shots, project: t ? P.of([t.title], t.cwd) : x.project });
    kept++;
  }
  index.sets.sort((a, b) => a.at - b.at);

  const pages = new Map(index.pages.map((x) => [x.id, x]));
  for (const x of prev.pages || []) {
    if (x.posted) continue;
    const versions = x.versions.filter((v) => fs.existsSync(path.join(STORE, `${v.hash}.html`)));
    const now = pages.get(x.id);
    if (now) {
      // a page rebuilt from fewer transcripts than before keeps the publishes it had
      const hashes = new Set(now.versions.map((v) => v.hash));
      const more = versions.filter((v) => !hashes.has(v.hash));
      if (more.length) { now.versions = [...now.versions, ...more].sort((a, b) => a.at - b.at); now.at = now.versions[now.versions.length - 1].at; }
      continue;
    }
    const t = x.thread ? threads.get(x.thread) : null, w = whose(x.thread);
    if (!versions.length || P.isPrivate(x.title, x.dir, w?.title, w?.cwd)) continue;
    index.pages.push({ ...x, thread: t ? x.thread : null, versions, at: versions[versions.length - 1].at });
    kept++;
  }
  index.folders = [...new Set([...(index.folders || []), ...(prev.folders || [])])];
  index.projects = { ...(prev.projects || {}), ...Object.fromEntries(P.names) };
  return kept;
}

export async function buildIndex({ log = () => {} } = {}) {
  fs.mkdirSync(IMG, { recursive: true });
  const P = projects();
  const { threads, byCli } = readThreads(P);
  const cliMeta = new Map(); // a session with no desktop record: what its transcript says
  const postThread = new Map(); // post id -> the thread that made it
  const sets = [];
  const pages = new Map(); // artifact id -> page
  const days = new Map(); // thread id -> { "YYYY-MM-DD": prompts }

  // a subagent's transcript belongs to its parent session; it isn't a thread of its own
  const transcripts = walk(TRANSCRIPTS, (n) => n.endsWith(".jsonl")).filter((f) => !f.includes(`${path.sep}subagents${path.sep}`));
  log(`${threads.size} threads, ${transcripts.length} transcripts`);
  for (const file of transcripts) {
    const cli = path.basename(file, ".jsonl");
    // the desktop app's record when there is one; otherwise the Claude Code session itself
    const threadId = byCli.get(cli) || cli;
    await readTranscript(file, (p) => {
      const id = p.url.split("/").pop();
      const page = pages.get(id) || { id, url: p.url, filePath: p.filePath, thread: threadId, versions: [] };
      page.filePath = p.filePath;
      if (threadId) page.thread = threadId;
      let text = p.text;
      page.versions.push({ at: p.at, text });
      pages.set(id, page);
    }, (day) => {
      if (!threadId) return;
      const d = days.get(threadId) || {};
      d[day] = (d[day] || 0) + 1;
      days.set(threadId, d);
    }, (send) => {
      // a forked thread carries its parent's history: count each send once, under the thread
      // that has a name when one does
      const dup = sets.find((x) => x.id === sha(send.id));
      if (dup) { if (threads.has(threadId) && !threads.has(dup.thread)) dup.thread = threadId; return; }
      const thread = threads.get(threadId);
      if (byCli.has(cli) && !thread) return; // its desktop thread was kept off the canvas
      const named = (f) => (typeof f === "object" ? f.name : f);
      if (P.isPrivate(send.caption, send.cwd, send.shots.map(named).join(" "), thread?.title, thread?.cwd)) return;
      const shots = [];
      for (const f of send.shots) {
        const m = keepImage(f);
        if (m && !shots.some((x) => x.hash === m.hash)) shots.push(m);
      }
      if (!shots.length) return;
      // a capture's before, one per screen, when every screen has one
      const before = send.before?.length === send.shots.length && shots.length === send.shots.length ? send.before.map(keepImage) : [];
      sets.push({
        id: sha(send.id),
        thread: threadId,
        // the thread decides first; a caption that says "mid-ride" shouldn't move a Shadowfax send
        // the thread decides; a caption that says "mid-ride" or "Shadowfax" doesn't move a send
        project: thread ? P.of([thread.title], thread.cwd) : P.of([send.caption, send.shots[0]], send.cwd),
        at: send.at,
        caption: send.caption,
        shots,
        ...(before.length && before.every(Boolean) ? { before } : {}),
        ...(send.captured ? { captured: true } : {}),
      });
    }, (meta) => {
      if (!threads.has(threadId)) cliMeta.set(threadId, meta);
    }, (postId) => postThread.set(postId, threadId));
  }

  // A post the tool hook tied to its session belongs to that session's thread (the desktop
  // thread it runs in, or the session itself), even before its transcript mentions it.
  for (const p of readDir(POSTS)) if (p.session && !postThread.has(p.id)) postThread.set(p.id, byCli.get(p.session) || p.session);

  // A Claude Code session with no desktop record becomes a thread when it made something.
  const madeBy = new Set([...sets.map((s) => s.thread), ...[...pages.values()].map((p) => p.thread), ...postThread.values()]);
  for (const [id, m] of cliMeta) {
    if (threads.has(id) || !madeBy.has(id)) continue;
    const title = m.summary || m.title || path.basename(m.cwd || "") || "Session";
    if (P.isPrivate(title, m.cwd)) continue;
    threads.set(id, { id, title, cwd: m.cwd, archived: false, at: m.at, recap: "", cli: true });
  }
  // A post that names its session, when no transcript here knows that session (work brought in
  // from elsewhere, the demo), brings the session's name with it.
  for (const p of readDir(POSTS)) {
    const id = postThread.get(p.id);
    if (!id || !p.sessionTitle || P.isPrivate(p.sessionTitle, p.cwd)) continue;
    const t = threads.get(id);
    if (!t) threads.set(id, { id, title: p.sessionTitle, cwd: p.cwd || "", archived: false, at: p.at, recap: "", cli: true });
    else if (t.cli && t.title === p.sessionTitle) t.at = Math.max(t.at, p.at);
  }
  // sends from a session that turned out private, or unknown, leave the canvas
  for (let i = sets.length - 1; i >= 0; i--) {
    const t = sets[i].thread;
    if (t && !threads.has(t)) { const m = cliMeta.get(t); if (!m || P.isPrivate(m.title, m.cwd, m.summary)) sets.splice(i, 1); else sets[i].thread = null; }
  }

  // Posts made through the MCP server (screens, pages, pushed changes), and pushes the git hook
  // recorded on its own.
  const posted = readPosts(P, threads, postThread, pages, sets);

  const out = [];
  for (const page of pages.values()) {
    page.versions.sort((a, b) => a.at - b.at);
    // The newest publish falls back to the file on disk when the transcript can't rebuild it.
    const last = page.versions[page.versions.length - 1];
    if (last.text == null) {
      try { last.text = fs.readFileSync(page.filePath, "utf8"); } catch {}
    }
    const versions = [];
    for (const v of page.versions) {
      if (v.text == null) continue;
      const hash = sha(v.text);
      if (versions.length && versions[versions.length - 1].hash === hash) continue;
      const dest = path.join(STORE, `${hash}.html`);
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, v.text);
      versions.push({ at: v.at, hash });
    }
    if (!versions.length) continue;
    const latestText = fs.readFileSync(path.join(STORE, `${versions[versions.length - 1].hash}.html`), "utf8");
    const thread = page.thread ? threads.get(page.thread) : null;
    const title = page.title || titleOf(latestText) || path.basename(page.filePath, path.extname(page.filePath));
    if (P.isPrivate(title, page.filePath, thread?.title, thread?.cwd)) continue;
    if (page.thread && !thread) page.thread = null;
    out.push({
      id: page.id,
      url: page.url,
      title,
      thread: page.thread,
      project: page.project || P.of([title, page.filePath, thread?.title], thread?.cwd || page.cwd),
      at: versions[versions.length - 1].at,
      dir: path.dirname(page.filePath),
      ...(page.posted ? { posted: true } : {}),
      ...(page.topic ? { topic: page.topic } : {}),
      versions,
    });
  }

  const threadList = [...threads.values()].map((t) => ({ ...t, project: P.of([t.title], t.cwd), days: days.get(t.id) || {} }));
  sets.sort((a, b) => a.at - b.at);
  // every folder a session ran in, made something or not: where a first launch looks for pushes
  const folders = [...new Set([...cliMeta.values(), ...threads.values()].map((m) => m.cwd).filter((c) => c && !P.isPrivate(c)))];
  const index = { builtAt: Date.now(), projects: Object.fromEntries(P.names), threads: threadList, pages: out, sets, folders };
  const kept = keepSeen(index, P);
  if (kept) log(`${kept} kept from earlier: their transcripts are gone`);
  filePostTopics(index); // a post that named its topic is filed under it now
  fs.writeFileSync(path.join(DATA, "index.json"), JSON.stringify(index));
  log(`${out.length} pages, ${out.reduce((n, p) => n + p.versions.length, 0)} versions, ${sets.length} sets, ${sets.reduce((n, s) => n + s.shots.length, 0)} screens`);
  return index;
}
