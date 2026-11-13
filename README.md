# caopazi-compact

在上下文达到 **70%** 时自动压缩，并用机械锚点保住关键对话。复用 DSH 原生的
`compaction-basic`，不引入第二个压缩器，也不替换 `ctx.compaction`。

## 它做了什么

1. **策略**：在 preset 配置解析时，把 preset 内嵌套的 `compaction-basic` 行调到
   `thresholdRatio: 0.7`、`retainRatio: 0.15`，并强制 `auto: true`。
2. **锚点**：在同一个隔离组里挂一个 `augment` 行，包住引擎唯一公开的扩展点
   `summarize()`。等模型正常写完摘要后，把一段有上限的「必须保留」事实**机械
   追加**到 checkpoint 末尾——不依赖模型是否愿意采纳：
   - 第一条用户消息（原始任务）逐字；
   - 用户消息里的硬性要求/禁止/约定（正则抽取）；
   - 路径、命令、错误码、URL；
   - 未完成事项；
   - 上一份 checkpoint 的目标/约束/未完成三节。

   摘要调用本身不改输入，provider 的 KV cache 和原生 prompt 都不受影响。
3. **可见性**：`/compact-status` 显示用量、阈值、剩余空间和上次压缩。

## 为什么不是新引擎

preset 的 `compaction` 组是 `isolate: compaction` 的，一个上下文只能有一个
`ctx.compaction`。再挂一个会冲突，`/compact` 也会找错对象。这里只改策略和摘要输入。

## 配置

参数写在包自己的 `cordis.patch.yml`（bundle patch）里；想覆盖时在 profile 的
`cordis.patch.yml` 里按 id 追加**完整** config（patch 是整段替换，不是深合并）。

```yaml
- insert:
    - id: caopazi-compact
      name: caopazi-compact
      config:
        thresholdRatio: 0.7      # 70%
        retainRatio: 0.15        # 尾部逐字保留
        anchors:
          enabled: true
          budgetTokens: 1500     # 锚点上限
        # 可选：透传给 compaction-basic
        # headroomTokens: 65536
        # summarizationProvider: ai-hub
        # summarizationModel: glm-5.3-flash
```

阈值按模型**声明窗口**计算：`min(window × 0.7, window - 输出预留 - headroom)`。
1M 窗口就是 70 万；如果实际可用窗口更小，应先改模型的 `contextWindow`。

## 安装

```bash
cp -r caopazi-compact "$DSH_HOME/profiles/ondevice/plugins/caopazi-compact"
cp -r caopazi-compact "$DSH_HOME/profiles/ondevice/node_modules/caopazi-compact"
```

把包名加进 profile 的 `dependencies`（`file:./plugins/caopazi-compact`），并把
`caopazi-compact` 放进 `dsh.profile.bundles`，**位置在
`@deepseek-ai/dsh-web-app` 之后**：

```json
"bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "caopazi-compact"
]
```

顺序是硬约束：bundle patch 按 bundle 顺序应用，排在 web-app 之后才能用 id patch
命中已经插入的 `preset-*` 行。bundle patch 给四个 preset 加了
`inject: [caopaziCompactReady]`：preset 会等 overlay 把 `internal/config` 钩子注册
完、并发布这个服务之后，才解析自己的 `config.plugins`。

包里还有 `caopazi-compact-fallback` 行：主插件若没起来，它会在 15 秒后放行 preset，
退回原生 80%，不会卡死新建会话。

然后重启 DSHM。

## 回滚

从 `dsh.profile.bundles` 删掉 `caopazi-compact` 并重启。插件行和四条 gate 行都
在同一个 bundle patch 里，会一起消失，不会留下等不到的服务。插件自身没有持久
状态，压缩结果仍是普通的 `compaction/*` 会话事件。

## 测试

```bash
node --test test/anchors.test.mjs test/patch.test.mjs
```
