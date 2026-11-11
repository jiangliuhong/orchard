import { decodeNativeMessages, encodeNativeMessage, MAX_MESSAGE_BYTES } from "./protocol.js";
import { localServerUrl } from "./install.js";
import { check } from "../domain/errors.js";

/** Native Messaging discovers the explicitly installed HTTP service; no API tokens cross this channel. */
export async function runNativeHost(server: string, extensionId: string, origin: string | undefined, input: AsyncIterable<Uint8Array>, write: (value: Uint8Array) => void) {
  check(origin === `chrome-extension://${extensionId}/`, "INVALID_ORIGIN", "Native Host 仅接受已安装的 Chrome 扩展");
  const serverUrl = localServerUrl(server);
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, chunk]);
    check(buffer.length <= MAX_MESSAGE_BYTES * 2, "BRIDGE_MESSAGE_TOO_LARGE", "Native 消息过大");
    const decoded = decodeNativeMessages(buffer); buffer = decoded.rest;
    for (const message of decoded.values) {
      const request = message as { id?: unknown; type?: unknown };
      const valid = request && request.type === "discover" && typeof request.id === "string" && request.id.length <= 100;
      write(encodeNativeMessage(valid ? { id: request.id, result: { serverUrl } } : { id: typeof request?.id === "string" ? request.id.slice(0, 100) : null, error: { code: "UNKNOWN_COMMAND", message: "Native Host 仅支持服务发现" } }));
    }
  }
  check(buffer.length === 0, "INVALID_NATIVE_MESSAGE", "Native 消息未完整接收");
}
