import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;

let extractor: FeatureExtractionPipeline | null = null;
let loadingPromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Lazily load the HuggingFace feature-extraction pipeline.
 * First call downloads + caches the ONNX model (~23 MB); subsequent calls reuse it.
 * Uses a singleton promise to prevent duplicate loads under concurrent access.
 */
async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;

  if (!loadingPromise) {
    loadingPromise = pipeline("feature-extraction", MODEL_ID, {
      dtype: "fp32",
    }).then((pipe) => {
      extractor = pipe;
      loadingPromise = null;
      return pipe;
    });
  }

  return loadingPromise;
}

/**
 * Embed a single text string into a 384-dimensional vector.
 * Uses all-MiniLM-L6-v2 running locally via ONNX — no API calls.
 * First call downloads + caches the model (~23 MB).
 */
export async function embed(text: string): Promise<number[]> {
  const pipe = await getExtractor();
  const output = await pipe(text, { pooling: "mean", normalize: true });
  const raw = output.tolist()[0] as number[];

  if (raw.length !== EMBEDDING_DIM) {
    throw new Error(`Expected ${EMBEDDING_DIM}-dim embedding, got ${raw.length}`);
  }

  return raw;
}

/**
 * Embed multiple texts in a single batch. More efficient than calling embed() in a loop.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const pipe = await getExtractor();
  const output = await pipe(texts, { pooling: "mean", normalize: true });
  return output.tolist() as number[][];
}

/**
 * Cosine similarity between two vectors. Both must be the same length.
 * Returns value in [-1, 1]. Higher = more similar.
 * For normalized vectors (which embed() produces), this is just the dot product.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export { EMBEDDING_DIM, MODEL_ID };
