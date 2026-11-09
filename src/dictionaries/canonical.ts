import { AppError, check } from "../domain/errors.js";

/**
 * 字典可移植定义、AAD 与新协议请求共用的规范化与解析契约（设计 §3.1）。
 * 规范化统一采用 UTF-8 字节序排序对象键、保持数组顺序、无空白；
 * 数字采用 JSON 有限数字表示，负零规范化为 0。
 * 不替换或改动旧脚本与 Git v1 的既有规范化算法。
 */

const CANONICAL_GUARD_DEPTH = 100;

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** UTF-8 字节序键比较；供需要稳定排序的字典协议复用。 */
export const compareUtf8Keys = compareUtf8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && [null, Object.prototype].includes(Object.getPrototypeOf(value));
}

/** 规范化 JSON 序列化：拒绝非 JSON 值与非普通对象；深度仅为内部护栏。 */
export function canonicalJson(value: unknown, maxDepth = CANONICAL_GUARD_DEPTH): string {
  const visit = (item: unknown, depth: number): string => {
    check(depth <= maxDepth, "INVALID_JSON", "JSON 嵌套深度超过内部护栏");
    if (item === null) return "null";
    const type = typeof item;
    if (type === "boolean") return item === true ? "true" : "false";
    if (type === "string") return JSON.stringify(item);
    if (type === "number") {
      check(Number.isFinite(item), "INVALID_JSON", "JSON 数字必须有限");
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      check(Object.keys(item).length === item.length, "INVALID_JSON", "JSON 数组不允许稀疏元素");
      return `[${item.map(entry => visit(entry, depth + 1)).join(",")}]`;
    }
    check(isPlainObject(item), "INVALID_JSON", "仅允许普通 JSON 对象");
    return `{${Object.keys(item).sort(compareUtf8).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      check("value" in descriptor, "INVALID_JSON", "JSON 不允许访问器");
      return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
    }).join(",")}}`;
  };
  return visit(value, 1);
}

/** JSON 值的嵌套深度：对象或数组各计一层，标量不计。 */
export function jsonDepth(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  let max = 0;
  const stack: Array<{ item: unknown; depth: number }> = [{ item: value, depth: 1 }];
  while (stack.length) {
    const { item, depth } = stack.pop()!;
    if (depth > max) max = depth;
    if (Array.isArray(item)) {
      for (const entry of item) if (entry && typeof entry === "object") stack.push({ item: entry, depth: depth + 1 });
    } else if (isPlainObject(item)) {
      for (const entry of Object.values(item)) if (entry && typeof entry === "object") stack.push({ item: entry, depth: depth + 1 });
    }
  }
  return max;
}

interface ParseOptions { maxDepth?: number }

/**
 * 严格 JSON 解析：拒绝重复对象键、超过深度限制的输入与非标准 JSON 文本。
 * 管理请求、密钥备份及 Git 字典 JSON 在转换为普通对象前必须使用本解析器；
 * 普通 JSON.parse 无法拒绝重复键，不允许绕过。
 */
export function parseStrictJson(text: string, options: ParseOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? 32;
  check(typeof text === "string", "INVALID_JSON", "JSON 输入必须是文本");
  const source = text;
  let position = 0;
  const fail = (detail: string): never => { throw new AppError("INVALID_JSON", `JSON 解析失败: ${detail}`); };
  const skipWhitespace = () => { while (position < source.length && " \t\r\n".includes(source[position]!)) position++; };
  const expect = (literal: string) => { if (source.startsWith(literal, position)) { position += literal.length; return; } fail(`预期 ${literal}`); };
  const parseValue = (depth: number): unknown => {
    skipWhitespace();
    const char = source[position];
    if ((char === "{" || char === "[") && depth > maxDepth) throw new AppError("INVALID_JSON", "JSON 嵌套深度超过限制");
    if (char === "{") return parseObject(depth);
    if (char === "[") return parseArray(depth);
    if (char === '"') return parseString();
    if (char === "t") { expect("true"); return true; }
    if (char === "f") { expect("false"); return false; }
    if (char === "n") { expect("null"); return null; }
    if (char !== undefined && (char === "-" || char >= "0" && char <= "9")) return parseNumber();
    fail("意外的输入结尾或字符");
  };
  const parseObject = (depth: number): Record<string, unknown> => {
    position++; skipWhitespace();
    const result: Record<string, unknown> = {};
    if (source[position] === "}") { position++; return result; }
    for (; ;) {
      skipWhitespace();
      if (source[position] !== '"') fail("对象键必须是字符串");
      const key = parseString();
      if (Object.hasOwn(result, key)) throw new AppError("INVALID_JSON", "JSON 对象键重复");
      skipWhitespace();
      if (source[position] !== ":") fail("对象键后预期冒号");
      position++;
      Object.defineProperty(result, key, { value: parseValue(depth + 1), writable: true, configurable: true, enumerable: true });
      skipWhitespace();
      const char = source[position];
      if (char === ",") { position++; continue; }
      if (char === "}") { position++; return result; }
      fail("对象预期逗号或结束括号");
    }
  };
  const parseArray = (depth: number): unknown[] => {
    position++; skipWhitespace();
    const result: unknown[] = [];
    if (source[position] === "]") { position++; return result; }
    for (; ;) {
      result.push(parseValue(depth + 1));
      skipWhitespace();
      const char = source[position];
      if (char === ",") { position++; continue; }
      if (char === "]") { position++; return result; }
      fail("数组预期逗号或结束括号");
    }
  };
  const parseString = (): string => {
    position++; // opening quote
    let result = "";
    for (; ;) {
      const start = position;
      while (position < source.length && source[position] !== '"' && source[position] !== "\\") position++;
      if (position >= source.length) fail("字符串未闭合");
      const chunk = source.slice(start, position);
      if (/[\u0000-\u001f]/.test(chunk)) fail("字符串含未转义的控制字符");
      result += chunk;
      const char = source[position]!;
      if (char === '"') { position++; return result; }
      position++;
      const escape = source[position];
      if (escape === undefined) fail("字符串转义不完整");
      position++;
      if (escape === '"') { result += '"'; continue; }
      if (escape === "\\") { result += "\\"; continue; }
      if (escape === "/") { result += "/"; continue; }
      if (escape === "b") { result += "\b"; continue; }
      if (escape === "f") { result += "\f"; continue; }
      if (escape === "n") { result += "\n"; continue; }
      if (escape === "r") { result += "\r"; continue; }
      if (escape === "t") { result += "\t"; continue; }
      if (escape === "u") {
        const hex = source.slice(position, position + 4);
        check(/^[0-9a-fA-F]{4}$/.test(hex), "INVALID_JSON", "Unicode 转义必须为四位十六进制");
        result += String.fromCharCode(Number.parseInt(hex, 16));
        position += 4;
        continue;
      }
      fail("不支持的转义字符");
    }
  };
  const parseNumber = (): number => {
    const start = position;
    if (source[position] === "-") position++;
    if (source[position] === "0") position++;
    else if (source[position] !== undefined && source[position]! >= "1" && source[position]! <= "9") { while (position < source.length && source[position]! >= "0" && source[position]! <= "9") position++; }
    else fail("非法数字");
    if (source[position] === ".") {
      position++;
      check(source[position] !== undefined && source[position]! >= "0" && source[position]! <= "9", "INVALID_JSON", "小数点后必须有数字");
      while (position < source.length && source[position]! >= "0" && source[position]! <= "9") position++;
    }
    if (source[position] === "e" || source[position] === "E") {
      position++;
      if (source[position] === "+" || source[position] === "-") position++;
      check(source[position] !== undefined && source[position]! >= "0" && source[position]! <= "9", "INVALID_JSON", "指数后必须有数字");
      while (position < source.length && source[position]! >= "0" && source[position]! <= "9") position++;
    }
    const text = source.slice(start, position);
    const value = Number(text);
    check(Number.isFinite(value), "INVALID_JSON", "JSON 数字必须有限");
    return value;
  };
  if (source.startsWith("\uFEFF")) throw new AppError("INVALID_JSON", "JSON 输入不允许 BOM 前缀");
  const value = parseValue(1);
  skipWhitespace();
  if (position !== source.length) fail("存在尾随内容");
  return value;
}
