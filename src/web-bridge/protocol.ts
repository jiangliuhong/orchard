import { Buffer } from "node:buffer";

export const PROTOCOL_VERSION = "orchard-web-bridge-1";
export const MAX_MESSAGE_BYTES = 512 * 1024;
export interface BridgeRequest { id: string; tool: string; args: unknown; catalogHash: string }
export interface BridgeResponse { id: string; result?: unknown; error?: { code: string; message: string } }

export function encodeLine(value: unknown) {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) throw new Error("BRIDGE_MESSAGE_TOO_LARGE");
  return `${line}\n`;
}
export function decodeLine(line: string): unknown {
  if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) throw new Error("BRIDGE_MESSAGE_TOO_LARGE");
  return JSON.parse(line);
}
export function encodeNativeMessage(value: unknown) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_MESSAGE_BYTES) throw new Error("BRIDGE_MESSAGE_TOO_LARGE");
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}
export function decodeNativeMessages(buffer: Buffer) {
  const values: unknown[] = []; let offset = 0;
  while (buffer.length - offset >= 4) {
    const size = buffer.readUInt32LE(offset);
    if (size > MAX_MESSAGE_BYTES) throw new Error("BRIDGE_MESSAGE_TOO_LARGE");
    if (buffer.length - offset - 4 < size) break;
    values.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + size).toString("utf8")));
    offset += 4 + size;
  }
  return { values, rest: buffer.subarray(offset) };
}
