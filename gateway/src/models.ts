/**
 * 对外暴露的"模型规格名" → 上游 CPA 参数 的映射。
 *
 * 客户看到的是 OpenAI 风格的 model name;网关内部把它翻译成 CPA 的
 * (size, quality, output_format) 一组参数,顺便决定计费倍率。
 *
 * 单图成本(credits)按规格定:
 *   img-standard    1
 *   img-hd          3
 *   img-4k-square   8
 *   img-4k-16x9     8
 *   img-4k-9x16     8
 *
 * n>1 时按 n × creditsPerImage 计费。
 */

export type ModelSpec = {
  name: string;
  description: string;
  upstream: {
    model: string; // 转给 CPA 的 model 字段
    size: string; // 1024x1024 / 2048x2048 / 2048x1152 / 1152x2048
    quality: "low" | "medium" | "high";
    output_format: "png" | "webp";
  };
  creditsPerImage: number;
};

export const MODEL_SPECS: Record<string, ModelSpec> = {
  "img-standard": {
    name: "img-standard",
    description: "1024x1024,medium 画质。日常配图、缩略图。",
    upstream: { model: "gpt-image-2", size: "1024x1024", quality: "medium", output_format: "png" },
    creditsPerImage: 1,
  },
  "img-hd": {
    name: "img-hd",
    description: "1024x1024,high 画质。需要细节的方图。",
    upstream: { model: "gpt-image-2", size: "1024x1024", quality: "high", output_format: "png" },
    creditsPerImage: 3,
  },
  "img-4k-square": {
    name: "img-4k-square",
    description: "2048x2048,high 画质。海报、印刷预备。",
    upstream: { model: "gpt-image-2", size: "2048x2048", quality: "high", output_format: "png" },
    creditsPerImage: 8,
  },
  "img-4k-16x9": {
    name: "img-4k-16x9",
    description: "2048x1152,high 画质。横版 banner、视频封面。",
    upstream: { model: "gpt-image-2", size: "2048x1152", quality: "high", output_format: "png" },
    creditsPerImage: 8,
  },
  "img-4k-9x16": {
    name: "img-4k-9x16",
    description: "1152x2048,high 画质。竖版海报、移动端、小红书素材。",
    upstream: { model: "gpt-image-2", size: "1152x2048", quality: "high", output_format: "png" },
    creditsPerImage: 8,
  },
};

export function getModelSpec(name: string): ModelSpec | null {
  return MODEL_SPECS[name] ?? null;
}

export function listModels() {
  return Object.values(MODEL_SPECS).map((m) => ({
    id: m.name,
    object: "model" as const,
    description: m.description,
    credits_per_image: m.creditsPerImage,
    size: m.upstream.size,
    quality: m.upstream.quality,
  }));
}

export function calculateCost(spec: ModelSpec, n: number): number {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("n must be a positive integer");
  }
  return spec.creditsPerImage * n;
}
