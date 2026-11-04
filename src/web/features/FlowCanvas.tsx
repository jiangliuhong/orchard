import { Background, Controls, Handle, Position, ReactFlow, type NodeProps } from "@xyflow/react";
import { Check, Code2, GitBranch, Sparkles, Terminal } from "lucide-react";
import type { Workflow, Layout, NodeRun } from "../../domain/types.js";
import { Status } from "../components/common";
import { projectGraph, type CanvasNode } from "./graph";
import { useTheme } from "../lib/theme";
const icons = { "code.nodejs": Code2, agent: Sparkles, shell: Terminal, switch: GitBranch, end: Check };
const names = { "code.nodejs": "NODE.JS", agent: "AGENT", shell: "SHELL", switch: "SWITCH", end: "END" };
function WorkflowNode({ data, selected }: NodeProps<CanvasNode>) {
  const Icon = icons[data.kind];
  return <div className={`flow-node ${selected ? "is-selected" : ""} flow-${data.status ?? "definition"}`}><Handle type="target" position={Position.Top} /><div className="flow-node-type"><Icon size={15} />{names[data.kind]}</div><strong>{data.label}</strong><span className="flow-node-subtitle">{data.subtitle}</span>{data.status && <Status value={data.status} />}<Handle type="source" position={Position.Bottom} /></div>;
}
const nodeTypes = { workflow: WorkflowNode };
export default function FlowCanvas({ workflow, layout, records, onSelect }: { workflow: Workflow; layout?: Layout; records?: NodeRun[]; onSelect: (id: string) => void }) {
  const graph = projectGraph(workflow, layout, records);
  const { resolvedTheme } = useTheme();
  return <div className="flow-canvas" aria-label="工作流流程图"><ReactFlow colorMode={resolvedTheme} nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} elementsSelectable onNodeClick={(_, node) => onSelect(node.id)} fitView fitViewOptions={{ padding: 0.25 }} minZoom={0.25} maxZoom={1.5}><Background gap={20} size={1} color="var(--canvas-dot)" /><Controls showInteractive={false} /></ReactFlow></div>;
}
