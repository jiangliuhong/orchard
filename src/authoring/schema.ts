export const AUTHORING_SCHEMA = {
  type: "object", required: ["summary", "changes"], properties: {
    summary: { type: "string", maxLength: 10000 },
    changes: { type: "array", maxItems: 100, items: { type: "object", required: ["operation", "path"], properties: { operation: { enum: ["create", "update", "delete"] }, path: { type: "string" }, content: { type: "string" } }, additionalProperties: false } },
  }, additionalProperties: false,
};
