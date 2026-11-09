import { backSlice, E, N, NE, NW, S, SE, SW, W, type Dial, type Dir, type RingSlice } from "./ring";
import { clipShort, RING_LAYOUT, SLOT_LOOK, type Command, type TargetKind } from "./commands";

/**
 * The dials. The empty canvas has one fixed 8-sided dial (Exit, Ask, Note, Checks, More, Pauses, Paste, Container) whose
 * sub-dials grow outward as new rings. Every other target keeps its own first dial, and the actions it has no slot for
 * go in an 8-sided "More" sub-dial behind its north-west wedge. Every sub-dial has Back at north-west, and a position
 * with nothing in it is left empty (drawn dim), so a dial keeps its number of sides.
 *
 * Commands that are on no dial are still in the palette.
 */

/** A command's wedge, or a dim inert one when the command is not available now. */
function pick(byId: Map<string, Command>, dir: Dir, id: string, label: string, short: string, icon?: string): RingSlice {
  const c = byId.get(id);
  if (!c) return { dir, label, short, icon, inert: true };
  return { dir, id: c.id, label: c.name, short, icon, run: c.run, danger: c.danger };
}

/** A wedge that opens a sub-dial; it is dim and inert when nothing in the sub-dial can be chosen. */
function open(dir: Dir, label: string, short: string, icon: string | undefined, dial: Dial): RingSlice {
  const live = dial.slices.some((s) => !s.back && !s.inert);
  return { dir, label, short, icon, children: dial, inert: live ? undefined : true };
}

const sub = (sides: 4 | 6 | 8, slices: RingSlice[]): Dial => ({ sides, slices: [backSlice(), ...slices] });

/** The dial for the empty canvas. `palette` opens the command palette. */
function canvasDial(all: Command[], palette: () => void): Dial {
  const byId = new Map(all.map((c) => [c.id, c]));
  const p = (dir: Dir, id: string, label: string, short: string, icon?: string) => pick(byId, dir, id, label, short, icon);

  // Paste: whichever of the two pastes is first in the list; the other keeps its palette path.
  const pastes = all.filter((c) => c.id === "paste.step" || c.id === "paste.container");
  const paste: RingSlice = pastes.length
    ? { dir: SW, id: pastes[0].id, alsoIds: pastes.slice(1).map((c) => c.id), label: pastes[0].name, short: "Paste", icon: "paste", run: pastes[0].run }
    : { dir: SW, label: "Paste", short: "Paste", icon: "paste", inert: true };

  // Plan lock is one button: "Lock" when the plan is open, "Unlock" when it is locked.
  const lock = byId.get("global.lock");
  const locked = !!lock && lock.name.startsWith("Unlock");
  const lockSlice: RingSlice = lock
    ? { dir: E, id: lock.id, label: lock.name, short: locked ? "Unlock" : "Lock", icon: "check", run: lock.run }
    : { dir: E, label: "Lock the plan", short: "Lock", icon: "check", inert: true };

  return {
    sides: 8,
    slices: [
      { dir: NW, label: "Exit", short: "Exit", icon: "close", run: () => {}, red: true },
      p(N, "canvas.ask", "Ask model", "Ask", "ask"),
      p(NE, "add.note", "Add a note", "Note", "note"),
      open(E, "Checks", "Checks", "check", sub(4, [
        p(NE, "add.check-tests", "Add a check: Tests pass", "Tests pass"),
        p(SE, "add.check-lint", "Add a check: Lint passes", "Lint passes"),
        p(SW, "add.check-custom", "Add a check: Custom check", "Custom"),
      ])),
      open(SE, "More", "More", "more", sub(8, [
        open(N, "Logic", "Logic", "chat", sub(6, [
          p(N, "add.ask-decision", "Add a question: Decision", "Decision", "chat"),
          p(NE, "add.ask-input", "Add a question", "Question", "chat"),
          p(SE, "add.ask-form", "Add a question: Form", "Form", "chat"),
          p(S, "add.ask-constant", "Add a question: Constant", "Constant", "chat"),
          p(SW, "add.translator", "Add a translator", "Translator", "repeat"),
        ])),
        p(NE, "global.issues", "Show the issues", "Issues", "alert"),
        lockSlice,
        p(SE, "studio.settings", "Settings", "Settings", "settings"),
        p(S, "global.history", "History", "History", "clock"),
        { dir: SW, label: "Command palette", short: "⌘K", icon: "terminal", run: palette },
        open(W, "Tweaks", "Tweaks", "sliders", sub(4, [
          p(NE, "global.zoom-in", "Zoom in", "Zoom in"),
          p(SE, "global.zoom-out", "Zoom out", "Zoom out"),
          p(SW, "global.zoom-reset", "Reset zoom to 100%", "100%"),
        ])),
      ])),
      open(S, "Pauses", "Pauses", "alert", sub(4, [
        p(NE, "add.approval", "Add a pause: Approval", "Approval"),
        p(SW, "add.wait", "Add a pause: Wait for reset", "Wait"),
      ])),
      paste,
      p(W, "add.container", "Add a container", "Container", "open"),
    ],
  };
}

/** The positions a More dial fills, in order. With a next page, south-west is kept for it. */
const MORE_DIRS: Dir[] = [N, NE, E, SE, S, SW, W];
const MORE_DIRS_PAGED: Dir[] = [N, NE, E, SE, S, W];

/** An 8-sided dial of a target's other actions, alphabetical, with Next page continuing it when they do not fit. */
function moreDial(entries: Command[], start: number): Dial {
  const paged = entries.length - start > MORE_DIRS.length;
  const dirs = paged ? MORE_DIRS_PAGED : MORE_DIRS;
  const slices: RingSlice[] = [backSlice()];
  entries.slice(start, start + dirs.length).forEach((c, i) => {
    slices.push({ dir: dirs[i], id: c.id, label: c.name, short: clipShort(c.short ?? c.name), run: c.run, danger: c.danger });
  });
  if (paged) slices.push({ dir: SW, label: "Next page", short: "Next page", icon: "more", children: moreDial(entries, start + dirs.length) });
  return { sides: 8, slices };
}

/**
 * The first dial for a target. `mine` is the target's own commands: those with a slot sit in its first dial, the rest go
 * in a More dial. `all` is every command the palette knows, which the canvas dial draws from. `palette` opens the palette.
 */
export function ringTree(mine: Command[], all: Command[], target: TargetKind, palette: () => void = () => {}): Dial {
  if (target === "canvas") return canvasDial(all, palette);
  const layout = RING_LAYOUT[target];
  const out: RingSlice[] = [];
  const placed = new Set<string>();
  for (const c of mine) {
    if (c.target !== target || !c.slot || c.slot === "more") continue;
    const dir = layout[c.slot];
    if (dir === undefined || out.some((s) => s.dir === dir)) continue;
    const look = SLOT_LOOK[c.slot];
    out.push({ dir, id: c.id, label: c.name, short: clipShort(c.short ?? look?.short ?? c.name), icon: look?.icon, run: c.run, danger: c.danger });
    placed.add(c.id);
  }
  const rest = mine.filter((c) => !placed.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
  if (rest.length > 0) {
    out.push({ dir: layout.more ?? NW, label: "More", short: "More", icon: "more", children: moreDial(rest, 0) });
  }
  return { sides: 8, slices: out };
}
