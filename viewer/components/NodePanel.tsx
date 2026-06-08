"use client";

import React from "react";
import type { GraphDocument, GraphNode, GraphEdge } from "@/lib/types";

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

const PROVENANCE_BADGES: Record<string, string> = {
  static: "bg-indigo-100 text-indigo-700",
  runtime: "bg-amber-100 text-amber-700",
  both: "bg-emerald-100 text-emerald-700",
};

export default function NodePanel({
  node,
  document,
  onClose,
  onSelectNode,
}: NodePanelProps) {
  if (!node) return null;

  const nodeMap = React.useMemo(
    () => new Map(document.nodes.map((n) => [n.id, n])),
    [document]
  );

  const neighbors = React.useMemo(() => {
    const inbound: GraphEdge[] = [];
    const outbound: GraphEdge[] = [];
    for (const e of document.edges) {
      if (e.target === node.id) inbound.push(e);
      if (e.source === node.id) outbound.push(e);
    }
    return { inbound, outbound };
  }, [document, node.id]);

  const attrs = node.attributes;

  return (
    <div className="w-80 h-full flex flex-col bg-white border-l shadow-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between p-4 border-b">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-lg">{KIND_ICONS[node.kind] ?? "◆"}</span>
            <span className="font-semibold text-sm truncate">{node.name}</span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              {node.kind}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 truncate">{node.qualname}</p>
        </div>
        <button
          onClick={onClose}
          className="ml-2 text-muted-foreground hover:text-foreground text-lg leading-none"
          aria-label="Close panel"
        >
          ×
        </button>
      </div>

      {/* Scrollable body */}
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
        <Section title="Attributes">
          {attrs.is_async && <Badge label="async" color="bg-blue-100 text-blue-700" />}
          {attrs.is_abstract && <Badge label="abstract" color="bg-orange-100 text-orange-700" />}
          {attrs.framework_entrypoint && (
            <Badge label="framework_entrypoint" color="bg-pink-100 text-pink-700" />
          )}
          {attrs.method_kind && (
            <Badge label={attrs.method_kind} color="bg-purple-100 text-purple-700" />
          )}
          {attrs.all_is_dynamic && (
            <Badge label="__all__ dynamic" color="bg-yellow-100 text-yellow-700" />
          )}
          {attrs.decorators && attrs.decorators.length > 0 && (
            <div className="mt-1">
              <p className="text-xs text-muted-foreground mb-1">Decorators:</p>
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
          {attrs.mro && attrs.mro.length > 0 && (
            <div className="mt-1">
              <p className="text-xs text-muted-foreground mb-1">MRO:</p>
              <ol className="text-xs font-mono list-decimal list-inside space-y-0.5">
                {attrs.mro.map((m) => (
                  <li key={m} className="text-gray-600">{m}</li>
                ))}
              </ol>
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

        {/* Outbound neighbors */}
        <Section title={`Outbound (${neighbors.outbound.length})`}>
          {neighbors.outbound.length === 0 ? (
            <p className="text-xs text-muted-foreground">None</p>
          ) : (
            <ul className="space-y-1">
              {neighbors.outbound.slice(0, 20).map((e) => {
                const tgt = nodeMap.get(e.target);
                return (
                  <li key={e.id}>
                    <button
                      onClick={() => tgt && onSelectNode(tgt.id)}
                      className="w-full text-left text-xs flex items-center gap-1.5 hover:bg-muted rounded px-1 py-0.5 group"
                    >
                      <span className={`px-1 py-0.5 rounded text-xs font-medium ${edgeKindColor(e.kind)}`}>
                        {e.kind}
                      </span>
                      <span className="flex-1 truncate font-mono">
                        {tgt?.qualname ?? e.target}
                      </span>
                      <span className={`text-xs px-1 rounded ${PROVENANCE_BADGES[e.provenance]}`}>
                        {e.provenance}
                      </span>
                    </button>
                  </li>
                );
              })}
              {neighbors.outbound.length > 20 && (
                <li className="text-xs text-muted-foreground">
                  …{neighbors.outbound.length - 20} more
                </li>
              )}
            </ul>
          )}
        </Section>

        {/* Inbound neighbors */}
        <Section title={`Inbound (${neighbors.inbound.length})`}>
          {neighbors.inbound.length === 0 ? (
            <p className="text-xs text-muted-foreground">None</p>
          ) : (
            <ul className="space-y-1">
              {neighbors.inbound.slice(0, 20).map((e) => {
                const src = nodeMap.get(e.source);
                return (
                  <li key={e.id}>
                    <button
                      onClick={() => src && onSelectNode(src.id)}
                      className="w-full text-left text-xs flex items-center gap-1.5 hover:bg-muted rounded px-1 py-0.5"
                    >
                      <span className={`px-1 py-0.5 rounded text-xs font-medium ${edgeKindColor(e.kind)}`}>
                        {e.kind}
                      </span>
                      <span className="flex-1 truncate font-mono">
                        {src?.qualname ?? e.source}
                      </span>
                      <span className={`text-xs px-1 rounded ${PROVENANCE_BADGES[e.provenance]}`}>
                        {e.provenance}
                      </span>
                    </button>
                  </li>
                );
              })}
              {neighbors.inbound.length > 20 && (
                <li className="text-xs text-muted-foreground">
                  …{neighbors.inbound.length - 20} more
                </li>
              )}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="p-4 border-b">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
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
    <span className={`inline-block text-xs px-1.5 py-0.5 rounded mr-1 mb-1 ${color}`}>
      {label}
    </span>
  );
}

function edgeKindColor(kind: string): string {
  const map: Record<string, string> = {
    imports: "bg-blue-100 text-blue-700",
    calls: "bg-purple-100 text-purple-700",
    instantiates: "bg-indigo-100 text-indigo-700",
    inherits: "bg-orange-100 text-orange-700",
    decorates: "bg-pink-100 text-pink-700",
    defines: "bg-gray-100 text-gray-600",
  };
  return map[kind] ?? "bg-gray-100 text-gray-600";
}
