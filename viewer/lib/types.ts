/** TypeScript types mirroring graph.json schema (§8). */

export type NodeKind =
  | "module"
  | "package"
  | "class"
  | "function"
  | "method"
  | "coroutine"
  | "variable"
  | "external";

export type EdgeKind =
  | "imports"
  | "calls"
  | "instantiates"
  | "inherits"
  | "decorates"
  | "defines";

export type Provenance = "static" | "runtime" | "both";
export type Confidence = "resolved" | "heuristic" | "dynamic-unresolved";

export interface NodeAttributes {
  is_async?: boolean;
  method_kind?: "instance" | "classmethod" | "staticmethod" | null;
  is_abstract?: boolean;
  is_namespace_package?: boolean;
  framework_entrypoint?: boolean;
  decorators?: string[];
  mro?: string[];
  all_is_dynamic?: boolean;
  dotted_name?: string;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualname: string;
  module: string;
  file_path: string;
  line_start: number;
  line_end: number;
  attributes: NodeAttributes;
  caveats: string[];
}

export interface EdgeEvidence {
  static?: { file?: string; line?: number; [key: string]: unknown };
  runtime?: { call_count?: number; tracer?: string; [key: string]: unknown };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  provenance: Provenance;
  confidence: Confidence;
  evidence: EdgeEvidence;
  caveats: string[];
}

export interface GraphStats {
  n_nodes: number;
  n_modules: number;
  n_classes: number;
  n_functions: number;
  n_edges: number;
  n_calls_static: number;
  n_calls_runtime: number;
  n_calls_both: number;
  n_init_targeted_definition_edges: number;
  node_kinds: Record<string, number>;
}

export interface GraphDocument {
  schema_version: string;
  repo: Record<string, unknown>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
  global_caveats: string[];
}

/** Filters applied in the viewer UI. */
export interface ViewFilters {
  nodeKinds: Set<NodeKind>;
  edgeKinds: Set<EdgeKind>;
  provenances: Set<Provenance>;
  confidences: Set<Confidence>;
}

export const ALL_NODE_KINDS: NodeKind[] = [
  "module", "package", "class", "function", "method", "coroutine", "variable", "external",
];

export const ALL_EDGE_KINDS: EdgeKind[] = [
  "imports", "calls", "instantiates", "inherits", "decorates", "defines",
];

export const ALL_PROVENANCES: Provenance[] = ["static", "runtime", "both"];
export const ALL_CONFIDENCES: Confidence[] = ["resolved", "heuristic", "dynamic-unresolved"];
