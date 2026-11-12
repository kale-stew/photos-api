import sharp from "sharp";
import {
  exceedsImagesInputLimit,
  IMAGES_INPUT_LIMIT_BYTES,
  TRANSFORM_SOURCE_LONG_EDGE,
} from "../../src/transform-source.js";

export interface TransformSource {
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * Downscale an oversized original into a WebP the Images binding can read.
 * EXIF orientation is baked in because the output carries no metadata.
 */
export async function createTransformSource(original: Buffer): Promise<TransformSource> {
  const { data, info } = await sharp(original, { failOn: "error", limitInputPixels: false })
    .rotate()
    .resize({
      width: TRANSFORM_SOURCE_LONG_EDGE,
      height: TRANSFORM_SOURCE_LONG_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 90 })
    .toBuffer({ resolveWithObject: true });

  if (exceedsImagesInputLimit(data.byteLength)) {
    throw new Error(`Transform source is ${data.byteLength} bytes; limit is ${IMAGES_INPUT_LIMIT_BYTES}`);
  }
  return { buffer: data, width: info.width, height: info.height };
}
