/** One box in a layout: its id, its words and the ids it waits for. */
export interface WorkflowTask {
  id: string;
  text: string;
  dependsOn: string[];
}

/**
 * Layout and edge routing for the workflow canvas.
 *
 * Soren's workflow graph is not freeform. Tasks sit in columns by dependency
 * depth, and edges move left to right. The router still has to solve the real
 * problem: a task can depend on one from several columns back, so a straight
 * line would cut through the nodes in between. We route every edge around
 * obstacles on a small grid instead.
 */

export interface GraphPoint {
  x: number;
  y: number;
}

export interface WorkflowNode {
  id: string;
  text: string;
  depth: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkflowStage {
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
}

export interface WorkflowLayout {
  nodes: WorkflowNode[];
  byId: Map<string, WorkflowNode>;
  stages: WorkflowStage[];
  width: number;
  height: number;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  points: GraphPoint[];
  path: string;
}

export const GRAPH = {
  nodeWidth: 176,
  nodeHeight: 76,
  columnGap: 56,
  rowGap: 20,
  headerHeight: 38,
  headerGap: 16,
  topBand: 56,
  padding: 22,
  bottomPadding: 28,
} as const;

const CELL = 8;
const CLEARANCE = 8;
// Ports sit far enough from the node that the A* grid can leave the obstacle
// band. The renderer draws a connector from the node edge to this point.
const PORT_OFFSET = 24;
const TURN_COST = 6;
const OCCUPANCY_COST = 2.5;

function emptyLayout(): WorkflowLayout {
  return {
    nodes: [],
    byId: new Map(),
    stages: [],
    width: GRAPH.padding * 2 + GRAPH.nodeWidth,
    height:
      GRAPH.topBand +
      GRAPH.headerHeight +
      GRAPH.headerGap +
      GRAPH.nodeHeight +
      GRAPH.bottomPadding,
  };
}

/**
 * Assign each task a dependency depth. Missing or self dependencies are
 * ignored. A cycle cannot normally reach here (validation rejects it), but the
 * guard keeps the layout from recursing forever if one does.
 */
function taskDepths(tasks: WorkflowTask[]): {
  depths: Map<string, number>;
  maxDepth: number;
} {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  function depthOf(id: string): number {
    const known = depths.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    const task = byId.get(id);
    if (!task) return 0;
    visiting.add(id);
    const parents = task.dependsOn.filter(
      (dependency) => dependency !== id && byId.has(dependency),
    );
    const depth =
      parents.length === 0
        ? 0
        : Math.max(...parents.map((parent) => depthOf(parent))) + 1;
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  }

  for (const task of tasks) depthOf(task.id);
  return {
    depths,
    maxDepth: Math.max(0, ...depths.values()),
  };
}

export function layoutWorkflow(tasks: WorkflowTask[]): WorkflowLayout {
  if (tasks.length === 0) return emptyLayout();

  const { depths, maxDepth } = taskDepths(tasks);
  const groups = new Map<number, WorkflowTask[]>();
  for (const task of tasks) {
    const depth = depths.get(task.id) ?? 0;
    groups.set(depth, [...(groups.get(depth) ?? []), task]);
  }

  // Order each column by the average row of its parents. This keeps dependency
  // lines short and stops a simple graph from looking tangled.
  const rowById = new Map<string, number>();
  const ordered: Array<{ task: WorkflowTask; depth: number; row: number }> = [];
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const group = groups.get(depth) ?? [];
    const ranked =
      depth === 0
        ? group.map((task, index) => ({ task, index, barycenter: index }))
        : group.map((task, index) => {
            const rows = task.dependsOn
              .map((dependency) => rowById.get(dependency))
              .filter((row): row is number => row !== undefined);
            return {
              task,
              index,
              barycenter:
                rows.length === 0
                  ? index
                  : rows.reduce((sum, row) => sum + row, 0) / rows.length,
            };
          });
    ranked.sort(
      (left, right) =>
        left.barycenter - right.barycenter || left.index - right.index,
    );
    ranked.forEach((entry, row) => {
      rowById.set(entry.task.id, row);
      ordered.push({ task: entry.task, depth, row });
    });
  }

  const nodes: WorkflowNode[] = ordered.map(({ task, depth, row }) => ({
    id: task.id,
    text: task.text,
    depth,
    row,
    x: GRAPH.padding + depth * (GRAPH.nodeWidth + GRAPH.columnGap),
    y:
      GRAPH.topBand +
      GRAPH.headerHeight +
      GRAPH.headerGap +
      row * (GRAPH.nodeHeight + GRAPH.rowGap),
    width: GRAPH.nodeWidth,
    height: GRAPH.nodeHeight,
  }));

  const rowCounts = new Map<number, number>();
  for (const node of nodes) {
    rowCounts.set(node.depth, Math.max(rowCounts.get(node.depth) ?? 0, node.row + 1));
  }

  const stages: WorkflowStage[] = [];
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    stages.push({
      depth,
      x: GRAPH.padding + depth * (GRAPH.nodeWidth + GRAPH.columnGap),
      y: GRAPH.topBand,
      width: GRAPH.nodeWidth,
      height: GRAPH.headerHeight,
      count: groups.get(depth)?.length ?? 0,
    });
  }

  const maxRows = Math.max(1, ...rowCounts.values());
  return {
    nodes,
    byId: new Map(nodes.map((node) => [node.id, node])),
    stages,
    width:
      GRAPH.padding * 2 +
      (maxDepth + 1) * GRAPH.nodeWidth +
      maxDepth * GRAPH.columnGap,
    height:
      GRAPH.topBand +
      GRAPH.headerHeight +
      GRAPH.headerGap +
      maxRows * GRAPH.nodeHeight +
      (maxRows - 1) * GRAPH.rowGap +
      GRAPH.bottomPadding,
  };
}

interface HeapEntry {
  key: number;
  cell: number;
  x: number;
  y: number;
  direction: number;
  cost: number;
  estimate: number;
}

class MinHeap {
  private items: HeapEntry[] = [];

  get size() {
    return this.items.length;
  }

  push(entry: HeapEntry) {
    this.items.push(entry);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent].estimate <= this.items[index].estimate) break;
      [this.items[parent], this.items[index]] = [
        this.items[index],
        this.items[parent],
      ];
      index = parent;
    }
  }

  pop(): HeapEntry | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop();
    if (!last) return top;
    if (this.items.length > 0) {
      this.items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (
          left < this.items.length &&
          this.items[left].estimate < this.items[smallest].estimate
        ) {
          smallest = left;
        }
        if (
          right < this.items.length &&
          this.items[right].estimate < this.items[smallest].estimate
        ) {
          smallest = right;
        }
        if (smallest === index) break;
        [this.items[smallest], this.items[index]] = [
          this.items[index],
          this.items[smallest],
        ];
        index = smallest;
      }
    }
    return top;
  }
}

const DIRECTIONS = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
] as const;

function gridSize(layout: WorkflowLayout) {
  return {
    columns: Math.max(2, Math.ceil(layout.width / CELL) + 1),
    rows: Math.max(2, Math.ceil(layout.height / CELL) + 1),
  };
}

function blockedCells(layout: WorkflowLayout): Uint8Array {
  const { columns, rows } = gridSize(layout);
  const blocked = new Uint8Array(columns * rows);

  function mark(x: number, y: number, width: number, height: number) {
    const left = Math.max(0, Math.floor((x - CLEARANCE) / CELL));
    const right = Math.min(
      columns - 1,
      Math.ceil((x + width + CLEARANCE) / CELL),
    );
    const top = Math.max(0, Math.floor((y - CLEARANCE) / CELL));
    const bottom = Math.min(rows - 1, Math.ceil((y + height + CLEARANCE) / CELL));
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        blocked[row * columns + column] = 1;
      }
    }
  }

  for (const node of layout.nodes) {
    mark(node.x, node.y, node.width, node.height);
  }
  for (const stage of layout.stages) {
    mark(stage.x, stage.y, stage.width, stage.height);
  }
  return blocked;
}

function cellCenter(cell: number, columns: number): GraphPoint {
  return {
    x: (cell % columns) * CELL + CELL / 2,
    y: Math.floor(cell / columns) * CELL + CELL / 2,
  };
}

function routeCells(
  from: WorkflowNode,
  to: WorkflowNode,
  layout: WorkflowLayout,
  blocked: Uint8Array,
  used: Map<number, number>,
): GraphPoint[] {
  const { columns, rows } = gridSize(layout);
  const start = {
    x: from.x + from.width + PORT_OFFSET,
    y: from.y + from.height / 2,
  };
  const goal = {
    x: to.x - PORT_OFFSET,
    y: to.y + to.height / 2,
  };
  const startColumn = Math.min(
    columns - 1,
    Math.max(0, Math.floor(start.x / CELL)),
  );
  const startRow = Math.min(rows - 1, Math.max(0, Math.floor(start.y / CELL)));
  const goalColumn = Math.min(
    columns - 1,
    Math.max(0, Math.floor(goal.x / CELL)),
  );
  const goalRow = Math.min(rows - 1, Math.max(0, Math.floor(goal.y / CELL)));
  const startCell = startRow * columns + startColumn;
  const goalCell = goalRow * columns + goalColumn;

  // The ports sit just outside the obstacle band. Keeping those two cells open
  // lets the path start and end at the node without letting it cross the node.
  blocked[startCell] = 0;
  blocked[goalCell] = 0;

  if (startCell === goalCell) return [start, goal];

  const stateCount = columns * rows * 4;
  const best = new Float64Array(stateCount);
  best.fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(stateCount);
  parent.fill(-1);

  const startKey = startCell * 4;
  best[startKey] = 0;
  const heap = new MinHeap();
  heap.push({
    key: startKey,
    cell: startCell,
    x: startColumn,
    y: startRow,
    direction: 0,
    cost: 0,
    estimate: Math.abs(goalColumn - startColumn) + Math.abs(goalRow - startRow),
  });

  let found: number | null = null;
  while (heap.size > 0) {
    const entry = heap.pop();
    if (!entry) break;
    if (entry.cost > best[entry.key] + 0.0001) continue;
    if (entry.cell === goalCell) {
      found = entry.key;
      break;
    }
    for (let direction = 0; direction < DIRECTIONS.length; direction += 1) {
      const step = DIRECTIONS[direction];
      const x = entry.x + step.x;
      const y = entry.y + step.y;
      if (x < 0 || x >= columns || y < 0 || y >= rows) continue;
      const cell = y * columns + x;
      if (blocked[cell] === 1 && cell !== goalCell) continue;
      const turn = direction === entry.direction ? 0 : TURN_COST;
      const occupancy = used.get(cell) ?? 0;
      const cost = entry.cost + 1 + turn + occupancy * OCCUPANCY_COST;
      const key = cell * 4 + direction;
      if (cost >= best[key] - 0.0001) continue;
      best[key] = cost;
      parent[key] = entry.key;
      heap.push({
        key,
        cell,
        x,
        y,
        direction,
        cost,
        estimate:
          cost + Math.abs(goalColumn - x) + Math.abs(goalRow - y),
      });
    }
  }

  if (found === null) {
    // The top band is always free of nodes and stage headers, so it is a
    // guaranteed way around any graph the router cannot solve.
    return [
      start,
      { x: start.x, y: GRAPH.topBand / 2 },
      { x: goal.x, y: GRAPH.topBand / 2 },
      goal,
    ];
  }

  const cells: number[] = [];
  let cursor: number = found;
  while (cursor !== -1) {
    cells.push(Math.floor(cursor / 4));
    cursor = parent[cursor];
  }
  cells.reverse();
  for (const cell of cells) used.set(cell, (used.get(cell) ?? 0) + 1);

  const points: GraphPoint[] = [start];
  for (const cell of cells) {
    const center = cellCenter(cell, columns);
    const last = points[points.length - 1];
    if (Math.abs(center.x - last.x) < 0.75 && Math.abs(center.y - last.y) < 0.75) {
      continue;
    }
    points.push(center);
  }
  points.push(goal);

  // Snap the first and last grid steps to the real port heights so the edge
  // leaves and enters horizontally instead of drifting by a few pixels.
  if (points.length > 2) {
    points[1] = { ...points[1], y: start.y };
    points[points.length - 2] = {
      ...points[points.length - 2],
      y: goal.y,
    };
  }
  return simplifyPoints(points);
}

function simplifyPoints(points: GraphPoint[]): GraphPoint[] {
  const simplified: GraphPoint[] = [];
  for (const point of points) {
    const last = simplified[simplified.length - 1];
    if (last && Math.abs(last.x - point.x) < 0.5 && Math.abs(last.y - point.y) < 0.5) {
      continue;
    }
    while (simplified.length >= 2) {
      const before = simplified[simplified.length - 2];
      const current = simplified[simplified.length - 1];
      const cross =
        (current.x - before.x) * (point.y - current.y) -
        (current.y - before.y) * (point.x - current.x);
      if (Math.abs(cross) > 0.001) break;
      simplified.pop();
    }
    simplified.push(point);
  }
  return simplified;
}

function roundedPath(points: GraphPoint[], radius = 9): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const inLength = Math.hypot(current.x - previous.x, current.y - previous.y);
    const outLength = Math.hypot(next.x - current.x, next.y - current.y);
    const limit = Math.min(radius, inLength / 2, outLength / 2);
    if (limit < 0.5) {
      path += ` L ${current.x} ${current.y}`;
      continue;
    }
    const inUnit = {
      x: (current.x - previous.x) / inLength,
      y: (current.y - previous.y) / inLength,
    };
    const outUnit = {
      x: (next.x - current.x) / outLength,
      y: (next.y - current.y) / outLength,
    };
    const before = {
      x: current.x - inUnit.x * limit,
      y: current.y - inUnit.y * limit,
    };
    const after = {
      x: current.x + outUnit.x * limit,
      y: current.y + outUnit.y * limit,
    };
    path += ` L ${before.x} ${before.y} Q ${current.x} ${current.y} ${after.x} ${after.y}`;
  }
  const last = points[points.length - 1];
  path += ` L ${last.x} ${last.y}`;
  return path;
}

/**
 * Route every dependency edge around the task rectangles. Edges are routed in
 * task order, with a small penalty for reusing a cell so parallel paths tend to
 * separate instead of lying on top of one another.
 */
export function routeWorkflowEdges(
  tasks: WorkflowTask[],
  layout: WorkflowLayout,
): WorkflowEdge[] {
  if (layout.nodes.length === 0) return [];
  const blocked = blockedCells(layout);
  const used = new Map<number, number>();
  const edges: WorkflowEdge[] = [];

  for (const task of tasks) {
    const to = layout.byId.get(task.id);
    if (!to) continue;
    for (const dependency of task.dependsOn) {
      const from = layout.byId.get(dependency);
      if (!from || to.depth <= from.depth) continue;
      const points = routeCells(from, to, layout, blocked, used);
      const connected = [
        { x: from.x + from.width, y: from.y + from.height / 2 },
        ...points,
        { x: to.x, y: to.y + to.height / 2 },
      ];
      edges.push({
        id: `${from.id}->${to.id}`,
        from: from.id,
        to: to.id,
        points: connected,
        path: roundedPath(connected),
      });
    }
  }

  return edges;
}

/**
 * Route wires between freely placed boxes, around every other box. Unlike
 * routeWorkflowEdges nothing here assumes columns or a left-to-right order:
 * a wire may need to loop back past its own source.
 */
export function routeBetween(
  pairs: Array<{ from: string; to: string }>,
  boxes: Array<{ id: string; x: number; y: number; width: number; height: number }>,
  bounds: { width: number; height: number },
): WorkflowEdge[] {
  if (boxes.length === 0) return [];
  const nodes: WorkflowNode[] = boxes.map((b, index) => ({
    id: b.id,
    text: "",
    depth: index,
    row: 0,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
  }));
  const layout: WorkflowLayout = {
    nodes,
    byId: new Map(nodes.map((n) => [n.id, n])),
    stages: [],
    width: bounds.width,
    height: bounds.height,
  };
  const blocked = blockedCells(layout);
  const used = new Map<number, number>();
  const edges: WorkflowEdge[] = [];
  for (const pair of pairs) {
    const from = layout.byId.get(pair.from);
    const to = layout.byId.get(pair.to);
    if (!from || !to) continue;
    const points = routeCells(from, to, layout, blocked, used);
    const connected = [
      { x: from.x + from.width, y: from.y + from.height / 2 },
      ...points,
      { x: to.x, y: to.y + to.height / 2 },
    ];
    edges.push({
      id: `${from.id}->${to.id}`,
      from: from.id,
      to: to.id,
      points: connected,
      path: roundedPath(connected),
    });
  }
  return edges;
}
