# ForgePilot × Glasswork：Blueprint 场景与悬浮玻璃工作台

- 日期：2026-11-09
- 状态：已确认（demo 评审通过：`design-demos/glasswork/index.html`，gitignored）
- 分支：`feat/glasswork-scene-20261108`

## 目标

在真实工作台里落地已确认的 Blueprint 工程网格 + Glasswork 液态玻璃方案：

1. 顶栏成为一整块悬浮玻璃，tab 收进等宽分段槽，选中项是一枚滑动的凸起胶囊。
2. 侧边栏同样成为悬浮玻璃板，与顶栏同一材质、同一留边节奏。
3. 支持两种玻璃模式：**Liquid**（近乎全透 + 边缘折射）与 **Frosted**（厚磨砂 + 关闭折射），偏好持久化。
4. 现有任务卡片（`.task-list-item`）的形式与选中样式**完全不变**；玻璃只作用于板体与详情卡。

## 场景

Blueprint 工程网格，沿用 demo 的层叠顺序（全部固定定位、不参与滚动）：

- 底色：`linear-gradient(var(--bg) → var(--bg-deep))`
- 两组径向光晕：右上 Signal 橙、左下冷蓝
- 64px 主网格 + 8px 次网格，径向遮罩向外淡出
- feTurbulence 颗粒，`mix-blend-mode: overlay`，深色 0.035 / 浅色 0.025

深色与浅色各自一套 token；浅色不是把深色反相，而是纸白工程图。

## 材质

Glasswork 配方（MIT，见 `design-demos/glasswork/LICENSE.glasswork`）：

- 注册 `--m-tint/--m-k/--m-thin/--m-dense/--m-blur/--m-sat/--m-bri/--m-con/--m-catch/--m-bevel/--m-shadow`
- 表面通过 `--density`、`--floor`、`--radius`、`--corner-k` 调整
- `backdrop-filter` 末尾追加 `var(--glass-lens,)`，liquid 下由 SVG 位移贴图提供边缘折射
- `corner-shape: superellipse(1.4)`（不支持时回退圆角）

| 表面        | density | floor | radius | lens |
| ----------- | ------: | ----: | -----: | ---- |
| 顶栏        |    0.50 |  0.04 |     18 | 是   |
| 侧栏        |    0.55 |  0.05 |     18 | 是   |
| 详情卡      |    0.45 |  0.06 |     10 | 否   |
| approval 卡 |    0.40 |  0.07 |     10 | 是   |
| 模态        |    0.55 |  0.72 |     14 | 否   |

### 两种模式

|                 | Liquid      | Frosted               |
| --------------- | ----------- | --------------------- |
| thin / dense    | 0.02 / 0.12 | 0.34 / 0.72           |
| blur            | 2px         | 24px                  |
| saturation      | 1.35        | 1                     |
| tint（深 / 浅） | 场景色透出  | `#222a37` / `#e6ebf2` |
| lens            | 开          | 关                    |

模式写在 `<html data-glass="liquid|frosted">`，`localStorage["fp-glass"]` 持久化；
顶栏按钮切换，图标与文案同步（Liquid / Frosted），按钮宽度固定，切换不推动导航。

## 布局

- 顶栏：`margin: 12px 16px 0`、`sticky top: 12px`、56px 高、18px 圆角、宽落影
- 导航：`width: max-content` 的胶囊槽，4px 内边距，36px 等宽 tab（128px），
  胶囊指示器 36px，tab 通过 `::after` 保持 44px 命中区
- 侧栏：网格列 280 → 296，板体仍 280px；左/底 16px、顶 12px 留边，
  高度 `100vh - 96px`；桌面 `position: fixed` 钉在视口（只有主面板滚动），
  工作区第一列保留占位、主面板显式放第 2 列
- 主区随网格右移 16px；滚动/动效不改布局
- ≤900px：保留现有单列钻取（列表 ⇄ 详情 + 返回键）；侧栏回到 `position: relative`
  的 12px 留边静态悬浮板；顶栏两行 48/48、总高 96、整体圆角 18；导航横向滚动并显示两端渐隐
- ≤1280px 隐藏顶栏动作文字（含玻璃模式标签），≤430px 只留图标
- 375 / 1440 双视口零横向溢出

## 可读性

- Liquid 下卡片近乎透明，因此卡片行高、字号、颜色全部沿用现有 token；`--muted` 在
  四组合（深浅 × 两模式）下均 ≥4.5:1
- 模态 floor 0.72：表单标签、readonly、placeholder 在深色遮罩 + 玻璃上仍 ≥4.5:1
- 浅色皮肤品牌字改用 `--accent-text`（Signal 橙在浅玻璃上只有 ~3:1）
- placeholder 统一 `var(--muted)` + `opacity: 1`
- 任务卡片 10px 状态字保留（与现有卡片完全一致）；这是本方案唯一低于 12px 的正文类文字，
  由“任务卡片形式不变”的约束决定

## 任务卡片不变

`.task-list-item`、`.task-list-item-selected`、状态点、hover、内边距、字号全部不改动；
侧栏变玻璃后，卡片仍是透明底，选中仍是现有橙色渐变（13% → 3%）+ 32% 橙边框。
卡片不加上玻璃、不加 lens。

## 实现清单

- `web/src/ui/liquid-glass.ts`：vendored Glasswork lens（TS 移植，保留 MIT 头）
- `web/src/ui/glass.ts`：模式读写 + `useSyncExternalStore` 订阅
- `web/src/ui/use-liquid-glass.ts`：把 lens 绑定到元素，模式切换时 update
- `web/src/ui/use-scroll-fade.ts`：导航横向滚动渐隐
- `web/src/ui/surface.ts`：同步 `data-kind`
- `web/src/main.tsx`：启动时应用玻璃模式
- `web/src/App.tsx`：场景层、顶栏/侧栏/详情卡/模态挂 `.glass`、模式按钮
- `web/src/styles.css`：token、材质、场景、悬浮壳层、响应式、对比度修正
- `AGENTS.md`：补充玻璃材质与模式约束

## 验收

```sh
cd web
npm run typecheck
npm test
npm run build
```

- Electron 真机截图：深/浅 × Liquid/Frosted × 1440/375
- 对比度探针：顶栏、侧栏、卡片、模态、任务卡片，四组合全部 ≥4.5:1
- 五个宽度零横向溢出；无 JS 报错

## 非目标

- 不重做任务卡片；不改审批/工作流语义
- 不把记忆、Issue、Dashboard 等 surface 的既有实底卡片一次性玻璃化（先保证任务工作台；
  其他 surface 共享场景与顶栏，后续可复用 `.glass`）
- 不引入第三方玻璃库运行时依赖
