/**
 * 模型规格 = 分辨率 × 比例 的派生组合,客户看到的是像素命名 `img-{w}x{h}`。
 *
 * 真值表(2026-04-25 实测 gpt-image-2 经 CPA + Pro 账号):
 *
 *           1x1  4x3  3x4  16x9 9x16 3x2  2x3  5x4  4x5  2x1  1x2  21x9 9x21
 *     1K    ✅   ✅   ✅   ❌   ❌   ❌   ❌   ❌   ❌   ❌   ❌   ❌   ❌
 *     2K    ✅   ✅   ✅   ✅   ✅   ✅   ✅   ✅   ✅   ✅   ✅   ❌   ❌
 *     4K    ❌   ❌   ❌   ✅   ✅   ❌   ❌   ❌   ❌   ✅   ✅   ✅   ✅
 *
 * 计费按总像素阶梯:
 *   ≤ 1.0 M px  → 1 credit
 *   ≤ 2.5 M px  → 3 credits
 *   ≤ 5.0 M px  → 8 credits
 *   ≤ 9.0 M px  → 16 credits
 *
 * 上游硬限制(实测,与套餐无关):
 *   - 长边 ≤ 3840 px,总像素 ≲ 8.3 M
 *   - background:"transparent" OpenAI 直接拒绝
 */

export type Resolution = "1k" | "2k" | "4k";
export type Aspect =
  | "1x1"
  | "4x3" | "3x4"
  | "16x9" | "9x16"
  | "3x2" | "2x3"
  | "5x4" | "4x5"
  | "2x1" | "1x2"
  | "21x9" | "9x21";

export const RESOLUTIONS: Resolution[] = ["1k", "2k", "4k"];
export const ASPECTS: Aspect[] = [
  "1x1",
  "4x3", "3x4",
  "16x9", "9x16",
  "3x2", "2x3",
  "5x4", "4x5",
  "2x1", "1x2",
  "21x9", "9x21",
];

const LONG_EDGE: Record<Resolution, number> = { "1k": 1024, "2k": 2048, "4k": 3840 };

const RATIO: Record<Aspect, [number, number]> = {
  "1x1":  [1, 1],
  "4x3":  [4, 3],   "3x4":  [3, 4],
  "16x9": [16, 9],  "9x16": [9, 16],
  "3x2":  [3, 2],   "2x3":  [2, 3],
  "5x4":  [5, 4],   "4x5":  [4, 5],
  "2x1":  [2, 1],   "1x2":  [1, 2],
  "21x9": [21, 9],  "9x21": [9, 21],
};

/**
 * (res, asp) → [w, h]。长边对齐 LONG_EDGE,短边按比例四舍五入到整像素
 * (不再做 /8 对齐:OpenAI 上游接受非 /8 对齐尺寸如 2048×1365 / 2048×878)。
 */
export function resolveDims(res: Resolution, asp: Aspect): [number, number] {
  const long = LONG_EDGE[res];
  const [rw, rh] = RATIO[asp];
  const longSide = Math.max(rw, rh);
  const shortSide = Math.min(rw, rh);
  const shortPx = Math.round((long * shortSide) / longSide);
  return rw >= rh ? [long, shortPx] : [shortPx, long];
}

/** OpenAI 上游闸门:实测得到的 valid 集合 */
const VALID_COMBOS = new Set<string>([
  "1k-1x1", "1k-4x3", "1k-3x4",
  "2k-1x1", "2k-4x3", "2k-3x4",
  "2k-16x9", "2k-9x16",
  "2k-3x2", "2k-2x3",
  "2k-5x4", "2k-4x5",
  "2k-2x1", "2k-1x2",
  "4k-16x9", "4k-9x16",
  "4k-2x1", "4k-1x2",
  "4k-21x9", "4k-9x21",
]);

export function isValidCombo(res: Resolution, asp: Aspect): boolean {
  return VALID_COMBOS.has(`${res}-${asp}`);
}

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
  /**
   * 尺寸系数(§3.6 A):edit 路径下乘到 creditsPerImage 上反映上游 token 烧速差。
   * 1k=1.0 / 2k=4.0 / 4k=8.5(按像素近似线性);generation 不使用,保持原定价。
   */
  tokenMultiplier: number;
};

/** edit 总倍率,叠加在 tokenMultiplier 之上。reflective:edit 比 generation 烧 ~1.5× 配额。 */
export const EDIT_MULTIPLIER = 1.5;

function tokenMultiplierFor(longEdge: number): number {
  if (longEdge <= 1024) return 1.0;
  if (longEdge <= 2048) return 4.0;
  return 8.5;
}

/**
 * 派生所有 valid 规格,命名 = `img-{1k|2k|4k}-{w}x{h}`,默认 high 画质。
 * 额外暴露:
 *   - img-standard           = 1024×1024 medium 1cr (老兼容入口)
 *   - img-1k-1024x1024-low   = 1024×1024 low    1cr (极速档)
 */
export const MODEL_SPECS: Record<string, ModelSpec> = (() => {
  const specs: Record<string, ModelSpec> = {};

  specs["img-standard"] = {
    name: "img-standard",
    description: "1024×1024,medium 画质。最便宜的兼容入口,适合缩略图、占位图。",
    upstream: { model: "gpt-image-2", size: "1024x1024", quality: "medium", output_format: "png" },
    creditsPerImage: 1,
    tokenMultiplier: 1.0,
  };

  specs["img-1k-1024x1024-low"] = {
    name: "img-1k-1024x1024-low",
    description: "1024×1024,low 画质。极速档(~10s),适合大批量草图/占位。",
    upstream: { model: "gpt-image-2", size: "1024x1024", quality: "low", output_format: "png" },
    creditsPerImage: 1,
    tokenMultiplier: 1.0,
  };

  for (const res of RESOLUTIONS) {
    for (const asp of ASPECTS) {
      if (!isValidCombo(res, asp)) continue;
      const [w, h] = resolveDims(res, asp);
      const px = w * h;
      const name = `img-${res}-${w}x${h}`;
      specs[name] = {
        name,
        description: `${w}×${h} (${res.toUpperCase()} ${asp.replace("x", ":")}),high 画质。`,
        upstream: { model: "gpt-image-2", size: `${w}x${h}`, quality: "high", output_format: "png" },
        creditsPerImage: priceFromPixels(px),
        tokenMultiplier: tokenMultiplierFor(LONG_EDGE[res]),
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

/** edit 路径定价:creditsPerImage × tokenMultiplier × EDIT_MULTIPLIER × n,向上取整。 */
export function calculateEditCost(spec: ModelSpec, n: number): number {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("n must be a positive integer");
  }
  return Math.ceil(spec.creditsPerImage * spec.tokenMultiplier * EDIT_MULTIPLIER * n);
}
