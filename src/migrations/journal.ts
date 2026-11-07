import { createHash, randomUUID } from 'node:crypto';
import { openSync, closeSync, fsyncSync, writeFileSync, renameSync, mkdirSync, lstatSync, readFileSync, readdirSync, chmodSync, unlinkSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { MigrationError, type FileRecord } from './types.js';
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort((a,b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function safe(root: string, relative: string): string {
  if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new MigrationError('INVALID_PATH');
  const target = resolve(root, relative);
  if (!target.startsWith(resolve(root) + sep)) throw new MigrationError('INVALID_PATH');
  let current = root;
  for (const part of relative.split('/')) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat && !stat.isFile() && !stat.isDirectory()) throw new MigrationError('INVALID_PATH');
  }
  return target;
}
export function present(path: string) { return !!lstatSync(path, { throwIfNoEntry: false }); }
export function syncDirectory(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function directory(path: string) {
  if (present(path)) return;
  directory(dirname(path));
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  syncDirectory(dirname(path));
}
export function durable(path: string, bytes: string | Buffer) {
  directory(dirname(path));
  const temp = `${path}.tmp-${randomUUID()}`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path); syncDirectory(dirname(path));
}
export function writeJson(path: string, value: unknown) { durable(path, JSON.stringify(value, null, 2)); }
export function appendJson(path:string,value:unknown){
  directory(dirname(path));const fd=openSync(path,'a',0o600);
  try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  syncDirectory(dirname(path));
}
export function readJson<T>(path: string): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { throw new MigrationError('UNKNOWN_PROTOCOL'); }
}
export function copyDurable(source: string, target: string, mode = 0o600) {
  directory(dirname(target)); copyFileSync(source, target); chmodSync(target, mode);
  const fd = openSync(target, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(target));
}
export function removeDurable(path: string) { if (present(path)) { unlinkSync(path); syncDirectory(dirname(path)); } }
export function fileHash(path: string): string | null {
  if (!present(path)) return null;
  if (!lstatSync(path).isFile()) throw new MigrationError('INVALID_PATH');
  return hash(readFileSync(path));
}
export function scan(root: string, roots: readonly string[]): { files: FileRecord[]; missing: string[] } {
  const files: FileRecord[] = [], missing: string[] = [];
  function walk(relative: string) {
    const path = safe(root, relative), before = lstatSync(path, { bigint: true });
    if (!before.isDirectory() && !before.isFile()) throw new MigrationError('INVALID_PATH');
    const record: FileRecord = { path: relative, type: before.isDirectory() ? 'directory' : 'file', mode: Number(before.mode & 0o7777n), size: before.isFile() ? Number(before.size) : 0, hash: before.isFile() ? hash(readFileSync(path)) : '' };
    files.push(record);
    if (before.isDirectory()) for (const child of readdirSync(path).sort()) walk(`${relative}/${child}`);
    const after = lstatSync(path, { bigint: true });
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new MigrationError('SOURCE_CHANGED');
  }
  for (const relative of roots) { if (present(safe(root, relative))) walk(relative); else missing.push(relative); }
  files.sort((a,b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { files, missing };
}
