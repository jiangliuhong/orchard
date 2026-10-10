import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import ts from "typescript";
import type { WorkflowExecutionPolicy, WorkflowTrigger } from "../core/contracts.js";
import { defineWorkflow } from "../workflow-sdk/index.js";
import { parseCron } from "../scheduler/cron.js";
import { describeWorkflowSource } from "./source-descriptions.js";

export interface SourceConfiguration {
  readonly name?: string;
  readonly description?: string;
  readonly triggers: readonly { readonly type: WorkflowTrigger["type"]; readonly config: Record<string, unknown> }[];
  readonly policy: WorkflowExecutionPolicy;
  readonly concurrency?: number;
}

export function sourceReadOnly(): Error {
  return Object.assign(new Error("工作流定义只允许通过修改源码并发布新版本变更。"), { name: "SOURCE_DEFINITION_READ_ONLY" });
}

/** Only JSON literals and local const references are accepted; never evaluate code. */
export function readSourceConfiguration(path: string, code: string): SourceConfiguration {
  const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) bindings.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  const unwrap = (node: ts.Expression, seen = new Set<string>()): ts.Expression => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) return unwrap(node.expression, seen);
    if (ts.isIdentifier(node) && bindings.has(node.text) && !seen.has(node.text)) {
      seen.add(node.text);
      return unwrap(bindings.get(node.text)!, seen);
    }
    return node;
  };
  const dynamic = (): never => { throw new Error("工作流名称、描述、触发器和执行策略必须在入口源码中静态声明，不能使用动态表达式或外部变量。"); };
  const json = (node: ts.Expression, ancestors = new Set<ts.Node>()): unknown => {
    node = unwrap(node);
    if (ancestors.has(node)) return dynamic();
    const next = new Set(ancestors).add(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(element => json(element, next));
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, unknown> = {};
      for (const item of node.properties) {
        if (ts.isSpreadAssignment(item)) {
          const value = json(item.expression, next);
          if (!value || typeof value !== "object" || Array.isArray(value)) return dynamic();
          Object.assign(result, value);
        } else if (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) {
          if (!ts.isIdentifier(item.name) && !ts.isStringLiteral(item.name)) return dynamic();
          Object.defineProperty(result, item.name.text, { value: json(ts.isPropertyAssignment(item) ? item.initializer : item.name, next), enumerable: true, configurable: true, writable: true });
        } else return dynamic();
      }
      return result;
    }
    return dynamic();
  };
  const fields = new Set(["name", "description", "triggers", "policy", "concurrency"]);
  const selected: Record<string, unknown> = {};
  const pick = (node: ts.Expression): void => {
    node = unwrap(node);
    if (!ts.isObjectLiteralExpression(node)) return dynamic();
    for (const item of node.properties) {
      if (ts.isSpreadAssignment(item)) pick(item.expression);
      else if (item.name && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && fields.has(item.name.text)) {
        if (!ts.isPropertyAssignment(item) && !ts.isShorthandPropertyAssignment(item)) return dynamic();
        selected[item.name.text] = json(ts.isPropertyAssignment(item) ? item.initializer : item.name);
      } else if (item.name && ts.isComputedPropertyName(item.name)) return dynamic();
    }
  };
  const exported = source.statements.find(statement => ts.isExportAssignment(statement) && !statement.isExportEquals);
  if (exported && ts.isExportAssignment(exported)) {
    let node = unwrap(exported.expression);
    if (ts.isCallExpression(node)) {
      if (!ts.isIdentifier(node.expression) || node.expression.text !== "defineWorkflow" || !node.arguments[0]) return dynamic();
      node = unwrap(node.arguments[0]);
    }
    if (ts.isObjectLiteralExpression(node)) pick(node);
    else if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return dynamic();
  } else if (!source.statements.some(statement => ts.isFunctionDeclaration(statement) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword))) {
    throw new Error("工作流入口必须有默认导出。");
  }
  for (const key of ["name", "description"] as const) if (selected[key] !== undefined && typeof selected[key] !== "string") throw new Error(`Invalid workflow ${key}`);
  if (selected.policy !== undefined && (!selected.policy || typeof selected.policy !== "object" || Array.isArray(selected.policy))) throw new Error("Invalid workflow policy");
  if (selected.triggers !== undefined && !Array.isArray(selected.triggers)) throw new Error("Invalid workflow triggers");
  const configuration: SourceConfiguration = {
    ...describeWorkflowSource(path, code).metadata,
    ...selected,
    triggers: (selected.triggers ?? []) as { type: WorkflowTrigger["type"]; config: Record<string, unknown> }[],
    policy: (selected.policy ?? {}) as WorkflowExecutionPolicy,
  };
  defineWorkflow({ ...configuration, id: "source-workflow", name: configuration.name ?? "source-workflow", inputSchema: {}, outputSchema: {}, run: async () => null });
  for (const trigger of configuration.triggers) {
    const config = trigger.config;
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid workflow trigger config");
    if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw new Error("Invalid trigger enabled");
    if (trigger.type === "cron") {
      if (typeof config.expression !== "string" || (config.timezone !== undefined && typeof config.timezone !== "string")) throw new Error("Cron requires an expression and a valid timezone");
      parseCron(config.expression, config.timezone as string | undefined);
      if (config.misfirePolicy !== undefined && !["skip", "catch_up"].includes(config.misfirePolicy as string)) throw new Error("Invalid cron misfirePolicy");
    }
    if (trigger.type === "event" && typeof (config.eventName ?? config.name) !== "string") throw new Error("Event trigger requires eventName");
  }
  return configuration;
}

/** Read the version's source, never its database configuration backup. */
export function readVersionConfiguration(instanceRoot: string, version: { sourcePath: string; contentHash: string; manifest: unknown }): SourceConfiguration {
  const root = realpathSync(instanceRoot);
  const inside = (path: string): boolean => path === root || path.startsWith(root + sep);
  const source = realpathSync(resolve(root, version.sourcePath));
  if (!inside(source)) throw new Error("Workflow source escaped instance root");
  const manifest = version.manifest as { entry?: string };
  const entry = (manifest.entry ?? "worker.ts").replace(/^source\//, "");
  if (entry.startsWith("/") || entry.includes("\\") || entry.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe workflow entry");
  const file = statSync(source).isDirectory() ? realpathSync(resolve(source, entry)) : source;
  if (!inside(file) || (statSync(source).isDirectory() && !file.startsWith(source + sep))) throw new Error("Workflow entry escaped source root");
  if (statSync(file).size > 1024 * 1024) throw new Error("Workflow source exceeds limit");
  const code = readFileSync(file, "utf8");
  if (/^[a-f0-9]{64}$/.test(version.contentHash) && createHash("sha256").update(code).digest("hex") !== version.contentHash) throw new Error("Workflow source digest mismatch; publish a new version");
  return readSourceConfiguration(entry, code);
}
