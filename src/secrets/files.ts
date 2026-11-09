import { accessSync, constants, lstatSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { check } from "../domain/errors.js";

/** 检查每个已有路径分量，拒绝包括父目录在内的符号链接。 */
export function checkSecretPath(path: string, code = "SECRET_KEYRING_FORMAT_INVALID") {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = dirname(absolute);
  for (;;) {
    const info = lstatSync(current, { throwIfNoEntry: false });
    check(!info || info.isDirectory() && !info.isSymbolicLink(), code, "密钥存储路径无效", 422);
    if (current === root) break;
    current = dirname(current);
  }
  const directory = lstatSync(dirname(absolute), { throwIfNoEntry: false });
  check(!directory || (directory.mode & 0o077) === 0, code, "密钥目录权限过宽", 422);
  const file = lstatSync(absolute, { throwIfNoEntry: false });
  check(!file || file.isFile() && !file.isSymbolicLink() && (file.mode & 0o077) === 0, code, "密钥文件类型或权限无效", 422);
}

export function secretStorageReadOnly(path: string): boolean {
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (file && (file.mode & 0o200) === 0) return true;
  let current = dirname(path);
  while (!lstatSync(current, { throwIfNoEntry: false })) {
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
  const directory = lstatSync(current)!;
  if ((directory.mode & 0o200) === 0) return true;
  try { accessSync(current, constants.W_OK); return false; } catch { return true; }
}
