import { spawn } from "node:child_process";
import { AppError, check } from "../domain/errors.js";

export interface ResponsePostprocess { runtime: "nodejs"; code: string; timeoutMs?: number }
export const RESPONSE_POSTPROCESS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["runtime", "code"],
  properties: {
    runtime: { const: "nodejs" }, code: { type: "string", minLength: 1, maxLength: 65536 },
    timeoutMs: { type: "integer", minimum: 1, maximum: 10000 },
  },
};

export async function postprocessResponse(config: ResponsePostprocess | undefined, response: unknown, args: unknown, signal: AbortSignal, maxBytes: number, secrets: string[]) {
  if (!config) return response;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs ?? 1000)]);
  const source = `let input=''; for await (const chunk of process.stdin) input+=chunk;
const {response,args}=JSON.parse(input);
const result=await (async (response,args)=>{${config.code}\n})(response,args);
process.stdout.write(JSON.stringify(result));`;
  const raw = await new Promise<string>((resolve, reject) => {
    deadline.throwIfAborted();
    const child = spawn(process.execPath, ["--permission", "--max-old-space-size=64", "--input-type=module", "-e", source], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", size = 0, settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new AppError(deadline.aborted ? "POSTPROCESS_TIMEOUT" : "POSTPROCESS_FAILED", "响应后处理失败、已取消或超时"));
    };
    deadline.addEventListener("abort", fail, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) fail(); else output += chunk;
    });
    child.stderr.resume();
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("close", code => {
      deadline.removeEventListener("abort", fail);
      if (settled) return;
      if (code !== 0) { fail(); return; }
      settled = true; resolve(output);
    });
    child.stdin.end(JSON.stringify({ response, args }));
  });
  let result: unknown;
  try { result = JSON.parse(raw); } catch { throw new AppError("POSTPROCESS_FAILED", "响应后处理必须返回有效 JSON"); }
  const serialized = JSON.stringify(result);
  check(!secrets.filter(Boolean).some(secret => serialized.includes(secret) || serialized.includes(JSON.stringify(secret).slice(1, -1))), "SENSITIVE_RESPONSE", "响应包含鉴权信息，已阻止返回");
  return result;
}
