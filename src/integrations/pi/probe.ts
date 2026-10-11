import { ProcessController } from "../cli/process-controller.js";
import type { BackendConfig, BackendSource } from "./backends.js";
import type { AgentLauncher } from "./profile.js";

/**
 * Availability probing (design D7).
 *
 * - L1 (cheap, local): run `<cli> --version`.
 * - L2 (deep, pi only, explicit user action): `pi auth check --model <m>
 *   --json --no-refresh` per referencing profile. Never cached — a diagnostic
 *   must report what was just checked.
 */

const VERSION_TIMEOUT_MS = 10_000;
const VERSION_MAX_OUTPUT_BYTES = 64 * 1024;
const READINESS_TIMEOUT_MS = 30_000;

export interface VersionProbe {
  readonly available: boolean;
  readonly version?: string;
  readonly reason?: string;
}

export interface BackendProbe extends VersionProbe {
  readonly launcher: AgentLauncher;
  readonly path: string;
  readonly source: BackendSource;
}

export type ReadinessState = "ready" | "failed" | "unchecked";

export interface ReadinessProbe {
  readonly state: ReadinessState;
  readonly reason?: string;
}

export async function probeVersion(
  executable: string,
  options: { controller?: ProcessController; timeoutMs?: number } = {},
): Promise<VersionProbe> {
  const controller = options.controller ?? new ProcessController();
  try {
    const result = await controller.execute({
      executable,
      args: ["--version"],
      timeoutMs: options.timeoutMs ?? VERSION_TIMEOUT_MS,
      maxOutputBytes: VERSION_MAX_OUTPUT_BYTES,
      killGraceMs: 1_000,
    });
    if (result.exitCode !== 0) {
      return { available: false, reason: `--version exited with code ${result.exitCode}` };
    }
    const version = result.stdout.trim().split("\n").pop()?.trim();
    return version ? { available: true, version } : { available: true };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Verifier adapter for `resolveCliBackends`. */
export function versionVerifier(controller?: ProcessController): (executable: string) => Promise<boolean> {
  return async (executable) => (await probeVersion(executable, controller ? { controller } : {})).available;
}

export async function probeBackend(
  launcher: AgentLauncher,
  config: BackendConfig,
  options: { controller?: ProcessController } = {},
): Promise<BackendProbe> {
  const probe = await probeVersion(config.executable, options.controller ? { controller: options.controller } : {});
  return { launcher, path: config.executable, source: config.source, ...probe };
}

/**
 * L2 for the pi launcher: checks provider readiness for one model without
 * refreshing credentials. Profiles without an explicit model are reported as
 * `unchecked` (pi auth check requires --model or --provider).
 */
export async function probePiReadiness(
  executable: string,
  model: string | undefined,
  options: { controller?: ProcessController } = {},
): Promise<ReadinessProbe> {
  if (!model) {
    return { state: "unchecked", reason: "profile has no explicit model to check against" };
  }
  const controller = options.controller ?? new ProcessController();
  try {
    const result = await controller.execute({
      executable,
      args: ["auth", "check", "--model", model, "--json", "--no-refresh"],
      timeoutMs: READINESS_TIMEOUT_MS,
      maxOutputBytes: VERSION_MAX_OUTPUT_BYTES,
      killGraceMs: 1_000,
    });
    if (result.exitCode === 0) return { state: "ready" };
    return { state: "failed", reason: excerpt(result.stderr || result.stdout) };
  } catch (error) {
    return { state: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

function excerpt(value: string, limit = 500): string {
  const text = value.trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
