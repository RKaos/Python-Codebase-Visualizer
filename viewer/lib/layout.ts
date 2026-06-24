import ELK from "elkjs/lib/elk.bundled.js";
import dagre from "dagre";
import type { Node, Edge } from "@xyflow/react";

const elk = new ELK();

const NODE_WIDTH = 180;
const NODE_HEIGHT = 48;

export function applyDagreLayout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 50, ranksep: 80, marginx: 20, marginy: 20 });

  const validTargets = new Set(nodes.map((n) => n.id));
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges
    .filter((e) => validTargets.has(e.source) && validTargets.has(e.target))
    .forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    return { ...n, position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 } };
  });
}

/**
 * Hierarchical (compound) ELK layout: nodes are nested inside their parent
 * container (module → its classes/functions, class → its methods). ELK sizes
 * each container to fit its children and guarantees no overlap.
 *
 * `parentOf` maps a child node id → its nearest VISIBLE ancestor id (or undefined
 * if it should sit at the top level). Returns geometry attached to each node:
 *   - position (relative to parent, as React Flow expects for child nodes)
 *   - parentId + extent for nested nodes
 *   - style.width/height for container nodes
 *   - data.isContainer flag
 */
const CONTAINER_PAD = { top: 30, left: 12, bottom: 12, right: 12 };

export async function applyElkHierarchicalLayout(
  nodes: Node[],
  edges: Edge[],
  parentOf: Map<string, string | undefined>
): Promise<Node[]> {
  if (nodes.length === 0) return nodes;

  const allIds = new Set(nodes.map((n) => n.id));

  // Build child lists + identify roots
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const n of nodes) {
    const p = parentOf.get(n.id);
    if (p && allIds.has(p)) {
      const list = childrenOf.get(p) ?? [];
      list.push(n.id);
      childrenOf.set(p, list);
    } else {
      roots.push(n.id);
    }
  }

  const isContainer = (id: string) => (childrenOf.get(id)?.length ?? 0) > 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildElkNode = (id: string): any => {
    const kids = childrenOf.get(id) ?? [];
    if (kids.length === 0) {
      return { id, width: NODE_WIDTH, height: NODE_HEIGHT };
    }
    return {
      id,
      layoutOptions: {
        "elk.padding": `[top=${CONTAINER_PAD.top},left=${CONTAINER_PAD.left},bottom=${CONTAINER_PAD.bottom},right=${CONTAINER_PAD.right}]`,
        "elk.spacing.nodeNode": "28",
        "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      },
      children: kids.map(buildElkNode),
    };
  };

  // defines edges are encoded as nesting — exclude them from layout edges
  const elkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.spacing.nodeNode": "55",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.separateConnectedComponents": "true",
      "elk.spacing.componentComponent": "55",
    },
    children: roots.map(buildElkNode),
    edges: edges
      .filter((e) => allIds.has(e.source) && allIds.has(e.target))
      .filter((e) => (e.data as { kind?: string })?.kind !== "defines")
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const laid = await elk.layout(elkGraph);

  // Walk the laid-out tree; ELK gives child coords relative to parent (matches RF)
  const geom = new Map<string, { x: number; y: number; w: number; h: number }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (node: any) => {
    for (const c of node.children ?? []) {
      geom.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? NODE_WIDTH, h: c.height ?? NODE_HEIGHT });
      walk(c);
    }
  };
  walk(laid);

  // Depth (for parents-first ordering required by React Flow)
  const depthOf = (id: string): number => {
    let d = 0;
    let cur = parentOf.get(id);
    while (cur && allIds.has(cur)) { d++; cur = parentOf.get(cur); }
    return d;
  };

  const out = nodes.map((n) => {
    const g = geom.get(n.id);
    const parent = parentOf.get(n.id);
    const container = isContainer(n.id);
    return {
      ...n,
      type: container ? "container" : n.type,
      position: { x: g?.x ?? 0, y: g?.y ?? 0 },
      ...(parent && allIds.has(parent) ? { parentId: parent, extent: "parent" as const } : {}),
      ...(container && g ? { style: { ...n.style, width: g.w, height: g.h } } : {}),
      data: { ...n.data, isContainer: container },
      _depth: depthOf(n.id),
    };
  });

  // React Flow requires a parent node to appear before its children
  out.sort((a, b) => (a._depth as number) - (b._depth as number));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return out.map(({ _depth, ...rest }) => rest as any);
}

export async function applyElkLayout(
  nodes: Node[],
  edges: Edge[],
  opts?: { direction?: "DOWN" | "RIGHT" }
): Promise<Node[]> {
  if (nodes.length === 0) return nodes;

  const validTargets = new Set(nodes.map((n) => n.id));

  const elkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": opts?.direction ?? "DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "100",
      "elk.spacing.nodeNode": "70",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.unnecessaryBendpoints": "true",
      "elk.separateConnectedComponents": "true",
      "elk.spacing.componentComponent": "60",
    },
    children: nodes.map((n) => ({
      id: n.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: edges
      .filter((e) => validTargets.has(e.source) && validTargets.has(e.target))
      .map((e) => ({
        id: e.id,
        sources: [e.source],
        targets: [e.target],
      })),
  };

  const laid = await elk.layout(elkGraph);

  const posMap = new Map(
    (laid.children ?? []).map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }])
  );

  return nodes.map((n) => ({
    ...n,
    position: posMap.get(n.id) ?? { x: 0, y: 0 },
  }));
}
