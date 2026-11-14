import { test } from "node:test";
import assert from "node:assert/strict";
import { nextLimit, page } from "../public/paging.js";

test("先頭から limit 件を見せ、残りの件数を返す", () => {
  assert.deepEqual(page([1, 2, 3, 4, 5], 3), { shown: [1, 2, 3], rest: 2 });
});

test("limit 以下なら全部見せ、残りは 0", () => {
  assert.deepEqual(page([1, 2], 3), { shown: [1, 2], rest: 0 });
  assert.deepEqual(page([], 3), { shown: [], rest: 0 });
});

test("さらに表示は step 件ずつ増やし、全体の件数を超えない", () => {
  assert.equal(nextLimit(10, 20, 100), 30);
  assert.equal(nextLimit(10, 20, 25), 25);
});
