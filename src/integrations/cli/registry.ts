import { CliExecutionError } from "./errors.js";
import type { CliToolDefinition } from "./types.js";

const TOOL_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export class CliToolRegistry {
  private readonly tools = new Map<string, CliToolDefinition<any, any>>();

  register<Input, Output>(tool: CliToolDefinition<Input, Output>): this {
    if (!TOOL_ID_PATTERN.test(tool.id)) {
      throw new CliExecutionError(
        "INVALID_TOOL_ID",
        `Invalid CLI tool id "${tool.id}". Use namespaced lowercase ids such as "local.report".`,
        { toolId: tool.id },
      );
    }
    if (!tool.executable || tool.executable.includes("\u0000")) {
      throw new CliExecutionError("INVALID_TOOL_ID", `Invalid executable for CLI tool "${tool.id}".`, {
        toolId: tool.id,
      });
    }
    if (this.tools.has(tool.id)) {
      throw new CliExecutionError("DUPLICATE_TOOL", `CLI tool "${tool.id}" is already registered.`, {
        toolId: tool.id,
      });
    }
    this.tools.set(tool.id, tool);
    return this;
  }

  get<Input, Output>(toolId: string): CliToolDefinition<Input, Output> {
    const tool = this.tools.get(toolId) as CliToolDefinition<Input, Output> | undefined;
    if (!tool) {
      throw new CliExecutionError("TOOL_NOT_FOUND", `CLI tool "${toolId}" is not registered.`, { toolId });
    }
    return tool;
  }

  has(toolId: string): boolean {
    return this.tools.has(toolId);
  }

  list(): readonly CliToolDefinition<any, any>[] {
    return [...this.tools.values()];
  }
}
