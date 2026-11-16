import thresholdJson from "./image-threshold.json" with { type: "json" };

/**
 * The image-similarity threshold the bench computed (design sections 7.6 and 7.9), as shipped:
 * a cosine similarity, or null while no run of the bench has measured one. With references, a
 * near match must reach it; while it is null nothing can be shown to clear it.
 */
export const IMAGE_THRESHOLD: number | null = thresholdJson.threshold;
