"use client";

/**
 * GraphView — React Flow graph with module-first progressive disclosure.
 *
 * Default view: module/package nodes only (never render thousands of functions at once).
 * Click a module node to expand its members (class/function/method nodes).
 * This is the UX decision that prevents rage-quitting on 200+ file repos (§9.2).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Node,
  type Edge,
} from "@xyflow/react";
import type {
  GraphDocument,
  GraphNode,
  GraphEdge,
  ViewFilters,
} from "@/lib/types";
import { applyDagreLayout } from "@/lib/layout";

interface GraphViewProps {
  document: GraphDocument;
  filters: ViewFilters;
  searchQuery: string;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}

const NODE_KIND_COLORS: Record<string, string> = {
  module: "#dbeafe",
  package: "#bfdbfe",
  class: "#fde68a",
  function: "#d1fae5",
  method: "#dcfce7",
  coroutine: "#a7f3d0",
  variable: "#f3f4f6",
  external: "#fca5a5",
};

const EDGE_KIND_COLORS: Record<string, string> = {
  imports: "#6366f1",
  calls: "#7c3aed",
  instantiates: "#4f46e5",
  inherits: "#ea580c",
  decorates: "#ec4899",
  defines: "#9ca3af",
};

function buildFlowNode(gNode: GraphNode, expanded: Set<string>): Node {
  const isModule = gNode.kind === "module" || gNode.kind === "package";
  const isExpanded = expanded.has(gNode.id);
  const label = isModule
    ? `${gNode.kind === "package" ? "📂" : "📦"} ${gNode.qualname}`
    : `${gNode.name}`;

  return {
    id: gNode.id,
    type: "default",
    data: {
      label: (
        <span className="text-xs font-medium leading-tight">
          {label}
          {gNode.attributes.framework_entrypoint && (
            <span className="ml-1 text-pink-500" title="framework entrypoint">★</span>
          )}
          {gNode.attributes.is_async && (
            <span className="ml-1 text-blue-400" title="async">⚡</span>
          )}
        </span>
      ),
    },
    position: { x: 0, y: 0 }, // overwritten by dagre
    style: {
      background: NODE_KIND_COLORS[gNode.kind] ?? "#f9fafb",
      border: isExpanded ? "2px solid #6366f1" : "1px solid #e5e7eb",
      borderRadius: 8,
      padding: "6px 10px",
      minWidth: 140,
      cursor: "pointer",
      fontSize: 12,
    },
  };
}

function buildFlowEdge(gEdge: GraphEdge): Edge {
  const color = EDGE_KIND_COLORS[gEdge.kind] ?? "#9ca3af";
  const isDashed =
    gEdge.provenance === "static" && gEdge.kind !== "defines" && gEdge.kind !== "inherits";
  const isDotted = gEdge.provenance === "runtime";
  const isHeuristic = gEdge.confidence !== "resolved";

  return {
    id: gEdge.id,
    source: gEdge.source,
    target: gEdge.target,
    type: "smoothstep",
    animated: gEdge.provenance === "both",
    markerEnd: { type: MarkerType.ArrowClosed, color },
    className: [
      `edge-${gEdge.provenance}`,
      isHeuristic ? `edge-${gEdge.confidence}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    style: {
      stroke: color,
      strokeWidth: gEdge.provenance === "both" ? 2 : 1.5,
      strokeDasharray: isDotted ? "5 3" : isDashed ? "none" : "none",
      opacity: isHeuristic ? 0.45 : 1,
    },
    label: gEdge.kind,
    labelStyle: { fontSize: 9, fill: color },
    labelBgStyle: { fill: "white", fillOpacity: 0.7 },
  };
}

export default function GraphView({
  document,
  filters,
  searchQuery,
  selectedNodeId,
  onSelectNode,
}: GraphViewProps) {
  // expandedModules: set of module/package node IDs whose children are visible
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());

  // nodeMap for fast lookups
  const nodeMap = useMemo(
    () => new Map(document.nodes.map((n) => [n.id, n])),
    [document]
  );

  // childrenOf: module node id -> child definition node ids
  const childrenOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const edge of document.edges) {
      if (edge.kind === "defines") {
        const src = nodeMap.get(edge.source);
        if (src && (src.kind === "module" || src.kind === "package" || src.kind === "class")) {
          const list = map.get(edge.source) ?? [];
          list.push(edge.target);
          map.set(edge.source, list);
        }
      }
    }
    return map;
  }, [document, nodeMap]);

  // Compute the visible node set based on filters + expansion state
  const visibleNodes = useMemo(() => {
    const visible = new Set<string>();

    for (const gNode of document.nodes) {
      // Apply kind filter
      if (!filters.nodeKinds.has(gNode.kind)) continue;

      const isTopLevel = gNode.kind === "module" || gNode.kind === "package";

      // Search filter
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matches =
          gNode.name.toLowerCase().includes(q) ||
          gNode.qualname.toLowerCase().includes(q) ||
          gNode.module.toLowerCase().includes(q);
        if (!matches) continue;
      }

      if (isTopLevel) {
        visible.add(gNode.id);
      } else {
        // Only show non-top-level nodes if their parent module is expanded
        // Find the parent module for this node (via defines edges)
        const parentEdge = document.edges.find(
          (e) => e.kind === "defines" && e.target === gNode.id
        );
        if (parentEdge) {
          const parent = nodeMap.get(parentEdge.source);
          if (parent) {
            const isParentModuleExpanded =
              expandedModules.has(parent.id) ||
              (parent.kind !== "module" && parent.kind !== "package" && expandedModules.has(
                // find the module ancestor
                document.edges.find(
                  (e2) => e2.kind === "defines" && e2.target === parent.id
                )?.source ?? ""
              ));
            if (expandedModules.has(parent.id) || isParentModuleExpanded) {
              visible.add(gNode.id);
            }
          }
        }
      }
    }

    // If searching, also include non-module nodes that match
    if (searchQuery) {
      for (const gNode of document.nodes) {
        if (!visible.has(gNode.id) && filters.nodeKinds.has(gNode.kind)) {
          const q = searchQuery.toLowerCase();
          if (
            gNode.name.toLowerCase().includes(q) ||
            gNode.qualname.toLowerCase().includes(q)
          ) {
            visible.add(gNode.id);
          }
        }
      }
    }

    return visible;
  }, [document, filters, expandedModules, searchQuery, nodeMap]);

  // Compute visible edges
  const visibleEdges = useMemo(() => {
    return document.edges.filter((e) => {
      if (!filters.edgeKinds.has(e.kind)) return false;
      if (!filters.provenances.has(e.provenance)) return false;
      if (!filters.confidences.has(e.confidence)) return false;
      if (!visibleNodes.has(e.source)) return false;
      if (!visibleNodes.has(e.target)) return false;
      return true;
    });
  }, [document.edges, filters, visibleNodes]);

  // Build React Flow nodes/edges and apply layout
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<any>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<any>([]);

  useEffect(() => {
    const rfNodes = [...visibleNodes]
      .map((id) => nodeMap.get(id))
      .filter(Boolean)
      .map((gNode) => buildFlowNode(gNode!, expandedModules));

    const rfEdges = visibleEdges.map(buildFlowEdge);

    const laidOut = applyDagreLayout(rfNodes, rfEdges);
    setFlowNodes(laidOut);
    setFlowEdges(rfEdges);
  }, [visibleNodes, visibleEdges, expandedModules, nodeMap]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const gNode = nodeMap.get(node.id);
      if (!gNode) return;

      // Toggle expansion for module/package nodes
      if (gNode.kind === "module" || gNode.kind === "package") {
        setExpandedModules((prev) => {
          const next = new Set(prev);
          next.has(node.id) ? next.delete(node.id) : next.add(node.id);
          return next;
        });
      }

      onSelectNode(node.id);
    },
    [nodeMap, onSelectNode]
  );

  const onPaneClick = useCallback(() => {
    onSelectNode(null);
  }, [onSelectNode]);

  // Highlight selected node
  const styledNodes = useMemo(
    () =>
      flowNodes.map((n) => ({
        ...n,
        style: {
          ...n.style,
          border:
            n.id === selectedNodeId
              ? "2px solid #6366f1"
              : n.style?.border ?? "1px solid #e5e7eb",
          boxShadow: n.id === selectedNodeId ? "0 0 0 3px rgba(99,102,241,0.3)" : undefined,
        },
      })),
    [flowNodes, selectedNodeId]
  );

  return (
    <div className="flex-1 h-full">
      <ReactFlow
        nodes={styledNodes}
        edges={flowEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.05}
        maxZoom={3}
        attributionPosition="bottom-right"
      >
        <Background gap={20} size={1} color="#f1f5f9" />
        <Controls />
        <MiniMap
          nodeColor={(n) => {
            const gNode = nodeMap.get(n.id);
            return NODE_KIND_COLORS[gNode?.kind ?? "module"] ?? "#dbeafe";
          }}
          pannable
          zoomable
        />
      </ReactFlow>
      <div className="absolute bottom-4 left-4 text-xs text-muted-foreground bg-white/80 rounded px-2 py-1 pointer-events-none">
        {visibleNodes.size} nodes · {visibleEdges.length} edges visible
        {expandedModules.size > 0 && ` · ${expandedModules.size} modules expanded`}
      </div>
    </div>
  );
}
