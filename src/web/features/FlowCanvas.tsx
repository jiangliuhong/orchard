import { useMemo } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type NodeProps } from "@xyflow/react";
import { Check, Code2, GitBranch, Sparkles, Terminal, Globe } from "lucide-react";
import type { Workflow, Layout, NodeRun } from "../../domain/types.js";
import { Status } from "../components/common";
import { projectGraph, type CanvasNode } from "./graph";
import { useTheme } from "../lib/theme";
const icons = { "code.nodejs": Code2, agent: Sparkles, shell: Terminal, script: Code2, switch: GitBranch, "web-bridge": Globe, end: Check };
const names = { "code.nodejs": "NODE.JS", agent: "AGENT", shell: "SHELL", script: "SCRIPT", switch: "SWITCH", "web-bridge": "WEB BRIDGE", end: "END" };
function WorkflowNode({ data, selected }: NodeProps<CanvasNode>) {
  const Icon = icons[data.kind];
  if (data.kind === "end") return <div className={`flow-node flow-node-end ${selected ? "is-selected" : ""}`} title="点击查看工作流最终输出"><Handle type="target" position={Position.Top} /><Icon size={12} /><span>结束</span></div>;
  return <div className={`flow-node flow-kind-${data.kind.replace(".", "-")} ${selected ? "is-selected" : ""} flow-${data.status ?? "definition"}`}><Handle type="target" position={Position.Top} /><div className="flow-node-heading"><span className="flow-node-icon"><Icon size={14} /></span><div className="flow-node-copy"><span className="flow-node-type">{names[data.kind]}</span><strong title={data.label}>{data.label}</strong></div></div><div className="flow-node-footer"><span className="flow-node-subtitle" title={data.subtitle}>{data.subtitle}</span>{data.status && <Status value={data.status} />}</div><Handle type="source" position={Position.Bottom} /></div>;
}
const nodeTypes = { workflow: WorkflowNode };
export default function FlowCanvas({ workflow, layout, records, onSelect }: { workflow: Workflow; layout?: Layout; records?: NodeRun[]; onSelect: (id: string) => void }) {
  const graph = useMemo(() => projectGraph(workflow, layout, records), [workflow, layout, records]);
  const { resolvedTheme } = useTheme();
  return <div className="flow-canvas" aria-label="工作流流程图"><ReactFlow colorMode={resolvedTheme} nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} defaultEdgeOptions={{ type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "var(--graph-edge)" }, style: { stroke: "var(--graph-edge)", strokeWidth: 1.25 } }} nodesDraggable={false} nodesConnectable={false} elementsSelectable onNodeClick={(_, node) => onSelect(node.id)} fitView fitViewOptions={{ padding: 0.22, maxZoom: 1 }} minZoom={0.25} maxZoom={1.5}><Background gap={18} size={1} color="var(--canvas-dot)" /><Controls showInteractive={false} fitViewOptions={{ padding: 0.22, maxZoom: 1 }} /></ReactFlow></div>;
}
