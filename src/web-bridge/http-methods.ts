/** Standard methods supported by browser Fetch (CONNECT/TRACE/TRACK are forbidden). */
export const BRIDGE_HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type BridgeHttpMethod = typeof BRIDGE_HTTP_METHODS[number];
export const allowsRequestBody = (method: string) => method !== "GET" && method !== "HEAD";
