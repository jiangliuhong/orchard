import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export class LocalApiAuth {
  readonly path: string;
  readonly token: string;
  constructor(dataDir: string) {
    const directory = join(dataDir, "runtime");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, "api-token");
    if (existsSync(this.path)) this.token = readFileSync(this.path, "utf8").trim();
    else {
      this.token = randomBytes(32).toString("hex");
      const fd = openSync(this.path, "wx", 0o600); writeFileSync(fd, this.token); closeSync(fd); chmodSync(this.path, 0o600);
    }
  }
  valid(value: unknown) { return typeof value === "string" && value === this.token; }
  view() { return { configured: true, path: this.path, last4: this.token.slice(-4) }; }
}
