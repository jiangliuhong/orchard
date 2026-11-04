import type { Model } from "./types.js";

export function isModelEnabled(model: Model): boolean {
  return model.enabled !== false && model.deleted !== true;
}

export function visibleModels(models: Model[]): Model[] {
  return models.filter(model => !model.deleted).map(model => ({ ...model, enabled: model.enabled !== false }));
}
