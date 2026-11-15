import type { InputSources } from "../../quick-launch/targets";

const format = "orchard.quick-launch.parameters.v1";
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function formatQuickLaunchParameters(fixedInput: unknown, inputSources: InputSources) {
  return JSON.stringify(Object.keys(inputSources).length || (object(fixedInput) && fixedInput.$format === format)
    ? { $format: format, fixedInput, inputSources }
    : fixedInput, null, 2);
}

export function parseQuickLaunchParameters(text: string): { fixedInput: unknown; inputSources: InputSources } {
  const parsed: unknown = JSON.parse(text);
  if (!object(parsed) || parsed.$format !== format) return { fixedInput: parsed, inputSources: {} };
  if (Object.keys(parsed).length !== 3 || !Object.hasOwn(parsed, "fixedInput") || !object(parsed.inputSources))
    throw new Error("参数 JSON 缺少 fixedInput 或 inputSources。");
  for (const [path, ref] of Object.entries(parsed.inputSources)) {
    if (!/^\/(?:[^~/]|~[01])*$/.test(path) || !object(ref) || Object.keys(ref).length !== 3 || ref.source !== "dictionary" ||
        typeof ref.dictionaryId !== "string" || !ref.dictionaryId || typeof ref.key !== "string" || !ref.key)
      throw new Error("字典引用需要有效的参数路径、字典 ID 和键名。");
  }
  return { fixedInput: parsed.fixedInput, inputSources: parsed.inputSources as InputSources };
}
