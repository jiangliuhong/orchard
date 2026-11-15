import assert from "node:assert/strict";
import { test } from "node:test";
import { formatQuickLaunchParameters, parseQuickLaunchParameters } from "../src/web/lib/quick-launch-parameters.js";
import type { InputSources } from "../src/quick-launch/targets.js";

test("copied JSON restores fixed parameters and dictionary keys independently", () => {
  const fixedInput = { count: 4 };
  const inputSources: InputSources = { "/region~1name": { source: "dictionary", dictionaryId: "config", key: "region" } };
  const text = formatQuickLaunchParameters(fixedInput, inputSources);
  assert.match(text, /"key": "region"/);
  assert.deepEqual(parseQuickLaunchParameters(text), { fixedInput, inputSources });
  assert.deepEqual(parseQuickLaunchParameters('{"count":4}'), { fixedInput, inputSources: {} });
});

test("incomplete dictionary references fail without dropping their bindings silently", () => {
  assert.throws(() => parseQuickLaunchParameters('{"$format":"orchard.quick-launch.parameters.v1","fixedInput":{},"inputSources":{"/region":{"source":"dictionary","dictionaryId":"config"}}}'), /字典引用/);
});
