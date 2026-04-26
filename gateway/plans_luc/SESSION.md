# SESSION · v2 /v1/images/edits 实施

> 起点 2026-04-26。Plan: `gateway/plans_luc/v2-images-edits-plan.md`(完整 spec,实证已通)。

## 现状

- v1 文生图已上线、跑通(`gateway/src/` 7 文件)
- v2 plan 已落、CPA multipart 透传已实证(`scripts/probe-edits.sh`)
- 实测 usage 结构:`input_tokens` / `output_tokens` / `*_tokens_details.{image_tokens,text_tokens}` / `total_tokens`
- 业务定位:网关 → 资方供应,credits 池对资方无限,multiplier 是供应核算系数

## 任务表(§八 9 步,#41 [1] probe 已完成)

| ID | 任务 | 状态 | 文件 | 依赖 |
|:-:|:--|:-:|:--|:--|
| #43 | [2] upstream.editImage + usage 解析 | pending | src/upstream.ts | — |
| #44 | [3] db migration | pending | src/db.ts | — |
| #45 | [5] tokenMultiplier | pending | src/models.ts | — |
| #46 | [4] /v1/images/edits 路由 | pending | src/index.ts | #43 #44 #45 |
| #47 | [6] mask PNG header 校验 | pending | src/index.ts | #46 |
| #48 | [7] 单测 ≥16 用例 | pending | src/*.test.ts | #43-47 |
| #49 | [8] smoke-edits.sh | pending | scripts/ | #46 #47 |
| #50 | [9] 文档更新 | pending | docs/ README | 全部 |

## 关键约束(全部源自 v2 plan,执行时不要偏离)

- **不引图像库**(无 sharp/Image),只读 PNG header 24 字节(§四 + §3.6 B)
- **图片不落盘**(内存 → fetch FormData → 释放,§四 红线)
- **不改 v1 路由任何字节**(§九 回滚)
- **`IMAGES_EDITS_ENABLED=false` env 开关**(§九)
- **`EDIT_MULTIPLIER=1.5`** 作为 edit 总倍率,在 tokenMultiplier 之上叠加
- **PRAGMA user_version 0→1 迁移**(§3.4),原行 op='generation' 默认值
- **usage_json TEXT 列保留嵌套**,同时 input_tokens/output_tokens/total_tokens 单列做整数索引
- **校验失败的不扣 credits**(§五 5/6/7/8 验收)
