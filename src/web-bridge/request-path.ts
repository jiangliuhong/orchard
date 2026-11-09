import { AppError, check } from "../domain/errors.js";

export function validatePath(path: string, template = false) {
  check(typeof path === "string" && /^\/[^/]/.test(path) && !/[\\\u0000-\u0020\u007f?#]/.test(path), "INVALID_PATH", "请求路径必须是同源绝对路径");
  const plain = template ? path.replace(/\{[a-zA-Z][a-zA-Z0-9_]{0,99}\}/g, "value") : path;
  check(!/[{}]/.test(plain), "INVALID_PATH", "路径占位符无效");
  for (const segment of plain.split("/")) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { throw new AppError("INVALID_PATH", "路径编码无效"); }
    check(decoded !== "." && decoded !== ".." && !/[\\/%\u0000-\u0020\u007f]/.test(decoded), "INVALID_PATH", "路径包含不安全的路径段");
  }
}
