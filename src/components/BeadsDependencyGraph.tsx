import React, { useMemo } from "react";
import type { BeadsTask } from "../types";

interface Props {
  tasks: BeadsTask[];
  agentTaskMap: Map<string, string>;
  onSelectTask?: (task: BeadsTask) => void;
}

interface GraphNode {
  id: string;
  task: BeadsTask;
  layer: number;
  col: number;
  x: number;
  y: number;
}

interface GraphEdge {
  from: string;
  to: string;
}

const NODE_W = 100;
const NODE_H = 40;
const LAYER_GAP = 80;
const COL_GAP = 20;
const PAD = 16;

const STATUS_COLORS: Record<string, string> = {
  done: "#9ece6a",
  "in-progress": "#7aa2f7",
  ready: "#e0af68",
  blocked: "#f7768e",
  open: "#a9b1d6",
};

function normalizeDeps(d: string[] | string | undefined): string[] {
  if (!d) return [];
  if (Array.isArray(d)) return d.filter(Boolean);
  return d.split(",").map(s => s.trim()).filter(Boolean);
}

function computeLayout(tasks: BeadsTask[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const edges: GraphEdge[] = [];
  const childrenOf = new Map<string, string[]>();

  for (const t of tasks) {
    const deps = normalizeDeps(t.deps);
    const blocked = normalizeDeps(t.blocked_by);
    const parentId = t.parent_id || t.parentId || t.parent;
    for (const d of [...deps, ...blocked]) {
      if (taskMap.has(d)) {
        edges.push({ from: d, to: t.id });
      }
    }
    if (parentId && taskMap.has(parentId)) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId)!.push(t.id);
      if (!edges.some(e => e.from === parentId && e.to === t.id)) {
        edges.push({ from: parentId, to: t.id });
      }
    }
  }

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const t of tasks) {
    inDegree.set(t.id, 0);
    adj.set(t.id, []);
  }
  for (const e of edges) {
    adj.get(e.from)?.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  const layers: string[][] = [];
  let frontier = tasks.filter(t => (inDegree.get(t.id) ?? 0) === 0).map(t => t.id);
  const visited = new Set<string>();

  while (frontier.length > 0) {
    layers.push(frontier);
    frontier.forEach(id => visited.add(id));
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of adj.get(id) ?? []) {
        inDegree.set(child, (inDegree.get(child) ?? 0) - 1);
        if ((inDegree.get(child) ?? 0) <= 0 && !visited.has(child)) {
          next.push(child);
          visited.add(child);
        }
      }
    }
    frontier = next;
  }

  for (const t of tasks) {
    if (!visited.has(t.id)) {
      if (layers.length === 0) layers.push([]);
      layers[layers.length - 1].push(t.id);
    }
  }

  const nodeMap = new Map<string, GraphNode>();
  for (let layer = 0; layer < layers.length; layer++) {
    const ids = layers[layer];
    for (let col = 0; col < ids.length; col++) {
      const task = taskMap.get(ids[col])!;
      nodeMap.set(ids[col], {
        id: ids[col],
        task,
        layer,
        col,
        x: PAD + layer * (NODE_W + LAYER_GAP),
        y: PAD + col * (NODE_H + COL_GAP),
      });
    }
  }

  return { nodes: Array.from(nodeMap.values()), edges };
}

export const BeadsDependencyGraph = React.memo(function BeadsDependencyGraph({
  tasks,
  agentTaskMap,
  onSelectTask,
}: Props) {
  const { nodes, edges } = useMemo(() => computeLayout(tasks), [tasks]);

  if (tasks.length === 0) {
    return <div className="beads-graph-empty">No tasks to visualize</div>;
  }

  const nodeMap = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);
  const maxX = Math.max(...nodes.map(n => n.x + NODE_W)) + PAD;
  const maxY = Math.max(...nodes.map(n => n.y + NODE_H)) + PAD;

  return (
    <div className="beads-graph" style={{ overflow: "auto" }}>
      <svg width={maxX} height={maxY} className="beads-graph-svg">
        <defs>
          <marker id="beads-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <path d="M 0 0 L 8 3 L 0 6 Z" fill="var(--ml-text-muted)" opacity="0.6" />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const from = nodeMap.get(e.from);
          const to = nodeMap.get(e.to);
          if (!from || !to) return null;
          const x1 = from.x + NODE_W;
          const y1 = from.y + NODE_H / 2;
          const x2 = to.x;
          const y2 = to.y + NODE_H / 2;
          const mx = (x1 + x2) / 2;
          return (
            <path
              key={i}
              d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke="var(--ml-text-muted)"
              strokeWidth="1.5"
              strokeOpacity="0.4"
              markerEnd="url(#beads-arrow)"
            />
          );
        })}
        {nodes.map(n => {
          const isActive = agentTaskMap.has(n.id);
          const statusColor = STATUS_COLORS[n.task.status] ?? "#a9b1d6";
          return (
            <g
              key={n.id}
              transform={`translate(${n.x}, ${n.y})`}
              className="beads-graph-node"
              onClick={() => onSelectTask?.(n.task)}
              style={{ cursor: "pointer" }}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={6}
                fill="var(--ml-bg-card)"
                stroke={statusColor}
                strokeWidth={isActive ? 2.5 : 1.5}
                opacity={n.task.status === "done" ? 0.5 : 1}
              />
              {isActive && (
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  fill="none"
                  stroke={statusColor}
                  strokeWidth={2}
                  opacity={0.4}
                  className="beads-graph-node-pulse"
                />
              )}
              <text
                x={NODE_W / 2}
                y={14}
                textAnchor="middle"
                fontSize="9"
                fontWeight="700"
                fontFamily="ui-monospace, monospace"
                fill="var(--ml-text-muted)"
              >
                {n.id.length > 12 ? n.id.slice(0, 11) + "…" : n.id}
              </text>
              <text
                x={NODE_W / 2}
                y={30}
                textAnchor="middle"
                fontSize="9"
                fill="var(--ml-text)"
              >
                {(n.task.title || "").length > 12 ? (n.task.title || "").slice(0, 11) + "…" : n.task.title || n.id}
              </text>
              <rect
                x={0}
                y={0}
                width={4}
                height={NODE_H}
                rx={2}
                fill={statusColor}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
});
