import { describe, expect, it } from "vitest";
import { addAgentNode, moveNode, newFlow, wire, addOutput, flowIssues } from "./flowModel";
import { anchor, boxOf, ensurePositions, extent, freeSlot, gridLayers, NODE_H, NODE_W, pickSides, roundedPath, route, snap, GRID, withStart } from "./flowLayout";

function chain() {
  let flow = newFlow("x");
  flow = addAgentNode(flow, "a");
  flow = addAgentNode(flow, "b");
  flow = addOutput(flow, "n1", "A out");
  return wire(flow, "n2", { node: "n1", port: "o1" });
}

describe("freeform positions", () => {
  it("lays a flow with no positions out once, then leaves it alone", () => {
    const placed = ensurePositions(chain());
    expect(placed.nodes.every((n) => n.pos)).toBe(true);
    expect(placed.nodes[1].pos!.x).toBeGreaterThan(placed.nodes[0].pos!.x);
    expect(ensurePositions(placed)).toBe(placed);
  });

  it("keeps positions the person set and only places the new node", () => {
    let flow = ensurePositions(chain());
    flow = moveNode(flow, "n1", { x: 500, y: 300 });
    flow = addAgentNode(flow, "c");
    const next = ensurePositions(flow);
    expect(next.nodes[0].pos).toEqual({ x: 500, y: 300 });
    expect(next.nodes[2].pos).toBeDefined();
    const [a, c] = [boxOf(next.nodes[0]), boxOf(next.nodes[2])];
    expect(Math.abs(a.x - c.x) >= NODE_W || Math.abs(a.y - c.y) >= NODE_H).toBe(true);
  });

  it("moving a node does not unlock the flow", () => {
    const flow = { ...ensurePositions(chain()), locked: true };
    expect(moveNode(flow, "n1", { x: 1, y: 2 }).locked).toBe(true);
  });

  it("finds a slot that touches nothing taken", () => {
    const first = freeSlot([]);
    const second = freeSlot([first]);
    expect(second).not.toEqual(first);
    expect(Math.abs(second.x - first.x) >= NODE_W || Math.abs(second.y - first.y) >= NODE_H).toBe(true);
  });

  const at = (x: number, y: number) => ({ id: "b", x, y, width: NODE_W, height: NODE_H });
  const home = at(100, 100);

  it("joins the sides that face each other", () => {
    expect(pickSides(home, at(500, 110))).toEqual(["right", "left"]);
    expect(pickSides(home, at(-300, 100))).toEqual(["left", "right"]);
    expect(pickSides(home, at(110, 400))).toEqual(["bottom", "top"]);
    expect(pickSides(home, at(100, -200))).toEqual(["top", "bottom"]);
  });

  it("runs a wire to a box beside it as a Z with the bend in the middle", () => {
    const to = at(500, 300);
    const r = route(home, to);
    const p = { x: home.x + NODE_W, y: home.y + NODE_H / 2 };
    const q = { x: to.x, y: to.y + NODE_H / 2 };
    const mx = (p.x + q.x) / 2;
    expect(r.points).toEqual([p, { x: mx, y: p.y }, { x: mx, y: q.y }, q]);
    expect(r.axis).toBe("x");
  });

  it("is a straight line when the two sit level", () => {
    expect(route(home, at(500, 100)).points).toHaveLength(2);
  });

  it("loops through the gap to a box below it, and bending slides the middle line", () => {
    const below = at(100, 400);
    const r = route(home, below, 30);
    expect(r.axis).toBe("y");
    // out of the right circle, down the gap, back along it, into the left circle
    expect(r.points).toHaveLength(6);
    expect(r.points[2].y).toBe(r.points[3].y);
    expect(r.points[2].y).toBe((home.y + NODE_H + below.y) / 2 + 30);
  });

  it("goes over the top of two steps that share a row when the target is behind", () => {
    const behind = at(-300, 100);
    const r = route(home, behind);
    expect(r.points[2].y).toBe(home.y - GRID);
    expect(r.points[2].y).toBeLessThan(home.y);
  });

  it("always leaves from the right circle and arrives at the left circle, wherever the target is", () => {
    for (const to of [at(500, 300), at(500, 100), at(100, 400), at(100, -300), at(-300, 100), at(150, 120)]) {
      const r = route(home, to);
      expect(r.points[0]).toEqual(anchor(home, "right"));
      expect(r.points[r.points.length - 1]).toEqual(anchor(to, "left"));
      // the first and last runs are horizontal, so the wire enters and leaves through the circles
      expect(r.points[1].y).toBe(r.points[0].y);
      expect(r.points[r.points.length - 2].y).toBe(r.points[r.points.length - 1].y);
    }
  });

  it("arrives at the middle of the left edge", () => {
    const to = at(500, 300);
    const r = route(home, to);
    expect(r.points[r.points.length - 1]).toEqual(anchor(to, "left"));
  });

  it("rounds each corner of a right-angle path", () => {
    const d = roundedPath(route(home, at(500, 300)).points);
    expect(d.match(/Q/g)).toHaveLength(2);
    expect(d.startsWith(`M ${home.x + NODE_W} ${home.y + NODE_H / 2}`)).toBe(true);
  });

  it("sizes the canvas to the farthest box", () => {
    const boxes = [{ id: "a", x: 10, y: 10, width: 100, height: 50 }, { id: "b", x: 300, y: 200, width: 100, height: 50 }];
    expect(extent(boxes, 10)).toEqual({ width: 410, height: 260 });
  });
});

describe("multi-scale grid", () => {
  it("has three layers, each four times coarser, thicker the farther apart", () => {
    const [a, b, c] = gridLayers(1);
    expect(b.spacing / a.spacing).toBe(4);
    expect(c.spacing / b.spacing).toBe(4);
    expect(b.width).toBeGreaterThanOrEqual(a.width);
    expect(b.alpha).toBeGreaterThanOrEqual(a.alpha);
  });

  it("keeps minor lines between 10 and 40 pixels apart at every zoom", () => {
    for (const k of [0.1, 0.17, 0.3, 0.5, 0.8, 1, 1.7, 3]) {
      const spacing = gridLayers(k)[0].spacing;
      expect(spacing).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(spacing).toBeLessThan(40 + 1e-9);
    }
  });

  it("hands over without a jump: the old thick lines become the new thin ones", () => {
    // Just before and after the level changes while zooming out.
    const k = 10 / 24;
    const before = gridLayers(k + 0.0001);
    const after = gridLayers(k - 0.0001);
    // What was the second layer is now the first.
    expect(after[0].spacing).toBeCloseTo(before[1].spacing, 1);
    expect(after[0].alpha).toBeCloseTo(before[1].alpha, 2);
    expect(after[0].width).toBeCloseTo(before[1].width, 2);
    // The finest layer was invisible at the moment it disappeared.
    expect(before[0].alpha).toBeLessThan(0.01);
  });

  it("the far coarse layer fades out so it never pops in", () => {
    const k = 40 / 24 - 0.0001;
    const layers = gridLayers(k);
    expect(layers[2].alpha).toBeLessThan(0.05);
  });
});

describe("cards sit on the grid", () => {
  it("a card is two heavy squares wide and one tall, in whole grid squares", () => {
    expect(NODE_W).toBe(GRID * 8);
    expect(NODE_H).toBe(GRID * 4);
    expect(NODE_W % GRID).toBe(0);
    expect(NODE_H % GRID).toBe(0);
  });

  it("snaps to the nearest grid line", () => {
    expect(snap(11)).toBe(0);
    expect(snap(13)).toBe(24);
    expect(snap(-30)).toBe(-24);
  });

  it("the first layout puts every card on a grid line and apart from the others", () => {
    const flow = ensurePositions(chain());
    for (const n of flow.nodes) {
      expect(n.pos!.x % GRID).toBe(0);
      expect(n.pos!.y % GRID).toBe(0);
    }
    const [a, b] = flow.nodes.map(boxOf);
    expect(Math.abs(a.x - b.x) >= NODE_W || Math.abs(a.y - b.y) >= NODE_H).toBe(true);
  });
});

describe("a Start for every workflow", () => {
  it("adds one to the left of the first steps and wires them to it, moving nothing", () => {
    let flow = ensurePositions(chain());
    flow = moveNode(flow, "n1", { x: 480, y: 240 });
    const next = withStart(flow);
    const start = next.nodes.find((n) => n.kind === "start")!;
    expect(start.pos!.x).toBeLessThan(480 - NODE_W);
    expect(next.nodes.find((n) => n.id === "n1")!.pos).toEqual({ x: 480, y: 240 });
    expect(next.nodes.find((n) => n.id === "n1")!.inputs[0].node).toBe(start.id);
    expect(next.nodes.find((n) => n.id === "n2")!.inputs.map((i) => i.node)).toEqual(["n1"]);
    expect(flowIssues(next).filter((i) => i.kind === "unreachable")).toEqual([]);
  });

  it("gives an empty workflow just a Start", () => {
    const next = withStart(newFlow("x"));
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0].kind).toBe("start");
  });

  it("leaves a workflow that has a Start alone, and does not touch its lock or age", () => {
    const once = withStart({ ...chain(), locked: true, revision: 7 });
    expect(once.locked).toBe(true);
    expect(once.revision).toBe(7);
    expect(withStart(once)).toBe(once);
  });
});
