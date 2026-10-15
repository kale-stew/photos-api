import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildManifest, desktopPhotoId, publicationFor, publishedShortId, sha256 } from "./import-local-photos.js";

test("preserves published short IDs and creates stable Desktop IDs", () => {
  assert.equal(publishedShortId("blog-51861129420"), "0a8224b1");
  assert.equal(desktopPhotoId("a".repeat(64)), desktopPhotoId("a".repeat(64)));
  assert.equal(desktopPhotoId("a".repeat(64)).length, 12);
});

test("publishes portfolio photos while keeping editorial assets unlisted", () => {
  assert.deepEqual(publicationFor("portfolio"), { exclude: 0, visibility: "public" });
  assert.deepEqual(publicationFor("kylies-photos-content"), { exclude: 1, visibility: "unlisted" });
  assert.deepEqual(publicationFor(null), { exclude: 1, visibility: "unlisted" });
});

test("builds a deterministic manifest and collapses exact duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "photos-plan-test-"));
  const desktopDir = join(root, "desktop");
  const image = await sharp({
    create: { width: 4, height: 3, channels: 3, background: "#123456" },
  }).png().toBuffer();
  await mkdir(desktopDir);
  await writeFile(join(desktopDir, "2025-example.jpg"), image);
  await writeFile(join(desktopDir, "2025-example2.png"), image);
  await writeFile(join(root, "blog.json"), JSON.stringify([{
    id: "blog-test",
    title: "Test",
    caption: null,
    src: "https://example.test/image.jpg",
    area: null,
    state: null,
    date: null,
    search_tags: null,
  }]));
  await writeFile(join(root, "resolutions.json"), "{}");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(image, { status: 200 });
  try {
    const options = {
      blogJson: join(root, "blog.json"),
      desktopDir,
      resolutions: join(root, "resolutions.json"),
    };
    const first = await buildManifest(options);
    const second = await buildManifest(options);
    assert.deepEqual(first, second);
    assert.equal(first.photos.length, 2);
    assert.equal(first.duplicates.length, 1);
    const desktop = first.photos.find(({ sourceKind }) => sourceKind === "desktop");
    assert.equal(desktop?.format, "png");
    assert.equal(desktop?.date, null);
    assert.equal(desktop?.collection, "portfolio");
    assert.equal(desktop?.id, desktopPhotoId(sha256(image)));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
