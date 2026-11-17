import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { cleanupRetiredGearPrefixes, type GearAssetDeps, serveGearImage, syncGearImages } from "./gear-assets.js";
import { gearAssetVersion, sha256Hex } from "./gear-image.js";

type Value = string | number | null;

function fakeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("migrations/0007_gear_assets.sql", "utf8"));
  const statement = (sql: string, values: Value[] = []): any => ({
    sql,
    values,
    bind: (...next: Value[]) => statement(sql, next),
    first: async () => (sqlite.prepare(sql).get(...values) as unknown) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => {
      sqlite.prepare(sql).run(...values);
      return {};
    },
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{ sql: string; values: Value[] }>) => {
      sqlite.exec("BEGIN");
      try {
        for (const s of statements) sqlite.prepare(s.sql).run(...s.values);
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
      return [];
    },
  };
  return { db: db as unknown as D1Database, sqlite };
}

function fakeBucket() {
  const objects = new Map<string, Uint8Array>();
  const object = (key: string) => {
    const bytes = objects.get(key);
    return bytes ? { key, etag: `e-${bytes.length}`, size: bytes.length, body: new Response(bytes).body } : null;
  };
  const bucket = {
    objects,
    get: async (key: string) => object(key),
    head: async (key: string) => object(key),
    put: async (key: string, value: ArrayBuffer | Uint8Array) => {
      objects.set(key, new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer.slice(0)));
      return {};
    },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    list: async ({ prefix, limit }: { prefix: string; limit?: number }) => {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit ?? 1000);
      return { objects: keys.map((key) => ({ key })), truncated: false };
    },
  };
  return bucket;
}

const ID = "41801b50-4364-8164-a9b6-fae06d0f2a8d";
const S3 = (file: string) => `https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/${file}/pack.png?X-Amz-Signature=x`;

function setup(sources: Record<string, string> = {}) {
  const { db, sqlite } = fakeDb();
  const bucket = fakeBucket();
  const env = { DB: db, PHOTOS_BUCKET: bucket, IMAGES: {} } as unknown as Env;
  const fetched: string[] = [];
  const normalized: string[] = [];
  const deps: GearAssetDeps = {
    fetch: (async (input: string) => {
      fetched.push(input);
      const url = new URL(input);
      if (url.hostname === "file.notion.so") {
        return new Response(null, { status: 302, headers: { Location: sources.redirect ?? S3("redirected") } });
      }
      const body = sources[url.pathname.split("/")[2]] ?? "bytes";
      return new Response(body, { status: 200 });
    }) as typeof fetch,
    normalize: (async (_images: unknown, source: Uint8Array) => {
      normalized.push(new TextDecoder().decode(source));
      return { master: new TextEncoder().encode(`master:${new TextDecoder().decode(source)}`), backgroundRemoved: false, needsReview: false, coverage: 0.3 };
    }) as GearAssetDeps["normalize"],
  };
  return { env, sqlite, bucket, deps, fetched, normalized };
}

test("ingests a new image, then skips it while the Notion file is unchanged", async () => {
  const { env, bucket, deps, normalized } = setup({ a: "one" });
  const first = await syncGearImages(env, [{ id: ID, url: S3("a") }], {}, deps);
  const version = await gearAssetVersion(await sha256Hex(new TextEncoder().encode("one")));
  assert.deepEqual(first.results, [{ id: ID, status: "ready", version }]);
  assert.ok(bucket.objects.has(`gear/${ID}/${version}/master.png`));

  const second = await syncGearImages(env, [{ id: ID, url: S3("a").replace("x", "y") }], {}, deps);
  assert.deepEqual(second.results, [{ id: ID, status: "ready", version }]);
  assert.equal(normalized.length, 1);
});

test("a changed file gets a new version and retires the old prefix", async () => {
  const { env, sqlite, deps } = setup({ a: "one", b: "two" });
  const [first] = (await syncGearImages(env, [{ id: ID, url: S3("a") }], {}, deps)).results;
  const [second] = (await syncGearImages(env, [{ id: ID, url: S3("b") }], {}, deps)).results;
  assert.notEqual(first.version, second.version);
  const retired = sqlite.prepare("SELECT r2_prefix FROM gear_asset_retired_prefixes").all() as Array<{ r2_prefix: string }>;
  assert.deepEqual(retired.map((row) => row.r2_prefix), [`gear/${ID}/${first.version}`]);
});

test("old versions redirect to the current one; unknown pages 404", async () => {
  const { env, deps } = setup({ a: "one", b: "two" });
  const [first] = (await syncGearImages(env, [{ id: ID, url: S3("a") }], {}, deps)).results;
  const [second] = (await syncGearImages(env, [{ id: ID, url: S3("b") }], {}, deps)).results;
  const stale = await serveGearImage(env, ID, first.version!, "webp", "400");
  assert.equal(stale.status, 302);
  assert.equal(stale.headers.get("Location"), `/gear/${ID}/${second.version}.webp?w=400`);
  const png = await serveGearImage(env, ID, second.version!, "png", undefined);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal((await serveGearImage(env, "00000000-0000-0000-0000-000000000000", second.version!, "png", undefined)).status, 404);
  assert.equal((await serveGearImage(env, ID, second.version!, "webp", "123")).status, 400);
});

test("cleanup deletes retired prefixes after the grace period, R2 first", async () => {
  const { env, sqlite, bucket, deps } = setup({ a: "one", b: "two" });
  const [first] = (await syncGearImages(env, [{ id: ID, url: S3("a") }], {}, deps)).results;
  await syncGearImages(env, [{ id: ID, url: S3("b") }], {}, deps);
  const oldPrefix = `gear/${ID}/${first.version}`;
  assert.equal(await cleanupRetiredGearPrefixes(env), 0, "nothing is due yet");
  sqlite.exec("UPDATE gear_asset_retired_prefixes SET retired_at = datetime('now', '-8 days')");
  assert.equal(await cleanupRetiredGearPrefixes(env), 1);
  assert.equal([...bucket.objects.keys()].some((key) => key.startsWith(oldPrefix)), false);
  assert.equal((sqlite.prepare("SELECT COUNT(*) n FROM gear_asset_retired_prefixes").get() as { n: number }).n, 0);
});

test("cleanup never deletes a prefix that is current again", async () => {
  const { env, sqlite, bucket, deps } = setup({ a: "one", b: "two" });
  const [first] = (await syncGearImages(env, [{ id: ID, url: S3("a") }], {}, deps)).results;
  await syncGearImages(env, [{ id: ID, url: S3("b") }], {}, deps);
  // Restoring the original bytes re-adopts the first prefix.
  await syncGearImages(env, [{ id: ID, url: S3("a2") }], {}, { ...deps, fetch: (async () => new Response("one")) as typeof fetch });
  sqlite.prepare("INSERT OR IGNORE INTO gear_asset_retired_prefixes (r2_prefix, notion_page_id, retired_at) VALUES (?, ?, datetime('now', '-8 days'))")
    .run(`gear/${ID}/${first.version}`, ID);
  sqlite.exec("UPDATE gear_asset_retired_prefixes SET retired_at = datetime('now', '-8 days')");
  await cleanupRetiredGearPrefixes(env);
  assert.ok(bucket.objects.has(`gear/${ID}/${first.version}/master.png`));
});

test("rebuilds the master when the same bytes are re-uploaded but the master is gone", async () => {
  const { env, bucket, deps, normalized } = setup({ a: "one", c: "one" });
  const [first] = (await syncGearImages(env, [{ id: ID, url: S3("a") }], {}, deps)).results;
  bucket.objects.delete(`gear/${ID}/${first.version}/master.png`);
  const [again] = (await syncGearImages(env, [{ id: ID, url: S3("c") }], {}, deps)).results;
  assert.equal(again.version, first.version);
  assert.equal(normalized.length, 2);
  assert.ok(bucket.objects.has(`gear/${ID}/${first.version}/master.png`));
});

test("follows one redirect only to an allowlisted host", async () => {
  const ok = setup({ redirected: "via-redirect" });
  const [result] = (await syncGearImages(ok.env, [{ id: ID, url: "https://file.notion.so/f/f/ws/a/pack.png" }], {}, ok.deps)).results;
  assert.equal(result.status, "ready");
  assert.deepEqual(ok.normalized, ["via-redirect"]);

  const bad = setup({ redirect: "https://evil.example/pack.png" });
  const [blocked] = (await syncGearImages(bad.env, [{ id: ID, url: "https://file.notion.so/f/f/ws/a/pack.png" }], {}, bad.deps)).results;
  assert.equal(blocked.status, "failed");
  assert.match(blocked.error ?? "", /not allowed/);
  assert.equal(bad.fetched.length, 1);
});

test("reports missing, unsupported, invalid, and over-budget items without fetching", async () => {
  const { env, deps, fetched } = setup();
  const second = "41801b50-4364-8164-a9b6-fae06d0f2a8e";
  const { results } = await syncGearImages(
    env,
    [
      { id: ID, url: null },
      { id: ID, url: "https://www.rei.com/pack.png" },
      { id: "../photos", url: S3("a") },
      { id: second, url: S3("a") },
    ],
    { maxProcess: 0 },
    deps,
  );
  assert.deepEqual(results.map((r) => r.status), ["missing", "unsupported", "failed", "pending"]);
  assert.equal(fetched.length, 0);
});
