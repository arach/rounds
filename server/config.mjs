// Where Rounds keeps things, and how it decides what a piece of work belongs to.
//
// ~/.rounds/config.json (every field optional):
//   {
//     "projects": [{ "key": "shop", "name": "Shop", "match": ["shop", "storefront"] }],
//     "private": ["acme-internal"],   // anything matching never reaches the canvas
//     "folders": true,                // unmatched work is named for its repo folder
//     "home": "Studio",               // the name for work with no project (a home folder)
//     "port": 4797,
//     "relay": false,                 // Claude desktop app: a relay session delivers notes at once
//     "scout": true,                  // with Scout installed, notes go to their live session at
//                                     // once; false turns it off, "wake" also resumes closed ones
//     "newSession": true,             // a closed session's note goes to a new Claude session in
//                                     // its repo, through Scout; false keeps it waiting instead
//     "captures": true                // screens sessions captured on their own (screenshots,
//                                     // images they opened) show without being posted
//   }
// A project is matched by its rules first (thread name, folder, caption), then, with "folders"
// on, by the git repo (or folder) the session ran in.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Overrides are ROUNDS_HOME, ROUNDS_CLAUDE_HOME, ROUNDS_DESKTOP_SESSIONS, ROUNDS_PORT and
// ROUNDS_BROWSER. The WORKBENCH_ names from before the name Rounds still work; both are set
// alike here, so every part reads the same value.
for (const k of ["HOME", "CLAUDE_HOME", "DESKTOP_SESSIONS", "PORT", "BROWSER"]) {
  const v = process.env[`ROUNDS_${k}`] ?? process.env[`WORKBENCH_${k}`];
  if (v != null) process.env[`ROUNDS_${k}`] = process.env[`WORKBENCH_${k}`] = v;
}

export const HOME = os.homedir();
// ~/.rounds, or ~/.workbench for an install from before the name, so nothing has to move
const at = (n) => path.join(HOME, n);
export const DATA = process.env.ROUNDS_HOME || (!fs.existsSync(at(".rounds")) && fs.existsSync(at(".workbench")) ? at(".workbench") : at(".rounds"));
export const CLAUDE = process.env.ROUNDS_CLAUDE_HOME || path.join(HOME, ".claude");
export const DESKTOP_SESSIONS = process.env.ROUNDS_DESKTOP_SESSIONS || path.join(HOME, "Library/Application Support/Claude/claude-code-sessions");
export const STORE = path.join(DATA, "store");
export const IMG = path.join(STORE, "img");
export const POSTS = path.join(DATA, "posts");
export const PUSHES = path.join(DATA, "pushes");
export const CONFIG = path.join(DATA, "config.json");

const DEFAULTS = { projects: [], private: [], folders: true, home: "Studio", port: 4797, relay: false, scout: true, newSession: true, captures: true };

export function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch {}
  return { ...DEFAULTS, ...c };
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "work";

// The repo a folder belongs to: the nearest parent holding .git, else the folder itself. A linked
// worktree (its .git is a file naming the main repo's .git/worktrees/<name>) belongs to the main
// checkout, so a branch's work sits with its project instead of becoming one of its own.
export function repoOf(dir) {
  const found = gitRoot(dir);
  if (found) return found;
  // A worktree removed once its branch merged leaves its name (and sometimes an empty folder):
  // the repo beside it whose name begins it (<repo>-<branch>, the longest such) is the one it
  // was cut from.
  const parent = path.dirname(dir), base = path.basename(dir);
  let best = "";
  try {
    for (const n of fs.readdirSync(parent)) {
      if (n.length > best.length && base.startsWith(`${n}-`) && fs.existsSync(path.join(parent, n, ".git"))) best = n;
    }
  } catch {}
  return (best && gitRoot(path.join(parent, best))) || dir;
}

function gitRoot(dir) {
  let d = dir;
  for (let i = 0; i < 12 && d && d !== path.dirname(d); i++) {
    const git = path.join(d, ".git");
    if (fs.existsSync(git)) {
      try {
        if (fs.statSync(git).isFile()) {
          const to = fs.readFileSync(git, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
          const main = to && path.resolve(d, to).split(`${path.sep}.git${path.sep}worktrees${path.sep}`);
          if (main?.length === 2 && fs.existsSync(main[0])) return main[0];
        }
      } catch {}
      return d;
    }
    d = path.dirname(d);
  }
  return null;
}

/** One function for every caller: which project a thing belongs to, and every project's name. */
export function projects(cfg = loadConfig()) {
  const rules = (cfg.projects || []).map((p) => ({ key: p.key || slug(p.name), name: p.name, re: new RegExp((p.match || [p.name]).join("|"), "i") }));
  const priv = (cfg.private || []).length ? new RegExp(cfg.private.join("|"), "i") : null;
  const names = new Map(rules.map((r) => [r.key, r.name]));
  names.set("studio", cfg.home);
  const repoCache = new Map();
  return {
    names,
    isPrivate: (...texts) => !!priv && priv.test(texts.filter(Boolean).join(" ")),
    of(texts, cwd) {
      const t = [...texts, cwd].filter(Boolean).join(" ");
      for (const r of rules) if (r.re.test(t)) return r.key;
      if (!cfg.folders || !cwd || path.resolve(cwd) === HOME) return "studio";
      let repo = repoCache.get(cwd);
      if (!repo) { repo = repoOf(cwd); repoCache.set(cwd, repo); }
      if (path.resolve(repo) === HOME) return "studio";
      const name = path.basename(repo);
      const key = slug(name);
      if (!names.has(key)) names.set(key, name);
      return key;
    },
  };
}
