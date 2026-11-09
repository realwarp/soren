import { describe, expect, it } from "vitest";
import { layoutWorkflow, routeWorkflowEdges } from "./workflowGraph";
import type { WorkflowTask } from "./workflowGraph";

function task(id: string, dependsOn: string[] = []): WorkflowTask {
  return { id, text: `Task ${id}`, dependsOn };
}

function sample(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const samples: Array<{ x: number; y: number }> = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance / 2));
    for (let step = 0; step <= steps; step += 1) {
      const ratio = step / steps;
      samples.push({
        x: from.x + (to.x - from.x) * ratio,
        y: from.y + (to.y - from.y) * ratio,
      });
    }
  }
  return samples;
}

describe("layoutWorkflow", () => {
  it("places tasks in columns by dependency depth", () => {
    const layout = layoutWorkflow([
      task("t1"),
      task("t2", ["t1"]),
      task("t3", ["t2"]),
      task("t4"),
    ]);

    expect(layout.byId.get("t1")?.depth).toBe(0);
    expect(layout.byId.get("t4")?.depth).toBe(0);
    expect(layout.byId.get("t2")?.depth).toBe(1);
    expect(layout.byId.get("t3")?.depth).toBe(2);
    expect(layout.stages).toHaveLength(3);
    expect(layout.stages[2].count).toBe(1);
    expect(layout.width).toBeGreaterThan(layout.stages[2].x);
  });

  it("uses the longest dependency path, not the first parent", () => {
    const layout = layoutWorkflow([
      task("a"),
      task("b", ["a"]),
      task("c", ["b"]),
      task("d", ["a", "c"]),
    ]);

    expect(layout.byId.get("d")?.depth).toBe(3);
  });

  it("keeps empty input to a sane canvas", () => {
    const layout = layoutWorkflow([]);
    expect(layout.nodes).toHaveLength(0);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });
});

describe("routeWorkflowEdges", () => {
  it("never routes through a task rectangle", () => {
    const tasks = [
      task("a"),
      task("b", ["a"]),
      task("c", ["b"]),
      task("d", ["c"]),
    ];
    const layout = layoutWorkflow(tasks);
    const edges = routeWorkflowEdges(tasks, layout);

    expect(edges).toHaveLength(3);
    for (const edge of edges) {
      for (const point of sample(edge.points)) {
        for (const node of layout.nodes) {
          const inside =
            point.x > node.x + 1 &&
            point.x < node.x + node.width - 1 &&
            point.y > node.y + 1 &&
            point.y < node.y + node.height - 1;
          expect(inside, `${edge.id} crosses ${node.id}`).toBe(false);
        }
      }
    }
  });

  it("routes a skip edge around the tasks in between", () => {
    const tasks = [
      task("a"),
      task("b", ["a"]),
      task("c", ["b"]),
      task("d", ["c"]),
      task("e", ["a", "d"]),
    ];
    const layout = layoutWorkflow(tasks);
    const edges = routeWorkflowEdges(tasks, layout);
    const skip = edges.find((edge) => edge.id === "a->e");

    expect(skip).toBeDefined();
    const firstNode = layout.byId.get("b");
    const lastNode = layout.byId.get("d");
    expect(firstNode).toBeDefined();
    expect(lastNode).toBeDefined();
    // The path has to leave the node band to get around b, c, and d — either
    // above the first row or below the last one.
    expect(
      skip?.points.some(
        (point) =>
          point.y < (firstNode?.y ?? 0) ||
          point.y > (lastNode?.y ?? 0) + (lastNode?.height ?? 0),
      ),
    ).toBe(true);
  });

  it("does not emit backwards or missing edges", () => {
    const tasks = [task("a"), task("b", ["a", "missing"])];
    const layout = layoutWorkflow(tasks);
    const edges = routeWorkflowEdges(tasks, layout);
    expect(edges.map((edge) => edge.id)).toEqual(["a->b"]);
  });

  it("produces an SVG path for every edge", () => {
    const tasks = [task("a"), task("b", ["a"])];
    const layout = layoutWorkflow(tasks);
    const edges = routeWorkflowEdges(tasks, layout);
    expect(edges[0].path.startsWith("M ")).toBe(true);
    expect(edges[0].path.length).toBeGreaterThan(10);
  });

  it("keeps every segment horizontal or vertical", () => {
    const tasks = [
      task("a"),
      task("b"),
      task("c", ["a", "b"]),
      task("d", ["c"]),
      task("e", ["c"]),
      task("f", ["d", "e"]),
      task("g", ["a", "f"]),
    ];
    const layout = layoutWorkflow(tasks);
    const edges = routeWorkflowEdges(tasks, layout);

    for (const edge of edges) {
      for (let index = 1; index < edge.points.length; index += 1) {
        const from = edge.points[index - 1];
        const to = edge.points[index];
        const horizontal = Math.abs(from.y - to.y) < 0.5;
        const vertical = Math.abs(from.x - to.x) < 0.5;
        expect(horizontal || vertical, `${edge.id} has a diagonal segment`).toBe(
          true,
        );
      }
    }
  });

  it("avoids every node in a branching graph", () => {
    const tasks = [
      task("a"),
      task("b"),
      task("c", ["a", "b"]),
      task("d", ["c"]),
      task("e", ["c"]),
      task("f", ["d", "e"]),
      task("g", ["a", "f"]),
    ];
    const layout = layoutWorkflow(tasks);
    const edges = routeWorkflowEdges(tasks, layout);

    for (const edge of edges) {
      for (const point of sample(edge.points)) {
        for (const node of layout.nodes) {
          const inside =
            point.x > node.x + 1 &&
            point.x < node.x + node.width - 1 &&
            point.y > node.y + 1 &&
            point.y < node.y + node.height - 1;
          expect(inside, `${edge.id} crosses ${node.id}`).toBe(false);
        }
      }
    }
  });
});
