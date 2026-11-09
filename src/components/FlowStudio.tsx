import { flushSync } from "react-dom";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  addAgentNode,
  addApprovalNode,
  addContainer,
  removeContainer,
  updateContainer,
  type FlowContainer,
  addEndNode,
  addWaitNode,
  waitUntil,
  addStartNode,
  canRemove,
  doneOf,
  isWork,
  addOutput,
  addVerifierNode,
  artifactLabel,
  canWire,
  dependencies,
  effectiveModel,
  fitsQuota,
  flowIssues,
  isReady,
  lock,
  markDone,
  markFailed,
  moveNode,
  newFlow,
  removeNode,
  renameFlow,
  reopen,
  setBend,
  setSub,
  subFlow,
  unwire,
  readyNodes,
  wire,
  type CheckKind,
  type Flow,
  type FlowNode,
} from "../flowModel";
import { exampleFlow, FLOW_ADDED, FLOW_REPLACED, loadFlows, proposalWaitingFor, saveFlows, setProposalWaiting } from "../flowStore";
import { batchDecisions, clearPendingMerges, forgetHistory, loadTimeline, recordPoint, recordTurn, updateTimeline, updateTurn, useTimeline, type HistoryDecision } from "../flowHistory";
import { branchTips, dropPoint, isTip, newlyAnswered, patchPoint, questionPoint, sameFlow, suggestMerges, tipOf, type MergeSuggestion, type PointSpec } from "../flowTimeline";
import { FlowStrip } from "./FlowStrip";
import { FlowHistory } from "./FlowHistory";
import { nodePrompt } from "../flowPrompt";
import {
  addNote,
  diffNotes,
  noteSize,
  NOTE_MIN,
  addNoteLink,
  hiddenNotes,
  removeNoteStack,
  updateNoteStack,
  notesInside,
  setNotesInside,
  stackNotes,
  STACK_SIZE,
  type NoteStack,
  COLLAPSED_SIZE,
  hiddenByContainers,
  insertCopy,
  NOTE_COLORS,
  removeNote,
  removeNoteLink,
  setRetry,
  setSubSteps,
  updateNote,
  type FlowNote,
  type NoteLink,
  type NoteLinkEnd,
} from "../flowModel";
import { draftQuestionnaire, rewriteRetryPrompt, suggestSubSteps } from "../flowAssist";
import { askAgent, leaveNotes } from "../flowAgent";
import { dropDiffNotes, expandStack, leaveDiffNotes, takeDiffNotes } from "../flowNotes";
import { editFlow, type FlowEdit } from "../flowEdit";
import { ghostView } from "../flowGhost";
import { addPlanningSquares, answerPlanning, batchOf, linkDecisions, withDecisions, type DecisionAnswer } from "../flowDecisions";
import { PlanAsk } from "./PlanAsk";
import { capturePiece, deletePreset, getPieces, getSlot, placePiece, savePreset, storeSlot, subscribePieces, type Piece } from "../flowPieces";
import {
  addAsk,
  applyQuestionnaire,
  ASK_SIZE,
  askHeight,
  ASK_KIND_INFO,
  askPorts,
  asksOf,
  askState,
  blockedByAsks,
  fillForAsk,
  isAnswered,
  isSkipped,
  pendingAsks,
  refState,
  removeAsk,
  translatedText,
  translatorState,
  unwireAsk,
  unwireTranslator,
  updateAsk,
  wireAsk,
  wireTranslator,
} from "../flowAsk";
import { newCritic } from "../flowCritic";
import { addTranslatorNode, updateNode, type AskKind, type AskRef, type FlowAsk } from "../flowModel";
import { AskPanel, AskSquareBody } from "./FlowAsks";
import { CriticRun } from "./FlowCriticRun";
import { exportFlow, exportName, parseFlowFile } from "../flowFile";
import { api } from "../api";
import { describePolish, describeProgress, polishPlans, type PolishSource } from "../flowCloud";
import { basePromptText } from "../flowPromptDoc";
import { resetsIn } from "../flowTools";
import { boxOf, ensurePositions, containerCover, freeSlot, GRID, gridLayers, NODE_H, snap, NODE_W, roundedPath, route, withStart, type Box } from "../flowLayout";
import { copyText } from "../clipboard";
import { CheckIcon, CopyIcon, PlusIcon, TrashIcon } from "./Icons";
import { WordDiff } from "./WordDiff";
import { placeRing, Ring, startPress, type RingOpen } from "./Ring";
import { Palette } from "./Palette";
import { TARGET_LABEL, type Command, type TargetKind } from "../commands";
import { ringPaths, type Dir } from "../ring";
import { ringTree } from "../ringTree";
import { FlowInspector } from "./FlowInspector";
import { FlowTools } from "./FlowTools";

type Mode = "plan" | "run";
type Panel = "node" | "tools";

/** Empty room kept to the left of and above the canvas, so steps never sit against the edge. */
const PAD_L = 72;
const PAD_T = 48;

/** The colours a container can have, by name. */
const CONTAINER_COLORS: Record<string, string> = {
  teal: "#1f5c56",
  amber: "#a8651c",
  red: "#8b3a30",
  blue: "#3b5fb0",
  grey: "#72695b",
};

/**
 * The groups the menus show, in order. A group with several kinds opens a side pane when you hover it;
 * one with a single kind is just that item. New kinds (a loop, a review) are added to a group here.
 */
const KIND_GROUPS: Array<{ key: string; label: string }> = [
  { key: "step", label: "Step" },
  { key: "checks", label: "Checks" },
  { key: "pauses", label: "Pauses" },
  { key: "ask", label: "Ask you" },
  { key: "markers", label: "Start and End" },
  { key: "canvas", label: "Canvas" },
  { key: "preset", label: "Saved pieces" },
];

/** Every kind the + menu and the drop menu can make. */
interface KindOption {
  key: string;
  /** Which group of the menu it sits in. */
  group: string;
  /** Its name inside its group, where the group's name already gives the context. */
  short: string;
  /** Makes the node, as the newest one in the flow. `toolId` is the tool a step should start in. */
  make: (f: Flow, toolId?: string) => Flow;
  /** Can it wait for something (so it can come after a step)? */
  hasInput: boolean;
  /** Does it make something (so a step can wait for it)? */
  hasOutput: boolean;
  /** A saved piece can be taken off the menu. */
  remove?: () => void;
}

function kindOptions(checks: Array<{ kind: CheckKind; label: string }>): KindOption[] {
  return [
    { key: "step", group: "step", short: "Step", make: (f, t) => addAgentNode(f, "", t), hasInput: true, hasOutput: true },
    ...checks.map((c) => ({
      key: `check-${c.kind}`,
      group: "checks",
      short: c.label,
      make: (f: Flow) => addVerifierNode(f, c.kind, c.label),
      hasInput: true,
      hasOutput: true,
    })),
    { key: "approval", group: "pauses", short: "Approval", make: (f) => addApprovalNode(f), hasInput: true, hasOutput: true },
    {
      key: "wait",
      group: "pauses",
      short: "Wait for reset",
      // Start it on the first limit that has a reset time, so it works as soon as it is added.
      make: (f, toolId) => {
        const tool = f.tools.find((t) => t.id === toolId) ?? f.tools[0];
        const window = tool?.windows.find((w) => w.resetsAt !== null) ?? tool?.windows[0];
        return addWaitNode(f, tool?.id ?? "", window?.label ?? "");
      },
      hasInput: true,
      hasOutput: true,
    },
    { key: "start", group: "markers", short: "Start", make: (f) => addStartNode(f), hasInput: false, hasOutput: true },
    { key: "end", group: "markers", short: "End", make: (f) => addEndNode(f), hasInput: true, hasOutput: false },
    // A container is drawn on the canvas, not a node, so it has no wires and is never offered after a drop.
    { key: "container", group: "canvas", short: "Container", make: (f) => f, hasInput: false, hasOutput: false },
    // Squares ask the person something at run time. They never wire to a step, so they are not offered after a drop.
    ...(["input", "decision", "form", "constant"] as const).map((kind) => ({
      key: `ask-${kind}`,
      group: "ask",
      short: { input: "Input", decision: "Decision", form: "Form", constant: "Constant" }[kind],
      make: (f: Flow) => f,
      hasInput: false,
      hasOutput: false,
    })),
    // A translator turns answers into an artifact that steps can take. It sits between the two families.
    { key: "translator", group: "ask", short: "Translator", make: (f: Flow) => addTranslatorNode(f), hasInput: false, hasOutput: true },
    // A sticky note is drawn like a container: no wires, and never offered after a drop.
    { key: "note", group: "canvas", short: "Note", make: (f) => f, hasInput: false, hasOutput: false },
  ];
}

const CHECKS: Array<{ kind: CheckKind; label: string }> = [
  { kind: "tests", label: "Tests pass" },
  { kind: "lint", label: "Lint passes" },
  { kind: "build", label: "Build passes" },
  { kind: "custom", label: "Custom check" },
];
const KINDS = kindOptions(CHECKS);

type Point = { clientX: number; clientY: number };

/** Where a square's output dot for `port` sits: down its right edge, one dot per branch. */
function portAt(ask: FlowAsk, at: { x: number; y: number }, port?: string) {
  const ports = askPorts(ask);
  const i = Math.max(0, ports.findIndex((p) => (p.port ?? "") === (port ?? "")));
  return { x: at.x + ASK_SIZE, y: at.y + (askHeight(ask) * (i + 1)) / (ports.length + 1) };
}

/** A horizontal S-curve between two points, the way a wire leaves a right edge and enters a left one. */
function curve(x1: number, y1: number, x2: number, y2: number) {
  const mid = Math.max(32, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`;
}

/** One thing being dragged: what it is, and where it sat when the drag began. */
interface DragMember {
  kind: "node" | "ask" | "note" | "stack";
  id: string;
  x: number;
  y: number;
}


type DragOffset = (kind: DragMember["kind"], id: string) => { dx: number; dy: number };
const NO_OFFSET: DragOffset = () => ({ dx: 0, dy: 0 });

/**
 * The dotted line for one note link: a straight line between the two nearest sides of the two things, so a note above
 * another is joined by a short vertical dash and a note beside a step by a short level one. `off` says how far each
 * card has been dragged so far, so the line can follow a drag by hand. Null when an end is hidden (a step folded inside
 * a container) or gone.
 */
function noteLinkPath(
  view: Flow,
  boxById: Map<string, { x: number; y: number; width: number; height: number }>,
  link: NoteLink,
  off: DragOffset,
): string | null {
  type Geo = { note: boolean; x: number; y: number; w: number; h: number };
  const folded = hiddenNotes(view);
  const geo = (e: NoteLinkEnd): Geo | null => {
    const o = e.kind === "container" ? { dx: 0, dy: 0 } : off(e.kind, e.id);
    if (e.kind === "stack") {
      const s = (view.noteStacks ?? []).find((x) => x.id === e.id);
      return s ? { note: false, x: s.x + o.dx, y: s.y + o.dy, ...STACK_SIZE } : null;
    }
    if (e.kind === "note") {
      // A note folded into a shrunk card is not drawn: a line to it meets the card instead.
      const home = folded.get(e.id);
      if (home) return geo({ kind: "stack", id: home });
      const n = (view.notes ?? []).find((x) => x.id === e.id);
      return n ? { note: true, x: n.x + o.dx, y: n.y + o.dy, ...noteSize(n) } : null;
    }
    if (e.kind === "ask") {
      const a = (view.asks ?? []).find((x) => x.id === e.id);
      return a ? { note: false, x: a.pos.x + o.dx, y: a.pos.y + o.dy, w: ASK_SIZE, h: askHeight(a) } : null;
    }
    if (e.kind === "node") {
      const b = boxById.get(e.id);
      return b ? { note: false, x: b.x + o.dx, y: b.y + o.dy, w: b.width, h: b.height } : null;
    }
    const c = (view.containers ?? []).find((x) => x.id === e.id);
    return c ? { note: false, x: c.x, y: c.y, w: c.collapsed ? COLLAPSED_SIZE.w : c.w, h: c.collapsed ? COLLAPSED_SIZE.h : c.h } : null;
  };
  const a = geo(link.from);
  const b = geo(link.to);
  if (!a || !b) return null;
  // Both ends folded into the same card: there is nothing to draw between them.
  const homeOf = (e: NoteLinkEnd) => (e.kind === "stack" ? e.id : e.kind === "note" ? folded.get(e.id) : undefined);
  if (homeOf(link.from) && homeOf(link.from) === homeOf(link.to)) return null;
  const sides = (g: Geo) => [
    { x: g.x + g.w / 2, y: g.y },
    { x: g.x + g.w, y: g.y + g.h / 2 },
    { x: g.x + g.w / 2, y: g.y + g.h },
    { x: g.x, y: g.y + g.h / 2 },
  ];
  let best: { p: { x: number; y: number }; q: { x: number; y: number }; d: number } | null = null;
  for (const p of sides(a)) {
    for (const q of sides(b)) {
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (!best || d < best.d) best = { p, q, d };
    }
  }
  return best ? `M ${best.p.x} ${best.p.y} L ${best.q.x} ${best.q.y}` : null;
}

/** Quote an id for use inside a CSS attribute selector. */
const cssq = (s: string) => s.replace(/["\\]/g, "\\$&");

/** What the ring or the palette is about: a kind of thing, which one, and where in the world it was pointed at. */
interface Target {
  kind: TargetKind;
  id?: string;
  at: { x: number; y: number };
}

/** What a canvas hands the studio when the palette opens: its commands for a target (or for the selection when none). */
type CommandSource = (target: Target | null) => { commands: Command[]; scope?: { label: string; commands: Command[] }; paths: Map<string, Dir[]> };

/** The link between a canvas and the studio's palette. */
interface StudioLink {
  /** The open canvas keeps its command list here, built only when the palette opens. */
  source: { current: CommandSource | null };
  openPalette: (opts?: { target?: Target; query?: string }) => void;
  /** What the studio itself can do (switch workflow, settings, undo...), for the canvas dial and the palette. */
  studioCommands: () => Command[];
}

const dedupe = (cmds: Command[]) => {
  const seen = new Set<string>();
  return cmds.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
};

/** The step last copied with Cmd or Ctrl + C, kept for as long as the app is open so it can go into another workflow. */
let nodeClipboard: FlowNode | null = null;
/** A container copied with Cmd or Ctrl + C, with everything inside it. Which of the two was copied last is what V pastes. */
let containerClipboard: Piece | null = null;
let lastCopied: "step" | "container" = "step";

/** Offer text as a file. Some webviews ignore this, which is why exporting also copies it. */
function downloadText(name: string, text: string) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    // The copy on the clipboard is the fallback.
  }
}

/** Calls `apply` with the latest value at most once per animation frame, however often `push` is called. */
function perFrame<T>(apply: (value: T) => void) {
  let frame = 0;
  let latest: T;
  return {
    push(value: T) {
      latest = value;
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          apply(latest);
        });
      }
    },
    /** Drop an update that has not run yet, so it cannot land after the gesture has ended. */
    cancel() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

type Cam = { x: number; y: number; k: number };

/** How far a grid layer with this spacing is shifted so its lines sit where the camera puts them. */
function gridShift(c: Cam, spacing: number): string {
  const mod = (n: number) => ((n % spacing) + spacing) % spacing;
  return `translate(${mod(c.x)}px, ${mod(c.y)}px)`;
}

function Library({
  flows,
  onOpen,
  onCreate,
  onExample,
  onImport,
  onDelete,
}: {
  flows: Flow[];
  onOpen: (id: string) => void;
  onCreate: () => void;
  onExample: () => void;
  onImport: (flow: Flow) => void;
  onDelete: (id: string) => void;
}) {
  const [sure, setSure] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);

  function tryImport(source: string) {
    try {
      onImport(parseFlowFile(source));
      setImporting(false);
      setText("");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That could not be read.");
    }
  }

  async function exportOne(flow: Flow) {
    const body = exportFlow(flow);
    await copyText(body);
    downloadText(exportName(flow), body);
    setExported(flow.id);
    window.setTimeout(() => setExported((cur) => (cur === flow.id ? null : cur)), 1600);
  }

  return (
    <div className="flow-library">
      <div className="flow-library-head">
        <h2 className="flow-library-title">Workflows</h2>
        <div className="flow-library-actions">
          <button type="button" className="flow-button" onClick={() => setImporting((v) => !v)}>
            Import
          </button>
          <button type="button" className="flow-button" onClick={onExample}>
            Try an example
          </button>
          <button type="button" className="flow-button primary" onClick={onCreate}>
            <PlusIcon /> New workflow
          </button>
        </div>
      </div>
      {importing && (
        <div className="flow-import">
          <textarea
            rows={5}
            value={text}
            placeholder="Paste an exported workflow here"
            onChange={(e) => setText(e.target.value)}
          />
          {error && <p className="flow-warn-box">{error}</p>}
          <div className="flow-run-actions">
            <button type="button" className="flow-button primary" disabled={!text.trim()} onClick={() => tryImport(text)}>
              Import the pasted text
            </button>
            <label className="flow-button">
              Choose a file…
              <input
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void file.text().then(tryImport);
                }}
              />
            </label>
            <button
              type="button"
              className="flow-button"
              onClick={() => {
                setImporting(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {flows.length === 0 ? (
        <p className="flow-empty">
          A workflow is a plan you can run across your coding tools. Pick the
          tools you have, lay out the steps, and copy each prompt in order.
        </p>
      ) : (
        <ul className="flow-list">
          {flows.map((flow) => {
            const work = flow.nodes.filter(isWork).length;
            const done = flow.nodes.filter((n) => isWork(n) && n.done).length;
            return (
              <li key={flow.id} className="flow-list-item">
                <button type="button" className="flow-list-open" onClick={() => onOpen(flow.id)}>
                  <span className="flow-list-title">{flow.title || "Untitled workflow"}</span>
                  <span className="flow-list-meta">
                    {work} step{work === 1 ? "" : "s"} · {done} done ·{" "}
                    {flow.tools.length} tool{flow.tools.length === 1 ? "" : "s"}
                  </span>
                </button>
                <button
                  type="button"
                  className="flow-button"
                  title="Copies the workflow as a file's text, and offers it as a download"
                  onClick={() => void exportOne(flow)}
                >
                  {exported === flow.id ? "Copied" : "Export"}
                </button>
                <button
                  type="button"
                  className="flow-icon-button"
                  aria-label={sure === flow.id ? "Confirm delete" : "Delete workflow"}
                  onClick={() => {
                    if (sure === flow.id) {
                      onDelete(flow.id);
                      setSure(null);
                    } else {
                      setSure(flow.id);
                    }
                  }}
                  onBlur={() => setSure(null)}
                >
                  {sure === flow.id ? "Sure?" : <TrashIcon />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** What a step card can do, as stable functions, so a card does not redraw just because the canvas did. */
interface NodeCardApi {
  down: (e: ReactPointerEvent, id: string) => void;
  click: (id: string) => void;
  open: (id: string) => void;
}

interface NodeCardProps {
  node: FlowNode;
  x: number;
  y: number;
  w: number;
  h: number;
  className: string;
  pressed: boolean;
  toolLabel: string;
  checked: boolean;
  issue: boolean;
  rank: number | undefined;
  waitText: string | null;
  metaText: string | null;
  api: NodeCardApi;
}

/**
 * One step on the canvas. Everything it shows comes in as plain values, and React skips it when none changed, so a
 * redraw of the canvas (a selection, a message) only touches the cards that are different.
 */
const NodeCard = memo(function NodeCard({ node, x, y, w, h, className, pressed, toolLabel, checked, issue, rank, waitText, metaText, api }: NodeCardProps) {
  return (
    <button
      type="button"
      data-drag={`node:${node.id}`}
      data-target={`step:${node.id}`}
      className={className}
      style={{ left: x, top: y, width: w, height: h }}
      aria-pressed={pressed}
      onPointerDown={(e) => api.down(e, node.id)}
      onClick={() => api.click(node.id)}
      onDoubleClick={() => api.open(node.id)}
    >
      <span className="workflow-node-top">
        <span className="flow-node-tool">{toolLabel}</span>
        {node.sub && node.sub.length > 0 && (
          <span className="flow-node-sub" title="Double-click to open the inside of this step">
            {node.sub.length} inside
          </span>
        )}
        {node.critic && (
          <span className="flow-node-sub" title="A critic reviews this step">
            ↻ critic
          </span>
        )}
        {node.when && (
          <span className="flow-node-sub" title={`Runs only if {${node.when.name}} is ${node.when.equals}`}>
            if {node.when.equals || "…"}
          </span>
        )}
        {issue && <span className="flow-node-dot" title="Something to fix on this step" />}
        {checked && <CheckIcon />}
        {rank && <span className="flow-node-rank">{rank}</span>}
      </span>
      <span className="workflow-node-title">{node.text || "Untitled step"}</span>
      {waitText && <span className="workflow-node-meta">{waitText}</span>}
      {metaText && <span className="workflow-node-meta">{metaText}</span>}
    </button>
  );
});

function FlowCanvas({
  flow: liveFlow,
  onChange: commitProp,
  onBack,
  embedded,
  onDraw,
  studio,
}: {
  flow: Flow;
  /** The palette's side of the studio: where this canvas lists its commands, and how it opens the palette. */
  studio: StudioLink;
  /** `silent` changes (a position given to a new step, say) are not recorded for undo. */
  onChange: (next: Flow, silent?: boolean) => void;
  /** Draw a whole new workflow from what was typed, the way the chat's Workflow button did. */
  onDraw?: (ask: string) => void;
  onBack: () => void;
  /** Set when this canvas shows the inside of one step of a bigger flow. */
  embedded?: { parent: string; /** What the canvas is the inside of; a step unless said. */ label?: string };
}) {
  // The history strip. Rewinding only changes what is shown: `flow` is the version being looked at, and `liveFlow` stays the
  // work. A change made while looking at an earlier version makes that version the work and starts a branch (see commit).
  const timeline = useTimeline(embedded ? "" : liveFlow.id);
  const [rewindId, setRewindId] = useState<string | null>(null);
  const rewindPoint = rewindId ? timeline.points.find((p) => p.id === rewindId) : undefined;
  const rewound = !embedded && rewindPoint ? rewindPoint.snapshot : null;
  const flow = rewound ?? liveFlow;
  /** The work as last committed, so a burst of changes in one event is compared step by step. */
  const latestWork = useRef(liveFlow);
  latestWork.current = liveFlow;
  const [mode, setMode] = useState<Mode>("plan");
  const [zoom, setZoom] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("node");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasNodes = flow.nodes.length > 0;
  // The view is a camera: where it looks (x, y are where the world's origin lands on screen)
  // and how far in it is (k). Nothing bounds it, so you can go anywhere and zoom out as far as you like.
  const [cam, setCamState] = useState<Cam>({ x: PAD_L, y: PAD_T, k: 1 });
  // Drags run for a while and the view can change under them (zoom, pan), so they read the
  // camera as it is now, never as it was when they began.
  const camRef = useRef(cam);
  // The camera changes many times a frame while panning, and React redrawing every step and wire
  // for each change is what made the canvas stutter. So it lives in `camRef`, is written straight
  // to the DOM once per frame, and React is told only when something drawn from it must change:
  // at once when the zoom changes or the camera jumps, and after a pause when it is only panning.
  // `camShown` is what React last drew.
  const camShown = useRef(cam);
  camShown.current = cam;
  const worldRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const camFrame = useRef(0);
  const camIdle = useRef(0);
  const camCool = useRef(0);
  const camWantsRender = useRef(false);
  useEffect(
    () => () => {
      cancelAnimationFrame(camFrame.current);
      window.clearTimeout(camIdle.current);
      window.clearTimeout(camCool.current);
    },
    [],
  );

  function commitCam() {
    window.clearTimeout(camIdle.current);
    if (camShown.current !== camRef.current) setCamState(camRef.current);
  }

  function paintCam() {
    const c = camRef.current;
    const world = worldRef.current;
    if (world) {
      world.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.k})`;
      // Moving as a ready-made picture keeps a pan on the compositor, but the picture is drawn at one zoom and
      // goes soft when scaled. So the canvas is a picture only while it moves, and is drawn sharp again at rest.
      world.style.willChange = "transform";
      window.clearTimeout(camCool.current);
      camCool.current = window.setTimeout(() => {
        if (worldRef.current) worldRef.current.style.willChange = "";
      }, 180);
    }
    const grid = gridRef.current;
    // The grid's layers are sized for the zoom React last drew; they are only shifted while it is the same.
    if (grid && Number(grid.dataset.k) === c.k) {
      for (const layer of Array.from(grid.children) as HTMLElement[]) {
        layer.style.transform = gridShift(c, Number(layer.dataset.spacing));
      }
    }
  }

  function setCam(update: Cam | ((c: Cam) => Cam), mode: "jump" | "pan" = "jump") {
    const next = typeof update === "function" ? update(camRef.current) : update;
    if (next === camRef.current) return;
    if (mode === "jump" || next.k !== camRef.current.k) camWantsRender.current = true;
    camRef.current = next;
    if (camFrame.current) return;
    camFrame.current = requestAnimationFrame(() => {
      camFrame.current = 0;
      paintCam();
      window.clearTimeout(camIdle.current);
      if (camWantsRender.current) {
        camWantsRender.current = false;
        commitCam();
      } else {
        camIdle.current = window.setTimeout(commitCam, 140);
      }
    });
  }
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const read = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNodes]);
  // dir "out" is dragged from a step's right circle (this step is the source); "in" from its left circle (this step waits for what it is dropped on).
  const [drag, setDrag] = useState<{ from: string; dir: "out" | "in"; x: number; y: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Just locked: the toast offers to polish the prompts until it times out or is used. */
  const [lockOffer, setLockOffer] = useState(false);
  useEffect(() => {
    if (!lockOffer) return;
    const t = window.setTimeout(() => setLockOffer(false), 10000);
    return () => window.clearTimeout(t);
  }, [lockOffer]);
  /** The cloud model is writing the prompts; the line says how far along it is. */
  const [writing, setWriting] = useState<string | null>(null);
  // Prompts arrive after an await, by which time the person may have edited; they land on the flow as it is then.
  const flowRef = useRef(flow);
  flowRef.current = flow;
  // What the cloud model offered for steps is left on the canvas as diff notes, which wait there until accepted or rejected;
  // nothing is applied unseen, and they are saved with the workflow.
  const diffList = useMemo(() => diffNotes(flow), [flow]);
  const [pick, setPick] = useState<{ from: string; to: string; x: number; y: number } | null>(null);
  const [newAt, setNewAt] = useState<{ from: string; dir: "out" | "in"; x: number; y: number } | null>(null);
  // Problems are shown as a small dot on the step until the person tries to lock; then the list opens.
  const [showIssues, setShowIssues] = useState(false);
  const justMoved = useRef(false);
  const [selectedContainer, setSelectedContainer] = useState<string | null>(null);
  // Saved pieces, shared by every workflow; and where the pointer is over the canvas, kept in a ref so moving costs no redraw.
  const presets = useSyncExternalStore(subscribePieces, () => getPieces().presets);
  const pointer = useRef<{ clientX: number; clientY: number } | null>(null);
  // The small box that names a piece being saved as a preset, opened where the container was right-clicked.
  const [naming, setNaming] = useState<{ x: number; y: number; container: string; name: string } | null>(null);
  const [selectedNote, setSelectedNote] = useState<string | null>(null);
  const [selectedAsk, setSelectedAsk] = useState<string | null>(null);
  const [selectedAskWire, setSelectedAskWire] = useState<string | null>(null);
  const [selectedNoteLink, setSelectedNoteLink] = useState<string | null>(null);
  // A dotted line being drawn from a note's connection point, following the pointer until it is let go.
  const [noteLine, setNoteLine] = useState<{ from: string; x: number; y: number } | null>(null);
  // The small see-through box you type to the agent in, opened where you double-clicked (world coordinates).
  const [talk, setTalk] = useState<{ x: number; y: number; text: string; busy: boolean; error: string | null } | null>(null);
  // A turn's changes, waiting to be applied or rejected as a whole. While one waits the workflow cannot be edited.
  // Gemini was busy and the agent is trying again: the box says which try it is on.
  const [busyRetry, setBusyRetry] = useState<{ attempt: number; of: number } | null>(null);
  useEffect(() => {
    const stop = api.onCanvasRetry(setBusyRetry);
    return () => void stop.then((off) => off());
  }, []);
  const keptReply = useRef<{ request: string; reply: Awaited<ReturnType<typeof askAgent>> } | null>(null);
  const [proposal, setProposal] = useState<{
    edit: FlowEdit;
    ask: string;
    spot: { x: number; y: number };
    decisions?: string[];
    /** The agent's one-line note and the Asker's questions with the answers, kept for the history. */
    line: string;
    asked: HistoryDecision[];
    /** The history turn that asked the questions, when there were any: it is filled in rather than a new one made. */
    turn?: string;
    /** For a merge: the pending point on the strip that keeping this finishes. */
    merge?: string;
  } | null>(null);
  // A merge of a branch into the main line: the point waits on the strip while the cloud model offers three ways to do it.
  const [merge, setMerge] = useState<{ point: string; tip: string; busy: boolean; error: string | null; options: MergeSuggestion[] | null } | null>(null);
  // Tell the Plan pane while a proposal waits, so it holds its own edits as the canvas does.
  useEffect(() => {
    if (embedded) return;
    setProposalWaiting(flow.id, proposal !== null);
    return () => setProposalWaiting(flow.id, false);
  }, [proposal !== null, flow.id, embedded]);
  const [historyOpen, setHistoryOpen] = useState(false);
  // The agent's questions for this turn are squares on the canvas. While some are unanswered, this holds what the turn
  // was for, so that when the last one is answered the change is drawn with the answers.
  const [batch, setBatch] = useState<{
    turn: string;
    spot: { x: number; y: number };
    request: string;
    /** The agent's one-line note, kept for the history. */
    line: string;
    change: string;
    busy: boolean;
    error: string | null;
  } | null>(null);
  function onChange(next: Flow, silent?: boolean) {
    if (proposal && !silent) {
      flashNotice("Apply or reject the proposed changes first.");
      return;
    }
    commit(next, silent);
  }
  /**
   * Every change to the workflow goes through here. A change made while looking at an earlier version makes that version
   * the work and starts a branch from it (or carries on that version's line if nothing comes after it). Otherwise it
   * lands as usual, and each question it answered, or the turn named in `point`, becomes a point on the strip.
   * `point` of "none" records nothing (a merge is finished by hand).
   */
  function commit(next: Flow, silent?: boolean, point?: Omit<PointSpec, "snapshot"> | "none") {
    if (embedded) return commitProp(next, silent);
    if (rewound && rewindId) {
      // Moving a step to its place is not an edit; only a change you made is.
      if (silent) return;
      branchFrom(rewindId, rewound, next, point);
      return;
    }
    const before = latestWork.current;
    latestWork.current = next;
    commitProp(next, silent);
    if (silent || point === "none") return;
    const specs = point ? [{ ...point, snapshot: next }] : newlyAnswered(before, next).map((a) => questionPoint(a, next));
    for (const spec of specs) recordPoint(liveFlow.id, spec);
  }

  /** If the work has moved on from the last point, keep it as a point, so nothing is lost when something takes its place. */
  function settle(work: Flow) {
    const tl = loadTimeline(liveFlow.id);
    const head = tl.points.find((p) => p.id === tl.head);
    if (head && !head.pending && !sameFlow(head.snapshot, work)) recordPoint(liveFlow.id, { kind: "edit", label: "Edited by hand", snapshot: work });
  }

  function branchFrom(pointId: string, base: Flow, next: Flow, point?: Omit<PointSpec, "snapshot"> | "none") {
    settle(liveFlow);
    const from = loadTimeline(liveFlow.id).points.find((p) => p.id === pointId);
    setRewindId(null);
    latestWork.current = next;
    commitProp(next);
    if (!from) return;
    const named = point && point !== "none" ? [{ ...point, snapshot: next }] : newlyAnswered(base, next).map((a) => questionPoint(a, next));
    const specs: PointSpec[] = named.length > 0 ? named : [{ kind: "edit", label: "Edited by hand", snapshot: next }];
    const goOn = isTip(loadTimeline(liveFlow.id), from);
    specs.forEach((spec, i) => recordPoint(liveFlow.id, i > 0 ? spec : goOn ? { ...spec, after: from.id } : { ...spec, forkFrom: from.id }));
    flashNotice(goOn ? "Carried on from that version." : "Started a branch from that version. The other line is kept on the strip.");
  }

  /** Look at a point (null: the latest). Not while a proposal or the agent's questions are waiting. */
  function rewindTo(id: string | null) {
    if (embedded) return;
    if (id && (proposal || batch || merge)) {
      flashNotice("Finish what is waiting first.");
      return;
    }
    setRewindId(id && id !== timeline.head ? id : null);
  }

  /** One point back (-1) or forward (+1) from where you are; forward past the newest returns to the latest. */
  function stepRewind(delta: -1 | 1) {
    const at = timeline.points.findIndex((p) => p.id === (rewindId ?? timeline.head));
    if (timeline.points.length === 0) return;
    const to = at + delta;
    if (to < 0) return rewindTo(timeline.points[0].id);
    if (to >= timeline.points.length) return rewindTo(null);
    rewindTo(timeline.points[to].id);
  }

  /** Merge a branch into the main line: one cloud request for three ways to do it, shown on a card beside the new dot. */
  async function startMerge(tipId: string) {
    if (embedded || proposal || batch || merge) {
      flashNotice("Finish what is waiting first.");
      return;
    }
    setRewindId(null);
    settle(liveFlow);
    const tl = loadTimeline(liveFlow.id);
    const tip = tl.points.find((p) => p.id === tipId);
    const main = tipOf(tl, 0);
    if (!tip || !main || tip.line === 0) return;
    const head = tl.points.find((p) => p.id === tl.head);
    // The work becomes the main line's newest version, so the merge is drawn on top of that.
    if (head && head.line !== 0) {
      latestWork.current = main.snapshot;
      commitProp(main.snapshot);
    }
    const point = recordPoint(liveFlow.id, { kind: "merge", label: "Merging…", snapshot: main.snapshot, pending: true, merged: tip.id, after: main.id });
    setMerge({ point, tip: tip.id, busy: true, error: null, options: null });
    try {
      const options = await suggestMerges(api.cloudComplete, main.snapshot, tip.snapshot);
      setMerge((m) => (m && m.point === point ? { ...m, busy: false, options } : m));
    } catch (cause) {
      const why = (cause instanceof Error ? cause.message : String(cause)).trim() || "The cloud model did not answer.";
      setMerge((m) => (m && m.point === point ? { ...m, busy: false, error: why } : m));
    }
  }

  /** The person picked one of the three: the editor draws it as a proposal to keep or reject. */
  async function pickMerge(index: number) {
    const m = merge;
    const option = m?.options?.[index];
    if (!m || !option || m.busy) return;
    setMerge({ ...m, busy: true, error: null });
    try {
      const edit = await editFlow(api.cloudComplete, flowRef.current, option.instruction);
      setMerge({ ...m, busy: false });
      setProposal({ edit, ask: `Merge: ${option.title}`, spot: viewCentre(), line: option.summary || option.title, asked: [], merge: m.point });
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause);
      setMerge({ ...m, busy: false, error: `The cloud model could not draw that merge. ${why}` });
    }
  }

  function cancelMerge() {
    if (!merge) return;
    updateTimeline(liveFlow.id, (tl) => dropPoint(tl, merge.point));
    setMerge(null);
  }

  // A merge left pending by a session that ended is not a real point.
  useEffect(() => {
    if (!embedded) clearPendingMerges(liveFlow.id);
  }, [liveFlow.id, embedded]);
  // A point that has aged out of the strip can no longer be looked at.
  useEffect(() => {
    if (rewindId && !rewindPoint) setRewindId(null);
  });
  // Esc returns to the latest; Option+Up and Option+Down step through the points, and plain Up and Down do once you are
  // looking at an earlier one or the strip has the focus (otherwise they move the view).
  useEffect(() => {
    if (embedded || zoom) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (e.key === "Escape" && rewindId) {
        e.preventDefault();
        setRewindId(null);
        return;
      }
      if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const onStrip = Boolean(t?.closest(".flow-strip"));
      if (!rewindId && !e.altKey && !onStrip) return;
      e.preventDefault();
      stepRewind(e.key === "ArrowUp" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // Where a wire from a square was let go on empty canvas: the menu of squares to put there opens at that point.
  const [askNewAt, setAskNewAt] = useState<{ from: string; port?: string; x: number; y: number } | null>(null);
  const [askLine, setAskLine] = useState<{ from: string; port?: string; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<{ open: boolean; text: string; busy: boolean }>({ open: false, text: "", busy: false });
  // The ring, drawn once when it opens.
  const [ring, setRing] = useState<RingOpen | null>(null);
  // Several things selected at once, by dragging a box on empty canvas. One thing selected is the single selection above.
  const [multi, setMulti] = useState<{ nodes: string[]; asks: string[]; notes: string[] }>({ nodes: [], asks: [], notes: [] });
  const multiCount = multi.nodes.length + multi.asks.length + multi.notes.length;
  /** The selection box. It is moved by hand, not through React, so dragging it costs no redraws. */
  const marqueeRef = useRef<HTMLDivElement>(null);
  /**
   * A drag in progress. Cards are moved by a direct transform and their wires redrawn by hand, and the workflow is
   * changed once, when you let go. `apply` puts everything where the pointer (and the camera) now say.
   */
  const dragRef = useRef<{ at: Point; apply: (pt: Point) => void } | null>(null);
  const clearMulti = () =>
    setMulti((m) => (m.nodes.length + m.asks.length + m.notes.length === 0 ? m : { nodes: [], asks: [], notes: [] }));
  const [rewriting, setRewriting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  // A note being resized: its size follows the pointer, and only the last one is saved.
  const [noteLive, setNoteLive] = useState<{ id: string; w: number; h: number } | null>(null);
  const [containerLive, setContainerLive] = useState<{ id: string } & Partial<Omit<FlowContainer, "id">> | null>(null);

  // Every node carries its own position. One that has none yet (an older flow,
  // or one just added) is given a spot here and saved right away.
  const real = useMemo(() => ensurePositions(embedded ? flow : withStart(flow)), [flow, embedded]);
  useEffect(() => {
    if (real !== flow) commit(real, true);
  }, [real, flow, commit]);
  // What the agent proposes is drawn over the real workflow and is not saved until it is applied.
  const ghost = useMemo(() => (proposal ? ghostView(real, ensurePositions(proposal.edit.flow)) : null), [real, proposal]);
  const view = ghost?.flow ?? real;
  // Steps inside a folded container are hidden; their wires meet at the folded card instead.
  const hidden = useMemo(() => hiddenByContainers(view, { w: NODE_W, h: NODE_H }), [view]);
  // Notes folded into a shrunk notes container exist but are not drawn, selected or boxed.
  const shownNotes = useMemo(() => {
    const folded = hiddenNotes(view);
    return (view.notes ?? []).filter((n) => !folded.has(n.id));
  }, [view]);
  const boxes = useMemo(
    () =>
      view.nodes
        .filter((n) => !hidden.has(n.id))
        .map((n) => boxOf(n)),
    [view, hidden],
  );
  const boxById = useMemo(() => new Map(boxes.map((b) => [b.id, b])), [boxes]);
  const nodeById = useMemo(() => new Map(view.nodes.map((n) => [n.id, n])), [view]);
  // Wires are right-angle lines between the facing sides of two steps, as in draw.io.
  // They do not search around other steps: if one crosses a step, move the step.
  // Dragging a wire's middle segment bends it, and the bend is saved with the wire.
  const [bending, setBending] = useState<{ id: string; bend: number } | null>(null);
  const edges = useMemo(() => {
    /** Where a wire meets this step: the step itself, or the folded container that hides it. */
    const endOf = (id: string): Box | undefined => {
      const cid = hidden.get(id);
      if (!cid) return boxById.get(id);
      const c = (view.containers ?? []).find((x) => x.id === cid);
      return c ? { id: `container:${cid}`, x: c.x, y: c.y, width: COLLAPSED_SIZE.w, height: COLLAPSED_SIZE.h } : undefined;
    };
    return view.nodes.flatMap((n) =>
      n.inputs.flatMap((ref) => {
        const a = endOf(ref.node);
        const b = endOf(n.id);
        // A wire between two steps inside the same folded container has nothing to draw.
        if (!a || !b || a.id === b.id) return [];
        const id = `${ref.node}.${ref.port}->${n.id}`;
        const bend = bending?.id === id ? bending.bend : ref.bend ?? 0;
        const r = route(a, b, bend);
        return [{ id, from: ref.node, to: n.id, ref, bend, ...r, path: roundedPath(r.points) }];
      }),
    );
  }, [view, boxById, bending, hidden]);
  // A dotted line from a square to each step that uses its answer. It is drawn for you to see, not a wire.
  const nodeAsks = useMemo(() => new Map(view.nodes.map((n) => [n.id, asksOf(view, n)] as const)), [view]);
  const bindings = useMemo(() => {
    const out: Array<{ id: string; ask: string; node: string; path: string }> = [];
    for (const node of view.nodes) {
      const box = boxById.get(node.id);
      if (!box) continue;
      for (const ask of nodeAsks.get(node.id) ?? []) {
        const a = ask.pos;
        const x1 = a.x + ASK_SIZE;
        const y1 = a.y + askHeight(ask) / 2;
        const x2 = box.x;
        const y2 = box.y + box.height / 2;
        const mid = Math.max(24, Math.abs(x2 - x1) / 2);
        out.push({ id: `${ask.id}->${node.id}`, ask: ask.id, node: node.id, path: `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}` });
      }
    }
    return out;
  }, [view, boxById, nodeAsks]);
  // Wires between squares, and from squares into translators. A wire is dashed until its answer is in.
  const refStates = useMemo(() => {
    const m = new Map<string, "live" | "dead" | "pending">();
    for (const a of view.asks ?? []) for (const ref of a.inputs ?? []) m.set(`a:${a.id}:${ref.ask}:${ref.port ?? ""}`, refState(view, ref));
    for (const n of view.nodes) for (const ref of n.askInputs ?? []) m.set(`n:${n.id}:${ref.ask}:${ref.port ?? ""}`, refState(view, ref));
    return m;
  }, [view]);
  const askEdges = useMemo(() => {
    const out: Array<{ id: string; to: { ask?: string; node?: string }; ref: AskRef; path: string; state: "live" | "dead" | "pending" }> = [];
    const at = (a: FlowAsk) => a.pos;
    const asks = view.asks ?? [];
    for (const to of asks) {
      for (const ref of to.inputs ?? []) {
        const from = asks.find((a) => a.id === ref.ask);
        if (!from) continue;
        const o = portAt(from, at(from), ref.port);
        const t = at(to);
        out.push({ id: `a:${to.id}:${ref.ask}:${ref.port ?? ""}`, to: { ask: to.id }, ref, path: curve(o.x, o.y, t.x, t.y + askHeight(to) / 2), state: refStates.get(`a:${to.id}:${ref.ask}:${ref.port ?? ""}`) ?? "pending" });
      }
    }
    for (const node of view.nodes) {
      const box = node.kind === "translator" ? boxById.get(node.id) : undefined;
      if (!box) continue;
      for (const ref of node.askInputs ?? []) {
        const from = asks.find((a) => a.id === ref.ask);
        if (!from) continue;
        const o = portAt(from, at(from), ref.port);
        out.push({ id: `n:${node.id}:${ref.ask}:${ref.port ?? ""}`, to: { node: node.id }, ref, path: curve(o.x, o.y, box.x, box.y + box.height / 2), state: refStates.get(`n:${node.id}:${ref.ask}:${ref.port ?? ""}`) ?? "pending" });
      }
    }
    return out;
  }, [view, boxById, refStates]);
  // Dotted lines from notes. They are annotations: nothing reads them but the canvas.
  const noteEdges = useMemo(
    () =>
      (view.noteLinks ?? []).flatMap((link) => {
        const path = noteLinkPath(view, boxById, link, NO_OFFSET);
        return path ? [{ id: link.id, link, path }] : [];
      }),
    [view, boxById],
  );
  const linkedNotes = useMemo(
    () => new Set((view.noteLinks ?? []).flatMap((l) => [l.from, l.to]).filter((e) => e.kind === "note").map((e) => e.id)),
    [view.noteLinks],
  );
  // What a drag needs to redraw wires by hand: the wires as they stand, and the boxes they run between.
  const liveRef = useRef({ edges, askEdges, noteEdges, bindings, boxById, view });
  liveRef.current = { edges, askEdges, noteEdges, bindings, boxById, view };

  // What a step card calls, as functions that never change identity. They reach the latest handlers through a ref.
  const latestRef = useRef({ startMove, select, setZoom });
  latestRef.current = { startMove, select, setZoom };
  const nodeApi = useMemo<NodeCardApi>(
    () => ({
      down: (e, id) => latestRef.current.startMove(e, id),
      click: (id) => {
        if (!justMoved.current) latestRef.current.select(id);
      },
      open: (id) => latestRef.current.setZoom(id),
    }),
    [],
  );

  // Big workflows draw only what is near the screen (a screenful of margin on every side), so their size does not set the
  // cost of every redraw. Small ones draw everything: culling would cost more than it saves. The camera is committed
  // to React after a pause while panning, so the margin is what keeps new steps from popping in.
  const visibleBoxes = useMemo(() => {
    if (viewport.w === 0 || boxes.length < 40) return boxes;
    const m = Math.max(viewport.w, viewport.h) / cam.k;
    const x0 = -cam.x / cam.k - m;
    const x1 = (viewport.w - cam.x) / cam.k + m;
    const y0 = -cam.y / cam.k - m;
    const y1 = (viewport.h - cam.y) / cam.k + m;
    return boxes.filter((b) => b.id === selectedId || (b.x + b.width > x0 && b.x < x1 && b.y + b.height > y0 && b.y < y1));
  }, [boxes, cam, viewport, selectedId]);
  const visibleEdges = useMemo(() => {
    if (visibleBoxes.length === boxes.length) return edges;
    const ids = new Set(visibleBoxes.map((b) => b.id));
    return edges.filter((e) => ids.has(e.from) || ids.has(e.to));
  }, [edges, boxes, visibleBoxes]);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);

  const issues = useMemo(
    () =>
      // Sub-steps run in their parent's tool, so tool problems do not apply.
      flowIssues(flow).filter((i) => !embedded || (i.kind !== "no-tool" && i.kind !== "unknown-tool")),
    [flow, embedded],
  );
  const issueNodes = useMemo(() => new Set(issues.map((i) => i.node)), [issues]);
  useEffect(() => {
    if (issues.length === 0) setShowIssues(false);
  }, [issues.length]);
  // A wait finishes by itself when its limit resets, so the screen needs to notice time passing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const ready = useMemo(() => (mode === "run" ? readyNodes(flow, now) : []), [flow, mode, now]);
  const rank = new Map(ready.map((node, index) => [node.id, index + 1]));
  // Each step's state, worked out once per change. It walks the graph for every step, so it must not run on every frame.
  const nodeStates = useMemo(() => {
    const out = new Map<string, string>();
    if (mode !== "run") return out;
    for (const node of flow.nodes) {
      out.set(
        node.id,
        isSkipped(flow, node)
          ? "skipped"
          : doneOf(flow, node, now)
            ? "done"
            : node.failed && isReady(flow, node, now)
              ? "failed"
              : ready[0]?.id === node.id
                ? "ready first"
                : isReady(flow, node, now)
                  ? "ready"
                  : "blocked",
      );
    }
    return out;
  }, [flow, mode, now, ready]);
  const selected = flow.nodes.find((n) => n.id === selectedId) ?? null;
  const selectedDiff = selected ? diffList.find((n) => n.diff?.node === selected.id) : undefined;
  const work = flow.nodes.filter(isWork);
  // Not per frame: a drag redraws this many times a second, and doneOf walks the whole graph for each step.
  const doneCount = useMemo(() => flow.nodes.filter(isWork).filter((n) => doneOf(flow, n, now)).length, [flow, now]);
  const pending = useMemo(() => (mode === "run" ? pendingAsks(flow) : []), [flow, mode]);
  useEffect(() => {
    if (selectedId && !flow.nodes.some((n) => n.id === selectedId)) setSelectedId(null);
  }, [flow.nodes, selectedId]);

  useEffect(() => {
    if (panel === "tools") document.getElementById("flow-tools")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [panel]);

  function flash(key: string) {
    setCopied(key);
    window.setTimeout(() => setCopied((cur) => (cur === key ? null : cur)), 1400);
  }

  /** Put the newest node at `at`, or in the first free spot on the canvas. */
  function placeNewest(next: Flow, at?: { x: number; y: number }): Flow {
    const created = next.nodes[next.nodes.length - 1];
    const taken = next.nodes.filter((n) => n.id !== created.id && n.pos).map((n) => n.pos!);
    return moveNode(next, created.id, at ?? freeSlot(taken));
  }

  /** The kinds that can be added right now: a workflow has one Start, so it is only offered when there is none. */
  const available = (need: "input" | "output" | "any") =>
    [
      ...KINDS,
      // Saved pieces are dropped whole, so they are only offered from the + menu, never after a wire.
      ...(need === "any" && !embedded
        ? presets.map<KindOption>((p) => ({
            key: `preset-${p.id}`,
            group: "preset",
            short: p.name,
            make: (f) => f,
            hasInput: false,
            hasOutput: false,
            remove: () => deletePreset(p.id),
          }))
        : []),
    ].filter(
      (k) =>
        (k.key !== "start" || !view.nodes.some((n) => n.kind === "start")) &&
        (k.key !== "container" || !embedded) &&
        (k.key !== "note" || !embedded) &&
        (!k.key.startsWith("ask-") || !embedded) &&
        (k.key !== "translator" || !embedded) &&
        (need === "any" || (need === "input" ? k.hasInput : k.hasOutput)),
    );

  /** A free spot at the middle of what you are looking at, so a new step appears where you are. */
  function spotInView() {
    const cx = (viewport.w / 2 - cam.x) / cam.k - NODE_W / 2;
    const cy = (viewport.h / 2 - cam.y) / cam.k - NODE_H / 2;
    let at = { x: snap(cx), y: snap(cy) };
    const clash = (p: { x: number; y: number }) =>
      boxes.some((b) => Math.abs(b.x - p.x) < NODE_W + 12 && Math.abs(b.y - p.y) < NODE_H + 12);
    for (let i = 0; i < 40 && clash(at); i += 1) at = { x: at.x + snap(NODE_W + 96), y: at.y };
    return at;
  }

  /** Draw a piece (a container with everything in it) with its top-left corner at `at`, and select the new container. */
  function dropPiece(piece: Piece, at: { x: number; y: number }) {
    if (embedded || mode !== "plan") return;
    const placed = placePiece(view, piece, { x: snap(at.x), y: snap(at.y) });
    onChange(placed.flow);
    clearMulti();
    setSelectedContainer(placed.containerId);
    setSelectedId(null);
    setSelectedEdge(null);
  }

  /** A piece's top-left corner when its middle should land on `centre`. */
  const cornerFor = (piece: Piece, centre: { x: number; y: number }) => ({
    x: centre.x - (piece.container.collapsed ? COLLAPSED_SIZE.w : piece.container.w) / 2,
    y: centre.y - (piece.container.collapsed ? COLLAPSED_SIZE.h : piece.container.h) / 2,
  });

  /** The middle of what you are looking at, in the world. */
  const viewCentre = () => ({ x: (viewport.w / 2 - cam.x) / cam.k, y: (viewport.h / 2 - cam.y) / cam.k });

  /** Where the pointer is on the canvas, or the middle of the view when it is not over it. */
  const pointerOrCentre = () => (pointer.current ? canvasPoint(pointer.current) : viewCentre());

  function copyContainer(id: string) {
    const piece = capturePiece(view, id);
    if (!piece) return;
    containerClipboard = piece;
    lastCopied = "container";
    flashNotice("Copied the container with everything in it. Paste it with Cmd or Ctrl + V.");
  }

  function pasteContainer() {
    if (!containerClipboard) return;
    dropPiece(containerClipboard, cornerFor(containerClipboard, pointerOrCentre()));
  }

  /** Add a node of any kind. `at` is where its top-left corner goes (a pointed-at spot); without it, the middle of the view. */
  function addKind(option: KindOption, at?: { x: number; y: number }) {
    const spot = at ? { x: snap(at.x), y: snap(at.y) } : null;
    if (option.key.startsWith("preset-")) {
      const preset = presets.find((p) => `preset-${p.id}` === option.key);
      if (preset) dropPiece(preset.piece, spot ?? cornerFor(preset.piece, viewCentre()));
      return;
    }
    if (option.key.startsWith("ask-")) {
      const next = addAsk(
        view,
        option.key.slice(4) as AskKind,
        spot ?? {
          x: snap((viewport.w / 2 - cam.x) / cam.k - ASK_SIZE / 2),
          y: snap((viewport.h / 2 - cam.y) / cam.k - ASK_SIZE / 2),
        },
      );
      onChange(next);
      selectAsk(next.asks![next.asks!.length - 1].id);
      return;
    }
    if (option.key === "note") {
      const next = addNote(
        view,
        spot ?? {
          x: snap((viewport.w / 2 - cam.x) / cam.k - 96),
          y: snap((viewport.h / 2 - cam.y) / cam.k - 64),
        },
      );
      onChange(next);
      setSelectedNote(next.notes![next.notes!.length - 1].id);
      setSelectedId(null);
      setSelectedContainer(null);
      setSelectedEdge(null);
      return;
    }
    if (option.key === "container") {
      const w = 576;
      const h = 384;
      const next = addContainer(
        view,
        spot ?? {
          x: snap((viewport.w / 2 - cam.x) / cam.k - w / 2),
          y: snap((viewport.h / 2 - cam.y) / cam.k - h / 2),
        },
      );
      onChange(next);
      setSelectedContainer(next.containers![next.containers!.length - 1].id);
      setSelectedId(null);
      setSelectedEdge(null);
      return;
    }
    const next = placeNewest(option.make(view, flow.tools[0]?.id), spot ?? spotInView());
    onChange(next);
    setSelectedId(next.nodes[next.nodes.length - 1].id);
    setPanel("node");
  }

  /** Where a mouse event lands in the world, whatever the pan and zoom. */
  function canvasPoint(e: { clientX: number; clientY: number }) {
    const rect = scrollRef.current?.getBoundingClientRect();
    const c = camRef.current;
    return { x: (e.clientX - (rect?.left ?? 0) - c.x) / c.k, y: (e.clientY - (rect?.top ?? 0) - c.y) / c.k };
  }

  function nodeAt(x: number, y: number): string | null {
    const slack = 6;
    const hit = boxes.find(
      (b) => x >= b.x - slack && x <= b.x + b.width + slack && y >= b.y - slack && y <= b.y + b.height + slack,
    );
    return hit?.id ?? null;
  }

  /** Wire `from`'s artifact into `to`; ask which one when there is more than one. */
  function connect(from: string, to: string, at: { x: number; y: number }) {
    const source = flow.nodes.find((n) => n.id === from);
    if (!source) return;
    if (source.outputs.length > 1) {
      setPick({ from, to, ...at });
      return;
    }
    let next = flow;
    if (source.outputs.length === 0) next = addOutput(next, from, artifactLabel(source));
    const port = next.nodes.find((n) => n.id === from)?.outputs[0]?.id;
    if (port) onChange(wire(next, to, { node: from, port }));
    setSelectedId(to);
  }

  function startDrag(e: ReactPointerEvent, from: string, dir: "out" | "in" = "out") {
    e.preventDefault();
    e.stopPropagation();
    setPick(null);
    setNewAt(null);
    setNotice(null);
    const origin = canvasPoint(e);
    setDrag({ from, dir, ...origin });
    const frames = perFrame<Point>((pt) => setDrag({ from, dir, ...canvasPoint(pt) }));
    const move = (ev: PointerEvent) => frames.push({ clientX: ev.clientX, clientY: ev.clientY });
    const end = (ev: PointerEvent, drop: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      frames.cancel();
      const at = canvasPoint(ev);
      setDrag(null);
      const target = drop ? nodeAt(at.x, at.y) : null;
      if (target) {
        // Whichever circle was dragged, work out who is the source and who waits.
        const [source, waiter] = dir === "out" ? [from, target] : [target, from];
        if (source === waiter) return;
        if (canWire(flow, source, waiter)) connect(source, waiter, at);
        else flashNotice(`That would make a loop: ${nameOf(source)} already waits, directly or not, for ${nameOf(waiter)}.`);
      } else if (drop && Math.hypot(at.x - origin.x, at.y - origin.y) > 14) {
        // Dropped on empty canvas: offer to make something there, already wired.
        setNewAt({ from, dir, ...at });
      }
    };
    const up = (ev: PointerEvent) => end(ev, true);
    const cancel = (ev: PointerEvent) => end(ev, false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  const nameOf = (id: string) => {
    const n = view.nodes.find((x) => x.id === id);
    return `"${n?.text.trim() || "Untitled step"}"`;
  };

  /**
   * Ask the cloud model to polish the prompts and the readable texts of some steps. What comes back is left on the canvas
   * as one diff note per changed step, beside the step; a text changes only when its note is accepted, so the template's
   * words (and yours) are never replaced unseen.
   */
  async function polishSteps(ids: string[]) {
    if (writing) return;
    const latest = flowRef.current;
    const texts = new Map<string, PolishSource>();
    for (const node of latest.nodes) {
      if (ids.includes(node.id) && (node.kind === "agent" || node.kind === "verifier")) {
        texts.set(node.id, { prompt: basePromptText(latest, node), readable: node.readable?.trim() || node.text });
      }
    }
    if (texts.size === 0) {
      flashNotice("Nothing to polish: only agent and checker steps have prompts.");
      return;
    }
    setWriting("Polishing prompts…");
    try {
      const result = await polishPlans(latest, texts, api.cloudComplete, (p) => setWriting(describeProgress(p)));
      // The notes land on the flow as it is now. A step the model answered for and left as it was has nothing to offer, and
      // an older note for it is out of date; one the model did not answer for keeps its note.
      let next = flowRef.current;
      const stale = new Set([...texts.keys()].filter((id) => !result.missing.includes(id)));
      next = dropDiffNotes(
        next,
        diffNotes(next).filter((n) => n.diff && stale.has(n.diff.node)).map((n) => n.id),
      );
      next = leaveDiffNotes(
        next,
        [...result.rewrites].map(([node, rewrite]) => ({ node, ...rewrite })),
      );
      if (next !== flowRef.current) commit(next);
      flashNotice(describePolish(result, texts.size));
    } catch (cause) {
      flashNotice(`The prompts could not be polished. ${cause instanceof Error ? cause.message : ""}`.trim());
    } finally {
      setWriting(null);
    }
  }

  /** Accept diff notes: their texts go onto the steps as the flow is now, and the plan keeps its lock. */
  function takeDiffs(ids: string[]) {
    if (proposal) {
      flashNotice("Apply or reject the proposed changes first.");
      return;
    }
    const { flow: next, stale } = takeDiffNotes(flowRef.current, ids);
    if (next !== flowRef.current) onChange(next);
    if (stale > 0) flashNotice(`${stale} step${stale === 1 ? "" : "s"} changed after the model saw ${stale === 1 ? "it" : "them"}, so ${stale === 1 ? "its" : "their"} changed text was left as it is. Polish again.`);
  }

  /** Reject diff notes: the notes go and nothing else changes. */
  function dropDiffs(ids: string[]) {
    if (proposal) {
      flashNotice("Apply or reject the proposed changes first.");
      return;
    }
    const next = dropDiffNotes(flowRef.current, ids);
    if (next !== flowRef.current) onChange(next);
  }

  function flashNotice(text: string) {
    setNotice(text);
    window.setTimeout(() => setNotice((cur) => (cur === text ? null : cur)), 3500);
  }

  /** Make a new node that `to` waits for, dropped so its right edge sits where the wire was let go. */
  function addBefore(to: string, make: (f: Flow) => Flow, at: { x: number; y: number }) {
    if (!view.nodes.some((n) => n.id === to)) return;
    let next = make(view);
    const created = next.nodes[next.nodes.length - 1];
    if (created.outputs.length === 0) next = addOutput(next, created.id, "Output");
    const port = next.nodes.find((n) => n.id === created.id)?.outputs[0]?.id;
    if (port) next = wire(next, to, { node: created.id, port });
    next = placeNewest(next, {
      x: snap(at.x - NODE_W),
      y: snap(at.y - NODE_H / 2),
    });
    onChange(next);
    setSelectedId(created.id);
    setPanel("node");
    setNewAt(null);
  }

  /** Make a new node that waits for `from`'s artifact (creating one if it makes none yet). */
  function addAfter(from: string, make: (f: Flow) => Flow, at: { x: number; y: number }) {
    const source = view.nodes.find((n) => n.id === from);
    if (!source) return;
    let next = source.outputs.length === 0 ? addOutput(view, from, artifactLabel(source)) : view;
    next = make(next);
    const created = next.nodes[next.nodes.length - 1];
    const port = next.nodes.find((n) => n.id === from)?.outputs[0]?.id;
    if (port) next = wire(next, created.id, { node: from, port });
    // The new node's left edge, vertically centred, is exactly where the wire was let go.
    next = placeNewest(next, { x: snap(at.x), y: snap(at.y - NODE_H / 2) });
    onChange(next);
    setSelectedId(created.id);
    setPanel("node");
    setNewAt(null);
  }

  /** Jump to a step, unfolding the container that hides it. */
  function reveal(id: string) {
    const node = nodeById.get(id);
    if (!node) return;
    const cid = hidden.get(id);
    if (cid) onChange(updateContainer(view, cid, { collapsed: false }));
    select(id);
    const b = boxOf(node);
    centerOn(b.x + NODE_W / 2, b.y + NODE_H / 2);
  }

  function duplicateNode(node: FlowNode) {
    if (mode !== "plan" || node.kind === "start") return;
    const from = boxOf(node);
    const next = insertCopy(view, node, { x: snap(from.x + 40), y: snap(from.y + NODE_H + 24) });
    onChange(next);
    setSelectedId(next.nodes[next.nodes.length - 1].id);
    setSelectedContainer(null);
    setSelectedAsk(null);
    setPanel("node");
  }

  function copyNode(node: FlowNode) {
    if (node.kind === "start") return;
    nodeClipboard = node;
    lastCopied = "step";
    flashNotice("Copied this step. Paste it with Cmd or Ctrl + V.");
  }

  function duplicateSelected() {
    const node = selectedId ? nodeById.get(selectedId) : undefined;
    if (node) duplicateNode(node);
  }

  function copySelected() {
    const node = selectedId ? nodeById.get(selectedId) : undefined;
    if (node) copyNode(node);
  }

  function pasteCopied() {
    if (!nodeClipboard || mode !== "plan") return;
    const next = insertCopy(view, nodeClipboard, spotInView());
    if (next === view) return;
    onChange(next);
    setSelectedId(next.nodes[next.nodes.length - 1].id);
    setPanel("node");
  }

  // Cmd or Ctrl + C, V and D copy, paste and duplicate the selected step; + F opens Find. Text fields keep their own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A step's inside is its own canvas; this one waits while that is open.
      if (zoom || !(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "f") {
        // Find is the palette, asked for steps.
        e.preventDefault();
        studio.openPalette({ query: "go to " });
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (key === "a" && mode === "plan") {
        e.preventDefault();
        setSelectedId(null);
        setSelectedAsk(null);
        setSelectedNote(null);
        setMulti({ nodes: boxes.map((b) => b.id), asks: (view.asks ?? []).map((a) => a.id), notes: shownNotes.map((n) => n.id) });
        return;
      }
      if (key === "c") {
        if (selectedContainer && !selectedId && mode === "plan" && !embedded) copyContainer(selectedContainer);
        else copySelected();
      } else if (key === "v") {
        e.preventDefault();
        if (lastCopied === "container" && containerClipboard && !embedded) pasteContainer();
        else pasteCopied();
      } else if (key === "d") {
        e.preventDefault();
        duplicateSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Number slots. Cmd or Ctrl + Shift or Alt + 1 to 9 stores the selected container in that slot; 1 to 9 alone, with the
  // pointer over the canvas, pastes it there. Alt is offered beside Shift because macOS keeps Cmd + Shift + 3, 4 and 5 for screenshots.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (zoom || embedded || mode !== "plan" || e.repeat) return;
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (!digit) return;
      const n = Number(digit[1]);
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (!scrollRef.current?.offsetWidth) return;
      if (e.metaKey || e.ctrlKey) {
        if (!(e.shiftKey || e.altKey)) return;
        e.preventDefault();
        const box = selectedContainer && !selectedId ? (view.containers ?? []).find((c) => c.id === selectedContainer) : undefined;
        const piece = box ? capturePiece(view, box.id) : null;
        if (!box || !piece) {
          flashNotice("Select a container first, then press Cmd or Ctrl + Alt + " + n + " to store it.");
          return;
        }
        storeSlot(n, box.name || "Container", piece);
        flashNotice(`Stored "${box.name || "Container"}" in slot ${n}. Press ${n} on the canvas to paste it.`);
        return;
      }
      if (e.altKey || e.shiftKey || !pointer.current) return;
      const slot = getSlot(n);
      if (!slot) return;
      e.preventDefault();
      dropPiece(slot.piece, cornerFor(slot.piece, canvasPoint(pointer.current)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The arrow keys move the view (Shift for a bigger step), since a drag on empty canvas selects. Not while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (zoom || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (rewindId || (e.target as HTMLElement | null)?.closest?.(".flow-strip"))) return;
      const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key];
      if (!dir) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      e.preventDefault();
      const step = e.shiftKey ? 240 : 80;
      setCam((c) => ({ ...c, x: c.x - dir[0] * step, y: c.y - dir[1] * step }), "jump");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /**
   * Drag cards without redrawing the canvas. The cards you hold get a direct transform and the wires touching them are
   * redrawn by hand; the workflow itself changes once, when you let go. A press that barely moves is a click.
   * `held` is the card under the pointer: its position is snapped to the grid, and the others keep their distance from it.
   */
  function beginDrag(e: ReactPointerEvent, members: DragMember[], held: DragMember, opts: { claim: boolean; onClick: () => void }) {
    const world = worldRef.current;
    if (!world || members.length === 0) return;
    if (opts.claim) {
      e.preventDefault();
      e.stopPropagation();
    }
    const start = canvasPoint(e);
    const key = (m: DragMember) => `${m.kind}:${m.id}`;
    const moving = new Set(members.map(key));
    const els: HTMLElement[] = [];
    const pathEls = new Map<string, SVGPathElement[]>();
    const was = new Map<SVGPathElement, string>();
    const route2 = new Map<string, (off: (k: DragMember["kind"], id: string) => { dx: number; dy: number }) => string | null>();
    let went = false;
    let dx = 0;
    let dy = 0;
    const off = (kind: DragMember["kind"], id: string) => (moving.has(`${kind}:${id}`) ? { dx, dy } : { dx: 0, dy: 0 });

    // On the first real movement: find what to move, once, so nothing is searched for on later frames.
    const prepare = () => {
      for (const m of members) {
        world.querySelectorAll<HTMLElement>(`[data-drag="${cssq(key(m))}"],[data-drag-with="${cssq(key(m))}"]`).forEach((el) => els.push(el));
      }
      const L = liveRef.current;
      const asks = new Map((L.view.asks ?? []).map((a) => [a.id, a] as const));
      for (const edge of L.edges) {
        if (!moving.has(`node:${edge.from}`) && !moving.has(`node:${edge.to}`)) continue;
        route2.set(edge.id, (o) => {
          const a = L.boxById.get(edge.from);
          const b = L.boxById.get(edge.to);
          if (!a || !b) return null;
          const sa = o("node", edge.from);
          const sb = o("node", edge.to);
          return roundedPath(route({ ...a, x: a.x + sa.dx, y: a.y + sa.dy }, { ...b, x: b.x + sb.dx, y: b.y + sb.dy }, edge.bend).points);
        });
      }
      for (const edge of L.askEdges) {
        const touches =
          moving.has(`ask:${edge.ref.ask}`) || (edge.to.ask && moving.has(`ask:${edge.to.ask}`)) || (edge.to.node && moving.has(`node:${edge.to.node}`));
        if (!touches) continue;
        route2.set(edge.id, (o) => {
          const from = asks.get(edge.ref.ask);
          if (!from) return null;
          const so = o("ask", from.id);
          const out = portAt(from, { x: from.pos.x + so.dx, y: from.pos.y + so.dy }, edge.ref.port);
          if (edge.to.ask) {
            const to = asks.get(edge.to.ask);
            if (!to) return null;
            const to2 = o("ask", to.id);
            return curve(out.x, out.y, to.pos.x + to2.dx, to.pos.y + to2.dy + askHeight(to) / 2);
          }
          const box = edge.to.node ? L.boxById.get(edge.to.node) : undefined;
          if (!box || !edge.to.node) return null;
          const bo = o("node", edge.to.node);
          return curve(out.x, out.y, box.x + bo.dx, box.y + box.height / 2 + bo.dy);
        });
      }
      for (const edge of L.noteEdges) {
        const { from, to } = edge.link;
        // Containers are not moved through here, so only notes, squares and steps can be held at either end.
        if (!moving.has(`${from.kind}:${from.id}`) && !moving.has(`${to.kind}:${to.id}`)) continue;
        route2.set(edge.id, (o) => noteLinkPath(L.view, L.boxById, edge.link, o));
      }
      for (const b of L.bindings) {
        if (!moving.has(`ask:${b.ask}`) && !moving.has(`node:${b.node}`)) continue;
        route2.set(b.id, (o) => {
          const ask = asks.get(b.ask);
          const box = L.boxById.get(b.node);
          if (!ask || !box) return null;
          const so = o("ask", ask.id);
          const bo = o("node", b.node);
          const x1 = ask.pos.x + so.dx + ASK_SIZE;
          const y1 = ask.pos.y + so.dy + askHeight(ask) / 2;
          const x2 = box.x + bo.dx;
          const y2 = box.y + box.height / 2 + bo.dy;
          const mid = Math.max(24, Math.abs(x2 - x1) / 2);
          return `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`;
        });
      }
      for (const id of route2.keys()) {
        const list = [...world.querySelectorAll<SVGPathElement>(`path[data-eid="${cssq(id)}"]`)];
        pathEls.set(id, list);
        for (const el of list) was.set(el, el.getAttribute("d") ?? "");
      }
      world.classList.add("dragging");
      for (const el of els) el.classList.add("moving");
    };

    const apply = (pt: Point) => {
      const p = canvasPoint(pt);
      // Cards glide with the pointer. Snapping to the grid on every move made them step 8 pixels at a time, which
      // looked like stutter even at 60 frames a second, so they snap once, when you let go.
      dx = p.x - start.x;
      dy = p.y - start.y;
      const t = `translate(${dx}px, ${dy}px)`;
      for (const el of els) el.style.transform = t;
      for (const [id, fn] of route2) {
        const d = fn(off);
        if (d) for (const el of pathEls.get(id) ?? []) el.setAttribute("d", d);
      }
    };

    const frames = perFrame<Point>(apply);
    const move = (ev: PointerEvent) => {
      const p = canvasPoint(ev);
      if (!went && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
      if (!went) {
        went = true;
        prepare();
      }
      dragRef.current = { at: { clientX: ev.clientX, clientY: ev.clientY }, apply };
      frames.push({ clientX: ev.clientX, clientY: ev.clientY });
    };
    const finish = (ev: PointerEvent, ok: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      frames.cancel();
      dragRef.current = null;
      if (!went) {
        if (ok) opts.onClick();
        return;
      }
      if (ok) {
        apply(ev);
        // Commit now, in this event, so the cards are at their new place before the transforms come off.
        flushSync(() => {
          let next = view;
          // Land on the grid: the held card snaps, and the others keep their distance from it.
          const fx = snap(held.x + dx) - held.x;
          const fy = snap(held.y + dy) - held.y;
          for (const m of members) {
            const at = { x: m.x + fx, y: m.y + fy };
            if (m.kind === "node") next = moveNode(next, m.id, at);
            else if (m.kind === "ask") next = updateAsk(next, m.id, { pos: at });
            else if (m.kind === "stack") next = updateNoteStack(next, m.id, at);
            else next = updateNote(next, m.id, at);
          }
          onChange(next);
        });
        justMoved.current = true;
        window.setTimeout(() => (justMoved.current = false), 0);
      } else {
        for (const [el, d] of was) el.setAttribute("d", d);
      }
      for (const el of els) {
        el.style.transform = "";
        el.classList.remove("moving");
      }
      world.classList.remove("dragging");
    };
    const up = (ev: PointerEvent) => finish(ev, true);
    const cancel = (ev: PointerEvent) => finish(ev, false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  /** Drag the whole selection by whichever member you hold; a press that does not move is a click on that one. */
  function startGroup(e: ReactPointerEvent, held: { kind: DragMember["kind"]; id: string }, onClick: () => void) {
    const members: DragMember[] = [
      ...multi.nodes.flatMap((id) => {
        const b = boxById.get(id);
        return b ? [{ kind: "node" as const, id, x: b.x, y: b.y }] : [];
      }),
      ...(view.asks ?? []).filter((a) => multi.asks.includes(a.id)).map((a) => ({ kind: "ask" as const, id: a.id, x: a.pos.x, y: a.pos.y })),
      ...(view.notes ?? []).filter((n) => multi.notes.includes(n.id)).map((n) => ({ kind: "note" as const, id: n.id, x: n.x, y: n.y })),
    ];
    const grabbed = members.find((m) => m.kind === held.kind && m.id === held.id) ?? members[0];
    if (grabbed) beginDrag(e, members, grabbed, { claim: true, onClick });
  }

  /** Drag a note by its top strip. */
  function startNoteMove(e: ReactPointerEvent, note: FlowNote) {
    if (e.button !== 0) return;
    if (multiCount > 1 && multi.notes.includes(note.id)) {
      return startGroup(e, { kind: "note", id: note.id }, () => {
        clearMulti();
        setSelectedNote(note.id);
      });
    }
    clearMulti();
    setSelectedNote(note.id);
    const m: DragMember = { kind: "note", id: note.id, x: note.x, y: note.y };
    beginDrag(e, [m], m, { claim: true, onClick: () => {} });
  }

  /** Drag a notes container by its card; the notes it holds go with it, drawn or folded away. */
  function startStackMove(e: ReactPointerEvent, stack: NoteStack) {
    if (e.button !== 0) return;
    clearMulti();
    const members: DragMember[] = [
      { kind: "stack", id: stack.id, x: stack.x, y: stack.y },
      ...stackNotes(view, stack.id).map((n) => ({ kind: "note" as const, id: n.id, x: n.x, y: n.y })),
    ];
    beginDrag(e, members, members[0], { claim: true, onClick: () => {} });
  }

  /** Fold a container's notes into its card, or lay them out again on the workflow where nothing is in the way. */
  function toggleStack(stack: NoteStack) {
    if (stack.expanded === false) onChange(expandStack(view, stack.id));
    else onChange(updateNoteStack(view, stack.id, { expanded: false }));
  }

  /**
   * Drag from a note's connection point onto a step, a square, a container or another note to draw a dotted line.
   * Let go on empty canvas and nothing is made: a note line is never offered a new thing to connect to.
   */
  function startNoteWire(e: ReactPointerEvent, note: FlowNote) {
    if (e.button !== 0 || mode !== "plan") return;
    e.preventDefault();
    e.stopPropagation();
    const line = (ev: { clientX: number; clientY: number }) => ({ from: note.id, ...canvasPoint(ev) });
    setNoteLine(line(e));
    const move = (ev: PointerEvent) => setNoteLine(line(ev));
    const finish = (ev: PointerEvent, ok: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      setNoteLine(null);
      if (!ok) return;
      const p = canvasPoint(ev);
      const slack = 6;
      const inside = (x: number, y: number, w: number, h: number) =>
        p.x >= x - slack && p.x <= x + w + slack && p.y >= y - slack && p.y <= y + h + slack;
      const stepId = nodeAt(p.x, p.y);
      const ask = (view.asks ?? []).find((a) => inside(a.pos.x, a.pos.y, ASK_SIZE, ASK_SIZE));
      const other = shownNotes.find((n) => n.id !== note.id && inside(n.x, n.y, noteSize(n).w, noteSize(n).h));
      // The smallest container under the pointer, so a container inside another is reachable.
      const box = (view.containers ?? [])
        .filter((c) => inside(c.x, c.y, c.collapsed ? COLLAPSED_SIZE.w : c.w, c.collapsed ? COLLAPSED_SIZE.h : c.h))
        .sort((a, b) => a.w * a.h - b.w * b.h)[0];
      const to: NoteLinkEnd | null = stepId
        ? { kind: "node", id: stepId }
        : ask
          ? { kind: "ask", id: ask.id }
          : other
            ? { kind: "note", id: other.id }
            : box
              ? { kind: "container", id: box.id }
              : null;
      if (!to) return;
      const next = addNoteLink(view, { kind: "note", id: note.id }, to);
      if (next === view) flashNotice("Those two are already joined by a dotted line.");
      else onChange(next);
    };
    const up = (ev: PointerEvent) => finish(ev, true);
    const cancel = (ev: PointerEvent) => finish(ev, false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  /** The right edge of the agent's squares for one turn, so a box beside them never covers one of them. */
  function batchRightEdgeOf(turn: string) {
    return (view.asks ?? []).filter((a) => a.turn === turn).reduce((edge, a) => Math.max(edge, a.pos.x + ASK_SIZE), 0);
  }
  function batchRightEdge(ask: FlowAsk) {
    return ask.turn ? Math.max(ask.pos.x + ASK_SIZE, batchRightEdgeOf(ask.turn)) : ask.pos.x + ASK_SIZE;
  }

  /** The ring's Ask model: a see-through box opens right there to say one thing to the agent. */
  function openTalkAt(at: { x: number; y: number }) {
    if (embedded || zoom || talk || proposal || batch) return;
    setTalk({ x: at.x, y: at.y, text: "", busy: false, error: null });
  }

  /**
   * Send what was typed. While the agent works the box says so. Then it is gone and either two notes are left where you
   * clicked (a plain answer), or the changes the agent wants are drawn over the workflow, dashed, with one Apply and
   * one Reject for the whole turn. Nothing in the graph changes until you apply.
   */
  async function askTheAgent() {
    if (!talk || talk.busy || !talk.text.trim()) return;
    const spot = { x: snap(talk.x), y: snap(talk.y) };
    const request = talk.text.trim();
    setTalk({ ...talk, busy: true, error: null });
    setBusyRetry(null);
    try {
      // A retry after the cloud model failed reuses what the chat model already said for this same request.
      const kept = keptReply.current?.request === request ? keptReply.current.reply : null;
      const reply = kept ?? (await askAgent(api.canvasAgent, flowRef.current, request));
      keptReply.current = { request, reply };
      if (reply.change && reply.decisions.length > 0) {
        // Major decisions first: they become squares on the canvas, and the change is drawn after the last is answered.
        keptReply.current = null;
        const turn = recordTurn(flow.id, {
          ask: request,
          reply: reply.line,
          decisions: reply.decisions.map((q) => ({ question: q.question, answer: "" })),
          outcome: "asking",
          changes: [],
        });
        const placed = addPlanningSquares(flowRef.current, spot, reply.decisions, turn.id);
        commit(placed.flow);
        setBatch({ turn: turn.id, spot, request, line: reply.line, change: reply.change, busy: false, error: null });
        selectAsk(placed.ids[0]);
        flashNotice(`The agent has ${reply.decisions.length} question${reply.decisions.length === 1 ? "" : "s"}. Answer or skip each one on the canvas.`);
      } else if (reply.change) {
        let edit: FlowEdit;
        try {
          edit = await editFlow(api.cloudComplete, flowRef.current, reply.change);
        } catch (cause) {
          // Say which step failed: the words came from the chat model, the drawing comes from the cloud model.
          const why = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`The chat model understood, but the cloud model could not draw the change. ${why}`);
        }
        keptReply.current = null;
        setProposal({ edit, ask: request, spot, line: reply.line, asked: [] });
      } else {
        keptReply.current = null;
        recordTurn(flow.id, { ask: request, reply: reply.line, decisions: [], outcome: "answered", changes: [] });
        commit(leaveNotes(flowRef.current, spot, request, [{ text: reply.line }]), false, { kind: "turn", label: reply.line });
      }
      setTalk(null);
    } catch (cause) {
      const why = (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "").trim() || "The agent did not answer.";
      setTalk((t) => (t ? { ...t, busy: false, error: why } : t));
    }
  }

  /** The person answered (or skipped) one of the agent's squares: put it on the square and move on to the next open one. */
  function answerPlanSquare(askId: string, answer: DecisionAnswer) {
    const ask = (view.asks ?? []).find((a) => a.id === askId);
    if (!ask) return;
    const next = answerPlanning(view, askId, answer);
    onChange(next);
    if (ask.turn) updateTurn(flow.id, ask.turn, { decisions: batchDecisions(next, ask.turn) });
    const following = (next.asks ?? []).find((a) => a.turn === ask.turn && !isAnswered(a));
    if (following) selectAsk(following.id);
  }

  /**
   * Every square of the batch is answered or skipped. The cloud editor draws the change with the answers in its
   * instruction (a skipped one is left to it), and the usual Apply/Reject follows.
   */
  async function finishBatch(from: NonNullable<typeof batch>) {
    if (from.busy) return;
    setBatch({ ...from, busy: true, error: null });
    try {
      const base = flowRef.current;
      const state = batchOf(base, from.turn);
      let edit: FlowEdit;
      try {
        edit = await editFlow(api.cloudComplete, base, withDecisions(from.change, state.questions, state.answers));
      } catch (cause) {
        const why = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`Your answers are kept on the canvas, but the cloud model could not draw the change. ${why}`);
      }
      setBatch(null);
      setProposal({ edit, ask: from.request, spot: from.spot, decisions: state.ids, line: from.line, asked: batchDecisions(base, from.turn), turn: from.turn });
    } catch (cause) {
      const why = (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "").trim() || "The cloud model did not answer.";
      setBatch({ ...from, busy: false, error: why });
    }
  }

  // When the last square of a batch is answered, carry on. A batch whose squares were all deleted is dropped.
  useEffect(() => {
    if (!batch || batch.busy || batch.error || proposal) return;
    const state = batchOf(flow, batch.turn);
    if (state.ids.length === 0) setBatch(null);
    else if (state.done) void finishBatch(batch);
  }, [flow, batch, proposal]);

  /** Keep the proposal: the changes land as one step you can undo, with a note for each thing done. */
  function applyProposal() {
    if (!proposal) return;
    const { edit, ask, spot, decisions, line, asked, turn } = proposal;
    setProposal(null);
    const done = { ask, reply: line, decisions: asked, outcome: "applied" as const, summary: edit.summary, changes: edit.changes };
    if (turn) updateTurn(flow.id, turn, done);
    else recordTurn(flow.id, done);
    if (proposal.merge) {
      // Keeping a merge closes the branch into the merge point: it takes the result as its version.
      const point = proposal.merge;
      setMerge(null);
      commit(edit.flow, false, "none");
      updateTimeline(liveFlow.id, (tl) => patchPoint(tl, point, { pending: false, label: line, snapshot: edit.flow }));
      return;
    }
    commit(linkDecisions(leaveNotes(edit.flow, spot, ask, edit.changes.map((text, i) => ({ text, touched: edit.touched[i] }))), decisions ?? []), false, { kind: "turn", label: edit.summary || line });
  }

  /** Drop the proposal. A note says it was turned down, so the next agent does not propose it again. */
  function rejectProposal() {
    if (!proposal) return;
    const { edit, ask, spot, decisions, line, asked, turn } = proposal;
    setProposal(null);
    const done = { ask, reply: line, decisions: asked, outcome: "rejected" as const, summary: edit.summary, changes: edit.changes };
    if (turn) updateTurn(flow.id, turn, done);
    else recordTurn(flow.id, done);
    // A merge turned down leaves its three suggestions on the card, to pick another.
    if (proposal.merge) return;
    commit(linkDecisions(leaveNotes(flowRef.current, spot, ask, [{ text: `Rejected: ${edit.summary}` }]), decisions ?? []), false, { kind: "turn", label: `Rejected: ${edit.summary}` });
  }

  /** Press a square to select it; in Plan mode, drag it. */
  function startAskMove(e: ReactPointerEvent, ask: FlowAsk) {
    if (e.button !== 0) return;
    if (mode === "plan" && multiCount > 1 && multi.asks.includes(ask.id)) return startGroup(e, { kind: "ask", id: ask.id }, () => selectAsk(ask.id));
    selectAsk(ask.id);
    if (mode !== "plan") {
      e.stopPropagation();
      return;
    }
    const m: DragMember = { kind: "ask", id: ask.id, x: ask.pos.x, y: ask.pos.y };
    beginDrag(e, [m], m, { claim: true, onClick: () => {} });
  }

  function selectAsk(id: string) {
    clearMulti();
    setSelectedAsk(id);
    setSelectedId(null);
    setSelectedContainer(null);
    setSelectedEdge(null);
    setSelectedNote(null);
    setPanel("node");
  }

  /** Make a question this step has to wait for, just left of it. */
  function askBefore(node: FlowNode) {
    if (embedded) return;
    const box = boxOf(node);
    let next = addAsk(view, "input", { x: snap(box.x - ASK_SIZE - 48), y: snap(box.y) });
    const ask = next.asks![next.asks!.length - 1];
    next = updateNode(next, node.id, { asks: [...(node.asks ?? []), { ask: ask.id }] });
    onChange(next);
    selectAsk(ask.id);
  }

  /** Drag from a square's output dot onto another square, or onto a translator, to make what follows it. */
  function startAskWire(e: ReactPointerEvent, ask: FlowAsk, port?: string) {
    if (e.button !== 0 || mode !== "plan") return;
    e.preventDefault();
    e.stopPropagation();
    const line = (ev: { clientX: number; clientY: number }) => ({ from: ask.id, port, ...canvasPoint(ev) });
    setAskLine(line(e));
    const move = (ev: PointerEvent) => setAskLine(line(ev));
    const finish = (ev: PointerEvent, ok: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      setAskLine(null);
      if (!ok) return;
      const p = canvasPoint(ev);
      const slack = 6;
      const target = (view.asks ?? []).find(
        (a) => p.x >= a.pos.x - slack && p.x <= a.pos.x + ASK_SIZE + slack && p.y >= a.pos.y - slack && p.y <= a.pos.y + ASK_SIZE + slack,
      );
      if (target && target.id !== ask.id) {
        const next = wireAsk(view, target.id, { ask: ask.id, port });
        if (next === view) flashNotice("That would make a loop, or those two are already wired.");
        else onChange(next);
        return;
      }
      const id = nodeAt(p.x, p.y);
      const node = id ? nodeById.get(id) : undefined;
      if (node?.kind === "translator") onChange(wireTranslator(view, node.id, { ask: ask.id, port }));
      else if (node) flashNotice("A square connects to other squares, or to a translator, not straight to a step.");
      // Let go on empty canvas: offer the squares, and make the one you pick right there, already wired.
      else setAskNewAt({ from: ask.id, port, x: p.x, y: p.y });
    };
    const up = (ev: PointerEvent) => finish(ev, true);
    const cancel = (ev: PointerEvent) => finish(ev, false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  /** Make a square of this kind where a wire was let go, wired from the one it was dragged from. */
  function addAskAfter(kind: AskKind) {
    if (!askNewAt) return;
    const { from, port, x, y } = askNewAt;
    let next = addAsk(view, kind, { x: snap(x), y: snap(y - ASK_SIZE / 2) });
    const made = next.asks![next.asks!.length - 1];
    next = wireAsk(next, made.id, { ask: from, port });
    onChange(next);
    selectAsk(made.id);
    setAskNewAt(null);
  }

  function removeAskWire(edge: (typeof askEdges)[number]) {
    if (edge.to.ask) onChange(unwireAsk(view, edge.to.ask, edge.ref));
    else if (edge.to.node) onChange(unwireTranslator(view, edge.to.node, edge.ref));
    setSelectedAskWire(null);
  }

  /** Optional: one request that proposes a questionnaire, drawn as squares and wires you can undo. */
  async function draftQuestions() {
    if (draft.busy) return;
    setDraft({ ...draft, busy: true });
    try {
      const plan = await draftQuestionnaire(api.cloudComplete, flowRef.current, draft.text);
      const at = spotInView();
      onChange(applyQuestionnaire(flowRef.current, plan, { x: at.x, y: at.y }));
      flashNotice(`Drew ${plan.questions.length} questions. Press Cmd+Z to take them back.`);
      setDraft({ open: false, text: "", busy: false });
    } catch (cause) {
      flashNotice(`The questions could not be drafted. ${cause instanceof Error ? cause.message : ""}`.trim());
      setDraft((d) => ({ ...d, busy: false }));
    }
  }

  // ---- The ring and the palette: every action there is, for whatever you point at. ----

  /** The commands for one thing, in the order the palette lists them. Those with a slot are also in its ring. */
  function targetCommands(t: Target): Command[] {
    const out: Command[] = [];
    const plan = mode === "plan";
    const on = (id: string, name: string, slot: string, run: () => void, extra: Partial<Command> = {}) =>
      out.push({ id: `${t.kind}.${t.id ?? ""}.${id}`, name, run, target: t.kind, slot, ...extra });
    switch (t.kind) {
      case "step": {
        const node = nodeById.get(t.id ?? "");
        if (!node) return out;
        const tag = node.text.trim().slice(0, 28) || "Untitled step";
        if (!plan) {
          if (isWork(node)) on("prompt", "Copy prompt", "open", () => void copyText(nodePrompt(flow, node)).then(() => flashNotice("Prompt copied.")), { tag, short: "Prompt" });
          if (node.done) on("reopen", "Reopen this step", "reopen", () => onChange(reopen(flow, node.id)), { tag });
          return out;
        }
        if (node.kind === "agent" && !embedded) {
          on("open", node.sub?.length ? "Open inside" : "Break into sub-steps", "open", () => setZoom(node.id), { tag, short: node.sub?.length ? "Inside" : "Sub-steps" });
          on("critic", node.critic ? "Remove the critic" : "Add a critic", "critic", () => onChange(updateNode(view, node.id, { critic: node.critic ? undefined : newCritic() })), { tag, short: node.critic ? "No critic" : "Critic" });
        }
        if (node.kind !== "start") {
          on("duplicate", "Duplicate", "duplicate", () => duplicateNode(node), { tag, keys: "⌘D" });
          on("copy", "Copy", "copy", () => copyNode(node), { tag, keys: "⌘C" });
        }
        if (isWork(node) && !embedded) {
          on("askfirst", "Ask you first", "askfirst", () => askBefore(node), { tag });
          if (node.when) on("always", "Run it always", "always", () => onChange(updateNode(view, node.id, { when: undefined })), { tag });
        }
        if (node.kind === "agent" || node.kind === "verifier") on("polish", "Polish this prompt", "", () => void polishSteps([node.id]), { tag, target: undefined, slot: undefined });
        if (canRemove(view, node.id)) {
          on("delete", "Delete", "delete", () => {
            onChange(removeNode(view, node.id));
            setSelectedId(null);
          }, { tag, danger: true, keys: "⌫" });
        }
        return out;
      }
      case "ask": {
        const ask = (view.asks ?? []).find((a) => a.id === t.id);
        if (!ask) return out;
        const tag = (ask.title || "Question").slice(0, 28);
        if (plan) {
          if (ask.kind !== "constant") on("optional", ask.optional ? "Make it required" : "Let me skip it", "main", () => onChange(updateAsk(view, ask.id, { optional: !ask.optional })), { tag, short: ask.optional ? "Required" : "Skippable" });
          on("delete", "Delete the question", "delete", () => onChange(removeAsk(view, ask.id)), { tag, short: "Delete", danger: true, keys: "⌫" });
        } else on("answer", "Open to answer", "main", () => selectAsk(ask.id), { tag, short: "Answer" });
        return out;
      }
      case "wire": {
        const edge = edges.find((x) => x.id === t.id);
        if (!edge || !plan) return out;
        on("straighten", "Straighten this wire", "main", () => onChange(setBend(view, edge.to, edge.ref, 0)), { short: "Straighten" });
        on("delete", "Remove this wire", "delete", () => onChange(unwire(view, edge.to, edge.ref)), { short: "Delete", danger: true, keys: "⌫" });
        return out;
      }
      case "askwire": {
        const edge = askEdges.find((x) => x.id === t.id);
        if (!edge || !plan) return out;
        on("delete", "Remove this wire", "delete", () => removeAskWire(edge), { short: "Delete", danger: true, keys: "⌫" });
        return out;
      }
      case "notelink": {
        if (!plan || !(view.noteLinks ?? []).some((l) => l.id === t.id)) return out;
        on("delete", "Remove this dotted line", "delete", () => onChange(removeNoteLink(view, t.id!)), { short: "Delete", danger: true, keys: "⌫" });
        return out;
      }
      case "note": {
        const note = (view.notes ?? []).find((n) => n.id === t.id);
        if (!note) return out;
        const tag = note.text.trim().slice(0, 28) || "Note";
        if (note.diff) {
          const step = `Polished: ${note.text.trim().slice(0, 18) || "step"}`;
          on("accept", "Accept the polished text", "main", () => takeDiffs([note.id]), { tag: step, short: "Accept" });
          on("reject", "Reject the polished text", "delete", () => dropDiffs([note.id]), { tag: step, short: "Reject", danger: true, keys: "⌫" });
          return out;
        }
        on("colour", "Change colour", "main", () => onChange(updateNote(view, note.id, { color: NOTE_COLORS[((NOTE_COLORS as readonly string[]).indexOf(note.color) + 1) % NOTE_COLORS.length] })), { tag, short: "Colour" });
        on("delete", "Delete the note", "delete", () => onChange(removeNote(view, note.id)), { tag, short: "Delete", danger: true, keys: "⌫" });
        return out;
      }
      case "container": {
        const c = (view.containers ?? []).find((x) => x.id === t.id);
        if (!c) return out;
        const tag = c.name || "Container";
        on("fold", c.collapsed ? "Show the steps inside" : "Fold the steps inside", "main", () => onChange(updateContainer(view, c.id, { collapsed: !c.collapsed })), { tag, short: c.collapsed ? "Unfold" : "Fold" });
        if (!embedded) {
          on("preset", "Save as preset…", "preset", () => setNaming({ x: t.at.x, y: t.at.y, container: c.id, name: c.name }), { tag, short: "Save piece" });
          on("copy", "Copy with everything inside", "copy", () => copyContainer(c.id), { tag, short: "Copy", keys: "⌘C" });
        }
        on("delete", "Delete the container", "delete", () => onChange(removeContainer(view, c.id)), { tag, short: "Delete", danger: true, keys: "⌫" });
        return out;
      }
      case "stack": {
        const stack = (view.noteStacks ?? []).find((x) => x.id === t.id);
        if (!stack) return out;
        const open = stack.expanded !== false;
        const tag = stack.title.slice(0, 28);
        on("toggle", open ? "Shrink into the card" : "Expand on the workflow", "main", () => toggleStack(stack), { tag, short: open ? "Shrink" : "Expand" });
        on("inside", "Open inside", "inside", () => setZoom(`stack:${stack.id}`), { tag });
        on("delete", "Delete the notes", "delete", () => onChange(removeNoteStack(view, stack.id)), { tag, short: "Delete", danger: true });
        return out;
      }
      case "dot": {
        const p = timeline.points.find((x) => x.id === t.id);
        if (!p) return out;
        const tag = p.label.slice(0, 28);
        if (p.id !== (rewindId ?? timeline.head)) on("rewind", "Rewind here", "main", () => rewindTo(p.id), { tag, short: "Rewind", keys: "⌥↑ ⌥↓" });
        else if (rewindId) on("latest", "Back to the latest", "main", () => rewindTo(null), { tag, short: "Latest", keys: "Esc" });
        if (branchTips(timeline).some((b) => b.id === p.id)) on("merge", "Merge into main", "merge", () => void startMerge(p.id), { tag });
        if (p.kind === "question" || p.kind === "turn") {
          on("copy", p.kind === "question" ? "Copy question" : "Copy note", "copy", () => void copyText(p.answer ? `${p.label}\n${p.answer}` : p.label).then(() => flashNotice("Copied.")), { tag, short: "Copy" });
        }
        return out;
      }
      case "canvas": {
        const at = t.at;
        const spot = { x: snap(at.x), y: snap(at.y) };
        if (!embedded && !talk && !proposal && !batch) out.push({ id: "canvas.ask", name: "Ask model", run: () => openTalkAt(at), target: "canvas", keys: "double-click" });
        if (plan) {
          out.push(...addCommands(spot));
          out.push(...pasteCommands(spot));
        }
        return out;
      }
      default:
        return out;
    }
  }

  /** One command per kind that can be added. With a spot they add there (as the canvas dial does); without, in the middle of the view. */
  function addCommands(spot: { x: number; y: number } | undefined): Command[] {
    const nameOf2 = (k: KindOption) => {
      if (k.key === "step") return "Add a step";
      if (k.key === "ask-input") return "Add a question";
      if (k.key === "note") return "Add a note";
      if (k.key === "container") return "Add a container";
      if (k.key === "translator") return "Add a translator";
      if (k.group === "checks") return `Add a check: ${k.short}`;
      if (k.group === "pauses") return `Add a pause: ${k.short}`;
      if (k.group === "ask") return `Add a question: ${k.short}`;
      if (k.group === "preset") return `Drop piece: ${k.short}`;
      return `Add ${k.short}`;
    };
    const out: Command[] = [];
    for (const k of available("any")) {
      out.push({ id: `add.${k.key}`, name: nameOf2(k), run: () => addKind(k, spot), keywords: "add new create" });
    }
    for (const p of presets) out.push({ id: `piece.delete.${p.id}`, name: `Delete saved piece: ${p.name}`, run: () => deletePreset(p.id), danger: true });
    return out;
  }

  /** Paste what was copied last, at a spot, or where you are looking. */
  function pasteCommands(spot: { x: number; y: number } | undefined): Command[] {
    if (mode !== "plan") return [];
    const step: Command | null = nodeClipboard
      ? {
          id: "paste.step",
          name: "Paste the copied step",
          run: () => {
            const clip = nodeClipboard;
            if (!clip) return;
            const next = insertCopy(view, clip, spot ?? spotInView());
            if (next === view) return;
            onChange(next);
            select(next.nodes[next.nodes.length - 1].id);
          },
          keys: "⌘V",
        }
      : null;
    const piece: Command | null =
      containerClipboard && !embedded
        ? { id: "paste.container", name: "Paste the copied container", run: () => (spot ? dropPiece(containerClipboard!, spot) : pasteContainer()), keys: "⌘V" }
        : null;
    const first = lastCopied === "container" ? [piece, step] : [step, piece];
    return first.flatMap((c) => (c ? [c] : []));
  }

  /** The actions that belong to no one thing: every button the toolbars used to hold, and a way to every step. */
  function globalCommands(): Command[] {
    const out: Command[] = [];
    const plan = mode === "plan";
    const g = (id: string, name: string, run: () => void, extra: Partial<Command> = {}) => out.push({ id, name, run, ...extra });
    if (embedded) g("global.back", "Back to the workflow", onBack);
    if (!embedded) {
      g("global.mode", plan ? "Switch to Run mode" : "Switch to Plan mode", () => setMode(plan ? "run" : "plan"), { keywords: "plan run mode" });
      if (plan && flow.nodes.length > 0) {
        g("global.lock", flow.locked ? "Unlock the plan" : "Lock the plan", () => {
          if (flow.locked) {
            onChange({ ...flow, locked: false, updatedAt: Date.now() });
            setLockOffer(false);
            flashNotice("Plan unlocked.");
            return;
          }
          const next = lock(flow);
          if (next) {
            onChange(next);
            setNotice(null);
            setLockOffer(true);
          } else {
            setShowIssues(true);
            setPanel("node");
            flashNotice(`Can't lock yet: fix the issue${issues.length === 1 ? "" : "s"} listed first.`);
          }
        }, { keywords: "freeze finish unlock" });
      }
      if (plan && issues.length > 0) g("global.issues", showIssues ? "Hide the issues" : `Show the issues (${issues.length})`, () => setShowIssues((v) => !v), { keywords: "problems errors" });
      if (plan && !writing && flow.nodes.some((n) => n.kind === "agent" || n.kind === "verifier")) {
        g("global.polish", "Polish prompts", () => void polishSteps(flow.nodes.map((n) => n.id)), { keywords: "write prompts reword cloud" });
      }
      if (plan) g("global.draft", "Draft questions with AI…", () => setDraft((d) => ({ ...d, open: true })), { keywords: "questionnaire squares" });
      g("global.history", "History", () => setHistoryOpen((v) => !v), { keywords: "turns asked agent" });
      g("global.tools", panel === "tools" ? "Close the tools panel" : "Open the tools panel", () => setPanel(panel === "tools" ? "node" : "tools"), { keywords: "tools models limits" });
    }
    if (!embedded && timeline.points.length > 0) {
      g("global.rewind", "Rewind one point", () => stepRewind(-1), { keys: "⌥↑", keywords: "history strip back earlier undo version" });
      if (rewindId) {
        g("global.forward", "Forward one point", () => stepRewind(1), { keys: "⌥↓", keywords: "history strip later" });
        g("global.latest", "Back to the latest version", () => rewindTo(null), { keys: "Esc", keywords: "history strip return" });
      }
      for (const tip of branchTips(timeline)) g(`global.merge.${tip.id}`, `Merge a branch into main: ${tip.label.slice(0, 40)}`, () => void startMerge(tip.id), { keywords: "history strip branch alternative" });
    }
    g("global.zoom-in", "Zoom in", () => zoomBy(1.25), { keywords: "closer bigger" });
    g("global.zoom-out", "Zoom out", () => zoomBy(1 / 1.25), { keywords: "farther smaller" });
    g("global.zoom-reset", `Reset zoom to 100% (now ${Math.round(cam.k * 100)}%)`, () => zoomBy(1 / cam.k));
    g("global.fit", "Show everything", fit, { keywords: "fit zoom all" });
    if (plan) {
      g("global.select-all", "Select everything", () => {
        setSelectedId(null);
        setSelectedAsk(null);
        setSelectedNote(null);
        setMulti({ nodes: boxes.map((b) => b.id), asks: (view.asks ?? []).map((a) => a.id), notes: shownNotes.map((n) => n.id) });
      }, { keys: "⌘A" });
      out.push(...addCommands(undefined));
      out.push(...pasteCommands(undefined));
    }
    if (diffList.length > 0 && !embedded) {
      g("global.accept-rewrites", `Accept all ${diffList.length} polished steps`, () => takeDiffs(diffList.map((n) => n.id)));
      g("global.reject-rewrites", "Reject all polished steps", () => dropDiffs(diffList.map((n) => n.id)));
    }
    if (proposal) {
      g("global.apply", "Apply the proposed changes", applyProposal);
      g("global.reject", "Reject the proposed changes", rejectProposal);
    }
    if (mode === "run") {
      for (const ask of pending) g(`global.answer.${ask.id}`, `Answer: ${ask.title || "A question"}`, () => selectAsk(ask.id), { keywords: "question square" });
      if (ready[0]) g("global.next", "Go to the next ready step", () => select(ready[0].id), { keywords: "ready" });
    }
    for (const n of view.nodes) {
      if (n.kind === "start" && view.nodes.length > 1) continue;
      g(`goto.${n.id}`, `Go to ${n.text.trim() || "Untitled step"}`, () => reveal(n.id), { tag: toolName(n), keywords: "find step jump" });
    }
    return out;
  }

  /** The thing the palette is about when it is opened without one: what is selected, else the canvas. */
  function selectionTarget(): Target {
    const at = viewCentre();
    if (selectedId) return { kind: "step", id: selectedId, at };
    if (selectedAsk) return { kind: "ask", id: selectedAsk, at };
    if (selectedNote) return { kind: "note", id: selectedNote, at };
    if (selectedContainer) return { kind: "container", id: selectedContainer, at };
    if (selectedEdge) return { kind: "wire", id: selectedEdge, at };
    if (selectedAskWire) return { kind: "askwire", id: selectedAskWire, at };
    if (selectedNoteLink) return { kind: "notelink", id: selectedNoteLink, at };
    return { kind: "canvas", at };
  }

  /** What the palette lists for this canvas. With a target it also says what the list is for and holds only that target's actions first. */
  const commandSource: CommandSource = (target) => {
    const t = target ?? selectionTarget();
    const mine = targetCommands(t);
    const globals = globalCommands();
    const commands = dedupe([...mine, ...globals]);
    // The path to each command through the ring that would open on this thing.
    const paths = ringPaths(ringTree(mine, dedupe([...commands, ...studio.studioCommands()]), t.kind));
    if (!target) return { commands, paths };
    const named =
      target.kind === "step" ? nodeById.get(target.id ?? "")?.text.trim() :
      target.kind === "ask" ? (view.asks ?? []).find((a) => a.id === target.id)?.title :
      target.kind === "note" ? (view.notes ?? []).find((n) => n.id === target.id)?.text.trim() :
      target.kind === "container" ? (view.containers ?? []).find((c) => c.id === target.id)?.name :
      target.kind === "stack" ? (view.noteStacks ?? []).find((st) => st.id === target.id)?.title : "";
    const label = named ? `${TARGET_LABEL[target.kind]} · ${named.slice(0, 32)}` : TARGET_LABEL[target.kind];
    return { commands, paths, scope: { label, commands: dedupe([...mine, ...(target.kind === "canvas" ? globals.filter((c) => !c.id.startsWith("goto.")) : [])]) } };
  };
  if (!zoom) studio.source.current = commandSource;

  /** What was pressed, from the element under the pointer: the kind of thing and which one. */
  function targetOf(el: Element, at: Point): Target {
    const world = canvasPoint(at);
    const hit = el.closest<HTMLElement>("[data-target]")?.dataset.target;
    if (hit) {
      const i = hit.indexOf(":");
      return { kind: hit.slice(0, i) as TargetKind, id: hit.slice(i + 1), at: world };
    }
    return { kind: "canvas", at: world };
  }

  /** Pressing or pointing at something selects it, as a click would, so the palette and the panels agree with the ring. */
  function selectTarget(t: Target) {
    if (!t.id) return;
    if (t.kind === "step") select(t.id);
    else if (t.kind === "ask") selectAsk(t.id);
    else if (t.kind === "note") setSelectedNote(t.id);
    else if (t.kind === "container") {
      clearMulti();
      setSelectedContainer(t.id);
      setSelectedId(null);
      setSelectedEdge(null);
    } else if (t.kind === "wire") {
      setSelectedId(null);
      setSelectedEdge(t.id);
    } else if (t.kind === "askwire") {
      setSelectedId(null);
      setSelectedEdge(null);
      setSelectedAsk(null);
      setSelectedAskWire(t.id);
    } else if (t.kind === "notelink") setSelectedNoteLink(t.id);
  }

  function ringFor(t: Target) {
    const mine = targetCommands(t);
    return ringTree(mine, dedupe([...mine, ...globalCommands(), ...studio.studioCommands()]), t.kind, () => studio.openPalette());
  }

  /** A press on the canvas that may become a ring: a right-button press, or a left-button press held still. */
  function beginRing(e: ReactPointerEvent, forced?: Target) {
    if (e.button !== 0 && e.button !== 2) return;
    const el = e.target as HTMLElement;
    if (el.closest(".flow-talk, .flow-pick, .flow-ring, .flow-minimap, .flow-proposal")) return;
    if (
      e.button === 0 &&
      el.closest("input, textarea, select, button.flow-pick-backdrop, .flow-handle, .flow-note-port, .flow-note-resize, .flow-container-resize, .flow-bend, .flow-note-button, .flow-container-fold, .flow-stack-buttons, [contenteditable]")
    ) {
      return;
    }
    const target = forced ?? targetOf(el, e);
    startPress({
      button: e.button,
      clientX: e.clientX,
      clientY: e.clientY,
      pointerId: e.pointerId,
      frame: () => scrollRef.current?.getBoundingClientRect() ?? null,
      prepare: () => {
        selectTarget(target);
        return ringFor(target);
      },
      show: (r) => flushSync(() => setRing(r)),
      // The hold wins: whatever else the press had begun (a drag, a box) lets go, so moving to a slice cannot move anything.
      onHold: () => window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true })),
    });
  }

  /** Double-click on empty canvas: a ring that stays open until a click or Esc. */
  function ringOnDoubleClick(e: ReactMouseEvent) {
    if (zoom || ring) return;
    const el = e.target as HTMLElement;
    if (el.closest("[data-target], .flow-node, .flow-note, .flow-stack, .flow-ask, .flow-handle, .flow-talk, .flow-ring, .flow-pick, input, textarea, button, select")) return;
    const rect = scrollRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dial = ringFor({ kind: "canvas", at: canvasPoint(e) });
    if (dial.slices.length > 0) setRing(placeRing(rect, e.clientX, e.clientY, dial, null));
  }

  useEffect(() => {
    if (!askNewAt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAskNewAt(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [askNewAt]);

  /** Optional: one request that rewrites the retry prompt of a failed step around its error. */
  async function rewriteRetry(nodeId: string) {
    const node = flowRef.current.nodes.find((n) => n.id === nodeId);
    if (!node?.failed || rewriting) return;
    setRewriting(true);
    try {
      const text = await rewriteRetryPrompt(api.cloudComplete, flowRef.current, node);
      onChange(setRetry(flowRef.current, nodeId, text), true);
      flashNotice("The retry prompt was rewritten. Read it before you copy it.");
    } catch (cause) {
      flashNotice(`The retry could not be rewritten. ${cause instanceof Error ? cause.message : ""}`.trim());
    } finally {
      setRewriting(false);
    }
  }

  /** Optional: one request that proposes sub-steps for a step; the person edits them inside. */
  async function suggestInside(nodeId: string) {
    const node = flowRef.current.nodes.find((n) => n.id === nodeId);
    if (!node || suggesting) return;
    setSuggesting(true);
    try {
      const parts = await suggestSubSteps(api.cloudComplete, flowRef.current, node);
      onChange(setSubSteps(flowRef.current, nodeId, parts));
      flashNotice(`Added ${parts.length} sub-steps. Open inside to change them.`);
    } catch (cause) {
      flashNotice(`Sub-steps could not be suggested. ${cause instanceof Error ? cause.message : ""}`.trim());
    } finally {
      setSuggesting(false);
    }
  }

  const NEW_MENU = { width: 190, height: 6 * 30 + 36 };
  const pickHeight = (pick?.from ? (flow.nodes.find((n) => n.id === pick.from)?.outputs.length ?? 1) : 1) * 30 + 36;

  /**
   * A popup opens where the mouse was let go, at a constant size whatever the zoom. Near the right or
   * bottom edge it opens leftwards or upwards from that point instead of being cut off.
   */
  function menuAt(wx: number, wy: number, width: number, height: number) {
    const sx = wx * cam.k + cam.x;
    const sy = wy * cam.k + cam.y;
    return {
      left: Math.max(8, sx + width + 8 > viewport.w ? sx - width : sx),
      top: Math.max(8, sy + height + 8 > viewport.h ? sy - height : sy),
    };
  }

  // Backspace or Delete removes the selected wire or step. Undo (Cmd+Z) brings it back.
  // Ignored while typing in a field, and while this canvas is covered by the inside of a step.
  useEffect(() => {
    if (mode !== "plan" || zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Backspace" && e.key !== "Delete") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (multiCount > 1) {
        e.preventDefault();
        let next = view;
        let kept = 0;
        for (const id of multi.nodes) {
          if (canRemove(next, id)) next = removeNode(next, id);
          else kept += 1;
        }
        for (const id of multi.asks) next = removeAsk(next, id);
        for (const id of multi.notes) next = removeNote(next, id);
        onChange(next);
        clearMulti();
        flashNotice(`Removed ${multiCount - kept} things${kept ? ` (the Start stays)` : ""}. Press Cmd+Z to undo.`);
        return;
      }
      if (selectedNoteLink && (view.noteLinks ?? []).some((l) => l.id === selectedNoteLink)) {
        e.preventDefault();
        onChange(removeNoteLink(view, selectedNoteLink));
        setSelectedNoteLink(null);
        flashNotice("Dotted line removed. Press Cmd+Z to undo.");
        return;
      }
      const askWire = askEdges.find((x) => x.id === selectedAskWire);
      if (askWire) {
        e.preventDefault();
        removeAskWire(askWire);
        flashNotice("Wire removed. Press Cmd+Z to undo.");
        return;
      }
      const edge = edges.find((x) => x.id === selectedEdge);
      if (edge) {
        e.preventDefault();
        onChange(unwire(view, edge.to, edge.ref));
        setSelectedEdge(null);
        flashNotice("Wire removed. Press Cmd+Z to undo.");
      } else if (selectedAsk && !selectedId) {
        e.preventDefault();
        onChange(removeAsk(view, selectedAsk));
        setSelectedAsk(null);
        flashNotice("Question removed. Press Cmd+Z to undo.");
      } else if (selectedNote && !selectedId) {
        e.preventDefault();
        onChange(removeNote(view, selectedNote));
        setSelectedNote(null);
        flashNotice("Note removed. Press Cmd+Z to undo.");
      } else if (selectedContainer && !selectedId) {
        e.preventDefault();
        onChange(removeContainer(view, selectedContainer));
        setSelectedContainer(null);
        flashNotice("Container removed. Press Cmd+Z to undo.");
      } else if (selectedId) {
        const node = view.nodes.find((n) => n.id === selectedId);
        if (!node) return;
        e.preventDefault();
        if (!canRemove(view, selectedId)) {
          flashNotice("A workflow always has its Start, so this one stays.");
          return;
        }
        onChange(removeNode(view, selectedId));
        setSelectedId(null);
        flashNotice(`Removed ${nameOf(selectedId)}. Press Cmd+Z to undo.`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The grid is drawn from the camera: thin lines with thicker ones every fourth line, three
  // scales at once. Zooming out turns the thick lines into the thin ones, and a coarser set
  // takes over as the thick ones. Each scale is its own layer, a little bigger than the screen,
  // that is only shifted as the camera pans, so panning moves it without repainting it.
  // All three scales are drawn into one tile the size of the coarsest spacing. Separate layers each rounded their own
  // fractional tile size, so their lines drifted apart and showed as doubled lines.
  const gridLayerList = useMemo(() => {
    const layers = gridLayers(cam.k);
    const size = layers[layers.length - 1].spacing;
    const rects: string[] = [];
    for (const l of layers) {
      if (l.alpha <= 0.004) continue;
      const a = l.alpha.toFixed(3);
      for (let at = 0; at < size - 0.01; at += l.spacing) {
        const p = at.toFixed(3);
        rects.push(`<rect x="${p}" y="0" width="${l.width}" height="${size}" fill-opacity="${a}"/>`);
        rects.push(`<rect x="0" y="${p}" width="${size}" height="${l.width}" fill-opacity="${a}"/>`);
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${rects.join("")}</svg>`;
    return [{ spacing: size, image: `url("data:image/svg+xml,${encodeURIComponent(svg)}")` }];
  }, [cam.k]);

  /** The dashed wire stays on screen while the new-node menu is open, ending where the mouse was let go. */
  const line = drag ?? newAt;

  const dragOver = drag ? nodeAt(drag.x, drag.y) : null;

  /** Drag a step anywhere; a press that barely moves is a plain click. */
  function startMove(e: ReactPointerEvent, id: string) {
    if (mode !== "plan" || e.button !== 0) return;
    const box = boxById.get(id);
    if (!box) return;
    if (multiCount > 1 && multi.nodes.includes(id)) return startGroup(e, { kind: "node", id }, () => select(id));
    const m: DragMember = { kind: "node", id, x: box.x, y: box.y };
    // The step is a button, so pressing it is left alone: it can still be clicked.
    beginDrag(e, [m], m, { claim: false, onClick: () => {} });
  }

  // If you zoom or pan while holding a card, the pointer has not moved but the world under it has: put the card back under it.
  useEffect(() => {
    const d = dragRef.current;
    if (d) d.apply(d.at);
  }, [cam]);

  /** Zoom by `factor`, keeping the point under (px, py) on screen where it is. */
  function zoomBy(factor: number, px = viewport.w / 2, py = viewport.h / 2) {
    setCam((c) => {
      const k = Math.min(3, Math.max(0.1, c.k * factor));
      if (k === c.k) return c;
      const r = k / c.k;
      return { k, x: px - (px - c.x) * r, y: py - (py - c.y) * r };
    });
  }

  // Two-finger scrolling on a touchpad (or a mouse wheel) pans the canvas. Pinching zooms, and so
  // does holding Cmd or Ctrl while scrolling. A touchpad pinch arrives as a wheel event with Ctrl set
  // in most browsers, but as separate gesture events in Safari, which the app's window is built on,
  // so both are handled. The listeners are added by hand because React's are passive and cannot
  // stop the page itself from scrolling or zooming.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Anything on the canvas that scrolls inside itself (a long note, the agent's proposal, an answer box) scrolls
      // first; at its top or bottom the wheel goes back to panning the canvas.
      if (!(e.ctrlKey || e.metaKey)) {
        let box: HTMLElement | null = e.target as HTMLElement | null;
        while (box && box !== el) {
          const overflowY = getComputedStyle(box).overflowY;
          if ((overflowY === "auto" || overflowY === "scroll") && box.scrollHeight > box.clientHeight + 1) {
            const atTop = box.scrollTop <= 0 && e.deltaY < 0;
            const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 1 && e.deltaY > 0;
            if (!atTop && !atEnd) return;
            break;
          }
          box = box.parentElement;
        }
      }
      e.preventDefault();
      // A mouse wheel reports lines, not pixels, and moves the page very little; scale it to feel like a touchpad.
      const unit = e.deltaMode === 1 ? 24 : e.deltaMode === 2 ? el.clientHeight : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      // Shift with a plain wheel moves sideways.
      if (e.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
      } else {
        setCam((c) => ({ ...c, x: c.x - dx, y: c.y - dy }), "pan");
      }
    };
    type PinchEvent = Event & { scale: number; clientX: number; clientY: number };
    let last = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      last = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as PinchEvent;
      const rect = el.getBoundingClientRect();
      zoomBy(g.scale / last, g.clientX - rect.left, g.clientY - rect.top);
      last = g.scale;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  });

  /** Drag empty canvas to pan (Run mode, or the middle button anywhere); a press that does not move just deselects. */
  function startHandPan(e: ReactPointerEvent) {
    if (e.target !== e.currentTarget || (e.button !== 0 && e.button !== 1)) return;
    const start = { x: e.clientX, y: e.clientY, cx: camRef.current.x, cy: camRef.current.y };
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 3) moved = true;
      setCam((c) => ({ ...c, x: start.cx + ev.clientX - start.x, y: start.cy + ev.clientY - start.y }), "pan");
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      commitCam();
      if (!moved) {
        setSelectedId(null);
        setSelectedEdge(null);
        setSelectedContainer(null);
        setSelectedAsk(null);
        setSelectedNote(null);
        setSelectedAskWire(null);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  /**
   * Drag on empty canvas to box-select what the box touches: steps, squares and notes. Shift, Cmd or Ctrl adds to what is
   * already selected. A press that does not move deselects. In Run mode there is nothing to select, so it pans.
   */
  function startPan(e: ReactPointerEvent) {
    if (e.target !== e.currentTarget) return;
    if (mode !== "plan" || e.button === 1) return startHandPan(e);
    if (e.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    let moved = false;
    const box = (ev: PointerEvent) => ({ x1: sx, y1: sy, x2: ev.clientX - rect.left, y2: ev.clientY - rect.top });
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      moved = true;
      const m = marqueeRef.current;
      if (m) {
        const r = box(ev);
        m.style.display = "block";
        m.style.left = `${Math.min(r.x1, r.x2)}px`;
        m.style.top = `${Math.min(r.y1, r.y2)}px`;
        m.style.width = `${Math.abs(r.x2 - r.x1)}px`;
        m.style.height = `${Math.abs(r.y2 - r.y1)}px`;
      }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (marqueeRef.current) marqueeRef.current.style.display = "none";
      if (!moved) {
        setSelectedId(null);
        setSelectedEdge(null);
        setSelectedContainer(null);
        setSelectedAsk(null);
        setSelectedNote(null);
        setSelectedAskWire(null);
        clearMulti();
        return;
      }
      const r = box(ev);
      const c = camRef.current;
      const x0 = (Math.min(r.x1, r.x2) - c.x) / c.k;
      const x1 = (Math.max(r.x1, r.x2) - c.x) / c.k;
      const y0 = (Math.min(r.y1, r.y2) - c.y) / c.k;
      const y1 = (Math.max(r.y1, r.y2) - c.y) / c.k;
      const touches = (x: number, y: number, w: number, h: number) => x < x1 && x + w > x0 && y < y1 && y + h > y0;
      const picked = {
        nodes: boxes.filter((b) => touches(b.x, b.y, b.width, b.height)).map((b) => b.id),
        asks: (view.asks ?? []).filter((a) => touches(a.pos.x, a.pos.y, ASK_SIZE, ASK_SIZE)).map((a) => a.id),
        // A note's height depends on its text; this is its smallest.
        notes: shownNotes.filter((n) => touches(n.x, n.y, noteSize(n).w, noteSize(n).h)).map((n) => n.id),
      };
      const keep = additive
        ? {
            nodes: [...multi.nodes, ...(selectedId ? [selectedId] : [])],
            asks: [...multi.asks, ...(selectedAsk ? [selectedAsk] : [])],
            notes: [...multi.notes, ...(selectedNote ? [selectedNote] : [])],
          }
        : { nodes: [], asks: [], notes: [] };
      const all = {
        nodes: [...new Set([...keep.nodes, ...picked.nodes])],
        asks: [...new Set([...keep.asks, ...picked.asks])],
        notes: [...new Set([...keep.notes, ...picked.notes])],
      };
      setSelectedEdge(null);
      setSelectedContainer(null);
      setSelectedAskWire(null);
      if (all.nodes.length + all.asks.length + all.notes.length <= 1) {
        // Nothing, or exactly one thing: the ordinary selection, with its panel.
        clearMulti();
        setSelectedId(all.nodes[0] ?? null);
        setSelectedAsk(all.asks[0] ?? null);
        setSelectedNote(all.notes[0] ?? null);
        if (all.nodes[0] || all.asks[0]) setPanel("node");
        return;
      }
      setSelectedId(null);
      setSelectedAsk(null);
      setSelectedNote(null);
      setMulti(all);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  /** Put the world point (wx, wy) in the middle of the screen, keeping the zoom. */
  function centerOn(wx: number, wy: number) {
    setCam((c) => ({ ...c, x: viewport.w / 2 - wx * c.k, y: viewport.h / 2 - wy * c.k }));
  }

  /** Frame everything: at 100% from the top left when it fits, otherwise zoomed out to fit. */
  function fit() {
    if (boxes.length === 0 || viewport.w === 0) return;
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const bw = Math.max(...boxes.map((b) => b.x + b.width)) - minX;
    const bh = Math.max(...boxes.map((b) => b.y + b.height)) - minY;
    const k = Math.max(0.1, Math.min(1, (viewport.w - 120) / bw, (viewport.h - 120) / bh));
    if (k >= 1) setCam({ k: 1, x: PAD_L - minX, y: PAD_T - minY });
    // Zoomed out to fit: centred across, but kept near the top so it reads like the full-size view.
    else setCam({ k, x: (viewport.w - bw * k) / 2 - minX * k, y: PAD_T - minY * k });
  }

  // Frame the workflow once, the first time the canvas has a size.
  const framed = useRef(false);
  useEffect(() => {
    if (framed.current || viewport.w === 0 || !hasNodes) return;
    framed.current = true;
    fit();
  });

  /** The step nearest to where the camera is looking, for the minimap's jump. */
  function nearestToView(): Box | undefined {
    const cx = (viewport.w / 2 - cam.x) / cam.k;
    const cy = (viewport.h / 2 - cam.y) / cam.k;
    let best: Box | undefined;
    let bestD = Infinity;
    for (const b of boxes) {
      const d = Math.hypot(b.x + b.width / 2 - cx, b.y + b.height / 2 - cy);
      if (d < bestD) [best, bestD] = [b, d];
    }
    return best;
  }

  function select(id: string) {
    clearMulti();
    setSelectedNote(null);
    setSelectedAsk(null);
    setSelectedAskWire(null);
    setSelectedId(id);
    setSelectedContainer(null);
    setSelectedEdge(null);
    setPanel("node");
  }

  /**
   * Mark a step done and go straight on to the next one: the best step that is now ready, the same one
   * the "1" badge would point at. It is selected, and the view moves to it only if it is off screen.
   */
  function finish(nodeId: string, pasted: string) {
    const next = markDone(flow, nodeId, pasted);
    onChange(next);
    const following = readyNodes(next, Date.now())[0];
    if (!following) {
      flashNotice(
        next.nodes.filter(isWork).every((n) => doneOf(next, n))
          ? "Every step is done."
          : "Nothing else is ready yet. What is left is waiting on another step or on a limit to reset.",
      );
      return;
    }
    select(following.id);
    const b = boxById.get(following.id);
    if (!b) return;
    const c = camRef.current;
    const left = b.x * c.k + c.x;
    const top = b.y * c.k + c.y;
    const margin = 40;
    if (left < margin || top < margin || left + b.width * c.k > viewport.w - margin || top + b.height * c.k > viewport.h - margin) {
      centerOn(b.x + b.width / 2, b.y + b.height / 2);
    }
  }

  // Containers: what is drawn is the saved box, with whatever it is being dragged to while you hold it.
  const containers = (view.containers ?? []).map((c) =>
    containerLive?.id === c.id ? ({ ...c, ...containerLive } as FlowContainer) : c,
  );
  const containerSel = containers.find((c) => c.id === selectedContainer) ?? null;
  const askSel = (view.asks ?? []).find((a) => a.id === selectedAsk) ?? null;

  /** Zoomed out, every container fills in with its colour and shows its name, like a labelled region. */
  const cover = containerCover(cam.k);

  /** Pressing a container's title selects it; dragging the title moves it. */
  function startContainerMove(e: ReactPointerEvent, c: FlowContainer) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    clearMulti();
    setSelectedContainer(c.id);
    setSelectedId(null);
    setSelectedEdge(null);
    if (mode !== "plan") return;
    const start = canvasPoint(e);
    const at = (ev: Point) => {
      const p = canvasPoint(ev);
      return { x: snap(c.x + p.x - start.x), y: snap(c.y + p.y - start.y) };
    };
    let moved = false;
    const frames = perFrame<Point>((pt) => setContainerLive({ id: c.id, ...at(pt) }));
    const move = (ev: PointerEvent) => {
      const p = canvasPoint(ev);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
      moved = true;
      frames.push({ clientX: ev.clientX, clientY: ev.clientY });
    };
    const done = (ev: PointerEvent, commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      frames.cancel();
      setContainerLive(null);
      if (moved && commit) onChange(updateContainer(view, c.id, at(ev)));
    };
    const up = (ev: PointerEvent) => done(ev, true);
    const cancel = (ev: PointerEvent) => done(ev, false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  /** Drag the bottom-right corner of a note to resize it. Sizes snap to the grid and stop at the smallest a note can be. */
  function startNoteResize(e: ReactPointerEvent, note: FlowNote) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const at = (ev: Point) => {
      const p = canvasPoint(ev);
      return { w: Math.max(NOTE_MIN.w, snap(p.x - note.x)), h: Math.max(NOTE_MIN.h, snap(p.y - note.y)) };
    };
    const frames = perFrame<Point>((pt) => setNoteLive({ id: note.id, ...at(pt) }));
    const move = (ev: PointerEvent) => frames.push({ clientX: ev.clientX, clientY: ev.clientY });
    const done = (ev: PointerEvent, commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      frames.cancel();
      setNoteLive(null);
      if (commit) onChange(updateNote(view, note.id, at(ev)));
    };
    const up = (ev: PointerEvent) => done(ev, true);
    const cancel = (ev: PointerEvent) => done(ev, false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  /** Drag the corner handle of the selected container to resize it. */
  function startContainerResize(e: ReactPointerEvent, c: FlowContainer) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const at = (ev: Point) => {
      const p = canvasPoint(ev);
      return { w: Math.max(GRID * 8, snap(p.x - c.x)), h: Math.max(GRID * 6, snap(p.y - c.y)) };
    };
    const frames = perFrame<Point>((pt) => setContainerLive({ id: c.id, ...at(pt) }));
    const move = (ev: PointerEvent) => frames.push({ clientX: ev.clientX, clientY: ev.clientY });
    const done = (ev: PointerEvent, commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      frames.cancel();
      setContainerLive(null);
      if (commit) onChange(updateContainer(view, c.id, at(ev)));
    };
    const up = (ev: PointerEvent) => done(ev, true);
    const cancel = (ev: PointerEvent) => done(ev, false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  /** Drag a wire's middle segment sideways (or up and down) to move where it turns. */
  function startBend(e: ReactPointerEvent, edge: (typeof edges)[number]) {
    e.preventDefault();
    e.stopPropagation();
    const base = (edge.axis === "x" ? edge.mid.x : edge.mid.y) - edge.bend;
    const bendAt = (ev: Point) => {
      const p = canvasPoint(ev);
      return Math.round(((edge.axis === "x" ? p.x : p.y) - base) / 8) * 8;
    };
    const frames = perFrame<Point>((pt) => setBending({ id: edge.id, bend: bendAt(pt) }));
    const move = (ev: PointerEvent) => frames.push({ clientX: ev.clientX, clientY: ev.clientY });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      frames.cancel();
      setBending(null);
      onChange(setBend(view, edge.to, edge.ref, bendAt(ev)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function nodeState(node: FlowNode): string {
    return nodeStates.get(node.id) ?? "";
  }

  const toolName = (node: FlowNode) =>
    node.kind === "translator"
      ? "Translator"
      : node.kind === "approval"
      ? "Approval"
      : node.kind === "wait"
        ? "Wait for reset"
        : node.kind === "start"
      ? "Start"
      : node.kind === "end"
        ? "End"
        : node.kind === "verifier"
      ? "Check"
      : embedded
        ? "Sub-step"
        : [flow.tools.find((t) => t.id === node.toolId)?.name ?? "No tool", effectiveModel(flow, node)?.name]
            .filter(Boolean)
            .join(" · ");

  // The inside being looked at can go (its last note deleted): then there is nothing to be inside of.
  useEffect(() => {
    if (zoom && !flow.nodes.some((n) => n.id === zoom) && !(flow.noteStacks ?? []).some((st) => `stack:${st.id}` === zoom)) setZoom(null);
  }, [zoom, flow]);
  const zoomedStack = zoom?.startsWith("stack:") ? (flow.noteStacks ?? []).find((s) => `stack:${s.id}` === zoom) : undefined;
  if (zoomedStack) {
    return (
      <FlowCanvas
        key={zoom ?? ""}
        flow={notesInside(flow, zoomedStack.id)}
        studio={studio}
        embedded={{ parent: zoomedStack.title, label: "Inside these notes" }}
        onChange={(inside, silent) => onChange(setNotesInside(flow, zoomedStack.id, inside), silent)}
        onBack={() => setZoom(null)}
      />
    );
  }
  const zoomed = zoom ? flow.nodes.find((n) => n.id === zoom) : undefined;
  if (zoomed) {
    return (
      <FlowCanvas
        key={zoomed.id}
        flow={subFlow(flow, zoomed.id)}
        studio={studio}
        embedded={{ parent: zoomed.text || zoomed.id }}
        onChange={(inside, silent) => onChange(setSub(flow, zoomed.id, inside), silent)}
        onBack={() => setZoom(null)}
      />
    );
  }

  return (
    <div className="workflow-canvas-view flow-view">
      <div className="workflow-canvas-head">
        {embedded && (
          <button type="button" className="workflow-back" onClick={onBack}>
            ← Back to the workflow
          </button>
        )}
        <div className="workflow-canvas-titleblock">
          {embedded ? (
            <div className="flow-inside-title">
              <span className="flow-inside-label">{embedded.label ?? "Inside this step"}</span>
              <span className="workflow-canvas-title">{embedded.parent}</span>
            </div>
          ) : (
            <input
              className="workflow-canvas-title"
              value={flow.title}
              placeholder="Name this workflow"
              onChange={(e) => onChange(renameFlow(flow, e.target.value))}
            />
          )}
          <div className="workflow-canvas-subtitle">
            {!embedded && (
              <>
                <span>{mode === "plan" ? "Plan" : "Run"}</span>
                <span>·</span>
              </>
            )}
            <span>
              {work.length} step{work.length === 1 ? "" : "s"}
            </span>
            <span>·</span>
            <span>{doneCount} done</span>
            {flow.locked && (
              <>
                <span>·</span>
                <span>locked</span>
                {mode === "plan" && !embedded && (
                  <>
                    <span>·</span>
                    {writing ? (
                      <span>polishing…</span>
                    ) : diffList.length > 0 ? (
                      <span>{diffList.length} polished to review</span>
                    ) : (
                      <button type="button" className="flow-polish-link" onClick={() => void polishSteps(flow.nodes.map((n) => n.id))}>
                        Polish prompts
                      </button>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {historyOpen && !embedded && <FlowHistory flowId={flow.id} onClose={() => setHistoryOpen(false)} />}

      {mode === "run" && (
        <div className="flow-next">
          {ready.length === 0 && pending.length === 0 ? (
            <span>{doneCount === work.length && work.length > 0 ? "Everything is done." : "Nothing is ready yet."}</span>
          ) : (
            <>
              <span className="flow-next-label">Next</span>
              {pending.map((ask) => (
                <button key={ask.id} type="button" className="flow-next-chip ask" onClick={() => selectAsk(ask.id)}>
                  <span className="flow-next-tool">Answer</span>
                  {ask.title || "A question"}
                </button>
              ))}
              {ready.map((node, index) => (
                <button
                  key={node.id}
                  type="button"
                  className={`flow-next-chip ${index === 0 ? "first" : ""}`}
                  onClick={() => select(node.id)}
                >
                  <span className="flow-next-tool">{toolName(node)}</span>
                  {node.text || "Untitled step"}
                  {!fitsQuota(flow, node) && <span className="flow-warn"> · won't finish in quota</span>}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      <div className="flow-body">
        <section className="workflow-canvas-panel">
          {mode === "plan" && !embedded && draft.open && (
            <div className="flow-draft">
              <textarea
                rows={2}
                value={draft.text}
                placeholder="What should the questions be for? Leave empty to use the workflow's steps."
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              />
              <div className="flow-run-actions">
                <button type="button" className="flow-button primary" disabled={draft.busy} onClick={() => void draftQuestions()}>
                  {draft.busy ? "Drafting…" : "Draw the questions"}
                </button>
                <button type="button" className="flow-button" onClick={() => setDraft({ open: false, text: "", busy: false })}>
                  Cancel
                </button>
              </div>
              <p className="flow-muted">One request. The questions appear as squares and wires you can edit, and Cmd+Z takes them back.</p>
            </div>
          )}

          {diffList.length > 0 && !embedded && (
            <div className="flow-notice flow-rewrites" role="status">
              <span>
                {diffList.length} polished step{diffList.length === 1 ? "" : "s"} to review
              </span>
              <button type="button" className="flow-rewrites-act accept" onClick={() => takeDiffs(diffList.map((n) => n.id))}>
                Accept all
              </button>
              <button type="button" className="flow-rewrites-act" onClick={() => dropDiffs(diffList.map((n) => n.id))}>
                Reject all
              </button>
            </div>
          )}

          {(writing || notice) ? (
            <div className="flow-notice" role="status">
              {writing ?? notice}
            </div>
          ) : (
            lockOffer &&
            flow.locked &&
            diffList.length === 0 && (
              <div className="flow-notice" role="status">
                Plan locked.{" "}
                <button
                  type="button"
                  className="flow-polish-link"
                  onClick={() => {
                    setLockOffer(false);
                    void polishSteps(flow.nodes.map((n) => n.id));
                  }}
                >
                  Polish prompts
                </button>
              </div>
            )
          )}

          {mode === "plan" && showIssues && issues.length > 0 && (
            <ul className="flow-issues">
              {issues.slice(0, 4).map((issue, i) => (
                <li key={i}>
                  <button type="button" onClick={() => {
                      if (!issue.node) return;
                      if ((view.asks ?? []).some((a) => a.id === issue.node)) selectAsk(issue.node);
                      else select(issue.node);
                    }}>
                    <b>{issue.node}</b> {issue.message}
                  </button>
                </li>
              ))}
              {issues.length > 4 && <li className="flow-issues-more">and {issues.length - 4} more</li>}
            </ul>
          )}

          {(
            <div className="workflow-canvas-frame" onContextMenu={(e) => e.preventDefault()}>
              <div
                className={`workflow-canvas-scroll flow-viewport ${mode === "plan" ? "select" : ""} ${rewound ? "rewound" : ""}`}
                ref={scrollRef}
                onPointerDown={startPan}
                onPointerDownCapture={(e) => {
                  // A field you were typing in keeps the keyboard when a card is pressed, so Backspace would edit it
                  // instead of deleting the card. Pressing the canvas hands the keyboard back.
                  const active = document.activeElement as HTMLElement | null;
                  if (active && active !== e.target && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) active.blur();
                  // Any press lets go of a selected dotted line; pressing the line itself selects it again on click.
                  setSelectedNoteLink(null);
                  beginRing(e);
                }}
                onContextMenu={(e) => e.preventDefault()}
                onDoubleClick={ringOnDoubleClick}
                onPointerMove={(e) => {
                  pointer.current = { clientX: e.clientX, clientY: e.clientY };
                }}
                onPointerLeave={() => {
                  pointer.current = null;
                }}
              >
                <div className="flow-grid" ref={gridRef} data-k={cam.k} aria-hidden="true">
                  {gridLayerList.map((l) => (
                    <div
                      key={l.spacing}
                      className="flow-grid-layer"
                      data-spacing={l.spacing}
                      style={{
                        inset: -l.spacing,
                        // The tile is a mask over the theme's line colour, so the grid follows the theme.
                        backgroundColor: "var(--faint)",
                        maskImage: l.image,
                        WebkitMaskImage: l.image,
                        maskSize: `${l.spacing}px ${l.spacing}px`,
                        WebkitMaskSize: `${l.spacing}px ${l.spacing}px`,
                        transform: gridShift(cam, l.spacing),
                      }}
                    />
                  ))}
                </div>
                {/* The world: steps and wires in their own coordinates, moved and scaled as one by the camera. */}
                <div className="flow-world" ref={worldRef} style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})` }}>
                <div className={`workflow-canvas ${drag ? "wiring" : ""}`}>
                  {containers.map((c) => {
                    return (
                      <div
                        key={c.id}
                        data-target={`container:${c.id}`}
                        className={`flow-container ${c.collapsed ? "collapsed" : ""} ${c.id === selectedContainer ? "active" : ""} ${cover > 0.02 ? "covering" : ""} ${cover > 0.5 ? "tile" : ""}`}
                        onPointerDown={cover > 0.5 ? (e) => startContainerMove(e, c) : undefined}
                        style={
                          {
                            left: c.x,
                            top: c.y,
                            width: c.collapsed ? COLLAPSED_SIZE.w : c.w,
                            height: c.collapsed ? COLLAPSED_SIZE.h : c.h,
                            "--c": CONTAINER_COLORS[c.color] ?? CONTAINER_COLORS.teal,
                            "--tint": `${(9 + 80 * cover).toFixed(1)}%`,
                            "--label": String(1 - cover),
                            "--cover": String(cover),
                            // The name on the tile stays 13 pixels on screen, the same as a container's title at
                            // 100%, whatever the zoom.
                            "--cover-font": `${(13 / cam.k).toFixed(1)}px`,
                            // The grab strip along the border keeps the same size on screen at every zoom.
                            "--edge": `${(12 / cam.k).toFixed(1)}px`,
                          } as CSSProperties
                        }
                      >
                        {(["top", "right", "bottom", "left"] as const).map((side) => (
                          <div
                            key={side}
                            className={`flow-container-edge ${side}`}
                            onPointerDown={(e) => startContainerMove(e, c)}
                          />
                        ))}
                        <div className="flow-container-head" onPointerDown={(e) => startContainerMove(e, c)}>
                          <button
                            type="button"
                            className="flow-container-fold"
                            title={c.collapsed ? "Show the steps inside" : "Fold the steps inside into this card"}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              onChange(updateContainer(view, c.id, { collapsed: !c.collapsed }));
                            }}
                          >
                            {c.collapsed ? "▸" : "▾"}
                          </button>
                          <span>
                            {c.name || "Container"}
                            {c.collapsed && (() => {
                              const count = [...hidden.values()].filter((v) => v === c.id).length;
                              return count > 0 ? ` · ${count} step${count === 1 ? "" : "s"}` : "";
                            })()}
                          </span>
                        </div>
                        <div className="flow-container-cover" aria-hidden="true">
                          <span>{c.name || "Container"}</span>
                        </div>
                        {c.id === selectedContainer && mode === "plan" && !c.collapsed && (
                          <span
                            className="flow-container-resize"
                            title="Drag to resize"
                            onPointerDown={(e) => startContainerResize(e, c)}
                          />
                        )}
                      </div>
                    );
                  })}
                  {shownNotes.map((note) => {
                    const at = { x: note.x, y: note.y };
                    const size = noteLive?.id === note.id ? noteLive : noteSize(note);
                    return (
                      <div
                        key={note.id}
                        data-drag={`note:${note.id}`}
                        data-target={`note:${note.id}`}
                        className={`flow-note ${note.color} ${note.id === selectedNote ? "active" : ""} ${multi.notes.includes(note.id) ? "multi" : ""}`}
                        style={{ left: at.x, top: at.y, width: size.w, height: size.h, minHeight: 0 }}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setSelectedNote(note.id);
                        }}
                      >
                        <div className="flow-note-grip" onPointerDown={(e) => startNoteMove(e, note)} title="Drag to move">
                          {note.diff && <span className="flow-note-diff-title">Polished: {note.text}</span>}
                          {!note.diff && (
                            <button
                              type="button"
                              className="flow-note-button"
                              title="Change colour"
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={() =>
                                onChange(
                                  updateNote(view, note.id, {
                                    color: NOTE_COLORS[((NOTE_COLORS as readonly string[]).indexOf(note.color) + 1) % NOTE_COLORS.length],
                                  }),
                                )
                              }
                            >
                              ●
                            </button>
                          )}
                          <button
                            type="button"
                            className="flow-note-button"
                            title={note.diff ? "Reject the polished text" : "Delete this note"}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => (note.diff ? dropDiffs([note.id]) : onChange(removeNote(view, note.id)))}
                          >
                            ×
                          </button>
                        </div>
                        {note.diff ? (
                          <>
                            <div className="flow-note-diff" onPointerDown={(e) => e.stopPropagation()}>
                              {note.diff.readable && (
                                <>
                                  <div className="mini-label">Plan text</div>
                                  <WordDiff before={note.diff.readable.base} after={note.diff.readable.text} beforeLabel="Now" afterLabel="Polished" />
                                </>
                              )}
                              {note.diff.prompt && (
                                <>
                                  <div className="mini-label">Prompt</div>
                                  <WordDiff before={note.diff.prompt.base} after={note.diff.prompt.text} beforeLabel="Now" afterLabel="Polished" />
                                </>
                              )}
                            </div>
                            <div className="flow-note-diff-actions">
                              <button
                                type="button"
                                className="flow-note-button flow-diff-act accept"
                                title="Put the polished text on the step"
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={() => takeDiffs([note.id])}
                              >
                                ✓ Accept
                              </button>
                              <button
                                type="button"
                                className="flow-note-button flow-diff-act reject"
                                title="Throw the polished text away"
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={() => dropDiffs([note.id])}
                              >
                                ✕ Reject
                              </button>
                            </div>
                          </>
                        ) : (
                          <textarea
                            value={note.text}
                            placeholder="Write a note"
                            onPointerDown={(e) => e.stopPropagation()}
                            onChange={(e) => onChange(updateNote(view, note.id, { text: e.target.value }))}
                          />
                        )}
                        {(mode === "plan" || linkedNotes.has(note.id)) && (
                          <span
                            className={`flow-note-port ${linkedNotes.has(note.id) ? "linked" : ""} ${noteLine?.from === note.id ? "live" : ""}`}
                            title={mode === "plan" ? "Drag onto a step, square, container or note to draw a dotted line" : "Dotted lines from this note"}
                            onPointerDown={(e) => startNoteWire(e, note)}
                          />
                        )}
                        <span className="flow-note-resize" title="Drag to resize" onPointerDown={(e) => startNoteResize(e, note)} />
                      </div>
                    );
                  })}
                  {(view.noteStacks ?? []).map((stack) => {
                    const members = stackNotes(view, stack.id);
                    const open = stack.expanded !== false;
                    return (
                      <div
                        key={stack.id}
                        data-drag={`stack:${stack.id}`}
                        data-target={`stack:${stack.id}`}
                        className={`flow-stack ${open ? "open" : "folded"}`}
                        style={{ left: stack.x, top: stack.y, width: STACK_SIZE.w, height: STACK_SIZE.h }}
                        title="Drag to move it with its notes. Double-click to open what is inside."
                        onPointerDown={(e) => startStackMove(e, stack)}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setZoom(`stack:${stack.id}`);
                        }}
                      >
                        <div className="flow-stack-head">
                          <span className="flow-stack-kind">
                            Notes · {members.length}
                          </span>
                          <span className="flow-stack-buttons">
                            <button
                              type="button"
                              title={open ? "Shrink: fold the notes into this card" : "Expand: show the notes on the workflow"}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={() => toggleStack(stack)}
                            >
                              {open ? "▾" : "▸"}
                            </button>
                            <button
                              type="button"
                              title="Open inside"
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={() => setZoom(`stack:${stack.id}`)}
                            >
                              ⤢
                            </button>
                            <button
                              type="button"
                              title="Delete these notes"
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={() => {
                                onChange(removeNoteStack(view, stack.id));
                                flashNotice("Notes removed. Press Cmd+Z to undo.");
                              }}
                            >
                              ×
                            </button>
                          </span>
                        </div>
                        <div className="flow-stack-title">{stack.title}</div>
                        {!open && members[0] && <div className="flow-stack-peek">{members[0].text}</div>}
                      </div>
                    );
                  })}
                  {(view.asks ?? []).map((ask) => {
                    const at = ask.pos;
                    const st = askState(view, ask);
                    const state =
                      mode === "run"
                        ? ask.skipped || st === "skipped"
                          ? "skipped"
                          : st === "locked"
                            ? "locked"
                            : isAnswered(ask)
                              ? "answered"
                              : "waiting"
                        : "";
                    return (
                      <div
                        key={ask.id}
                        data-drag={`ask:${ask.id}`}
                        data-target={`ask:${ask.id}`}
                        className={`flow-ask ${ask.kind} ${state} ${ask.origin === "agent" ? `agent ${isAnswered(ask) ? "folded" : "asking"}` : ""} ${ask.id === selectedAsk ? "active" : ""} ${multi.asks.includes(ask.id) ? "multi" : ""}`}
                        style={{ left: at.x, top: at.y, width: ASK_SIZE, height: askHeight(ask) }}
                        role="button"
                        tabIndex={0}
                        onPointerDown={(e) => startAskMove(e, ask)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") selectAsk(ask.id);
                        }}
                      >
                        <AskSquareBody ask={ask} title={fillForAsk(view, ask, ask.title)} />
                      </div>
                    );
                  })}
                  <svg className="flow-bindings" aria-hidden="true">
                    {bindings.map((b) => (
                      <path key={b.id} data-eid={b.id} className={`flow-binding ${b.ask === selectedAsk || b.node === selectedId ? "active" : ""}`} d={b.path} />
                    ))}
                  </svg>
                  <svg className="flow-ask-edges" aria-hidden="true">
                    {askEdges.map((edge) => (
                      <path
                        key={edge.id}
                        data-eid={edge.id}
                        className={`flow-ask-edge ${edge.state} ${edge.id === selectedAskWire ? "active" : ""}`}
                        d={edge.path}
                        markerEnd="url(#flow-arrow)"
                      />
                    ))}
                  </svg>
                  <svg className="flow-edge-hits" aria-hidden="true">
                    {askEdges.map((edge) => (
                      <path
                        key={edge.id}
                        data-eid={edge.id}
                        className="flow-edge-hit"
                        data-target={`askwire:${edge.id}`}
                        d={edge.path}
                        onClick={() => {
                          setSelectedId(null);
                          setSelectedEdge(null);
                          setSelectedAsk(null);
                          setSelectedAskWire(edge.id);
                        }}
                      />
                    ))}
                  </svg>
                  <svg className="flow-note-links" aria-hidden="true">
                    {noteEdges.map((edge) => (
                      <path key={edge.id} data-eid={edge.id} className={`flow-note-link ${edge.id === selectedNoteLink ? "active" : ""}`} d={edge.path} />
                    ))}
                  </svg>
                  <svg className="flow-edge-hits" aria-hidden="true">
                    {noteEdges.map((edge) => (
                      <path
                        key={edge.id}
                        data-eid={edge.id}
                        className="flow-edge-hit"
                        data-target={`notelink:${edge.id}`}
                        d={edge.path}
                        onClick={() => setSelectedNoteLink(edge.id)}
                      />
                    ))}
                  </svg>
                  <svg className="workflow-edges" aria-hidden="true">
                    <defs>
                      {["", "-active"].map((k) => (
                        <marker
                          key={k}
                          id={`flow-arrow${k}`}
                          viewBox="0 0 10 10"
                          refX="9"
                          refY="5"
                          markerWidth="8"
                          markerHeight="8"
                          orient="auto-start-reverse"
                        >
                          <path d="M 0 1 L 9 5 L 0 9 z" className={`flow-arrow-head${k}`} />
                        </marker>
                      ))}
                    </defs>
                    {visibleEdges.map((edge) => {
                      const on = edge.id === selectedEdge || edge.from === selectedId || edge.to === selectedId;
                      const dim = (selectedId || selectedEdge) && !on;
                      return (
                        <path
                          key={edge.id}
                          data-eid={edge.id}
                          className={`workflow-edge ${on ? "active" : ""} ${dim ? "faded" : ""} ${ghost?.addEdges.has(edge.id) ? "ghost-add" : ghost?.removeEdges.has(edge.id) ? "ghost-remove" : ""}`}
                          d={edge.path}
                          markerEnd={`url(#flow-arrow${on ? "-active" : ""})`}
                        />
                      );
                    })}
                  </svg>
                  <svg className="flow-edge-hits" aria-hidden="true">
                    {visibleEdges.map((edge) => (
                      <path
                        key={edge.id}
                        data-eid={edge.id}
                        className="flow-edge-hit"
                        data-target={`wire:${edge.id}`}
                        d={edge.path}
                        onClick={() => {
                          setSelectedId(null);
                          setSelectedEdge(edge.id);
                        }}
                      />
                    ))}
                  </svg>
                  {mode === "plan" &&
                    edges
                      .filter((edge) => edge.id === selectedEdge)
                      .map((edge) => (
                        <span
                          key={`bend-${edge.id}`}
                          className="flow-bend"
                          style={{ left: edge.mid.x - 6, top: edge.mid.y - 6, cursor: edge.axis === "x" ? "ew-resize" : "ns-resize" }}
                          title="Drag to move this wire's middle segment"
                          onPointerDown={(e) => startBend(e, edge)}
                        />
                      ))}
                  {visibleBoxes.map((box) => {
                    const node = nodeById.get(box.id);
                    if (!node) return null;
                    const needs = dependencies(node).length;
                    const here = node.id === selectedId;
                    const wiring =
                      drag && node.id !== drag.from
                        ? (drag.dir === "out" ? canWire(flow, drag.from, node.id) : canWire(flow, node.id, drag.from))
                          ? `drop-ok ${dragOver === node.id ? "over" : ""}`
                          : "drop-no"
                        : "";
                    return (
                      <NodeCard
                        key={node.id}
                        node={node}
                        x={box.x}
                        y={box.y}
                        w={box.width}
                        h={box.height}
                        className={`workflow-node flow-node ${node.kind} ${nodeState(node)} ${here ? "active" : ""} ${multi.nodes.includes(node.id) ? "multi" : ""} ${wiring} ${ghost?.addNodes.has(node.id) ? "ghost-add" : ghost?.editNodes.has(node.id) ? "ghost-edit" : ghost?.removeNodes.has(node.id) ? "ghost-remove" : ""}`}
                        pressed={here}
                        toolLabel={toolName(node)}
                        checked={Boolean(node.done || ((node.kind === "end" || node.kind === "translator") && doneOf(flow, node)))}
                        issue={mode === "plan" && issueNodes.has(node.id)}
                        rank={node.done ? undefined : rank.get(node.id)}
                        waitText={node.kind === "wait" ? (doneOf(flow, node, now) ? "Reset" : `Resumes ${resetsIn(waitUntil(flow, node), now)}`) : null}
                        metaText={
                          here && node.kind !== "wait"
                            ? node.kind === "start"
                              ? `holds ${node.outputs.length}`
                              : node.kind === "end"
                                ? `waits for ${needs}`
                                : `${needs === 0 ? "Starts here" : `waits for ${needs}`} · makes ${node.outputs.length}`
                            : null
                        }
                        api={nodeApi}
                      />
                    );
                  })}
                  {mode === "plan" &&
                    (view.asks ?? []).flatMap((ask) => {
                      const q = ask.pos;
                      const ports = askPorts(ask);
                      return [
                        <span
                          key={`ai-${ask.id}`}
                          data-drag-with={`ask:${ask.id}`}
                          className="flow-handle flow-handle-in ask"
                          style={{ left: q.x - 7, top: q.y + askHeight(ask) / 2 - 7 }}
                          title="What this square comes after goes here"
                        />,
                        ...ports.flatMap((pt) => {
                          const o = portAt(ask, q, pt.port);
                          return [
                            <span
                              key={`ao-${ask.id}-${pt.port ?? ""}`}
                              data-drag-with={`ask:${ask.id}`}
                              className={`flow-handle ask ${askLine?.from === ask.id && (askLine.port ?? "") === (pt.port ?? "") ? "live" : ""}`}
                              style={{ left: o.x - 7, top: o.y - 7 }}
                              title={pt.label ? `Drag from "${pt.label}" to what follows that answer` : "Drag onto the square or translator that comes next"}
                              onPointerDown={(e) => startAskWire(e, ask, pt.port)}
                            />,
                            ...(pt.label
                              ? [
                                  <span key={`al-${ask.id}-${pt.port}`} data-drag-with={`ask:${ask.id}`} className="flow-port-label" style={{ left: o.x + 12, top: o.y - 9 }}>
                                    {pt.label}
                                  </span>,
                                ]
                              : []),
                          ];
                        }),
                      ];
                    })}
                  {askLine && (view.asks ?? []).find((a) => a.id === askLine.from) && (
                    <svg className="flow-drag-line" aria-hidden="true">
                      <path
                        d={(() => {
                          const a = (view.asks ?? []).find((x) => x.id === askLine.from)!;
                          const o = portAt(a, a.pos, askLine.port);
                          return curve(o.x, o.y, askLine.x, askLine.y);
                        })()}
                      />
                    </svg>
                  )}
                  {noteLine && (view.notes ?? []).find((n) => n.id === noteLine.from) && (
                    <svg className="flow-drag-line" aria-hidden="true">
                      <path
                        d={(() => {
                          const n = (view.notes ?? []).find((x) => x.id === noteLine.from)!;
                          const x1 = n.x;
                          const y1 = n.y + noteSize(n).h / 2;
                          return `M ${x1} ${y1} L ${noteLine.x} ${noteLine.y}`;
                        })()}
                      />
                    </svg>
                  )}
                  {mode === "plan" &&
                    visibleBoxes.flatMap((box) => {
                      const kind = nodeById.get(box.id)?.kind;
                      return [
                      kind === "end" ? null : (
                      <span
                        key={`h-${box.id}`}
                        data-drag-with={`node:${box.id}`}
                        className={`flow-handle ${line?.from === box.id && line.dir === "out" ? "live" : ""}`}
                        style={{ left: box.x + box.width - 7, top: box.y + box.height / 2 - 7 }}
                        title="Drag onto another step: that step will wait for this one"
                        onPointerDown={(e) => startDrag(e, box.id, "out")}
                      />
                      ),
                      kind === "start" || kind === "translator" ? null : (
                      <span
                        key={`hi-${box.id}`}
                        data-drag-with={`node:${box.id}`}
                        className={`flow-handle flow-handle-in ${line?.from === box.id && line.dir === "in" ? "live" : ""}`}
                        style={{ left: box.x - 7, top: box.y + box.height / 2 - 7 }}
                        title="Drag onto another step: this step will wait for that one"
                        onPointerDown={(e) => startDrag(e, box.id, "in")}
                      />
                      ),
                    ];
                    })}
                  {line && boxById.get(line.from) && (
                    <svg className="flow-drag-line" aria-hidden="true">
                      <path
                        d={(() => {
                          const b = boxById.get(line.from)!;
                          const back = line.dir === "in";
                          const x1 = back ? b.x : b.x + b.width;
                          const y1 = b.y + b.height / 2;
                          const mid = Math.max(24, Math.abs(line.x - x1) / 2);
                          const s = back ? -1 : 1;
                          return `M ${x1} ${y1} C ${x1 + s * mid} ${y1}, ${line.x - s * mid} ${line.y}, ${line.x} ${line.y}`;
                        })()}
                      />
                    </svg>
                  )}
                </div>
                </div>
                  {proposal && (
                    <div className="flow-talk flow-proposal" style={menuAt(proposal.spot.x, proposal.spot.y, 340, 200)} role="group" aria-label="Proposed changes">
                      <div className="flow-proposal-title">{proposal.edit.summary}</div>
                      <ul>
                        {proposal.edit.changes.slice(0, 6).map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                        {proposal.edit.changes.length > 6 && <li>...and {proposal.edit.changes.length - 6} more</li>}
                      </ul>
                      {proposal.edit.skipped.length > 0 && <div className="flow-talk-error">Left out: {proposal.edit.skipped.join("; ")}</div>}
                      <div className="flow-proposal-actions">
                        <button type="button" className="flow-button primary" onClick={applyProposal}>
                          Apply
                        </button>
                        <button type="button" className="ghost" onClick={rejectProposal}>
                          Reject
                        </button>
                      </div>
                    </div>
                  )}
                  {naming && (
                    <>
                      <button type="button" className="flow-pick-backdrop" aria-label="Cancel" onClick={() => setNaming(null)} />
                      <div className="flow-talk" style={menuAt(naming.x, naming.y, 340, 70)} role="group" aria-label="Save as preset">
                        <input
                          autoFocus
                          className="flow-asker-text"
                          style={{ marginTop: 0 }}
                          value={naming.name}
                          placeholder="Name this piece, then press Enter"
                          onChange={(e) => setNaming({ ...naming, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setNaming(null);
                            else if (e.key === "Enter") {
                              e.preventDefault();
                              const piece = capturePiece(view, naming.container);
                              if (piece) {
                                const saved = savePreset(naming.name, piece);
                                flashNotice(`Saved "${saved.name}". Find it under Add, then Saved pieces.`);
                              }
                              setNaming(null);
                            }
                          }}
                        />
                      </div>
                    </>
                  )}
                  {batch && (batch.busy || batch.error) && (
                    <div className="flow-talk flow-batch" style={menuAt(batchRightEdgeOf(batch.turn) + 14, batch.spot.y, 340, 90)} role="status">
                      {batch.busy ? (
                        <div className="flow-talk-working">{busyRetry && busyRetry.attempt > 0 ? `Gemini is busy. Trying again (${busyRetry.attempt} of ${busyRetry.of})…` : "Drawing the change with your answers…"}</div>
                      ) : (
                        <>
                          <div className="flow-talk-error">{batch.error}</div>
                          <div className="flow-proposal-actions">
                            <button type="button" className="flow-button primary" onClick={() => void finishBatch(batch)}>
                              Try again
                            </button>
                            <button type="button" className="ghost" onClick={() => setBatch(null)}>
                              Leave it
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  {askSel && askSel.origin === "agent" && !isAnswered(askSel) && !(batch && batch.busy) && (
                    <PlanAsk key={askSel.id} ask={askSel} style={menuAt(batchRightEdge(askSel) + 14, askSel.pos.y, 340, 270)} onAnswer={(answer) => answerPlanSquare(askSel.id, answer)} />
                  )}
                  {talk && (
                    <>
                      <button
                        type="button"
                        className="flow-pick-backdrop"
                        aria-label="Close"
                        onClick={() => (talk.busy ? undefined : setTalk(null))}
                      />
                      <div className="flow-talk" style={menuAt(talk.x, talk.y, 340, 84)}>
                        {talk.busy ? (
                          <div className="flow-talk-working" role="status">
                            {busyRetry && busyRetry.attempt > 0 ? `Gemini is busy. Trying again (${busyRetry.attempt} of ${busyRetry.of})…` : "Working…"}
                          </div>
                        ) : (
                          <textarea
                            autoFocus
                            rows={2}
                            value={talk.text}
                            placeholder="Ask or tell the agent"
                            onChange={(e) => setTalk({ ...talk, text: e.target.value, error: null })}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") setTalk(null);
                              else if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                void askTheAgent();
                              }
                            }}
                          />
                        )}
                        {talk.error && <div className="flow-talk-error">{talk.error}</div>}
                        {talk.error && !talk.busy && (
                          <button
                            type="button"
                            className="flow-talk-retry"
                            title="Ask again: Gemini is tried up to five times, five seconds apart"
                            onClick={() => void askTheAgent()}
                          >
                            Retry
                          </button>
                        )}
                        {!talk.busy && onDraw && talk.text.trim() && (
                          <button
                            type="button"
                            className="flow-talk-draw"
                            title="Draw a whole new workflow from this, as its own workflow in the list"
                            onClick={() => {
                              onDraw(talk.text.trim());
                              setTalk(null);
                            }}
                          >
                            Draw a whole workflow from this
                          </button>
                        )}
                      </div>
                    </>
                  )}
                  {newAt && (
                    <>
                      <button
                        type="button"
                        className="flow-pick-backdrop"
                        aria-label="Cancel"
                        onClick={() => setNewAt(null)}
                      />
                      <div className="flow-pick" style={menuAt(newAt.x, newAt.y, NEW_MENU.width, NEW_MENU.height)} role="menu">
                        <span className="flow-pick-title">{newAt.dir === "in" ? "Add before this step" : "Add after this step"}</span>
                        <KindMenu
                          options={available(newAt.dir === "in" ? "output" : "input")}
                          side={menuAt(newAt.x, newAt.y, NEW_MENU.width, NEW_MENU.height).left + NEW_MENU.width + 190 > viewport.w ? "left" : "right"}
                          onPick={(k) => {
                            const toolId = view.nodes.find((n) => n.id === newAt.from)?.toolId ?? view.tools[0]?.id;
                            const make = (f: Flow) => k.make(f, toolId);
                            if (newAt.dir === "in") addBefore(newAt.from, make, newAt);
                            else addAfter(newAt.from, make, newAt);
                          }}
                        />
                      </div>
                    </>
                  )}
                  <div ref={marqueeRef} className="flow-marquee" style={{ display: "none" }} />
                  {askNewAt && (
                    <>
                      <button type="button" className="flow-pick-backdrop" aria-label="Cancel" onClick={() => setAskNewAt(null)} />
                      <div className="flow-pick" style={menuAt(askNewAt.x, askNewAt.y, 190, 4 * 30 + 36)} role="menu">
                        <span className="flow-pick-title">Add a square after this</span>
                        {(["input", "decision", "form", "constant"] as const).map((kind) => (
                          <button key={kind} type="button" role="menuitem" title={ASK_KIND_INFO[kind].hint} onClick={() => addAskAfter(kind)}>
                            {ASK_KIND_INFO[kind].label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  {ring && <Ring ring={ring} onClose={() => setRing(null)} />}
                  {pick && (
                    <>
                      <button
                        type="button"
                        className="flow-pick-backdrop"
                        aria-label="Cancel"
                        onClick={() => setPick(null)}
                      />
                      <div
                        className="flow-pick"
                        style={menuAt(pick.x, pick.y, 190, pickHeight)}
                        role="menu"
                      >
                        <span className="flow-pick-title">Wire which artifact?</span>
                        {(flow.nodes.find((n) => n.id === pick.from)?.outputs ?? []).map((port) => (
                          <button
                            key={port.id}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              onChange(wire(flow, pick.to, { node: pick.from, port: port.id }));
                              setSelectedId(pick.to);
                              setPick(null);
                            }}
                          >
                            {port.label || "Unnamed"}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                {panel !== "tools" && boxes.length > 0 && (
                  <MiniMap
                    boxes={boxes}
                    cam={cam}
                    viewport={viewport}
                    selectedId={selectedId}
                    onCenter={centerOn}
                    onNode={(b) => centerOn(b.x + b.width / 2, b.y + b.height / 2)}
                    onNearest={() => {
                      const b = nearestToView();
                      if (b) centerOn(b.x + b.width / 2, b.y + b.height / 2);
                    }}
                  />
                )}
              </div>
              {rewound && (
                <div className="flow-rewind-banner" role="status">
                  Earlier version · Esc to return · change anything to branch
                </div>
              )}
              {!embedded && (
                <FlowStrip
                  timeline={timeline}
                  viewing={rewindId}
                  onView={rewindTo}
                  onPress={(e, pointId) => {
                    if (pointId) beginRing(e, { kind: "dot", id: pointId, at: viewCentre() });
                  }}
                  card={
                    merge && !proposal
                      ? {
                          point: merge.point,
                          node: (
                            <div className="flow-merge-card" role="group" aria-label="Ways to merge into the main line">
                              <div className="flow-merge-head">
                                <span>Merge into main</span>
                                <button type="button" className="flow-asker-close" aria-label="Cancel the merge" title="Cancel the merge" onClick={cancelMerge}>
                                  ×
                                </button>
                              </div>
                              {merge.busy && <div className="flow-talk-working">{merge.options ? "Drawing that merge…" : "Asking the cloud model for three ways to merge…"}</div>}
                              {merge.error && <div className="flow-talk-error">{merge.error}</div>}
                              {!merge.busy &&
                                merge.options?.map((o, i) => (
                                  <button key={i} type="button" className="flow-merge-option" onClick={() => void pickMerge(i)}>
                                    <b>{o.title}</b>
                                    <span>{o.summary}</span>
                                    {o.exists.length > 0 && (
                                      <>
                                        <em>Would exist</em>
                                        <ul>
                                          {o.exists.map((x, k) => (
                                            <li key={k}>{x}</li>
                                          ))}
                                        </ul>
                                      </>
                                    )}
                                    {o.removed.length > 0 && (
                                      <>
                                        <em>Removed because of conflicts</em>
                                        <ul>
                                          {o.removed.map((x, k) => (
                                            <li key={k}>{x}</li>
                                          ))}
                                        </ul>
                                      </>
                                    )}
                                  </button>
                                ))}
                            </div>
                          ),
                        }
                      : null
                  }
                />
              )}
              {work.length === 0 && !(view.asks ?? []).length && !(view.notes ?? []).length && (
                <div className="flow-hint" aria-hidden="true">
                  {embedded ? "Double-click or right-click to add the sub-steps · ⌘K for everything" : "Double-click or right-click for actions · ⌘K for everything"}
                </div>
              )}
            </div>
          )}
        </section>

        {(selected || containerSel || askSel) && (
        <aside className="flow-side">
          {askSel && !selected ? (
            <AskPanel
              flow={view}
              ask={askSel}
              mode={mode}
              onChange={onChange}
              onRemove={() => {
                onChange(removeAsk(view, askSel.id));
                setSelectedAsk(null);
              }}
            />
          ) : containerSel && !selected ? (
            <ContainerPanel
              container={containerSel}
              onChange={(patch) => onChange(updateContainer(view, containerSel.id, patch))}
              onRemove={() => {
                onChange(removeContainer(view, containerSel.id));
                setSelectedContainer(null);
              }}
            />
          ) : selected ? (
            mode === "plan" ? (
              <FlowInspector
                flow={flow}
                node={selected}
                embedded={Boolean(embedded)}
                onOpenInside={() => setZoom(selected.id)}
                onDuplicate={duplicateSelected}
                onSuggestInside={() => void suggestInside(selected.id)}
                suggesting={suggesting}
                rewrite={selectedDiff?.diff}
                polishing={Boolean(writing)}
                onPolish={() => void polishSteps([selected.id])}
                onAcceptRewrite={() => selectedDiff && takeDiffs([selectedDiff.id])}
                onRejectRewrite={() => selectedDiff && dropDiffs([selectedDiff.id])}
                onChange={onChange}
                removable={canRemove(view, selected.id)}
                onRemove={() => onChange(removeNode(flow, selected.id))}
              />
            ) : (
              <RunPanel
                flow={flow}
                node={selected}
                isFirst={rank.get(selected.id) === 1}
                copied={copied === `p-${selected.id}`}
                onCopy={() =>
                  void copyText(nodePrompt(flow, selected)).then(() => flash(`p-${selected.id}`))
                }
                onOpenInside={() => setZoom(selected.id)}
                onDone={(pasted) => finish(selected.id, pasted)}
                onFail={(error) => {
                  onChange(markFailed(flow, selected.id, error));
                  flashNotice("Marked failed. The prompt now includes the error: copy it to try again.");
                }}
                onFlow={onChange}
                onRewrite={() => void rewriteRetry(selected.id)}
                onPlainRetry={() => onChange(setRetry(flow, selected.id, undefined), true)}
                rewriting={rewriting}
                onReopen={() => onChange(reopen(flow, selected.id))}
              />
            )
          ) : (
            <p className="flow-muted flow-side-empty">
              {mode === "run"
                ? "Pick a step to see its prompt."
                : "Pick a step to edit what it needs and what it makes."}
            </p>
          )}
        </aside>
        )}

        {panel === "tools" && <FlowTools flow={flow} onChange={onChange} />}
      </div>


    </div>
  );
}

function RunPanel({
  flow,
  node,
  isFirst,
  copied,
  onCopy,
  onOpenInside,
  onDone,
  onFail,
  onFlow,
  onRewrite,
  onPlainRetry,
  rewriting,
  onReopen,
}: {
  flow: Flow;
  node: FlowNode;
  isFirst: boolean;
  copied: boolean;
  onCopy: () => void;
  onOpenInside: () => void;
  onDone: (pasted: string) => void;
  onFail: (error: string) => void;
  onFlow: (next: Flow) => void;
  onRewrite: () => void;
  onPlainRetry: () => void;
  rewriting: boolean;
  onReopen: () => void;
}) {
  const [pasted, setPasted] = useState("");
  useEffect(() => setPasted(node.done?.pasted ?? ""), [node.id, node.done]);
  if (node.kind === "approval") {
    const reviewed = node.inputs.flatMap((ref) => {
      const source = flow.nodes.find((n) => n.id === ref.node);
      return source && isWork(source) ? [source] : [];
    });
    return (
      <div className="flow-run">
        <div className="flow-side-head">
          <h3>{node.text || "Approval"}</h3>
        </div>
        <p className="flow-muted">Nothing after this starts until you approve it.</p>
        {reviewed.length > 0 && (
          <div className="flow-inside-list">
            <span className="flow-inside-label">What to look at</span>
            <ul>
              {reviewed.map((step) => (
                <li key={step.id}>
                  {step.text || step.id}
                  {step.done?.pasted.trim() && <em> — {step.done.pasted.trim().slice(0, 140)}</em>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <label className="flow-field">
          <span>Your note (optional)</span>
          <textarea rows={3} value={pasted} onChange={(e) => setPasted(e.target.value)} />
        </label>
        {node.done ? (
          <button type="button" className="flow-button" onClick={onReopen}>
            Take the approval back
          </button>
        ) : (
          <button type="button" className="flow-button primary" onClick={() => onDone(pasted)}>
            <CheckIcon /> Approve
          </button>
        )}
      </div>
    );
  }
  if (node.kind === "wait") {
    const until = waitUntil(flow, node);
    const tool = flow.tools.find((t) => t.id === node.wait?.toolId);
    return (
      <div className="flow-run">
        <div className="flow-side-head">
          <h3>Wait for reset</h3>
        </div>
        <p className="flow-muted">
          {tool && node.wait ? `Holding for ${tool.name}'s ${node.wait.window} limit. ` : "No limit chosen. "}
          {until === null ? "Set when it resets in the Tools panel." : `It resets ${resetsIn(until)}.`}
        </p>
        <p className="flow-muted">This step finishes by itself when the time comes.</p>
        {node.done ? (
          <button type="button" className="flow-button" onClick={onReopen}>
            Wait again
          </button>
        ) : (
          <button type="button" className="flow-button" onClick={() => onDone("")}>
            I know it has reset
          </button>
        )}
      </div>
    );
  }
  if (node.kind === "translator") {
    const st = translatorState(flow, node);
    return (
      <div className="flow-run">
        <div className="flow-side-head">
          <h3>Translator</h3>
        </div>
        <p className="flow-muted">
          {st === "waiting"
            ? "Waiting for the answers wired into it. It finishes by itself."
            : st === "skipped"
              ? "Skipped: the branch that leads here was not taken."
              : "Done by itself. This is what the steps after it receive:"}
        </p>
        {st === "live" && <pre className="flow-prompt">{translatedText(flow, node) || "(no answers yet)"}</pre>}
      </div>
    );
  }
  if (node.kind === "start" || node.kind === "end") {
    return (
      <div className="flow-run">
        <div className="flow-side-head">
          <h3>{node.kind === "start" ? "Start" : "End"}</h3>
        </div>
        <p className="flow-muted">
          {node.kind === "start"
            ? "This is where the workflow begins. What it holds is already there, so the first steps are ready."
            : doneOf(flow, node)
              ? "Reached. Everything before this End is done."
              : "Reached once everything before it is done. There is nothing to copy here."}
        </p>
      </div>
    );
  }
  const waiting = dependencies(node).filter((id) => !flow.nodes.find((n) => n.id === id)?.done);
  const tool = flow.tools.find((t) => t.id === node.toolId);
  const model = effectiveModel(flow, node);
  return (
    <div className="flow-run">
      <div className="flow-side-head">
        <h3>{node.text || "Untitled step"}</h3>
      </div>
      <p className="flow-muted">
        {node.kind === "verifier"
          ? "Check"
          : tool
            ? `${tool.name} · ${tool.tier}${model ? ` · ${model.name} (${model.capability})` : ""}`
            : "No tool picked"}
        {isFirst && !node.done && " · start here"}
        {!fitsQuota(flow, node) && " · won't finish in the quota you set"}
      </p>
      {waiting.length > 0 && !node.done && (
        <p className="flow-warn-box">Waiting for {waiting.join(", ")}.</p>
      )}
      {isSkipped(flow, node) && (
        <p className="flow-muted">
          Skipped: {node.when ? `it only runs if {${node.when.name}} is ${node.when.equals}` : "everything it waits for was skipped"}.
        </p>
      )}
      {!isSkipped(flow, node) && blockedByAsks(flow, node) && !node.done && (
        <p className="flow-warn-box">
          Waiting for your answer to{" "}
          {[
            ...(node.asks ?? []).filter((n) => !n.optional).map((n) => (flow.asks ?? []).find((a) => a.id === n.ask)),
            ...(node.when ? [[...(flow.asks ?? [])].find((a) => a.fields.some((f) => f.name === node.when!.name))] : []),
          ]
            .filter((a): a is FlowAsk => Boolean(a) && !isAnswered(a as FlowAsk))
            .map((a) => a.title || "a question")
            .join(", ")}
          . Answer it from the Next bar or the square.
        </p>
      )}
      {node.failed && !node.done && (
        <div className="flow-fail-box">
          <p>
            Attempt {node.failed.attempts} failed.{" "}
            {node.failed.retry
              ? "The prompt below is the retry the model rewrote."
              : `The prompt below asks for a retry${node.failed.error ? " and includes the error you pasted." : "."}`}
          </p>
          <div className="flow-run-actions">
            <button
              type="button"
              className="flow-button"
              disabled={rewriting}
              title="Optional. Sends this step, its prompt and the error to the cloud model: one request."
              onClick={onRewrite}
            >
              {rewriting ? "Rewriting…" : node.failed.retry ? "Rewrite again" : "Rewrite with AI (optional)"}
            </button>
            {node.failed.retry && (
              <button type="button" className="flow-button" onClick={onPlainRetry}>
                Use the plain retry
              </button>
            )}
          </div>
        </div>
      )}
      {node.readable?.trim() && <p className="flow-readable flow-sticky">{node.readable.trim()}</p>}
      {node.sub && node.sub.length > 0 && (
        <div className="flow-inside-list">
          <span className="flow-inside-label">Inside this step</span>
          <ul>
            {node.sub.map((step) => (
              <li key={step.id}>{step.text || step.id}</li>
            ))}
          </ul>
          <button type="button" className="flow-button" onClick={onOpenInside}>
            Open inside
          </button>
        </div>
      )}
      {node.critic && !node.done ? (
        <CriticRun flow={flow} node={node} onFlow={onFlow} onReopen={onReopen} />
      ) : (
      <>
      <pre className="flow-prompt">{nodePrompt(flow, node)}</pre>
      <button type="button" className="flow-button primary" onClick={onCopy}>
        <CopyIcon /> {copied ? "Copied" : "Copy prompt"}
      </button>
      <label className="flow-field">
        <span>What came out (pasted back). If it failed, paste the error.</span>
        <textarea
          value={pasted}
          rows={4}
          placeholder="Paste the tool's summary so later prompts can use it, or the error if it failed. Optional."
          onChange={(e) => setPasted(e.target.value)}
        />
      </label>
      {node.done ? (
        <button type="button" className="flow-button" onClick={onReopen}>
          Reopen this step
        </button>
      ) : (
        <div className="flow-run-actions">
          <button type="button" className="flow-button primary" onClick={() => onDone(pasted)}>
            <CheckIcon /> Mark done
          </button>
          <button
            type="button"
            className="flow-button"
            title="The attempt did not work. What is pasted above becomes the error in the retry prompt."
            onClick={() => {
              onFail(pasted);
              setPasted("");
            }}
          >
            It failed
          </button>
        </div>
      )}
      </>
      )}
    </div>
  );
}

/**
 * A small map of everything that is used, with a frame showing what the screen sees.
 * Drag it to move the view. A click on a step jumps to that step; a click on empty
 * map jumps to the step nearest to where the camera is looking now, which is the way
 * back when you have wandered off into empty space.
 */
function MiniMap({
  boxes,
  cam,
  viewport,
  selectedId,
  onCenter,
  onNode,
  onNearest,
}: {
  boxes: Box[];
  cam: { x: number; y: number; k: number };
  viewport: { w: number; h: number };
  selectedId: string | null;
  onCenter: (wx: number, wy: number) => void;
  onNode: (box: Box) => void;
  onNearest: () => void;
}) {
  const W = 200;
  const H = 132;
  const INSET = 10;
  const view = { x: -cam.x / cam.k, y: -cam.y / cam.k, w: viewport.w / cam.k, h: viewport.h / cam.k };
  // The map covers the used canvas and also wherever the camera is, so the frame never leaves it.
  const x0 = Math.min(view.x, ...boxes.map((b) => b.x));
  const y0 = Math.min(view.y, ...boxes.map((b) => b.y));
  const x1 = Math.max(view.x + view.w, ...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(view.y + view.h, ...boxes.map((b) => b.y + b.height));
  const s = Math.min((W - INSET * 2) / (x1 - x0), (H - INSET * 2) / (y1 - y0));
  const ox = (W - (x1 - x0) * s) / 2 - x0 * s;
  const oy = (H - (y1 - y0) * s) / 2 - y0 * s;
  const toWorld = (mx: number, my: number) => ({ x: (mx - ox) / s, y: (my - oy) / s });

  function down(e: ReactPointerEvent<SVGSVGElement>) {
    e.preventDefault();
    e.stopPropagation();
    const svg = e.currentTarget;
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = svg.getBoundingClientRect();
      return toWorld(((ev.clientX - r.left) / r.width) * W, ((ev.clientY - r.top) / r.height) * H);
    };
    const start = { x: e.clientX, y: e.clientY };
    let dragged = false;
    const move = (ev: PointerEvent) => {
      if (!dragged && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      dragged = true;
      const p = at(ev);
      onCenter(p.x, p.y);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (dragged) return;
      const p = at(ev);
      const hit = boxes.find((b) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height);
      if (hit) onNode(hit);
      else onNearest();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <svg
      className="flow-minimap"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Map of the whole canvas. Click to jump to the nearest step, or drag to move."
      onPointerDown={down}
    >
      {boxes.map((b) => (
        <rect
          key={b.id}
          className={`flow-minimap-node ${b.id === selectedId ? "selected" : ""}`}
          x={b.x * s + ox}
          y={b.y * s + oy}
          width={Math.max(3, b.width * s)}
          height={Math.max(3, b.height * s)}
          rx={1.5}
        />
      ))}
      <rect
        className="flow-minimap-view"
        x={view.x * s + ox}
        y={view.y * s + oy}
        width={view.w * s}
        height={view.h * s}
      />
    </svg>
  );
}

/** Name, colour and removal for the selected container. */
function ContainerPanel({
  container,
  onChange,
  onRemove,
}: {
  container: FlowContainer;
  onChange: (patch: Partial<Omit<FlowContainer, "id">>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flow-inspector">
      <div className="flow-side-head">
        <h3>Container</h3>
        <button type="button" className="flow-icon-button" aria-label="Remove this container" onClick={onRemove}>
          <TrashIcon />
        </button>
      </div>
      <label className="flow-field">
        <span>Name</span>
        <input value={container.name} placeholder="What this part is" onChange={(e) => onChange({ name: e.target.value })} />
      </label>
      <button type="button" className="flow-button" onClick={() => onChange({ collapsed: !container.collapsed })}>
        {container.collapsed ? "Show the steps inside" : "Fold the steps inside"}
      </button>
      <div className="flow-group">
        <h4>Colour</h4>
        <div className="flow-swatches" role="radiogroup" aria-label="Container colour">
          {Object.entries(CONTAINER_COLORS).map(([name, value]) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={container.color === name}
              aria-label={name}
              title={name}
              className={`flow-swatch ${container.color === name ? "on" : ""}`}
              style={{ background: value }}
              onClick={() => onChange({ color: name })}
            />
          ))}
        </div>
      </div>
      <p className="flow-muted">Drag its title to move it and the corner to resize it. It only marks a part of the canvas, so steps inside keep working as before.</p>
    </div>
  );
}

/**
 * The list of kinds, grouped. Hovering a group opens a side pane with everything in it; a group with
 * one kind is a plain item. `side` says which way the pane opens, so it never runs off the screen.
 */
function KindMenu({
  options,
  onPick,
  side = "right",
}: {
  options: KindOption[];
  onPick: (option: KindOption) => void;
  side?: "left" | "right";
}) {
  const [open, setOpen] = useState<string | null>(null);
  const groups = KIND_GROUPS.map((g) => ({ ...g, items: options.filter((o) => o.group === g.key) })).filter(
    (g) => g.items.length > 0,
  );
  return (
    <div className="flow-kinds" onPointerLeave={() => setOpen(null)}>
      {groups.map((g) =>
        g.items.length === 1 && g.key !== "preset" ? (
          <button
            key={g.key}
            type="button"
            role="menuitem"
            className="flow-kinds-row"
            onPointerEnter={() => setOpen(null)}
            onClick={() => onPick(g.items[0])}
          >
            {g.items[0].short}
          </button>
        ) : (
          <div key={g.key} className="flow-kinds-group" onPointerEnter={() => setOpen(g.key)}>
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open === g.key}
              className="flow-kinds-row"
              onClick={() => setOpen(open === g.key ? null : g.key)}
            >
              {g.label}
              <span className="flow-kinds-arrow" aria-hidden="true">
                {side === "left" ? "◂" : "▸"}
              </span>
            </button>
            {open === g.key && (
              <div className={`flow-kinds-pane ${side}`} role="menu" aria-label={g.label}>
                {g.items.map((k) => (
                  <span key={k.key} className="flow-kinds-item">
                    <button type="button" role="menuitem" onClick={() => onPick(k)}>
                      {k.short}
                    </button>
                    {k.remove && (
                      <button type="button" className="flow-kinds-remove" aria-label={`Remove ${k.short}`} title="Remove this saved piece" onClick={k.remove}>
                        ×
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}

/** Undo and redo for each workflow, kept for as long as the app is open. */
interface History {
  past: Flow[];
  future: Flow[];
  /** When the last change was recorded, so a burst of typing counts as one step. */
  at: number;
}

export function FlowStudio({
  openId,
  onActive,
  onDraw,
  onSettings,
  onPlan,
}: {
  /** Open the model settings. */
  onSettings?: () => void;
  /** Open the written plan beside the canvas. */
  onPlan?: () => void;
  /** Draw a whole workflow from a few words; it arrives in the list when it is done. */
  onDraw?: (ask: string) => void;
  /** A workflow to open now, such as one the chat just had written; changing it opens that one. */
  openId?: string;
  /** Told which workflow is open (or none), so the page can show its whole plan beside it. */
  onActive?: (flow: Flow | null) => void;
}) {
  const [flows, setFlows] = useState<Flow[]>(() => loadFlows());
  const [activeId, setActiveId] = useState<string | null>(openId ?? null);
  // The Studio no longer remounts when the chat opens a workflow, so a new `openId` has to open it here.
  useEffect(() => {
    if (openId) setActiveId(openId);
  }, [openId]);
  const flowsRef = useRef(flows);
  const histories = useRef(new Map<string, History>());

  useEffect(() => saveFlows(flows), [flows]);

  // A workflow the cloud model finishes while this view is open: take it in, or the next save would drop it.
  useEffect(() => {
    const onAdded = (event: Event) => {
      const added = (event as CustomEvent<Flow>).detail;
      if (!added || flowsRef.current.some((f) => f.id === added.id)) return;
      flowsRef.current = [added, ...flowsRef.current];
      setFlows(flowsRef.current);
    };
    window.addEventListener(FLOW_ADDED, onAdded);
    return () => window.removeEventListener(FLOW_ADDED, onAdded);
  }, []);

  // An edit the chat's editor made and the person accepted: taken in as an ordinary change, so Cmd+Z undoes it.
  const changeRef = useRef<(next: Flow) => void>(() => {});
  useEffect(() => {
    const onReplaced = (event: Event) => {
      const next = (event as CustomEvent<Flow>).detail;
      if (!next || !flowsRef.current.some((f) => f.id === next.id)) return;
      // The canvas holds a proposal: an edit from the Plan pane now would be written over when it is applied.
      if (proposalWaitingFor(next.id)) return;
      changeRef.current(next);
    };
    window.addEventListener(FLOW_REPLACED, onReplaced);
    return () => window.removeEventListener(FLOW_REPLACED, onReplaced);
  }, []);

  const active = flows.find((f) => f.id === activeId) ?? null;
  useEffect(() => {
    onActive?.(active);
  }, [active, onActive]);
  useEffect(() => () => onActive?.(null), [onActive]);

  function put(next: Flow) {
    flowsRef.current = flowsRef.current.map((f) => (f.id === next.id ? next : f));
    setFlows(flowsRef.current);
  }

  function historyOf(id: string): History {
    let h = histories.current.get(id);
    if (!h) {
      h = { past: [], future: [], at: 0 };
      histories.current.set(id, h);
    }
    return h;
  }

  function change(next: Flow, silent = false) {
    const prev = flowsRef.current.find((f) => f.id === next.id);
    if (prev && prev !== next && !silent) {
      const h = historyOf(next.id);
      const now = Date.now();
      // Edits within 0.7 s of each other (typing, a slider) are one undo step.
      if (h.past.length === 0 || now - h.at > 700) {
        h.past.push(prev);
        if (h.past.length > 100) h.past.shift();
      }
      h.at = now;
      h.future = [];
    }
    put(next);
  }
  changeRef.current = (next: Flow) => change(next);

  function undo() {
    const current = flowsRef.current.find((f) => f.id === activeId);
    if (!current) return;
    const h = historyOf(current.id);
    const back = h.past.pop();
    if (!back) return;
    h.future.push(current);
    h.at = 0;
    put(back);
  }

  function redo() {
    const current = flowsRef.current.find((f) => f.id === activeId);
    if (!current) return;
    const h = historyOf(current.id);
    const forward = h.future.pop();
    if (!forward) return;
    h.past.push(current);
    h.at = 0;
    put(forward);
  }

  // Cmd or Ctrl+Z undoes, with Shift (or Cmd+Y) it redoes. Text fields keep their own undo.
  useEffect(() => {
    if (!activeId) return;
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (!(e.metaKey || e.ctrlKey) || (key !== "z" && key !== "y")) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      e.preventDefault();
      if (key === "y" || e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function create(flow: Flow) {
    flowsRef.current = [flow, ...flowsRef.current];
    setFlows(flowsRef.current);
    setActiveId(flow.id);
  }

  // ---- The palette: the open canvas lists its own commands when it opens; the studio adds its own. ----
  const source = useRef<CommandSource | null>(null);
  const [palette, setPalette] = useState<{ commands: Command[]; scope?: { label: string; commands: Command[] }; paths?: Map<string, Dir[]>; query: string } | null>(null);

  /** What the studio itself can do, whichever view is open. */
  function studioCommands(): Command[] {
    const out: Command[] = [];
    const g = (id: string, name: string, run: () => void, extra: Partial<Command> = {}) => out.push({ id, name, run, ...extra });
    if (activeId) {
      g("studio.undo", "Undo", undo, { keys: "⌘Z" });
      g("studio.redo", "Redo", redo, { keys: "⇧⌘Z" });
      g("studio.all", "All workflows", () => setActiveId(null), { keywords: "library list switch close" });
    }
    g("studio.new", "New workflow", () => create(newFlow("")), { keywords: "create blank" });
    g("studio.example", "Try the example workflow", () => create(exampleFlow()), { keywords: "sample" });
    for (const f of flowsRef.current) {
      if (f.id === activeId) continue;
      g(`studio.open.${f.id}`, `Open workflow: ${f.title || "Untitled workflow"}`, () => setActiveId(f.id), { keywords: "switch" });
    }
    if (onPlan) g("studio.plan", "Open the written plan", onPlan, { keywords: "brief document pane" });
    if (onSettings) g("studio.settings", "Settings", onSettings, { keys: "⌘,", keywords: "model provider preferences" });
    return out;
  }

  function openPalette(opts?: { target?: Target; query?: string }) {
    const mine = activeId ? source.current?.(opts?.target ?? null) : undefined;
    const commands = [...(mine?.commands ?? []), ...studioCommands()];
    setPalette({ commands, scope: mine?.scope, paths: mine?.paths, query: opts?.query ?? "" });
  }
  const link: StudioLink = { source, openPalette, studioCommands };

  // Command-K opens the palette anywhere in the studio.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      if (palette) setPalette(null);
      else openPalette();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className={`workflows-view flow-studio ${active ? "editing" : ""}`}>
      {active ? (
        <FlowCanvas flow={active} studio={link} onChange={change} onBack={() => setActiveId(null)} onDraw={onDraw} />
      ) : (
        <Library
          flows={flows}
          onOpen={setActiveId}
          onCreate={() => create(newFlow(""))}
          onExample={() => create(exampleFlow())}
          onImport={create}
          onDelete={(id) => {
            flowsRef.current = flowsRef.current.filter((f) => f.id !== id);
            histories.current.delete(id);
            forgetHistory(id);
            setFlows(flowsRef.current);
          }}
        />
      )}
      {palette && <Palette commands={palette.commands} scope={palette.scope} paths={palette.paths} initialQuery={palette.query} onClose={() => setPalette(null)} />}
    </div>
  );
}
