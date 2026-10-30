# AGENTS.md

面向在本仓库工作的 AI agent 与工程师。产品语言与治理约束见 `CONTEXT.md`，
本文档只写 **前端视觉/交互约束**。改 `web/` 之前先读完本文。

## 1. 设计基线

- 基线方向：**Linear 暗色工作台**（`design-demos/dir-2.html`，选定记录 `design-demos/direction-approved.md`）
- 参照气质：Qoder（近黑、克制、工程理性）——只借气质，不用它的配色
- 品牌：**Signal 信号橙 #F25C05** 是唯一品牌色，与 logo A1 橙点同色
- Logo：**A1 双柱穿珠**（两道闸门 + 穿过的橙点 = 一次 run 通过两道 deny-by-default 关卡）
  柱用 `currentColor` 随皮肤反转，橙点永远走 `--accent`。禁改图形、禁换色
- 单一事实源：token 全部定义在 `web/src/styles.css` 的 `:root`，规格页
  `design-demos/type-spacing.html` 与产品共用同一套 CSS 变量（看即所用）

## 2. Design tokens（必须使用，禁止硬编码）

| 类别 | Token | 值 |
|---|---|---|
| 字阶（1.2 小三度） | `--fs-meta` / `--fs-body` / `--fs-card-title` / `--fs-title` | 12 / 14 / 17 / 21 px |
| 字重 | — | 只用 400 / 500 / 600 三档，`font-synthesis: none` |
| 间距（4px 网格） | `--sp-1` … `--sp-8` | 4 / 8 / 12 / 16 / 24 / 32 px |
| 圆角（按角色） | `--r-xs` / `--r-sm` / `--r-md` / `--r-lg` | 4 / 6 / 10 / 14 px |
| 行高 | — | 西文 1.5 / 中文 1.65 |

- 间距只走 4px 网格；例外仅允许 6px（点·标签对等微型光学对位）
- mono 字体全局 `font-nums: tabular-nums slashed-zero`（等宽数字 + 零斜杠）
- 字体栈：Inter / Inter Tight / JetBrains Mono（已验证原始 Manrope/DM Mono 从未加载，无网络依赖）

## 3. 颜色系统：accent 与 status 分层

**这是本项目最容易做错的一条。**

- `--accent`（Signal 橙）只属于：品牌、主操作、focus 环、选中态、进度条、tab 指示器
- 状态色只表达语义，**不得**用作品牌装饰；装饰性强调一律走 `--accent-text`
- 深浅双皮肤靠 `[data-surface="light"]` 整套覆盖（中性/语义/阴影），语义色在浅色下加深，
  保证正文对比度 **≥4.5:1**（实测值在 `design-demos/dir-2.html`）

### 状态语义色（固定映射，勿乱改）

| 语义 | 色 | 状态 |
|---|---|---|
| 绿 | `--green` | 机器正常工作：planning / executing / validating / approved / approved_for_merge / merged |
| 琥珀 | `--amber` | **需要人介入**：awaiting_approval / assessing_risk / **stopped** |
| 蓝 | `--blue` | 信息性中进展：queued / requested / assessing_risk / awaiting_review |
| 红 | `--red` | **真失败**：rejected / timed_out |
| 灰 | `--faint` / `--muted` | 人为终止/过期：cancelled / expired |

关键产品语义（对齐 `CONTEXT.md`）：**stopped 是"停下等人处置"，不是失败**，必须是琥珀不是红。

### rgba 淡底

语义色的淡底/边框一律走 RGB 通道变量（`--accent-rgb` / `--red-rgb` / `--amber-rgb` /
`--green-rgb` / `--cyan-rgb` / `--panel-rgb`）写 `rgba(var(--x-rgb), α)`，
禁止写死 `rgba(244, 127, 131, …)` 这类深色主题值——浅色皮肤会失效。

## 4. 可访问性下限（硬约束）

| 规则 | 下限 |
|---|---|
| 正文字号 | ≥14px（`--fs-body`） |
| 标签/metadata 字号 | ≥12px（`--fs-meta`）；`--fs-meta` 以下只允许纯装饰 |
| 正文对比度 | ≥4.5:1（深浅两个皮肤都要满足） |
| 可点击目标 | ≥44px（按钮用 hit overshoot 补足） |

新增 UI 时若用到 10px/9px 之类的小字，只允许出现在**装饰性**位置（eyebrow 标签、角标），
且不得承载正文信息。

## 5. 表单与控件规范

- **必填/可选**：可选不加任何标识；必填在 label 文字右侧加主题色上标 `*`
  （`.required-dot`，`vertical-align: super`）。**禁止**用 "optional" / "required" 文字标注
- label 是 flex column，文字与 `*` 必须包一层 `.label-text`（inline-flex）保持同行
- **下拉框必须用 `ui/Select.tsx` 自定义组件**，禁止原生 `<select>`（macOS 毛玻璃菜单不可控）：
  主题弹出菜单、SVG 箭头（深浅各一色）、键盘导航（↑↓/Enter/Escape）、点击外部关闭、
  aria-expanded / role=combobox / listbox
- 滚动条统一主题化：`scrollbar-color: var(--faint) transparent`、`scrollbar-width: thin`、
  `::-webkit-scrollbar` 6px + `--faint` thumb，禁止出现系统默认白色滚动条
- 输入框 hover 只动 border-color（120ms），focus 用 `outline: 2px solid var(--accent)`

## 6. 布局与响应式

- **改动滚动/动效时不要动布局**。列表容器保持填充侧栏（`flex:1`），效果只叠加
  transform/opacity，禁止用固定高度/`margin-top:auto` hack 压缩布局
- ≤900px 断点：单列钻取（列表 ⇄ 详情 + 返回键 `.detail-back`），body 撤销桌面 min-width
- ≤430px：topbar 收纳文字标签（`.service-label` / `.action-label`），只留图标
- 验收线：375 与 1440 双视口**零横向溢出**、零 JS 报错

## 7. 动效规范

- 逐帧动画（如 `ui/use-stack-fold.ts` 折叠堆叠）用 `requestAnimationFrame` 驱动，
  几何量取 `offsetTop/offsetHeight`（布局坐标）——**禁止**从 getBoundingClientRect 读被
  transform 过的值（会自我反馈、抖动）
- 注意 `offsetParent`：`.sidebar` 是 sticky 定位，子元素 offsetTop 基准是 sidebar 不是列表，
  计算列表内位置要减 `list.offsetTop`
- 时长克制：hover/过渡 80–120ms；不做弹跳、不做长动画
- 动画不得降低静止态对比度（`opacity` 的静止值必须是 1）

## 8. 文案规范

- 表单/设置里**不留解释性说明文字**（用户明确要求移除过 7 处）；只留字段名、状态标签、
  单位等结构性文字
- 装饰性小标签少用"中点连接"列表（A · B · C）与整行等宽小字——设计体检会警告
- 产品语言遵循 `CONTEXT.md`：remediation run / capability grant / approval quorum /
  stop condition，禁用 autonomous deployment、unattended fix 等措辞

## 9. 验收清单（改动 `web/` 后必跑）

```sh
cd web
npm run typecheck    # 基线 2 个既有 TS 错误（settings-ipc.test / RepositoryPicker.test），不得新增
npm test             # 必须 102/102
npm run build        # vite + electron 主进程 + preload，须成功
```

视觉验收：Electron 起真实 app 截图核对（深/浅两皮肤、375/1440 双视口）。
设计体检工具 `python3 .agents/skills/huashu-design/scripts/design_lint.py check <html>`。

## 10. 参考材料索引

| 文件 | 内容 |
|---|---|
| `design-demos/direction-approved.md` | 所有设计决策 + 用户原话（改视觉前先读） |
| `design-demos/type-spacing.html` | 字阶/间距/圆角规格页（与产品共用 CSS 变量） |
| `design-demos/dir-2.html` | 设计基线原型（token 真相源之一） |
| `design-demos/brand-spec.md` | 品牌/logo 设计约束 |
| `design-demos/video-storyboard.md` | 对外视频分镜（界面改动需保持分镜截图可用） |
| `web/src/styles.css` `:root` | design tokens 定义（唯一事实源） |

## 11. Git 约束

- 分支：`autofixer/workbench-visual-refresh`
- 不要动 `ceda68a` 之前携带的 orchestrator model settings WIP（含 2 个已知 TS 错误）
- 提交信息写清：改了什么、为什么、如何验证（typecheck/测试/截图）
