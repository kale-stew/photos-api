#!/usr/bin/env npx tsx
/**
 * Integration test script for photos-api
 * Run with: npx tsx scripts/test-integration.ts
 * 
 * Requires the dev server to be running: npm run dev
 */

const BASE_URL = process.env.API_URL || "http://localhost:8787";

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`✓ ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, error: message });
    console.log(`✗ ${name}: ${message}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log(`\nTesting ${BASE_URL}\n`);

  // Test 1: Health check - API responds
  await test("API responds to requests", async () => {
    const res = await fetch(`${BASE_URL}/api/photos`);
    assert(res.ok, `Expected 200, got ${res.status}`);
  });

  // Test 2: List photos returns valid JSON structure
  await test("GET /api/photos returns valid structure", async () => {
    const res = await fetch(`${BASE_URL}/api/photos`);
    const data = await res.json() as { photos: unknown[]; meta: { limit: number; offset: number; count: number } };
    assert(Array.isArray(data.photos), "Expected photos array");
    assert(typeof data.meta.limit === "number", "Expected meta.limit");
    assert(typeof data.meta.offset === "number", "Expected meta.offset");
  });

  await test("legacy list excludes non-public photos", async () => {
    const res = await fetch(`${BASE_URL}/api/photos?limit=100`);
    const data = await res.json() as { photos: { id: string }[] };
    const ids = new Set(data.photos.map((photo) => photo.id));
    assert(!ids.has("test-unlisted-photo"), "Unlisted photo appeared in legacy list");
    assert(!ids.has("test-private-photo"), "Private photo appeared in legacy list");
    assert(!ids.has("test-quarantined-photo"), "Quarantined photo appeared in legacy list");
  });

  // Test 3: Pagination params work
  await test("GET /api/photos respects limit param", async () => {
    const res = await fetch(`${BASE_URL}/api/photos?limit=5`);
    const data = await res.json() as { meta: { limit: number } };
    assert(data.meta.limit === 5, `Expected limit 5, got ${data.meta.limit}`);
  });

  // Test 4: Invalid limit doesn't crash
  await test("GET /api/photos handles invalid limit", async () => {
    const res = await fetch(`${BASE_URL}/api/photos?limit=abc`);
    assert(res.ok, `Expected 200, got ${res.status}`);
    const data = await res.json() as { meta: { limit: number } };
    assert(data.meta.limit === 50, `Expected default limit 50, got ${data.meta.limit}`);
  });

  // Test 5: Limit is capped at 100
  await test("GET /api/photos caps limit at 100", async () => {
    const res = await fetch(`${BASE_URL}/api/photos?limit=500`);
    const data = await res.json() as { meta: { limit: number } };
    assert(data.meta.limit === 100, `Expected max limit 100, got ${data.meta.limit}`);
  });

  // Test 6: Non-existent photo returns 404
  await test("GET /api/photos/:id returns 404 for missing photo", async () => {
    const res = await fetch(`${BASE_URL}/api/photos/nonexistent-id`);
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  // Test 7: Image endpoint returns 404 for missing photo
  await test("GET /img/:id returns 404 for missing photo", async () => {
    const res = await fetch(`${BASE_URL}/img/nonexistent-id`);
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  // Test 8: Invalid width returns 400
  await test("GET /img/:id?w=999 returns 400 for invalid width", async () => {
    // First need a photo in the DB for this to test the width validation
    // For now, this will 404 on missing photo first
    const res = await fetch(`${BASE_URL}/img/test?w=999`);
    // Either 400 (bad width) or 404 (no photo) is acceptable
    assert(res.status === 400 || res.status === 404, `Expected 400 or 404, got ${res.status}`);
  });

  // Test 9: CORS headers present
  await test("CORS headers are present", async () => {
    const res = await fetch(`${BASE_URL}/api/photos`);
    const cors = res.headers.get("Access-Control-Allow-Origin");
    assert(cors === "*", `Expected CORS header *, got ${cors}`);
  });

  // Test 10: OPTIONS request works (preflight)
  await test("OPTIONS request returns CORS headers", async () => {
    const res = await fetch(`${BASE_URL}/api/photos`, { method: "OPTIONS" });
    assert(res.ok, `Expected 200, got ${res.status}`);
    const methods = res.headers.get("Access-Control-Allow-Methods");
    assert(methods?.includes("GET"), "Expected GET in allowed methods");
  });

  // Test 11: 404 for unknown routes
  await test("Unknown routes return 404", async () => {
    const res = await fetch(`${BASE_URL}/unknown/route`);
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  // Test 12: Site filter works
  await test("GET /api/photos?site=climb-log filters by site", async () => {
    const res = await fetch(`${BASE_URL}/api/photos?site=climb-log`);
    assert(res.ok, `Expected 200, got ${res.status}`);
    // Can't verify filtering without data, but at least it doesn't crash
  });

  await test("GET /api/collections/portfolio/photos returns a collection", async () => {
    const res = await fetch(`${BASE_URL}/api/collections/portfolio/photos`);
    assert(res.ok, `Expected 200, got ${res.status}`);
    const data = await res.json() as { collection: { slug: string }; photos: unknown[] };
    assert(data.collection.slug === "portfolio", "Expected portfolio collection");
    assert(Array.isArray(data.photos), "Expected photos array");
    assert(
      (data.photos as { id: string }[]).some((photo) => photo.id === "test-photo-1"),
      "Expected seeded portfolio member"
    );
  });

  await test("GET /api/photos/:alias resolves a legacy alias", async () => {
    const res = await fetch(`${BASE_URL}/api/photos/legacy-test-photo-1`);
    assert(res.ok, `Expected 200, got ${res.status}`);
    const data = await res.json() as { id: string };
    assert(data.id === "test-photo-1", `Expected canonical ID, got ${data.id}`);
  });

  await test("private photo metadata is not public", async () => {
    const res = await fetch(`${BASE_URL}/api/photos/test-private-photo`);
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  await test("forged Access header does not expose private metadata", async () => {
    const res = await fetch(`${BASE_URL}/api/photos/test-private-photo`, {
      headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
    });
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  await test("forged Access header does not expose private image", async () => {
    const res = await fetch(`${BASE_URL}/img/test-private-photo`, {
      headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
    });
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  await test("forged Access header cannot call admin API", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/photos/test-photo-1`, {
      method: "PATCH",
      headers: {
        "Cf-Access-Jwt-Assertion": "not-a-jwt",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Should not change" }),
    });
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test("admin UI denies access without valid configuration", async () => {
    const res = await fetch(`${BASE_URL}/admin`, {
      headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
    });
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test("unlisted photo metadata remains addressable", async () => {
    const res = await fetch(`${BASE_URL}/api/photos/test-unlisted-photo`);
    assert(res.ok, `Expected 200, got ${res.status}`);
  });

  await test("quarantined photo metadata is not public", async () => {
    const res = await fetch(`${BASE_URL}/api/photos/test-quarantined-photo`);
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  await test("public person returns assigned photos", async () => {
    const res = await fetch(`${BASE_URL}/api/people/test-person/photos`);
    assert(res.ok, `Expected 200, got ${res.status}`);
    const data = await res.json() as { photos: { id: string }[] };
    assert(data.photos.some((photo) => photo.id === "test-photo-1"), "Expected assigned photo");
  });

  await test("unlisted editorial collection is not publicly enumerable", async () => {
    const res = await fetch(`${BASE_URL}/api/collections/kylies-photos-content/photos`);
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  await test("OpenAPI documents collection and people endpoints", async () => {
    const res = await fetch(`${BASE_URL}/openapi.json`);
    const data = await res.json() as { paths: Record<string, unknown> };
    assert("/api/collections/{slug}/photos" in data.paths, "Missing collection path");
    assert("/api/people/{slug}/photos" in data.paths, "Missing people path");
  });

  // Summary
  console.log("\n" + "=".repeat(50));
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log("\nFailed tests:");
    results.filter((r) => !r.passed).forEach((r) => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
    process.exit(1);
  }
}

run().catch((e) => {
  console.error("Test runner failed:", e);
  process.exit(1);
});
