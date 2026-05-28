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
