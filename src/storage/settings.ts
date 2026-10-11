import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * File-backed instance settings store: `<dataDir>/settings.json`.
 *
 * Deliberately NOT a database table: schema changes require review
 * (AGENTS.md), and operational settings must be readable before the backend
 * registry is constructed. The file uses a namespaced structure
 * (`cli`, `authoring`, ...) so future settings can join without format churn.
 */

export interface CliBackendSetting {
  readonly executable: string;
}

export interface OrchardSettings {
  readonly cli?: { readonly "pi-cli"?: CliBackendSetting; readonly "codex-cli"?: CliBackendSetting };
  readonly authoring?: { readonly profileId?: string };
}

const EMPTY_SETTINGS: OrchardSettings = {};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class SettingsStore {
  private readonly filePath: string;

  constructor(readonly dataDir: string) {
    this.filePath = join(dataDir, "settings.json");
  }

  async read(): Promise<OrchardSettings> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return isPlainObject(parsed) ? (parsed as OrchardSettings) : EMPTY_SETTINGS;
    } catch {
      // Missing or malformed settings behave like "no overrides".
      return EMPTY_SETTINGS;
    }
  }

  async getCliExecutable(launcher: "pi-cli" | "codex-cli"): Promise<string | undefined> {
    const settings = await this.read();
    const entry = settings.cli?.[launcher];
    return typeof entry?.executable === "string" && entry.executable.length > 0 ? entry.executable : undefined;
  }

  /**
   * Persists (or clears, when `executable` is null) the trusted path for a
   * launcher. Callers must probe the path before saving; this store only
   * persists what it is told.
   */
  async setCliExecutable(launcher: "pi-cli" | "codex-cli", executable: string | null): Promise<OrchardSettings> {
    return this.mutate((settings) => {
      const cli = { ...(settings.cli ?? {}) };
      if (executable === null) delete cli[launcher];
      else cli[launcher] = { executable };
      return { ...settings, cli };
    });
  }

  async getAuthoringProfileId(): Promise<string | undefined> {
    const settings = await this.read();
    const profileId = settings.authoring?.profileId;
    return typeof profileId === "string" && profileId.length > 0 ? profileId : undefined;
  }

  async setAuthoringProfileId(profileId: string | null): Promise<OrchardSettings> {
    return this.mutate((settings) => ({ ...settings, authoring: profileId === null ? {} : { profileId } }));
  }

  private async mutate(update: (settings: OrchardSettings) => OrchardSettings): Promise<OrchardSettings> {
    // Read-modify-write without a lock: the workbench is a single-user local
    // process and settings writes only come from its own API handlers.
    const next = update(await this.read());
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return next;
  }
}
