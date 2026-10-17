import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { planTransformSources } from "./backfill-transform-sources.js";
import { createTransformSource } from "./transform-source.js";

const object = (key: string, size: number) => [key, { key, size, etag: `etag-${key}` }] as const;

test("plans sources only for oversized originals without one", () => {
  const photos = [
    { id: "small", r2_key: "photos/small", format: "jpeg" },
    { id: "big", r2_key: "photos/big", format: "jpeg" },
    { id: "done", r2_key: "photos/done", format: "png" },
    { id: "gone", r2_key: "photos/gone", format: "jpeg" },
  ];
  const objects = new Map([
    object("photos/small/original.jpeg", 3_000_000),
    object("photos/big/original.jpeg", 28_395_532),
    object("photos/big/w200.webp", 9_000),
    object("photos/done/original.png", 40_104_888),
    object("photos/done/transform-source.webp", 2_000_000),
  ]);

  const manifest = planTransformSources(photos, objects);

  assert.deepEqual(manifest.photos.map(({ id }) => id), ["big"]);
  assert.equal(manifest.photos[0].targetKey, "photos/big/transform-source.webp");
  assert.equal(manifest.photos[0].originalEtag, "etag-photos/big/original.jpeg");
  assert.deepEqual(manifest.summary, {
    activePhotos: 4,
    oversizedOriginals: 2,
    alreadyHaveSource: 1,
    toCreate: 1,
    missingOriginals: ["gone"],
  });
});

test("plans nothing when every original is within the limit", () => {
  const manifest = planTransformSources(
    [{ id: "small", r2_key: "photos/small", format: "jpeg" }],
    new Map([object("photos/small/original.jpeg", 20_000_000)]),
  );
  assert.equal(manifest.photos.length, 0);
});

test("creates a WebP source capped at the long edge with orientation applied", async () => {
  const rotated = await sharp({ create: { width: 6000, height: 4000, channels: 3, background: "#7c8c6d" } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();

  const source = await createTransformSource(rotated);
  const metadata = await sharp(source.buffer).metadata();

  assert.equal(metadata.format, "webp");
  assert.equal(source.width, 2731);
  assert.equal(source.height, 4096);
  assert.equal(metadata.orientation, undefined);
});

test("does not enlarge originals smaller than the long edge", async () => {
  const small = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#a96443" } }).png().toBuffer();
  const source = await createTransformSource(small);
  assert.equal(source.width, 1200);
  assert.equal(source.height, 800);
});
