"use client";

import React from "react";
import type {
  ViewFilters,
  NodeKind,
  EdgeKind,
  Provenance,
  Confidence,
} from "@/lib/types";
import {
  ALL_NODE_KINDS,
  ALL_EDGE_KINDS,
  ALL_PROVENANCES,
  ALL_CONFIDENCES,
} from "@/lib/types";

interface FilterBarProps {
  filters: ViewFilters;
  onChange: (filters: ViewFilters) => void;
  stats?: Record<string, number>;
}

const EDGE_KIND_COLORS: Record<string, string> = {
  imports: "bg-blue-100 text-blue-800",
  calls: "bg-purple-100 text-purple-800",
  instantiates: "bg-indigo-100 text-indigo-800",
  inherits: "bg-orange-100 text-orange-800",
  decorates: "bg-pink-100 text-pink-800",
  defines: "bg-gray-100 text-gray-700",
};

const PROVENANCE_STYLES: Record<string, string> = {
  static: "bg-indigo-50 text-indigo-700 border border-indigo-200",
  runtime: "bg-amber-50 text-amber-700 border border-amber-200",
  both: "bg-emerald-50 text-emerald-700 border border-emerald-200",
};

function ToggleChip({
  label,
  active,
  colorClass,
  onClick,
}: {
  label: string;
  active: boolean;
  colorClass?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 rounded text-xs font-medium transition-opacity cursor-pointer select-none
        ${colorClass ?? "bg-gray-100 text-gray-700"}
        ${active ? "opacity-100 ring-2 ring-offset-1 ring-current" : "opacity-40"}
      `}
    >
      {label}
    </button>
  );
}

export default function FilterBar({ filters, onChange, stats }: FilterBarProps) {
  function toggleNodeKind(k: NodeKind) {
    const next = new Set(filters.nodeKinds);
    next.has(k) ? next.delete(k) : next.add(k);
    onChange({ ...filters, nodeKinds: next });
  }

  function toggleEdgeKind(k: EdgeKind) {
    const next = new Set(filters.edgeKinds);
    next.has(k) ? next.delete(k) : next.add(k);
    onChange({ ...filters, edgeKinds: next });
  }

  function toggleProvenance(p: Provenance) {
    const next = new Set(filters.provenances);
    next.has(p) ? next.delete(p) : next.add(p);
    onChange({ ...filters, provenances: next });
  }

  function toggleConfidence(c: Confidence) {
    const next = new Set(filters.confidences);
    next.has(c) ? next.delete(c) : next.add(c);
    onChange({ ...filters, confidences: next });
  }

  return (
    <div className="flex flex-wrap items-center gap-4 px-4 py-2 bg-white border-b text-sm">
      {/* Node kinds */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wide mr-1">
          Nodes
        </span>
        {ALL_NODE_KINDS.map((k) => (
          <ToggleChip
            key={k}
            label={k}
            active={filters.nodeKinds.has(k)}
            onClick={() => toggleNodeKind(k)}
          />
        ))}
      </div>

      <div className="h-4 w-px bg-border" />

      {/* Edge kinds — "imported ≠ called" is a first-class UI control (§9.2) */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wide mr-1">
          Edges
        </span>
        {ALL_EDGE_KINDS.map((k) => (
          <ToggleChip
            key={k}
            label={k}
            active={filters.edgeKinds.has(k)}
            colorClass={EDGE_KIND_COLORS[k]}
            onClick={() => toggleEdgeKind(k)}
          />
        ))}
      </div>

      <div className="h-4 w-px bg-border" />

      {/* Provenance — static / runtime / both */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wide mr-1">
          Provenance
        </span>
        {ALL_PROVENANCES.map((p) => (
          <ToggleChip
            key={p}
            label={p}
            active={filters.provenances.has(p)}
            colorClass={PROVENANCE_STYLES[p]}
            onClick={() => toggleProvenance(p)}
          />
        ))}
      </div>

      <div className="h-4 w-px bg-border" />

      {/* Confidence */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wide mr-1">
          Confidence
        </span>
        {ALL_CONFIDENCES.map((c) => (
          <ToggleChip
            key={c}
            label={c === "dynamic-unresolved" ? "dynamic?" : c}
            active={filters.confidences.has(c)}
            onClick={() => toggleConfidence(c)}
          />
        ))}
      </div>

      {stats && (
        <>
          <div className="h-4 w-px bg-border" />
          <span className="text-xs text-muted-foreground">
            {stats.n_nodes ?? 0} nodes · {stats.n_edges ?? 0} edges
          </span>
        </>
      )}
    </div>
  );
}
