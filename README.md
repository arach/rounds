<p align="center">
  <img src="docs/rounds-mark.svg" width="72" alt="">
</p>

<h1 align="center">Rounds</h1>

<p align="center">Everything your Claude Code sessions make, on one canvas.</p>

[![The Rounds canvas](docs/rounds-og.png)](docs/rounds-film.mp4)

<p align="center"><a href="docs/rounds-film.mp4">Watch the film</a></p>

I run a lot of Claude Code sessions at once and kept losing track of what each one made. Now it
all lands in one place, and I can leave notes on it.

## Try it

```bash
npx github:krispuckett/rounds --demo
```

The demo is six of my public projects and the real notes I left on them. It runs in its own
folder and doesn't touch your setup.

## What it does

Screens, pages and pushes from every session, sorted by project.

![The Road, one of the projects on the canvas](docs/canvas-project.jpg)

Pin a note on a screen. The session that made it gets the note, makes the fix and replies.

![A note on a screen, with the session's reply](docs/canvas-note.jpg)

Drag to compare a screen with the one it replaced.

![A sky before and after a fix](docs/canvas-compare.jpg)

Step back to any day.

![Earlier days stacked behind the current one](docs/canvas-time.jpg)

Search a session by name to see everything it made, newest first.

Claude Code deletes terminal sessions after 30 days by default. What they made stays on your canvas.

## Set it up

You need a Mac, Node 20 or newer, and Claude Code.

```bash
npx github:krispuckett/rounds init
```

This adds an MCP server, a skill and two hooks to Claude Code, and asks before each one. Then
open the canvas:

```bash
npx github:krispuckett/rounds
```

This also updates Rounds, hooks included, whenever there's a new version.

To take it all out:

```bash
npx github:krispuckett/rounds uninstall
```

## Privacy

Everything stays in `~/.rounds` on your Mac, and websites can't reach it. To sort older screens
into topics, Rounds asks Claude Haiku through your own Claude Code, sending each one's caption, session
name and file names.

<details>
<summary>More</summary>

### Tools

Sessions post with `rounds_post` and `rounds_change`, read notes with `rounds_notes` and answer
them with `rounds_reply`. One hook brings each session its notes with your next message. The
other ties posts to their session and notices pushes to main.

In auto mode, Claude Code may ask you before acting on a note. Say yes and it carries on.

### Without posting

Sessions don't have to post anything. Every screenshot a session takes, and every image it opens
to look at, is in its transcript, so Rounds finds them on its own, including in sessions from
before you installed it. For each turn it keeps the last screen of each page or folder, a few
at most, captioned with what the session told you at the end of the turn. A screen of the same
page from earlier in the session becomes its before. Set `"captures": false` in the config to
show only what sessions post. Work from a worktree sits with the repo it was cut from, even
after the worktree is gone.

### Scout

With [Scout](https://openscout.app) installed, a note goes straight to the session that made the
work, the moment you pin it, when that session is open. Rounds looks the session up with
`scout session address` and sends the note with `scout ask`, and the pin says it went through Scout.

When that session is closed, a new Claude session in the same repo takes the note, through
`scout ask --project`. It's told which session made the work and where that session's
transcript is, so it can read what was done before acting on the note. The pin says so.

The pin always says where a note stands: sent, on its way, or waiting and why (Scout can't
reach the session, or Scout refused the send). Each step is kept in `~/.rounds/trail`, so a
refresh or a restart tells the same story, and the pin lists them. A session that answers on
the Scout task instead of with `rounds_reply` (a new session has no Rounds tools) still gets
its answer onto the pin, with the screens it names kept in the store.

While a note is out, Rounds reads the transcript of the session that got it (the one whose
prompt carried the note, or after a handoff, the one in the new task's repo whose brief names
it) and shows what the agent is doing: dots and the repo's name by the pin, and in the note's
panel the agent's current step ("Editing Board.tsx", "Running the build") typed out with a
cursor. Dots move only while that transcript is moving, or while a tool call it made is still
out. A session that has gone quiet says so ("quiet", "no sign of work"), however long Scout
lists its task as running. Rounds tries waiting notes again every half
minute. Set `"scout": false` in the config to turn Scout off, `"scout": "wake"` to first reopen
a session Scout can resume, or `"newSession": false` to keep a closed session's notes waiting
for your next message there instead.

### Keys

| Key | Does |
| --- | --- |
| T | Timeline |
| ← → | A day back, a day forward |
| / or ⌘K | Search |
| + − 0 | Zoom in, zoom out, fit everything |
| Space | Hold to pan, or to see the before while comparing |
| Esc | Back out |

Scroll pans and pinch zooms, in the timeline too; scrolling over its rail moves through
the days. Drop an image or an HTML file on the canvas to add it to a project.

### Config

`~/.rounds/config.json`, every field optional:

```json
{
  "projects": [{ "key": "shop", "name": "Shop", "match": ["shop", "storefront"] }],
  "private": ["acme-internal"],
  "port": 4797,
  "scout": true
}
```

`projects` groups work by words in its session, folder or caption. Anything matching `private`
never shows up. `ROUNDS_HOME` and `ROUNDS_PORT` override the folder and the port.

### Develop

```bash
npm install
npm run dev     # the canvas, on :4797
npm run eval    # the whole loop with real Claude sessions
```

</details>

## License

MIT. Made by [Kris Puckett](https://krispuckett.com).
