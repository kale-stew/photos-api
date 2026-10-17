/**
 * The Images binding rejects `.input()` streams over 20 MB. Originals above this
 * size are resized from a smaller transform source stored beside the original.
 * Decimal megabytes keep the threshold conservative.
 */
export const IMAGES_INPUT_LIMIT_BYTES = 20_000_000;

/** Long edge of the transform source; must stay above every servable width. */
export const TRANSFORM_SOURCE_LONG_EDGE = 4096;

export const TRANSFORM_SOURCE_FORMAT = "webp";

export function originalKey(r2Key: string, format: string): string {
  return `${r2Key}/original.${format}`;
}

/** Lives under the photo prefix so prefix-based deletion removes it with the photo. */
export function transformSourceKey(r2Key: string): string {
  return `${r2Key}/transform-source.${TRANSFORM_SOURCE_FORMAT}`;
}

export function exceedsImagesInputLimit(sizeBytes: number): boolean {
  return sizeBytes > IMAGES_INPUT_LIMIT_BYTES;
}

export type TransformInput = "original" | "transform-source" | "source-url" | "none";

/** Ordered inputs to try for a transform, given what exists for the photo. */
export function transformInputs(options: {
  originalSize: number | null;
  hasTransformSource: boolean;
  hasSourceUrl: boolean;
}): TransformInput[] {
  const inputs: TransformInput[] = [];
  if (options.originalSize !== null && !exceedsImagesInputLimit(options.originalSize)) inputs.push("original");
  if (options.hasTransformSource) inputs.push("transform-source");
  if (options.hasSourceUrl) inputs.push("source-url");
  return inputs.length > 0 ? inputs : ["none"];
}
