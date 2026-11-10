import { lstatSync, writeFileSync, accessSync, constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { check, AppError } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import type { SshProfile } from "./types.js";

const token = /^[a-zA-Z0-9_.-]+$/;
export function validateProfile(value: unknown): asserts value is SshProfile {
  assertSchema(value, { type: "object", required: ["id", "name", "host", "port", "user", "identityFile", "knownHostsFile", "useAgent", "revision"], additionalProperties: false,
    properties: { id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$" }, name: { type: "string", minLength: 1, maxLength: 200 }, host: { type: "string" }, user: { type: "string" }, port: { type: "integer", minimum: 1, maximum: 65535 }, identityFile: { type: "string" }, knownHostsFile: { type: "string" }, useAgent: { type: "boolean" }, revision: { type: "integer", minimum: 1 } } }, "SSH 档案");
  const profile = value as SshProfile;
  check(token.test(profile.host) && !profile.host.startsWith("-") && token.test(profile.user) && !profile.user.startsWith("-"), "SSH_PROFILE_INVALID", "SSH 主机或用户无效");
}
export function validateKeyFiles(profile: SshProfile) {
  for (const [path, privateKey] of [[profile.identityFile, true], [profile.knownHostsFile, false]] as const) {
    check(isAbsolute(path) && !/[\0\r\n%]/.test(path), "SSH_AUTH_FAILED", "SSH 文件引用无效");
    let info;
    try { info = lstatSync(path); } catch { throw new AppError("SSH_AUTH_FAILED", "SSH 密钥或主机信任文件不可用"); }
    check(info.isFile() && !info.isSymbolicLink() && (!privateKey || !(info.mode & 0o077)), "SSH_AUTH_FAILED", "SSH 文件类型或私钥权限无效");
    // The immediate containing directory must be controlled by the service account.
    let ancestor = dirname(path);
    while (ancestor !== dirname(ancestor)) {
      const stat = lstatSync(ancestor);
      check(!stat.isSymbolicLink() && (!(stat.mode & 0o022) || Boolean(stat.mode & 0o1000) && stat.uid === 0), "SSH_AUTH_FAILED", "SSH 文件祖先目录不受控");
      ancestor = dirname(ancestor);
    }
    accessSync(path, constants.R_OK);
    const parent = lstatSync(dirname(path));
    check(parent.isDirectory() && !parent.isSymbolicLink() && !(parent.mode & 0o022), "SSH_AUTH_FAILED", "SSH 文件父目录不受控");
    if (process.getuid) check(info.uid === process.getuid() && parent.uid === process.getuid(), "SSH_AUTH_FAILED", "SSH 文件必须属于运行账户");
  }
  if (profile.useAgent) check(Boolean(process.env.SSH_AUTH_SOCK), "SSH_AUTH_FAILED", "服务未检测到已解锁的 ssh-agent");
}
export function normalizeRemote(value: string, profile: SshProfile): string {
  check(typeof value === "string" && !/[\s\x00-\x1f\x7f]/.test(value), "PROJECT_REMOTE_INVALID", "仅支持非交互 SSH Git 地址");
  let host: string, user: string, port: number, path: string;
  const scp = /^([\w.-]+)@([\w.-]+):(.+)$/.exec(value);
  if (scp) { [, user, host, path] = scp as unknown as [string, string, string, string]; port = profile.port; }
  else {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new AppError("PROJECT_REMOTE_INVALID", "SSH Git 地址无效"); }
    check(parsed.protocol === "ssh:" && !parsed.password && !parsed.search && !parsed.hash, "PROJECT_REMOTE_INVALID", "仅支持 SSH Git 地址");
    host = parsed.hostname; user = parsed.username; port = Number(parsed.port || 22); path = parsed.pathname.replace(/^\//, "");
  }
  check(host!.toLowerCase() === profile.host.toLowerCase() && user! === profile.user && port! === profile.port, "PROJECT_REMOTE_INVALID", "地址主机、端口与用户必须匹配 SSH 档案");
  // Restrict remote paths to a portable, non-shell-active subset (including percent encoding).
  check(/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(path!) && !path!.split("/").some(p => !p || p === "." || p === ".."), "PROJECT_REMOTE_INVALID", "SSH 仓库路径无效");
  // Preserve SCP relative-path semantics; the controlled launcher supplies its explicit port.
  return scp ? `${profile.user}@${profile.host}:${path!}` : `ssh://${profile.user}@${profile.host}:${profile.port}/${path!}`;
}
export function validateBranch(branch: string) {
  check(typeof branch === "string" && branch.length > 0 && !branch.startsWith("-") && !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(branch) && !branch.includes("..") && !branch.includes("@{") && branch !== "@" && !branch.endsWith("/") && !branch.endsWith(".") && branch.split("/").every(p => p && !p.startsWith(".") && !p.endsWith(".lock")), "PROJECT_BRANCH_INVALID", "Git 分支名无效");
}
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Git invokes this fixed launcher; no user-provided SSH command is accepted. */
export function sshEnvironment(directory: string, profile: SshProfile): Record<string, string> {
  validateKeyFiles(profile);
  const launcher = join(directory, "ssh-launcher");
  const args = ["-F", "/dev/null", "-p", String(profile.port), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "ConnectTimeout=15", "-o", "IdentitiesOnly=yes", "-o", "GlobalKnownHostsFile=/dev/null", "-o", `UserKnownHostsFile="${profile.knownHostsFile.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`, "-i", profile.identityFile, ...(!profile.useAgent ? ["-o", "IdentityAgent=none"] : [])];
  writeFileSync(launcher, `#!/bin/sh\nexec /usr/bin/ssh ${args.map(shellQuote).join(" ")} "$@"\n`, { mode: 0o700, flag: "wx" });
  return { GIT_SSH: launcher, GIT_SSH_VARIANT: "ssh", ...(profile.useAgent ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK! } : {}) };
}
export function safeGitError(stderr: string): AppError {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .*host key is known/i.test(stderr)) return new AppError("SSH_HOST_UNTRUSTED", "SSH 主机未受信任或主机密钥已变化");
  if (/Permission denied|publickey|identity file|sign_and_send_pubkey/i.test(stderr)) return new AppError("SSH_AUTH_FAILED", "SSH 认证失败，请检查密钥、解锁状态及仓库读取权限");
  if (/couldn't find remote ref|Remote branch .* not found/i.test(stderr)) return new AppError("PROJECT_BRANCH_NOT_FOUND", "远端分支不存在");
  if (/timed out|timeout/i.test(stderr)) return new AppError("TIMEOUT", "Git 网络连接超时");
  return new AppError("PROJECT_FETCH_FAILED", "Git 操作失败，请检查网络、仓库权限和可用磁盘空间");
}
