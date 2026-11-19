import assert from "node:assert/strict";
import test from "node:test";
import { fillAboutCollection, isAboutPhoto, missingAboutPhotos } from "./about-collection.js";

test("matches the kylie tag exactly, in any case", () => {
  assert.equal(isAboutPhoto('["summit","Kylie"]'), true);
  assert.equal(isAboutPhoto('["kylies-photos"]'), false);
  assert.equal(isAboutPhoto("kylie, summit"), true);
  assert.equal(isAboutPhoto(null), false);
});

test("returns only tagged photos that are not members yet, in order", () => {
  const candidates = [
    { id: "a", tags: '["kylie"]' },
    { id: "b", tags: '["kylie"]' },
    { id: "c", tags: '["ridge"]' },
    { id: "d", tags: '["kylie","ridge"]' },
  ];
  assert.deepEqual(missingAboutPhotos(candidates, new Set(["b"])), ["a", "d"]);
});

function fakeDb(candidates: Array<{ id: string; tags: string | null }>, members: string[]) {
  const inserted: string[] = [];
  let batches = 0;
  const db = {
    prepare(sql: string) {
      const statement = {
        bind: (...args: unknown[]) => ({ ...statement, args }),
        all: async () =>
          sql.includes("FROM photo_collections")
            ? { results: members.map((photo_id) => ({ photo_id })) }
            : { results: candidates },
        args: [] as unknown[],
      };
      return statement;
    },
    batch: async (statements: Array<{ args: unknown[] }>) => {
      batches += 1;
      inserted.push(...statements.map(({ args }) => String(args[0])));
      return [];
    },
  } as unknown as D1Database;
  return { db, inserted, batches: () => batches };
}

test("fill adds only new tagged photos and never rewrites members", async () => {
  const { db, inserted } = fakeDb([{ id: "a", tags: '["kylie"]' }, { id: "b", tags: '["kylie"]' }, { id: "c", tags: "[]" }], ["a"]);
  assert.deepEqual(await fillAboutCollection(db), { added: ["b"], total: 2 });
  assert.deepEqual(inserted, ["b"]);
});

test("a dry run reports without writing", async () => {
  const { db, inserted } = fakeDb([{ id: "a", tags: '["kylie"]' }], []);
  assert.deepEqual(await fillAboutCollection(db, { dryRun: true }), { added: ["a"], total: 1 });
  assert.deepEqual(inserted, []);
});

test("large fills are written in batches of 50", async () => {
  const candidates = Array.from({ length: 120 }, (_, index) => ({ id: `p${index}`, tags: '["kylie"]' }));
  const { db, inserted, batches } = fakeDb(candidates, []);
  await fillAboutCollection(db);
  assert.equal(inserted.length, 120);
  assert.equal(batches(), 3);
});
