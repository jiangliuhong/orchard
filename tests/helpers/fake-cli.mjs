import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Materializes the fake pi/codex CLIs as executable scripts in a temp dir so
 * they can be registered as trusted backend executables.
 */
export async function materializeFakeClis(dir) {
  await mkdir(dir, { recursive: true });
  const pi = join(dir, "pi");
  const codex = join(dir, "codex");
  await copyFile(fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url)), pi);
  await copyFile(fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url)), codex);
  await chmod(pi, 0o755);
  await chmod(codex, 0o755);
  return { pi, codex };
}
