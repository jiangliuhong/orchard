import type { Workflow, Layout, NodeRun, StreamEvent } from "../../domain/types.js";
import type { Node, Edge } from "@xyflow/react";

export interface GraphData extends Record<string, unknown> { label: string; kind: Workflow["nodes"][number]["type"] | "end"; status?: string; subtitle: string }
export type CanvasNode = Node<GraphData>;
export function projectGraph(workflow: Workflow, layout: Layout = {}, records: NodeRun[] = []) {
  const depths = new Map<string, number>([[workflow.entryNodeId, 0]]);
  const queue = [workflow.entryNodeId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of workflow.edges.filter(e => e.from === id && e.to !== null)) {
      const depth = (depths.get(id) ?? 0) + 1;
      if (depth > (depths.get(edge.to!) ?? -1) && depth <= workflow.nodes.length) { depths.set(edge.to!, depth); queue.push(edge.to!); }
    }
  }
  const levels = new Map<number, number>();
  const nodes: CanvasNode[] = workflow.nodes.map(node => {
    const depth = depths.get(node.id) ?? 0, row = levels.get(depth) ?? 0; levels.set(depth, row + 1);
    return { id: node.id, type: "workflow", position: layout[node.id] ?? { x: row * 260, y: depth * 155 }, data: {
      label: node.name, kind: node.type, status: records.find(r => r.nodeId === node.id)?.status,
      subtitle: node.type === "agent" ? [node.config.providerId ?? "继承默认", node.config.modelId].filter(Boolean).join(" · ") : node.type === "switch" ? `${node.config.cases?.length ?? 0} 个条件 + 默认` : node.config.script ?? "",
    } };
  });
  const chosen = new Set(records.map(n => n.route?.edgeId).filter(Boolean));
  const edges: Edge[] = workflow.edges.map(edge => {
    const from = records.find(n => n.nodeId === edge.from), to = records.find(n => n.nodeId === edge.to);
    const selected = chosen.has(edge.id) || from?.type !== "switch" && from?.status === "succeeded" && to?.status !== "skipped" && to?.status !== "pending";
    return { id: edge.id, source: edge.from, target: edge.to ?? "__end", label: edge.label, type: "smoothstep", animated: selected && to?.status === "running", style: { stroke: selected ? "var(--graph-edge-active)" : "var(--graph-edge)", strokeWidth: selected ? 2.5 : 1.5 }, labelStyle: { fontSize: 11 } };
  });
  const maxDepth = Math.max(...depths.values(), 0);
  nodes.push({ id: "__end", type: "workflow", position: { x: 0, y: (maxDepth + 1) * 155 }, data: { label: "结束", kind: "end", subtitle: "返回工作流结果" }, selectable: false });
  for (const node of workflow.nodes.filter(n => !workflow.edges.some(e => e.from === n.id))) edges.push({ id: `__end-${node.id}`, source: node.id, target: "__end", type: "smoothstep" });
  return { nodes, edges };
}
export function renderableWorkflow(value: unknown): value is Workflow {
  if (!value || typeof value !== "object") return false;
  const g = value as Workflow;
  return Array.isArray(g.nodes) && Array.isArray(g.edges) && typeof g.entryNodeId === "string" &&
    g.nodes.every(n => n && typeof n.id === "string" && typeof n.name === "string" && n.config && ["code.nodejs", "agent", "shell", "switch"].includes(n.type)) &&
    g.edges.every(e => e && typeof e.id === "string" && g.nodes.some(n => n.id === e.from) && (e.to === null || g.nodes.some(n => n.id === e.to))) &&
    new Set(g.nodes.map(n => n.id)).size === g.nodes.length;
}
export function applyEventStatus(records: NodeRun[], event: StreamEvent) {
  if (!event.nodeId || !/^node\.(started|succeeded|failed|cancelled)$/.test(event.type)) return records;
  const status = event.type === "node.started" ? "running" : event.type.slice(5);
  return records.map(node => node.nodeId === event.nodeId && ["pending", "running"].includes(node.status) ? { ...node, status: status as NodeRun["status"] } : node);
}
