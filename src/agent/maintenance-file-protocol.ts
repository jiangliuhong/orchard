/** Shared wire schemas, with no native filesystem or process backend. */
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const offset = { type: "integer", minimum: 0, maximum: 1000000 }, limit = { type: "integer", minimum: 1, maximum: 50 };
export const maintenanceReadSchemas = {
  read: schema({ path: { type: "string", minLength: 1, maxLength: 500 }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 200 } }, ["path"]),
  ls: schema({ path: { type: "string", maxLength: 500 }, offset, limit }),
  find: schema({ pattern: { type: "string", maxLength: 200 }, offset, limit }),
  grep: schema({ query: { type: "string", minLength: 1, maxLength: 200 }, offset, limit }, ["query"]),
};
export type MaintenanceReadMethod = keyof typeof maintenanceReadSchemas;
