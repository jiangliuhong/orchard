import ts from "typescript";

export interface SourceStep { id: string; type: string; description: string; file: string; line: number; }

/** Parse documentation without importing, evaluating, or executing user code. */
export function describeWorkflowSource(path: string, code: string): {
  metadata: { id?: string; name?: string; description?: string };
  steps: SourceStep[];
} {
  const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true);
  const unwrap = (expression: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
    return expression;
  };
  const literal = (expression: ts.Expression | undefined): string | undefined => {
    if (!expression) return undefined;
    const value = unwrap(expression);
    return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : undefined;
  };
  const property = (expression: ts.Expression | undefined, name: string): ts.Expression | undefined => {
    if (!expression) return undefined;
    const value = unwrap(expression);
    if (!ts.isObjectLiteralExpression(value)) return undefined;
    // A later spread can override a property; do not invent its runtime value.
    let result: ts.Expression | undefined;
    for (const item of value.properties) {
      if (ts.isSpreadAssignment(item)) result = undefined;
      else if (item.name && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name) {
        result = ts.isPropertyAssignment(item) ? item.initializer : ts.isShorthandPropertyAssignment(item) ? item.name : undefined;
      }
    }
    return result;
  };
  const comment = (node: ts.Node | undefined): string => {
    if (!node) return "";
    const ranges = ts.getLeadingCommentRanges(code, node.getFullStart()) ?? [];
    // Only adjacent documentation belongs to this declaration.
    let next = node.getStart(source);
    const parts: string[] = [];
    for (const range of [...ranges].reverse()) {
      const gap = code.slice(range.end, next);
      if (!/^\s*$/.test(gap) || /\n\s*\n/.test(gap)) break;
      const text = code.slice(range.pos, range.end);
      const body = text.startsWith("//") ? text.slice(2).trim() : text.slice(2, -2).replace(/^\s*\* ?/gm, "").trim();
      parts.unshift(body);
      next = range.pos;
    }
    return parts.join("\n").replace(/^@description\s+/m, "").split(/\n\s*@(?:param|returns?|example|see)\b/)[0]!.trim();
  };
  const declarationFor = (node: ts.Node): ts.Node | undefined => {
    while (node.parent && !ts.isStatement(node) && !ts.isSourceFile(node.parent) && !ts.isBlock(node.parent)) {
      if (ts.isCallExpression(node.parent)) return undefined;
      node = node.parent;
    }
    return node;
  };

  const metadata: { id?: string; name?: string; description?: string } = {};
  const steps: SourceStep[] = [];
  const bindings = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) bindings.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  const resolve = (expression: ts.Expression, seen = new Set<string>()): ts.Expression => {
    expression = unwrap(expression);
    if (ts.isIdentifier(expression) && bindings.has(expression.text) && !seen.has(expression.text)) {
      seen.add(expression.text);
      return resolve(bindings.get(expression.text)!, seen);
    }
    return expression;
  };
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      const text = comment(statement);
      if (text) metadata.description = text;
    }
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    let definition = resolve(statement.expression);
    if (ts.isCallExpression(definition) && ts.isIdentifier(definition.expression) && definition.expression.text === "defineWorkflow" && definition.arguments[0]) definition = resolve(definition.arguments[0]);
    for (const key of ["id", "name", "description"] as const) {
      const value = property(definition, key);
      const text = literal(value ? resolve(value) : undefined);
      if (text !== undefined) metadata[key] = text;
    }
    if (metadata.description === undefined) {
      const text = comment(statement);
      if (text) metadata.description = text;
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const access = node.expression;
      const method = access.name.text;
      if (ts.isPropertyAccessExpression(access.expression) && access.expression.name.text === "step" && ["execute", "run", "sleep", "sleepUntil", "waitForEvent", "sendEvent", "invokeWorkflow"].includes(method) && node.arguments[0] && steps.length < 256) {
        const request = node.arguments[1];
        const explicit = property(request, "description");
        const description = literal(explicit) ?? comment(declarationFor(node));
        steps.push({
          id: literal(node.arguments[0]) ?? node.arguments[0].getText(source).replace(/^`|`$/g, ""),
          type: method === "execute" || method === "run" ? literal(property(request, "type")) ?? "动态节点" : method,
          description,
          file: path,
          line: source.getLineAndCharacterOfPosition(access.expression.name.getStart(source)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { metadata, steps };
}
