import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";

export interface OperationLogEntry {
  readonly operation: string;
  readonly correlationId?: string;
  readonly resourceId?: string;
  readonly status: "started" | "succeeded" | "failed";
  readonly error?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class OperationsLog {
  readonly directory: string;
  constructor(instanceRoot: string) { this.directory = join(instanceRoot, "logs"); }
  async write(entry: OperationLogEntry): Promise<string> {
    const correlationId = entry.correlationId ?? uuidv7();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), correlationId, ...entry }) + "\n";
    await appendFile(join(this.directory, "operations.jsonl"), line, { encoding: "utf8", mode: 0o600 });
    return correlationId;
  }
}
