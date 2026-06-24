"use client";

import React from "react";
import type { GraphDocument, GraphNode, GraphEdge, NodeAttributes } from "@/lib/types";

interface NodePanelProps {
  node: GraphNode | null;
  document: GraphDocument;
  onClose: () => void;
  onSelectNode: (id: string) => void;
}

const KIND_ICONS: Record<string, string> = {
  module: "📦",
  package: "📂",
  class: "🔷",
  function: "🔧",
  method: "⚙️",
  coroutine: "⚡",
  variable: "📝",
  external: "🌐",
};

const EDGE_KIND_COLORS: Record<string, string> = {
  imports: "bg-blue-100 text-blue-700",
  calls: "bg-purple-100 text-purple-700",
  instantiates: "bg-indigo-100 text-indigo-700",
  inherits: "bg-orange-100 text-orange-700",
  decorates: "bg-pink-100 text-pink-700",
  defines: "bg-gray-100 text-gray-600",
};

const DEPENDENCY_KINDS = ["calls", "imports", "instantiates", "inherits", "decorates"] as const;

export default function NodePanel({ node, document, onClose }: NodePanelProps) {
  if (!node) return null;

  const { inbound, outbound } = React.useMemo(() => {
    const inbound: GraphEdge[] = [];
    const outbound: GraphEdge[] = [];
    for (const e of document.edges) {
      if (e.target === node.id) inbound.push(e);
      if (e.source === node.id) outbound.push(e);
    }
    return { inbound, outbound };
  }, [document, node.id]);

  // Fan-in/out exclude structural 'defines' edges (parent→child ownership)
  const fanIn = inbound.filter((e) => e.kind !== "defines").length;
  const fanOut = outbound.filter((e) => e.kind !== "defines").length;
  const loc = node.line_start > 0 ? node.line_end - node.line_start + 1 : 0;

  // Edge breakdown by kind (only rows with at least one edge)
  const kindRows = DEPENDENCY_KINDS.map((k) => ({
    kind: k,
    in: inbound.filter((e) => e.kind === k).length,
    out: outbound.filter((e) => e.kind === k).length,
  })).filter((r) => r.in > 0 || r.out > 0);

  // Provenance summary across all non-defines edges
  const allDepEdges = [...inbound, ...outbound].filter((e) => e.kind !== "defines");
  const provCounts = {
    static: allDepEdges.filter((e) => e.provenance === "static").length,
    runtime: allDepEdges.filter((e) => e.provenance === "runtime").length,
    both: allDepEdges.filter((e) => e.provenance === "both").length,
  };

  const isHotspot = fanIn >= 8;
  const attrs = node.attributes;

  return (
    <div className="w-56 h-full flex flex-col bg-white border-l shadow-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between p-3 border-b">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span>{KIND_ICONS[node.kind] ?? "◆"}</span>
            <span className="font-semibold text-sm truncate">{node.name}</span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              {node.kind}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 truncate">{node.qualname}</p>
        </div>
        <button
          onClick={onClose}
          className="ml-2 text-muted-foreground hover:text-foreground text-lg leading-none flex-shrink-0"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Location */}
        <Section title="Location">
          <Row label="Module" value={node.module} mono />
          <Row label="File" value={node.file_path} mono />
          {node.line_start > 0 && (
            <Row label="Lines" value={`${node.line_start}–${node.line_end}`} mono />
          )}
        </Section>

        {/* Attributes */}
        {hasAttrs(attrs) && (
          <Section title="Attributes">
            <div className="flex flex-wrap gap-1 mb-2">
              {attrs.is_async && <Badge label="async" color="bg-blue-100 text-blue-700" />}
              {attrs.is_abstract && <Badge label="abstract" color="bg-orange-100 text-orange-700" />}
              {attrs.framework_entrypoint && (
                <Badge label="entrypoint" color="bg-pink-100 text-pink-700" />
              )}
              {attrs.method_kind && (
                <Badge label={attrs.method_kind} color="bg-purple-100 text-purple-700" />
              )}
              {attrs.all_is_dynamic && (
                <Badge label="__all__ dynamic" color="bg-yellow-100 text-yellow-700" />
              )}
            </div>

            {attrs.decorators && attrs.decorators.length > 0 && (
              <div className="mb-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">
                  Decorators
                </p>
                <div className="flex flex-wrap gap-1">
                  {attrs.decorators.map((d) => (
                    <span
                      key={d}
                      className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 font-mono"
                    >
                      @{d}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {attrs.mro && attrs.mro.length > 1 && (
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">
                  MRO
                </p>
                <ol className="text-xs font-mono space-y-0.5">
                  {attrs.mro.map((m, i) => (
                    <li key={m} className="flex gap-1.5 text-gray-600">
                      <span className="text-gray-400 w-4 text-right shrink-0">{i + 1}.</span>
                      <span className="truncate">{m}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </Section>
        )}

        {/* Metrics */}
        <Section title="Metrics">
          {isHotspot && (
            <div className="mb-2 text-xs bg-red-50 text-red-700 rounded px-2 py-1">
              ⚠ High coupling — {fanIn} things depend on this
            </div>
          )}

          {/* Fan-in / Fan-out / LOC */}
          <div className={`grid gap-2 mb-3 ${loc > 0 ? "grid-cols-3" : "grid-cols-2"}`}>
            <Metric label="Fan-in" value={fanIn} hint="other nodes that depend on this" />
            <Metric label="Fan-out" value={fanOut} hint="nodes this depends on" />
            {loc > 0 && <Metric label="LOC" value={loc} hint="lines of code" />}
          </div>

          {/* Edge kind breakdown */}
          {kindRows.length > 0 && (
            <div className="mb-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">
                Edge breakdown
              </p>
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr>
                    <th className="text-left font-normal text-muted-foreground pb-1">Kind</th>
                    <th className="text-right font-normal text-blue-500 pb-1">In</th>
                    <th className="text-right font-normal text-purple-500 pb-1">Out</th>
                  </tr>
                </thead>
                <tbody>
                  {kindRows.map((r) => (
                    <tr key={r.kind} className="border-t border-gray-50">
                      <td className="py-0.5">
                        <span
                          className={`px-1 py-0.5 rounded text-[10px] font-medium ${EDGE_KIND_COLORS[r.kind]}`}
                        >
                          {r.kind}
                        </span>
                      </td>
                      <td className="text-right py-0.5 text-blue-700 font-mono">
                        {r.in || "–"}
                      </td>
                      <td className="text-right py-0.5 text-purple-700 font-mono">
                        {r.out || "–"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Analysis trust (provenance) */}
          {allDepEdges.length > 0 && (
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">
                Analysis trust
              </p>
              <div className="flex flex-wrap gap-1.5">
                {provCounts.static > 0 && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">
                    {provCounts.static} static
                  </span>
                )}
                {provCounts.runtime > 0 && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                    {provCounts.runtime} runtime
                  </span>
                )}
                {provCounts.both > 0 && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">
                    {provCounts.both} corroborated
                  </span>
                )}
              </div>
            </div>
          )}
        </Section>

        {/* Caveats */}
        {node.caveats.length > 0 && (
          <Section title="Caveats">
            <ul className="space-y-1">
              {node.caveats.map((c, i) => (
                <li key={i} className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">
                  ⚠ {c}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}

function hasAttrs(attrs: NodeAttributes): boolean {
  return !!(
    attrs.is_async ||
    attrs.is_abstract ||
    attrs.framework_entrypoint ||
    attrs.method_kind ||
    attrs.all_is_dynamic ||
    (attrs.decorators?.length ?? 0) > 0 ||
    (attrs.mro?.length ?? 0) > 1
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="p-3 border-b">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2 text-xs mb-1">
      <span className="text-muted-foreground w-14 shrink-0">{label}</span>
      <span className={`flex-1 break-all ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className={`inline-block text-xs px-1.5 py-0.5 rounded ${color}`}>{label}</span>
  );
}

function Metric({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="text-center bg-gray-50 rounded py-1.5 px-1" title={hint}>
      <div className="text-base font-bold text-gray-800">{value}</div>
      <div className="text-[9px] text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
