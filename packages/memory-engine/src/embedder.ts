import type { Embedder } from "./types";

export class DeterministicEmbedder implements Embedder {
  async embed(text: string) {
    const vector = Array.from({ length: 8 }, () => 0);
    for (let index = 0; index < text.length; index++) {
      vector[index % vector.length] += text.charCodeAt(index) / 255;
    }
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => Number((value / magnitude).toFixed(6)));
  }
}

export function cosine(a: number[], b: number[]) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  return dot / ((Math.sqrt(aMag) || 1) * (Math.sqrt(bMag) || 1));
}

