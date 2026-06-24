"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Node,
  type Edge,
} from "@xyflow/react";

import type { GraphDocument, GraphNode, GraphEdge, ViewFilters } from "@/lib/types";
import { applyElkHierarchicalLayout, applyDagreLayout } from "@/lib/layout";

interface GraphViewProps {
  document: GraphDocument;
  filters: ViewFilters;
  searchQuery: string;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  viewMode: "full" | "explorer";
}

const NODE_WIDTH = 180;
const NODE_HEIGHT = 48;

const NODE_KIND_COLORS: Record<string, string> = {
  module:   "#dbeafe", package:  "#bfdbfe", class:    "#fde68a",
  function: "#d1fae5", method:   "#dcfce7", coroutine:"#a7f3d0",
  variable: "#f3f4f6", external: "#fca5a5",
};
const EDGE_KIND_COLORS: Record<string, string> = {
  imports: "#6366f1", calls: "#7c3aed", instantiates: "#4f46e5",
  inherits: "#ea580c", decorates: "#ec4899", defines: "#9ca3af",
};

// Translucent container fills keyed by kind (module/class boxes in full view)
const CONTAINER_FILLS: Record<string, string> = {
  module: "rgba(59,130,246,0.06)",
  class:  "rgba(245,158,11,0.08)",
};
const CONTAINER_BORDERS: Record<string, string> = {
  module: "rgba(59,130,246,0.5)",
  class:  "rgba(245,158,11,0.6)",
};
const CONTAINER_LABEL_COLORS: Record<string, string> = {
  module: "#2563eb",
  class:  "#d97706",
};

// Custom node type for hierarchical containers — label at top-left, children nested inside
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ContainerNode({ data }: { data: any }) {
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div
        className="absolute top-1 left-2 right-2 truncate pointer-events-none"
        style={{ fontSize: 11, fontWeight: 700, color: data.labelColor }}
      >
        {data.label}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </>
  );
}

// Junction dot — where edges of one kind merge before crossing to another container ("river mouth")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function JunctionNode({ data }: { data: any }) {
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ opacity: 0, left: "50%", top: "50%" }} />
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: data.color, opacity: 0.9 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, left: "50%", top: "50%" }} />
    </>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NODE_TYPES: any = { container: ContainerNode, junction: JunctionNode };

function buildFlowNode(gNode: GraphNode): Node {
  return {
    id: gNode.id,
    type: "default",
    data: {
      label: (
        <span className="text-xs font-medium leading-tight">
          {gNode.kind === "package" ? "📂 " : gNode.kind === "module" ? "📦 " : ""}
          {gNode.kind === "module" || gNode.kind === "package" ? gNode.qualname : gNode.name}
          {gNode.attributes.framework_entrypoint && (
            <span className="ml-1 text-pink-500" title="framework entrypoint">★</span>
          )}
          {gNode.attributes.is_async && (
            <span className="ml-1 text-blue-400" title="async">⚡</span>
          )}
        </span>
      ),
    },
    position: { x: 0, y: 0 },
    style: {
      background: NODE_KIND_COLORS[gNode.kind] ?? "#f9fafb",
      border: "1px solid #e5e7eb",
      borderRadius: 8,
      padding: "6px 10px",
      minWidth: NODE_WIDTH,
      cursor: "pointer",
      fontSize: 12,
    },
  };
}

function buildFlowEdge(gEdge: GraphEdge): Edge {
  const color = EDGE_KIND_COLORS[gEdge.kind] ?? "#9ca3af";
  return {
    id: gEdge.id,
    source: gEdge.source,
    target: gEdge.target,
    type: "straight",
    animated: gEdge.provenance === "both",
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
    data: { kind: gEdge.kind, color, dashed: gEdge.provenance === "runtime" },
    style: {
      stroke: color,
      strokeWidth: 1.5,
      strokeDasharray: gEdge.provenance === "runtime" ? "5 3" : "none",
    },
  };
}

// ── Hierarchical edge bundling (full view) ────────────────────────────────────
// "Rivers" (same-kind edges) leaving the cities of one module ("country") converge
// at a junction on the module's border, cross the gap as a single "sea" trunk edge,
// then fan back out to the target cities inside the other module.

const JUNCTION_R = 8;
const BORDER_MARGIN = 18;

// Point on a box border (center ± half-extents) in the direction of a target, pushed out by margin
function borderPoint(
  cx: number, cy: number, hw: number, hh: number,
  tx: number, ty: number, margin: number
): { x: number; y: number } {
  let dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) dy = 1;
  const scale = 1 / Math.max(Math.abs(dx) / (hw || 1), Math.abs(dy) / (hh || 1));
  let ex = cx + dx * scale, ey = cy + dy * scale;
  const len = Math.hypot(dx, dy) || 1;
  ex += (dx / len) * margin;
  ey += (dy / len) * margin;
  return { x: ex, y: ey };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bundleFullView(baseNodes: any[], edges: Edge[]): { nodes: any[]; edges: Edge[] } {
  const byId = new Map(baseNodes.map((n) => [n.id, n]));

  const absCache = new Map<string, { x: number; y: number }>();
  const abs = (id: string): { x: number; y: number } => {
    const cached = absCache.get(id);
    if (cached) return cached;
    const n = byId.get(id);
    if (!n) return { x: 0, y: 0 };
    const p = n.parentId ? abs(n.parentId) : { x: 0, y: 0 };
    const r = { x: p.x + (n.position?.x ?? 0), y: p.y + (n.position?.y ?? 0) };
    absCache.set(id, r);
    return r;
  };
  const sizeOf = (id: string) => {
    const n = byId.get(id);
    return { w: Number(n?.style?.width) || NODE_WIDTH, h: Number(n?.style?.height) || NODE_HEIGHT };
  };
  const countryCache = new Map<string, string>();
  const country = (id: string): string => {
    const cached = countryCache.get(id);
    if (cached) return cached;
    let cur = id;
    let guard = 0;
    while (byId.get(cur)?.parentId && guard++ < 20) cur = byId.get(cur)!.parentId;
    countryCache.set(id, cur);
    return cur;
  };

  type Group = {
    cA: string; cB: string; kind: string; color: string;
    edges: Edge[]; sources: Set<string>; targets: Set<string>;
  };
  const directEdges: Edge[] = [];
  const groups = new Map<string, Group>();

  for (const e of edges) {
    const cA = country(e.source);
    const cB = country(e.target);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kind = (e.data as any)?.kind ?? "calls";
    if (cA === cB) { directEdges.push(e); continue; }
    const key = `${cA}|${cB}|${kind}`;
    let g = groups.get(key);
    if (!g) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      g = { cA, cB, kind, color: (e.data as any)?.color ?? "#9ca3af", edges: [], sources: new Set(), targets: new Set() };
      groups.set(key, g);
    }
    g.edges.push(e);
    g.sources.add(e.source);
    g.targets.add(e.target);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const junctionNodes: any[] = [];
  const bundled: Edge[] = [];

  for (const g of groups.values()) {
    if (g.edges.length < 2) { directEdges.push(g.edges[0]); continue; } // a lone river stays direct

    const aPos = abs(g.cA), aSz = sizeOf(g.cA);
    const bPos = abs(g.cB), bSz = sizeOf(g.cB);
    const Acx = aPos.x + aSz.w / 2, Acy = aPos.y + aSz.h / 2;
    const Bcx = bPos.x + bSz.w / 2, Bcy = bPos.y + bSz.h / 2;
    const jOut = borderPoint(Acx, Acy, aSz.w / 2, aSz.h / 2, Bcx, Bcy, BORDER_MARGIN);
    const jIn = borderPoint(Bcx, Bcy, bSz.w / 2, bSz.h / 2, Acx, Acy, BORDER_MARGIN);
    const idOut = `j-${g.cA}-${g.cB}-${g.kind}-o`;
    const idIn = `j-${g.cA}-${g.cB}-${g.kind}-i`;

    junctionNodes.push(
      { id: idOut, type: "junction", position: { x: jOut.x - JUNCTION_R / 2, y: jOut.y - JUNCTION_R / 2 },
        data: { isJunction: true, color: g.color }, style: { width: JUNCTION_R, height: JUNCTION_R },
        selectable: false, draggable: false, zIndex: 5 },
      { id: idIn, type: "junction", position: { x: jIn.x - JUNCTION_R / 2, y: jIn.y - JUNCTION_R / 2 },
        data: { isJunction: true, color: g.color }, style: { width: JUNCTION_R, height: JUNCTION_R },
        selectable: false, draggable: false, zIndex: 5 }
    );

    const members = [...g.sources, ...g.targets];
    const count = g.edges.length;

    for (const s of g.sources) {
      bundled.push({
        id: `seg-${g.cA}-${g.cB}-${g.kind}-o-${s}`, source: s, target: idOut, type: "straight",
        data: { isSegment: true, color: g.color, members },
        style: { stroke: g.color, strokeWidth: 1.2 },
      });
    }
    for (const t of g.targets) {
      bundled.push({
        id: `seg-${g.cA}-${g.cB}-${g.kind}-i-${t}`, source: idIn, target: t, type: "straight",
        markerEnd: { type: MarkerType.ArrowClosed, color: g.color, width: 10, height: 10 },
        data: { isSegment: true, color: g.color, members },
        style: { stroke: g.color, strokeWidth: 1.2 },
      });
    }
    bundled.push({
      id: `trunk-${g.cA}-${g.cB}-${g.kind}`, source: idOut, target: idIn, type: "straight",
      markerEnd: { type: MarkerType.ArrowClosed, color: g.color, width: 14, height: 14 },
      data: { isTrunk: true, kind: g.kind, color: g.color, count, members },
      style: { stroke: g.color, strokeWidth: Math.min(2 + count * 0.7, 9) },
    });
  }

  return { nodes: [...baseNodes, ...junctionNodes], edges: [...directEdges, ...bundled] };
}


// ── Main component ─────────────────────────────────────────────────────────────
export default function GraphView({
  document, filters, searchQuery, selectedNodeId, onSelectNode, viewMode,
}: GraphViewProps) {
  // Full-view hierarchical layout cache, keyed by the set of visible node ids
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fullCacheRef = useRef<{ sig: string; nodes: any[] } | null>(null);
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());

  const nodeMap = useMemo(
    () => new Map(document.nodes.map((n) => [n.id, n])),
    [document]
  );

  // child id → its defines-parent id (any kind)
  const parentEdgeMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of document.edges) {
      if (e.kind === "defines") m.set(e.target, e.source);
    }
    return m;
  }, [document.edges]);

  // Clear full-mode layout cache only when document changes (not on mode switch)
  useEffect(() => {
    fullCacheRef.current = null;
  }, [document]);

  // Reset expanded modules when document or mode changes
  useEffect(() => {
    setExpandedModules(new Set());
  }, [document, viewMode]);

  // Which module/package nodes have expandable children
  const expandableIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of document.edges) {
      if (e.kind !== "defines") continue;
      const child = nodeMap.get(e.target);
      if (!child || child.kind === "module" || child.kind === "package") continue;
      const parent = nodeMap.get(e.source);
      if (parent?.kind === "module" || parent?.kind === "package") ids.add(e.source);
    }
    return ids;
  }, [document.edges, nodeMap]);

  const visibleNodes = useMemo(() => {
    const visible = new Set<string>();
    for (const gNode of document.nodes) {
      if (gNode.name === "__init__" && gNode.kind === "method") continue;
      if (!filters.nodeKinds.has(gNode.kind)) continue;

      if (viewMode === "full") {
        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          if (
            !gNode.name.toLowerCase().includes(q) &&
            !gNode.qualname.toLowerCase().includes(q) &&
            !gNode.module.toLowerCase().includes(q)
          ) continue;
        }
        visible.add(gNode.id);
      } else {
        // Explorer: always show modules/packages; show others only if parent is expanded
        const isBase = gNode.kind === "module" || gNode.kind === "package";
        if (isBase) {
          if (searchQuery) {
            const q = searchQuery.toLowerCase();
            if (
              !gNode.name.toLowerCase().includes(q) &&
              !gNode.qualname.toLowerCase().includes(q) &&
              !gNode.module.toLowerCase().includes(q)
            ) continue;
          }
          visible.add(gNode.id);
        } else {
          const parentEdge = document.edges.find(
            (e) => e.kind === "defines" && e.target === gNode.id
          );
          if (parentEdge && expandedModules.has(parentEdge.source)) {
            visible.add(gNode.id);
          }
        }
      }
    }
    return visible;
  }, [document, filters, searchQuery, viewMode, expandedModules]);

  const visibleEdges = useMemo(() =>
    document.edges.filter((e) =>
      filters.edgeKinds.has(e.kind) &&
      filters.provenances.has(e.provenance) &&
      filters.confidences.has(e.confidence) &&
      visibleNodes.has(e.source) &&
      visibleNodes.has(e.target)
    ),
    [document.edges, filters, visibleNodes]
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<any>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<any>([]);

  // Layout effect — re-runs when NODES or mode change; never touches positions due to edge-only changes
  useEffect(() => {
    let cancelled = false;

    const rfNodes = [...visibleNodes]
      .map((id) => nodeMap.get(id))
      .filter(Boolean)
      .map((gNode) => buildFlowNode(gNode!));

    if (rfNodes.length === 0) { setFlowNodes([]); setFlowEdges([]); return; }

    if (viewMode === "explorer") {
      const rfEdges = visibleEdges.map(buildFlowEdge);
      const laidOut = applyDagreLayout(rfNodes, rfEdges);
      if (!cancelled) { setFlowNodes(laidOut); setFlowEdges(rfEdges); }
      return;
    }

    // Full mode: hierarchical ELK — symbols nest inside their module/class container.
    // Cache the BASE layout (no junctions) keyed by the visible node-id set so mode
    // switches / edge toggles don't re-run ELK; bundling is recomputed cheaply on top.
    const sig = [...visibleNodes].sort().join("|");
    if (fullCacheRef.current?.sig === sig) {
      const { nodes, edges } = bundleFullView(fullCacheRef.current.nodes, visibleEdges.map(buildFlowEdge));
      setFlowNodes(nodes);
      setFlowEdges(edges);
      return;
    }

    // Resolve each visible node to its nearest visible module/class ancestor (skip packages)
    const parentOf = new Map<string, string | undefined>();
    for (const id of visibleNodes) {
      let p = parentEdgeMap.get(id);
      let resolved: string | undefined;
      while (p) {
        const pk = nodeMap.get(p)?.kind;
        if (visibleNodes.has(p) && (pk === "module" || pk === "class")) { resolved = p; break; }
        p = parentEdgeMap.get(p);
      }
      parentOf.set(id, resolved);
    }

    const rfEdges = visibleEdges.map(buildFlowEdge);
    applyElkHierarchicalLayout(rfNodes, rfEdges, parentOf).then((laidOut) => {
      if (!cancelled) {
        fullCacheRef.current = { sig, nodes: laidOut };
        const { nodes, edges } = bundleFullView(laidOut, rfEdges);
        setFlowNodes(nodes);
        setFlowEdges(edges);
      }
    });

    return () => { cancelled = true; };
  // visibleEdges intentionally excluded — edge changes must not re-run layout
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleNodes, viewMode, nodeMap, parentEdgeMap, document]);

  // Edge-only effect — re-bundle (full) or re-build (explorer) edges without re-running layout
  useEffect(() => {
    if (viewMode === "explorer") {
      setFlowEdges(visibleEdges.map(buildFlowEdge));
      return;
    }
    const sig = [...visibleNodes].sort().join("|");
    if (fullCacheRef.current?.sig === sig) {
      const { nodes, edges } = bundleFullView(fullCacheRef.current.nodes, visibleEdges.map(buildFlowEdge));
      setFlowNodes(nodes);
      setFlowEdges(edges);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEdges, viewMode]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.data?.isJunction) return; // junctions are not selectable
      if (viewMode === "explorer") {
        const gNode = nodeMap.get(node.id);
        if (gNode?.kind === "module" || gNode?.kind === "package") {
          setExpandedModules((prev) => {
            const next = new Set(prev);
            if (next.has(node.id)) next.delete(node.id);
            else next.add(node.id);
            return next;
          });
          return; // expand/collapse only — no panel for base nodes in explorer
        }
      }
      onSelectNode(node.id);
    },
    [viewMode, nodeMap, onSelectNode]
  );

  const onPaneClick = useCallback(() => onSelectNode(null), [onSelectNode]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const styledNodes: any[] = useMemo(
    () =>
      flowNodes.map((n: Node) => {
        if (n.data?.isJunction) return n; // bundling junction dots render as-is

        const gNode = nodeMap.get(n.id);
        const kind = gNode?.kind ?? "module";
        const selected = n.id === selectedNodeId;

        // Full view: hierarchical container box (module/class holding nested children)
        if (n.data?.isContainer) {
          return {
            ...n,
            data: { ...n.data, labelColor: CONTAINER_LABEL_COLORS[kind] ?? "#475569" },
            style: {
              width: n.style?.width,
              height: n.style?.height,
              background: CONTAINER_FILLS[kind] ?? "rgba(100,116,139,0.06)",
              border: selected
                ? "2px solid #6366f1"
                : `1.5px solid ${CONTAINER_BORDERS[kind] ?? "rgba(100,116,139,0.5)"}`,
              borderRadius: 12,
              boxShadow: selected ? "0 0 0 3px rgba(99,102,241,0.3)" : undefined,
              cursor: "pointer",
            },
          };
        }

        const isBase = kind === "module" || kind === "package";
        const isExpandable = viewMode === "explorer" && isBase && expandableIds.has(n.id);
        const isExpanded = expandedModules.has(n.id);

        const baseLabel = n.data?.label as React.ReactNode;
        const label = isExpandable ? (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 9, opacity: 0.55, flexShrink: 0 }}>
              {isExpanded ? "▾" : "▸"}
            </span>
            {baseLabel}
          </span>
        ) : baseLabel;

        return {
          ...n,
          data: { ...n.data, label },
          style: {
            ...n.style,
            border: selected
              ? "2px solid #6366f1"
              : isExpanded
                ? "1.5px solid #a5b4fc"
                : "1px solid #e5e7eb",
            boxShadow: selected ? "0 0 0 3px rgba(99,102,241,0.3)" : undefined,
          },
        };
      }),
    [flowNodes, selectedNodeId, viewMode, expandableIds, expandedModules, nodeMap]
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const styledEdges: any[] = useMemo(() =>
    flowEdges.map((e: Edge) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = (e.data ?? {}) as any;
      const { color, kind, dashed } = d as { color: string; kind: string; dashed: boolean };

      // Explorer view: always show edges at full opacity with labels
      if (viewMode === "explorer") {
        return {
          ...e,
          label: kind,
          labelStyle: { fontSize: 9, fill: color },
          labelBgStyle: { fill: "white", fillOpacity: 0.8 },
          style: { ...e.style, opacity: 0.75, strokeDasharray: dashed ? "5 3" : "none" },
        };
      }

      // Full view: edges may be bundled (trunk / segment) or direct.
      const isTrunk = !!d.isTrunk;
      const isSeg = !!d.isSegment;
      const members = d.members as string[] | undefined;
      const connected = !!selectedNodeId &&
        (e.source === selectedNodeId || e.target === selectedNodeId ||
          (members?.includes(selectedNodeId) ?? false));

      // Selection focus: dim everything not on the selected node's path
      if (selectedNodeId && !connected) {
        return { ...e, label: undefined, style: { ...e.style, opacity: 0.05 }, zIndex: 0 };
      }
      if (selectedNodeId && connected) {
        return {
          ...e,
          label: isTrunk ? `${kind} ×${d.count}` : isSeg ? undefined : kind,
          labelStyle: { fontSize: 9, fill: color, fontWeight: 600 },
          labelBgStyle: { fill: "white", fillOpacity: 0.9 },
          style: { ...e.style, opacity: 1, strokeWidth: (Number(e.style?.strokeWidth) || 1.5) + 1 },
          zIndex: 10,
        };
      }

      // No selection — trunks are the prominent "rivers", segments faint, direct edges modest
      if (isTrunk) {
        return {
          ...e,
          label: `${kind} ×${d.count}`,
          labelStyle: { fontSize: 9, fill: color, fontWeight: 600 },
          labelBgStyle: { fill: "white", fillOpacity: 0.85 },
          style: { ...e.style, opacity: 0.9 },
          zIndex: 2,
        };
      }
      if (isSeg) {
        return { ...e, label: undefined, style: { ...e.style, opacity: 0.4 }, zIndex: 1 };
      }
      return {
        ...e,
        label: undefined,
        style: { ...e.style, opacity: 0.5, strokeDasharray: dashed ? "5 3" : "none" },
        zIndex: 1,
      };
    }),
    [flowEdges, selectedNodeId, viewMode]
  );

  return (
    <div className="flex-1 h-full">
      <ReactFlow
        nodes={styledNodes}
        edges={styledEdges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodesDraggable={false}
        fitView
        fitViewOptions={{ padding: 0.1 }}
        minZoom={0.02}
        maxZoom={3}
        attributionPosition="bottom-right"
      >
        <Background gap={20} size={1} color="#f1f5f9" />
        <Controls />
        <MiniMap
          nodeColor={(n) => {
            if (n.data?.isJunction) return "transparent";
            const gNode = nodeMap.get(n.id);
            return NODE_KIND_COLORS[gNode?.kind ?? "module"] ?? "#dbeafe";
          }}
          pannable
          zoomable
        />
      </ReactFlow>
      <div className="absolute bottom-4 left-4 text-xs text-muted-foreground bg-white/80 rounded px-2 py-1 pointer-events-none">
        {visibleNodes.size} nodes · {visibleEdges.length} edges visible
        {viewMode === "explorer" && expandedModules.size > 0 && (
          <span className="ml-2 text-indigo-500">· {expandedModules.size} expanded</span>
        )}
      </div>
    </div>
  );
}
