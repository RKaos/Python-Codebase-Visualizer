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

const ABBREV: Record<string, string> = {
  package: "pkg",
  function: "fn",
  coroutine: "coro",
  variable: "var",
  external: "ext",
  instantiates: "inst.",
  decorates: "deco.",
  "dynamic-unresolved": "dyn?",
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
      title={label}
      className={`px-1.5 py-px rounded text-[11px] font-medium transition-opacity cursor-pointer select-none whitespace-nowrap
        ${colorClass ?? "bg-gray-100 text-gray-700"}
        ${active ? "opacity-100 ring-1 ring-offset-1 ring-current" : "opacity-35"}
      `}
    >
      {ABBREV[label] ?? label}
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

  const sep = <div className="h-3 w-px bg-border flex-shrink-0" />;
  const label = (text: string) => (
    <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide flex-shrink-0">
      {text}
    </span>
  );

  return (
    <div className="flex items-center gap-2 px-3 py-1 bg-white border-b overflow-x-auto">
      {label("Nodes")}
      <div className="flex items-center gap-1">
        {ALL_NODE_KINDS.map((k) => (
          <ToggleChip key={k} label={k} active={filters.nodeKinds.has(k)} onClick={() => toggleNodeKind(k)} />
        ))}
      </div>

      {sep}

      {label("Edges")}
      <div className="flex items-center gap-1">
        {ALL_EDGE_KINDS.map((k) => (
          <ToggleChip key={k} label={k} active={filters.edgeKinds.has(k)} colorClass={EDGE_KIND_COLORS[k]} onClick={() => toggleEdgeKind(k)} />
        ))}
      </div>

      {sep}

      {label("Prov.")}
      <div className="flex items-center gap-1">
        {ALL_PROVENANCES.map((p) => (
          <ToggleChip key={p} label={p} active={filters.provenances.has(p)} colorClass={PROVENANCE_STYLES[p]} onClick={() => toggleProvenance(p)} />
        ))}
      </div>

      {sep}

      {label("Conf.")}
      <div className="flex items-center gap-1">
        {ALL_CONFIDENCES.map((c) => (
          <ToggleChip key={c} label={c} active={filters.confidences.has(c)} onClick={() => toggleConfidence(c)} />
        ))}
      </div>
    </div>
  );
}
