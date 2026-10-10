import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchSourceFiles } from '../dist/web/source-search.js';

test('source search finds every literal occurrence across files with exact highlight offsets', () => {
  const files = [{ path: 'worker.ts', code: 'Task task\n中文 Task' }, { path: 'helper.ts', code: 'task' }];
  assert.deepEqual(searchSourceFiles(files, 'task'), [
    { file: 'worker.ts', line: 1, column: 0, length: 4 },
    { file: 'worker.ts', line: 1, column: 5, length: 4 },
    { file: 'worker.ts', line: 2, column: 3, length: 4 },
    { file: 'helper.ts', line: 1, column: 0, length: 4 },
  ]);
  assert.deepEqual(searchSourceFiles(files, ''), []);
  assert.deepEqual(searchSourceFiles(files, 'missing'), []);
  assert.deepEqual(searchSourceFiles([{ path: 'worker.ts', code: 'a.b aXb [x] $ { }' }], 'a.b'), [{ file: 'worker.ts', line: 1, column: 0, length: 3 }]);
  assert.equal(searchSourceFiles([{ path: 'worker.ts', code: '[]{}$\\.*+?^()|' }], '[]{}$\\.*+?^()|').length, 1);
});


test('editor workspace search bounds results for large sources', () => {
  const files = [{ path: 'worker.ts', code: 'task task\ntask' }, { path: 'other.ts', code: 'task' }];
  assert.deepEqual(searchSourceFiles(files, 'task', 2), [
    { file: 'worker.ts', line: 1, column: 0, length: 4 },
    { file: 'worker.ts', line: 1, column: 5, length: 4 },
  ]);
  assert.deepEqual(searchSourceFiles(files, 'task', 0), []);
});
