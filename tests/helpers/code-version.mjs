import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Repository fixtures publish real source instead of fabricating DB-only definitions.
export function createCodeVersion(workflows, args, configuration = {}) {
  const directory = join(workflows.instanceRoot, 'test-sources');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${args.contentHash.replace(/[^a-zA-Z0-9._-]/g, '_')}.ts`);
  if (!existsSync(path)) writeFileSync(path, `export default { ...${JSON.stringify({ name: 'Fixture', ...configuration })}, async run() { return {}; } };`);
  return workflows.createVersion({ ...args, sourcePath: path, manifest: { ...args.manifest, entry: 'worker.ts' } });
}
