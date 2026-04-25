/**
 * 模型规格 = 分辨率 × 比例 的派生组合,不再硬编码命名 spec。
 *
 * 客户调用:`model: "img-{resolution}-{aspect}"`,例如 `img-2k-16x9`。
 * 网关内部 (resolution, aspect) → CPA size 参数。
 *
 * 真值表(2026-04-25 实测 gpt-image-2 经 CPA + Pro 账号):
 *
 *           1x1   4x3   3x4   16x9  9x16
 *     1K    ✅    ✅    ✅    ❌    ❌    (1K 宽屏被 OpenAI 拒:像素过小)
 *     2K    ✅    ✅    ✅    ✅    ✅    (2K 全通)
 *     4K    ❌    ❌    ❌    ✅    ✅    (4K 非宽屏被拒:像素预算超)
 *
 * 计费按总像素阶梯(像素越多生成成本越高):
 *   ≤ 1.0 M px  → 1 credit
 *   ≤ 2.5 M px  → 3 credits
 *   ≤ 5.0 M px  → 8 credits
 *   ≤ 9.0 M px  → 16 credits
 *
 * gpt-image-2 上游硬限制(实测,与套餐无关):
 *   - 长边 ≤ 3840 px
 *   - 总像素 ≲ 8.3 M (3072² 已超预算)
 *   - background:"transparent" OpenAI 直接拒绝
 */

export type Resolution = "1k" | "2k" | "4k";
export type Aspect = "1x1" | "4x3" | "3x4" | "16x9" | "9x16";

export const RESOLUTIONS: Resolution[] = ["1k", "2k", "4k"];
export const ASPECTS: Aspect[] = ["1x1", "4x3", "3x4", "16x9", "9x16"];

/** 长边像素 */
const LONG_EDGE: Record<Resolution, number> = { "1k": 1024, "2k": 2048, "4k": 3840 };

/** 比例 = (w, h) 单位向量,长边按 LONG_EDGE 缩放 */
const RATIO: Record<Aspect, [number, number]> = {
  "1x1": [1, 1],
  "4x3": [4, 3],
  "3x4": [3, 4],
  "16x9": [16, 9],
  "9x16": [9, 16],
};

/**
 * 计算 (res, asp) → 真实像素尺寸 [w, h]。
 * 长边对齐到 LONG_EDGE,短边按比例缩,向 8 取整(图像编码友好)。
 */
export function resolveDims(res: Resolution, asp: Aspect): [number, number] {
  const long = LONG_EDGE[res];
  const [rw, rh] = RATIO[asp];
  const longSide = Math.max(rw, rh);
  const shortSide = Math.min(rw, rh);
  const shortPx = Math.round((long * shortSide) / longSide / 8) * 8;
  return rw >= rh ? [long, shortPx] : [shortPx, long];
}

/** OpenAI 上游闸门:实测得到的 valid 集合 */
const VALID_COMBOS = new Set<string>([
  "1k-1x1", "1k-4x3", "1k-3x4",
  "2k-1x1", "2k-4x3", "2k-3x4", "2k-16x9", "2k-9x16",
  "4k-16x9", "4k-9x16",
]);

export function isValidCombo(res: Resolution, asp: Aspect): boolean {
  return VALID_COMBOS.has(`${res}-${asp}`);
}

/** 像素阶梯定价 */
function priceFromPixels(totalPx: number): number {
  if (totalPx <= 1_000_000) return 1;
  if (totalPx <= 2_500_000) return 3;
  if (totalPx <= 5_000_000) return 8;
  return 16;
}

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

/**
 * 派生所有 valid 规格。1K 默认 medium,2K/4K 默认 high。
 * 还额外暴露 1K-1x1 的 medium 版本 = "img-standard"(便宜的兼容档,Phase 1 已用)。
 */
export const MODEL_SPECS: Record<string, ModelSpec> = (() => {
  const specs: Record<string, ModelSpec> = {};

  // 兼容老命名:img-standard = 1K 1:1 medium 1cr,作为最便宜入口
  specs["img-standard"] = {
    name: "img-standard",
    description: "1024×1024,medium 画质。最便宜的入门档,适合缩略图、占位图。",
    upstream: {
      model: "gpt-image-2",
      size: "1024x1024",
      quality: "medium",
      output_format: "png",
    },
    creditsPerImage: 1,
  };

  for (const res of RESOLUTIONS) {
    for (const asp of ASPECTS) {
      if (!isValidCombo(res, asp)) continue;
      const [w, h] = resolveDims(res, asp);
      const px = w * h;
      const quality: "medium" | "high" = res === "1k" ? "high" : "high";
      const name = `img-${res}-${asp}`;
      specs[name] = {
        name,
        description: `${w}×${h} (${res.toUpperCase()} ${asp.replace("x", ":")}),${quality} 画质。`,
        upstream: { model: "gpt-image-2", size: `${w}x${h}`, quality, output_format: "png" },
        creditsPerImage: priceFromPixels(px),
      };
    }
  }
  return specs;
})();

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
