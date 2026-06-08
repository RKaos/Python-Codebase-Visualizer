"use client";

import React, { useCallback, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type {
  GraphDocument,
  GraphNode,
  ViewFilters,
} from "@/lib/types";
import {
  ALL_NODE_KINDS,
  ALL_EDGE_KINDS,
  ALL_PROVENANCES,
  ALL_CONFIDENCES,
} from "@/lib/types";
import FilterBar from "@/components/FilterBar";
import NodePanel from "@/components/NodePanel";

// Dynamic import: React Flow must be client-only (uses browser APIs).
const GraphView = dynamic(() => import("@/components/GraphView"), { ssr: false });

const DEFAULT_FILTERS: ViewFilters = {
  // Default: show modules and packages only (progressive disclosure start state)
  nodeKinds: new Set(["module", "package", "class", "function", "method", "coroutine", "external"]),
  edgeKinds: new Set(["imports", "calls", "instantiates", "inherits", "decorates"]),
  provenances: new Set(["static", "runtime", "both"]),
  confidences: new Set(["resolved", "heuristic"]), // hide dynamic-unresolved by default for clean view
};

export default function HomePage() {
  const [document, setDocument] = useState<GraphDocument | null>(null);
  const [filters, setFilters] = useState<ViewFilters>(DEFAULT_FILTERS);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadGraph = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const parsed: GraphDocument = JSON.parse(text);
      if (!parsed.nodes || !parsed.edges) {
        throw new Error("Not a valid graph.json — missing nodes or edges.");
      }
      setDocument(parsed);
      setSelectedNodeId(null);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to parse graph.json");
    }
  }, []);

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) loadGraph(file);
    },
    [loadGraph]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file?.name.endsWith(".json")) loadGraph(file);
    },
    [loadGraph]
  );

  const selectedNode = document?.nodes.find((n) => n.id === selectedNodeId) ?? null;

  if (!document) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-slate-50 to-blue-50"
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        <div className="text-center max-w-lg px-6">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">
            pyviz
          </h1>
          <p className="text-slate-500 mb-8 text-sm">
            Python codebase call/dependency graph visualizer
          </p>

          <div
            className="border-2 border-dashed border-slate-300 rounded-xl p-12 cursor-pointer
                       hover:border-indigo-400 hover:bg-indigo-50/40 transition-colors"
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="text-4xl mb-3">📂</div>
            <p className="text-slate-700 font-medium">Drop graph.json here</p>
            <p className="text-slate-400 text-sm mt-1">or click to browse</p>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={onFileChange}
          />

          {loadError && (
            <p className="mt-4 text-red-600 text-sm bg-red-50 rounded-lg px-4 py-2">
              {loadError}
            </p>
          )}

          <div className="mt-10 text-left text-xs text-slate-400 space-y-1">
            <p className="font-semibold text-slate-500 mb-2">Generate graph.json with:</p>
            <pre className="bg-slate-100 rounded-lg px-4 py-3 text-slate-700 overflow-x-auto">
{`pip install -e .
pyviz analyze ./your-repo --out ./pyviz-out
# → opens pyviz-out/graph.json`}
            </pre>
          </div>
        </div>
      </div>
    );
  }

  const stats = {
    n_nodes: document.stats.n_nodes,
    n_edges: document.stats.n_edges,
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-2 bg-white border-b shadow-sm shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setDocument(null); setSelectedNodeId(null); }}
            className="text-sm font-bold text-indigo-700 hover:underline"
          >
            pyviz
          </button>
          <span className="text-xs text-muted-foreground">
            {(document.repo as Record<string,string>)?.path?.split(/[\\/]/).pop() ?? "graph"}
          </span>
        </div>

        {/* Search */}
        <input
          type="text"
          placeholder="Search nodes…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-64 text-sm px-3 py-1.5 rounded-md border focus:outline-none focus:ring-2 focus:ring-indigo-300"
        />

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{document.stats.n_modules} modules</span>
          <span>·</span>
          <span>{document.stats.n_classes} classes</span>
          <span>·</span>
          <span>{document.stats.n_functions} functions</span>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="ml-3 px-2 py-1 text-xs rounded border hover:bg-muted"
          >
            Load different file
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={onFileChange}
          />
        </div>
      </header>

      {/* Filter bar */}
      <FilterBar filters={filters} onChange={setFilters} stats={stats} />

      {/* Global caveats banner */}
      {document.global_caveats.length > 0 && (
        <div className="bg-amber-50 border-b border-amber-100 px-4 py-1 text-xs text-amber-700 shrink-0">
          ⚠ {document.global_caveats.join(" · ")}
        </div>
      )}

      {/* Main area: graph + side panel */}
      <div className="flex-1 flex overflow-hidden relative">
        <GraphView
          document={document}
          filters={filters}
          searchQuery={searchQuery}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
        />
        {selectedNode && (
          <NodePanel
            node={selectedNode}
            document={document}
            onClose={() => setSelectedNodeId(null)}
            onSelectNode={setSelectedNodeId}
          />
        )}
      </div>

      {/* Legend */}
      <div className="shrink-0 flex items-center gap-4 px-4 py-1.5 bg-white border-t text-xs text-muted-foreground">
        <span className="font-medium">Legend:</span>
        <LegendItem color="#6366f1" label="static" dash="none" />
        <LegendItem color="#f59e0b" label="runtime-only" dash="5 3" />
        <LegendItem color="#10b981" label="both (corroborated)" dash="none" bold />
        <span className="ml-2 opacity-50">·</span>
        <span>Click module/package to expand definitions</span>
      </div>
    </div>
  );
}

function LegendItem({
  color,
  label,
  dash,
  bold,
}: {
  color: string;
  label: string;
  dash: string;
  bold?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width="28" height="10">
        <line
          x1="0"
          y1="5"
          x2="28"
          y2="5"
          stroke={color}
          strokeWidth={bold ? 2.5 : 1.5}
          strokeDasharray={dash}
        />
      </svg>
      <span>{label}</span>
    </span>
  );
}
