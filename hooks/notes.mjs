#!/usr/bin/env node
// UserPromptSubmit hook: when you type in a session that has new notes on its work, they come
// into the conversation with your message, so the session sees them without any relay.
//
// A note belongs to this session when its thread is this session (or the desktop thread this
// session runs in), or when it is on work this session made: a post (the tool hook records
// which session made each post) or anything the canvas has since traced to it. Never by guessing from the folder: two sessions in one repo each
// get only their own. Each note is delivered once.
import fs from "node:fs";
import path from "node:path";
import { DATA } from "../server/config.mjs";
import { SENT, delivered, noteMessage, postOf as postIn, readPosts } from "../server/notes.mjs";

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
const session = input.session_id || "";

const comments = read(path.join(DATA, "comments.json"), []);
const INBOX = path.join(DATA, "inbox");
// A note the desktop relay is carrying is the relay's for its first five minutes: the relay's
// own message to the session runs this hook too, and the note would arrive twice. Past that the
// relay isn't running, and the next message here brings it.
const relaying = (c) => { try { return Date.now() - fs.statSync(path.join(INBOX, `${c.id}.json`)).mtimeMs < 5 * 60e3; } catch { return false; } };
const waiting = comments.filter((c) => !delivered(c) && !c.reply && !relaying(c));
if (!waiting.length) process.exit(0);

// this session's thread ids: itself, and any desktop thread it is the engine of
const index = read(path.join(DATA, "index.json"), { threads: [], sets: [], pages: [] });
const mine = new Set([session, ...index.threads.filter((t) => (t.clis || []).includes(session)).map((t) => t.id)]);

const posts = readPosts();
const postOf = (c) => postIn(c, posts);

// pinned before the canvas knew who made it: the same lookup the canvas uses for the pin
const madeBy = (c) => postOf(c)?.session
  || (index.sets || []).find((x) => x.thread && x.shots.some((s) => s.hash === c.hash))?.thread
  || (index.pages || []).find((x) => x.thread && x.versions.some((v) => v.hash === c.hash))?.thread;
const notes = waiting.filter((c) => mine.has(c.thread || madeBy(c)));
if (!notes.length) process.exit(0);

const context = noteMessage(notes, posts);

fs.mkdirSync(SENT, { recursive: true });
for (const c of notes) {
  fs.writeFileSync(path.join(SENT, `${c.id}.json`), JSON.stringify({ delivery: "hook", session, at: Date.now() }));
  try { fs.unlinkSync(path.join(INBOX, `${c.id}.json`)); } catch {}
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }));
