/**
 * 对外暴露的"模型规格名" → 上游 CPA 参数 的映射。
 *
 * 客户看到的是 OpenAI 风格的 model name;网关内部把它翻译成 CPA 的
 * (size, quality, output_format) 一组参数,顺便决定计费倍率。
 *
 * gpt-image-2 实测硬限制(2026-04-25 在 Pro 账号):
 *   - 最长边 ≤ 3840 px
 *   - 总像素 ≲ 8.3M(3072x3072 已超预算)
 *   - background:"transparent" OpenAI 上游硬拒绝(任何套餐都不行)
 *
 * 单图成本(credits)按总像素阶梯定:
 *   img-standard    1   (1M px,medium)
 *   img-hd          3   (1M px,high)
 *   img-2k-square   8   (4.2M px,high)  — 之前误名 img-4k-square
 *   img-uhd-16x9   16   (8.3M px,真 4K UHD 横版)
 *   img-uhd-9x16   16   (8.3M px,真 4K UHD 竖版)
 *
 * n>1 时按 n × creditsPerImage 计费。
 */

export type ModelSpec = {
  name: string;
  description: string;
  upstream: {
    model: string;
    size: string;
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
  "img-2k-square": {
    name: "img-2k-square",
    description: "2048x2048,high 画质。大方图(海报、印刷预备)。",
    upstream: { model: "gpt-image-2", size: "2048x2048", quality: "high", output_format: "png" },
    creditsPerImage: 8,
  },
  "img-uhd-16x9": {
    name: "img-uhd-16x9",
    description: "3840x2160 真 4K UHD 横版,high 画质。视频封面、4K banner、屏保。",
    upstream: { model: "gpt-image-2", size: "3840x2160", quality: "high", output_format: "png" },
    creditsPerImage: 16,
  },
  "img-uhd-9x16": {
    name: "img-uhd-9x16",
    description: "2160x3840 真 4K UHD 竖版,high 画质。竖版海报、手机壁纸、小红书素材。",
    upstream: { model: "gpt-image-2", size: "2160x3840", quality: "high", output_format: "png" },
    creditsPerImage: 16,
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
