import { mkdirSync, mkdtempSync, lstatSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../domain/errors.js";
import type { DictionaryContext } from "../dictionaries/execution.js";

/** Context access checks own properties at both levels. Errors never include values. */
export const CONTEXT_SOURCE = `
function dictionaryContext(data) {
  function read(section, alias, key) {
    if(typeof alias!=='string'||typeof key!=='string'||!Object.hasOwn(data[section],alias)||!Object.hasOwn(data[section][alias],key)) throw new Error('DICTIONARY_ACCESS_DENIED');
    return structuredClone(data[section][alias][key]);
  }
  return Object.freeze({dictionaries:Object.freeze({get:(alias,key)=>read('dictionaries',alias,key)}),secrets:Object.freeze({get:(alias,key)=>read('secrets',alias,key)})});
}
`;
const HELPER_SOURCE = `import {readFileSync} from 'node:fs';
${CONTEXT_SOURCE}
try {
 const [kind,alias,key,raw,...extra]=process.argv.slice(2);
 if(!['plain','secret'].includes(kind)||extra.length||raw!==undefined&&raw!=='--raw')throw new Error();
 const data=JSON.parse(readFileSync(process.env.ORCHARD_DICTIONARY_FILE,'utf8'));
 const ctx=dictionaryContext(data),value=ctx[kind==='plain'?'dictionaries':'secrets'].get(alias,key);
 if(raw==='--raw'&&typeof value!=='string')throw new Error();
 process.stdout.write(raw==='--raw'?value:JSON.stringify(value));
} catch {process.stderr.write('DICTIONARY_ACCESS_DENIED');process.exitCode=1;}
`;
export function writeDictionaryContext(directory: string, context: DictionaryContext): Record<string, string> {
  // Keep host-owned files separate from version-local sources, without reserving
  // user filenames or directory names. The enclosing attempt owns cleanup.
  const contextDirectory = mkdtempSync(join(directory, ".orchard-context-"));
  const file = join(contextDirectory, "dictionary-context.json"), helper = join(contextDirectory, "dictionary-helper.mjs");
  writeFileSync(file, JSON.stringify(context), { mode: 0o600, flag: "wx" });
  writeFileSync(helper, HELPER_SOURCE, { mode: 0o600, flag: "wx" });
  return { ORCHARD_DICTIONARY_FILE: file, ORCHARD_DICTIONARY_HELPER: helper, ORCHARD_NODE_EXECUTABLE: process.execPath };
}
const preparedStores = new WeakSet<object>();
export function prepareScriptRuntime(store: { files: { path(path: string): string } }) {
  if (preparedStores.has(store)) return;
  cleanScriptAttempts(store.files.path("runs")); preparedStores.add(store);
}
/** Only a fixed, private attempt namespace is eligible; never follow symlinks or remove run artifacts. */
export function cleanScriptAttempts(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  check(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), "INVALID_PATH", "执行临时目录无效");
  for (const name of readdirSync(root)) if (/^script-attempt-[a-f0-9-]{36}$/.test(name)) {
    const path = join(root, name), info = lstatSync(path);
    check(info.isDirectory() && !info.isSymbolicLink(), "INVALID_PATH", "遗留执行临时目录无效");
    rmSync(path, { recursive: true, force: true });
  }
}
