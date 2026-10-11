import { access, constants, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { AGENT_LAUNCHERS, type AgentLauncher } from "./profile.js";
import type { OrchardSettings } from "../../storage/settings.js";

/**
 * Trusted resolution of host CLI backends (design D1): user-configured path
 * first, then a documented, deterministic list of common install locations.
 * The resolved absolute path is pinned in the registry; run-time requests can
 * never influence which executable runs.
 */

export type BackendSource = "settings" | "discovered";

export interface BackendConfig {
  readonly executable: string;
  readonly source: BackendSource;
  readonly defaultTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly killGraceMs: number;
}

/** Per-launcher limits (design D10). Output caps are not profile-overridable. */
const LAUNCHER_LIMITS: Record<AgentLauncher, { defaultTimeoutMs: number; maxOutputBytes: number }> = {
  "pi-cli": { defaultTimeoutMs: 300_000, maxOutputBytes: 8 * 1024 * 1024 },
  "codex-cli": { defaultTimeoutMs: 300_000, maxOutputBytes: 4 * 1024 * 1024 },
};

const KILL_GRACE_MS = 2_000;

/**
 * In-memory registry of resolved backends. Entries are replaced atomically so
 * a settings save takes effect for subsequent executions while in-flight ones
 * keep the command they already resolved.
 */
export class CliBackendRegistry {
  private readonly entries = new Map<AgentLauncher, BackendConfig>();

  set(launcher: AgentLauncher, config: BackendConfig): void {
    this.entries.set(launcher, config);
  }

  delete(launcher: AgentLauncher): void {
    this.entries.delete(launcher);
  }

  get(launcher: AgentLauncher): BackendConfig | undefined {
    return this.entries.get(launcher);
  }

  list(): readonly { launcher: AgentLauncher; config: BackendConfig }[] {
    return AGENT_LAUNCHERS.flatMap((launcher) => {
      const config = this.entries.get(launcher);
      return config ? [{ launcher, config }] : [];
    });
  }
}

function compareVersionsDescending(a: string, b: string): number {
  const parse = (value: string): number[] => value.replace(/^v/, "").split(".").map((segment) => Number.parseInt(segment, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (right[index] ?? 0) - (left[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function launcherCommand(launcher: AgentLauncher): string {
  return launcher === "pi-cli" ? "pi" : "codex";
}

/** Documented, deterministic search list of static install locations. */
export function discoveryCandidates(launcher: AgentLauncher, home: string = homedir()): string[] {
  const cli = launcherCommand(launcher);
  // Order matters: `resolveCliBackends` tries nvm bins (newest Node first)
  // before these static entries.
  const candidates = [
    join(home, ".npm-global", "bin", cli),
    join("/usr", "local", "bin", cli),
    join(home, ".local", "bin", cli),
  ];
  if (process.platform === "darwin") candidates.push(join("/opt", "homebrew", "bin", cli));
  if (launcher === "codex-cli") candidates.push(join(home, ".cargo", "bin", cli));
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    candidates.push(join(appData, "npm", `${cli}.cmd`));
  }
  return candidates;
}

/** nvm bin directories for `cli`, newest Node version first. */
export async function nvmCandidates(launcher: AgentLauncher, home: string = homedir()): Promise<string[]> {
  const cli = launcherCommand(launcher);
  const root = join(home, ".nvm", "versions", "node");
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^v?\d+(\.\d+)*$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareVersionsDescending)
      .map((version) => join(root, version, "bin", cli));
  } catch {
    return [];
  }
}

export async function isExecutablePath(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function backendConfig(launcher: AgentLauncher, executable: string, source: BackendSource): BackendConfig {
  return { executable, source, ...LAUNCHER_LIMITS[launcher], killGraceMs: KILL_GRACE_MS };
}

export interface ResolveCliBackendsOptions {
  readonly settings: OrchardSettings;
  /** Extra verification (e.g. a `--version` probe) applied to discovered candidates. */
  readonly verify?: (executable: string) => Promise<boolean>;
  readonly home?: string;
  readonly isExecutable?: (path: string) => Promise<boolean>;
}

/**
 * Resolves every launcher: settings path (absolute only) wins; otherwise the
 * first candidate from the documented list that exists and passes `verify`.
 * Unresolved launchers stay unregistered ("not configured" semantics).
 */
export async function resolveCliBackends(options: ResolveCliBackendsOptions): Promise<CliBackendRegistry> {
  const registry = new CliBackendRegistry();
  const checkExists = options.isExecutable ?? isExecutablePath;
  const home = options.home ?? homedir();
  for (const launcher of AGENT_LAUNCHERS) {
    const configured = options.settings.cli?.[launcher]?.executable;
    if (typeof configured === "string" && isAbsolute(configured)) {
      // Saved paths are validated (absolute + probed) at save time; the store
      // is the operator's explicit choice, so it is trusted as-is here.
      // Non-absolute values are rejected and fall through to discovery.
      registry.set(launcher, backendConfig(launcher, configured, "settings"));
      continue;
    }
    const candidates = [...(await nvmCandidates(launcher, home)), ...discoveryCandidates(launcher, home)];
    for (const candidate of candidates) {
      if (!(await checkExists(candidate))) continue;
      if (options.verify && !(await options.verify(candidate))) continue;
      registry.set(launcher, backendConfig(launcher, candidate, "discovered"));
      break;
    }
  }
  return registry;
}
