// Your notes, from the dock: each with what it's on and where it stands right now, newest first.
// The count on the key is how many are still under way; one that's moving shows a dot that
// breathes. Picking one opens its screen or page with the note open to read.
import { useEffect, useRef, useState } from "react";
import { clean, when, type Comment, type Index } from "./data";
import { Glyph } from "./glyphs";
import { whereTo } from "./Stage";

/** Still waiting on its session: not answered, not kept here for good. */
export const underWay = (c: Comment) => !c.reply && c.state !== "kept";

/** What a note was pinned on, in a few words. */
function onWhat(c: Comment, index: Index) {
  if (String(c.page).startsWith("shot-")) {
    const set = index.sets.find((s) => s.shots.some((x) => x.hash === c.hash));
    return set ? clean(set.caption) : "A screen";
  }
  const page = index.pages.find((p) => p.id === c.page);
  return page ? clean(page.title) : "A page";
}

export function NotesKey({ index, onOpen }: { index: Index; onOpen: (c: Comment) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const notes = [...index.comments].sort((a, b) => (b.trail?.at(-1)?.at ?? b.at) - (a.trail?.at(-1)?.at ?? a.at)).slice(0, 30);
  const busy = index.comments.filter(underWay).length;
  // a step in the last two minutes: the key's dot breathes
  const moving = index.comments.some((c) => underWay(c) && Date.now() - (c.trail?.at(-1)?.at ?? c.at) < 120e3);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); setOpen(false); } };
    addEventListener("pointerdown", away, true);
    addEventListener("keydown", key, true);
    return () => { removeEventListener("pointerdown", away, true); removeEventListener("keydown", key, true); };
  }, [open]);

  if (!index.comments.length) return null;
  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={busy ? `Notes, ${busy} under way` : "Notes"}
        aria-expanded={open}
        data-tip="Notes"
        className="relative grid h-11 w-11 shrink-0 place-items-center rounded-full transition-[background,color,transform] duration-200 active:scale-95"
        style={{ background: open ? "var(--ink)" : "transparent", color: open ? "white" : "var(--ink)" }}
      >
        <Glyph name="comment" />
        {busy > 0 && (
          <span
            className="type-mono absolute right-0.5 top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[10.5px] font-medium text-white"
            style={{ background: "var(--honey)", boxShadow: "0 0 0 2px var(--wall)", animation: moving ? "wb-breathe 1.6s ease-in-out infinite" : undefined }}
          >
            {busy}
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Notes"
          className="absolute bottom-[calc(100%+14px)] left-1/2 flex max-h-[min(560px,calc(100vh-140px))] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-[18px] border border-[var(--faint)] text-[var(--ink)]"
          style={{ background: "var(--wall)", boxShadow: "var(--shadow-lift)", animation: "wb-notes 220ms var(--ease-out) both" }}
        >
          <div className="flex items-baseline justify-between border-b border-[var(--faint)] px-4 py-3">
            <span className="text-[14px] font-[560]">Notes</span>
            <span className="type-mono text-[11px] text-[var(--muted)]">{busy ? `${busy} under way` : "all answered"}</span>
          </div>
          <ol className="overflow-y-auto overscroll-contain py-1">
            {notes.map((c) => {
              const live = underWay(c);
              return (
                <li key={c.id}>
                  <button
                    onClick={() => { setOpen(false); onOpen(c); }}
                    className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-black/[0.04]"
                  >
                    <span
                      className="mt-[5px] h-2 w-2 shrink-0 rounded-full"
                      style={{ background: c.reply ? "var(--quiet)" : c.state === "kept" ? "var(--faint)" : "var(--honey)", animation: live && Date.now() - (c.trail?.at(-1)?.at ?? c.at) < 120e3 ? "wb-breathe 1.6s ease-in-out infinite" : undefined }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-[520]">{c.text}</span>
                      <span className="block truncate text-[12px] text-[var(--muted)]">{onWhat(c, index)}</span>
                      <span className="mt-0.5 block text-[12px] leading-snug" style={{ color: live ? "var(--ink)" : "var(--muted)" }}>{whereTo(c)}</span>
                    </span>
                    <span className="type-mono mt-[3px] shrink-0 text-[11px] text-[var(--quiet)]">{when(c.trail?.at(-1)?.at ?? c.at)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}
      <style>{`@keyframes wb-notes { from { opacity: 0; transform: translate(-50%, 6px) } } @keyframes wb-breathe { 50% { opacity: 0.45 } }`}</style>
    </div>
  );
}
