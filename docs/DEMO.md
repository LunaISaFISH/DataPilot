# DataPilot 招聘会 3 分钟演示

扫码入口：`https://datapilotgo.com`

主路径：主页 →「看 3 分钟演示」→ `/demo`

备用真实分析：`/workbench`；公网 API：`https://datapilotgo-api.fly.dev`

主数据是 UCI Online Retail 2010 年 12 月真实公开数据，42,481 行 × 8 列，CC BY 4.0。演示页是一次已完成、已独立复验的真实引擎运行快照，不是现场重跑，也不发起后端或模型请求。页面始终显示「已验证回放 · 非实时运行」。

## 0:00–0:20｜一句话建立产品定位

操作：扫码打开主页，点击主按钮进入演示。

台词：

> DataPilot 不是让 AI 随意清洗 CSV，而是判断一份数据能不能安全、可解释、可审计地发布。今天用一份真实公开交易数据演示：AI 只能提议，策略和人授权，确定性规则执行，验证器决定能不能发布。

页面证据：真实公开数据标签、UCI 来源、CC BY 4.0、source SHA-256；演示无需登录、无需等待后台。

## 0:20–0:55｜第一步：发现问题

操作：停留在「发现问题」。

台词：

> Polars 在固定的 42,481 条源记录范围内得到 89.43 分和 7 项发现，其中 5 项会阻断发布。分数高不代表可以发布；阻断项优先。这里的数字、分子分母和 scope hash 都来自同一份运行工件，没有为演示硬编码另一套结果。

指给评委看：500 个重复成员、42,481 个日期格式单元格、403 个国家名语义变体、15,631 个缺失 CustomerID，以及 `BLOCKED`。

## 0:55–1:35｜第二步：AI 赋能与 AI 监管

操作：点击「下一步」，展示 `EIRE → Ireland`。

台词：

> 模型只收到 Country 列的聚合候选、词频、契约词表和证据编号，原始行发送数是 0。它提出 `EIRE → Ireland`，但模型无权决定风险，也无权修改数据。后端重新计算影响范围为 403 条，并逐项验证来源值、目标词表和证据引用；通过后仍然要求人工批准。

指给评委看：`rows sent = 0`、`aggregate values sent = 38`、grounding passed、human approval required、AI ledger input hash。

说明：这个快照忠实保留当次运行实际使用的模型记录；新的实时运行默认使用低成本 `claude-haiku-4-5-20251001`。回放不调用模型，不产生费用。

## 1:35–2:10｜第三步：做出决定

操作：点击「下一步」，进入审核决定。

台词：

> 两项低风险动作由具名策略规则授权，五项语义或阻断动作由人授权。每个 finding 必须恰好获得一个最终处置，所以台账是 7/7。AI 的 proposal 和 executor 的 action 是不同对象；没有授权来源的提议永远进不了执行器。

指给评委看：授权来源、动作白名单、7/7 finding ledger。强调 500 是重复成员数；由于隔离优先且集合有重叠，最终发布排除是 487 条，不把 source rows 描述成被删除。

## 2:10–2:50｜第四步：安全交付

操作：点击「下一步」，进入交付结果。

台词：

> 执行器只运行白名单规则，并写出新的派生版本；源文件保持不变。14 项 post-condition 全部通过后，发布状态才从 BLOCKED 变成 CONDITIONAL_PASS。最终 25,653 条可发布、16,341 条隔离、487 条仅从发布包排除；固定 scope 下质量分从 89.43 到 95.92，completeness 和 uniqueness 没有靠缩小分母制造改善。

指给评委看：14/14、before/after 四维分数、source/scope/contract/action/release hashes。

## 2:50–3:00｜收束

台词：

> DataPilot 不追求自动改得最多，而是只自动执行证据与策略允许的部分。最终交付的不只是一份 CSV，而是一条可以复验的发布证据链。

## 评委追问时再打开真实模式

演示页右上角或最后一步进入「真实分析」：

- 上传任意受支持 CSV，或展开样例并启动真实后端运行；
- 「快速扫描」不调用 LLM，只做 ingestion、profiling 与确定性检测；
- 带契约分析会启用受约束语义提议、人工处置、dry run、apply 与验证；
- 运行页 SSE 断开时自动切换轮询，不把等待动画冒充进度；
- 实时模型默认 Haiku，并受每日 40 次全局上限和每客户端限流保护；预算耗尽时如实回退，绝不伪装成模型成功。

如果展示实时 AI，必须读屏说明 provider、model、token、latency、input hash、redaction 与 grounding。不要背诵回放数字作为新运行结果。

## 现场兜底阶梯

1. 首选 `/demo`：静态加载、零后端请求、零模型费用，仍使用真实引擎和独立复验产出的数据。
2. 需要证明真实功能时再打开 `/workbench`，先用「快速扫描」或小样例。
3. 公网 API 或 Anthropic 不可用时，回放照常工作；实时页必须明确显示断连或 deterministic fallback。
4. 手机或网络完全不可用时才使用预录屏，并明确说明是录屏。

## 彩排清单

```bash
make test
make demo
node scripts/e2e_smoke.mjs --web http://localhost:3000
```

- 手机 5G 和会场 Wi-Fi 各扫码一次；确认 `/demo` 秒开、中英文切换、390px 无横向溢出。
- 检查 `https://datapilotgo-api.fly.dev/health`，但不要在屏幕上打开或输出 secrets。
- 若要验证完整 API 生命周期，在 replay 模式的本地 API 上运行 `make demo-smoke`，避免彩排重复消费模型额度。
- 只有明确要验证供应商集成或输出质量时才使用 `--live`；普通测试和现场主路径不需要模型调用。

## 冻结回放数据来源

`lib/data/uci-online-retail-replay.json` 由 `scripts/export_verified_replay.py` 从一个已完成的 `APPLIED` UCI 运行导出。导出器在写入前验证 source/contract/scope/action/decision/release 哈希链、finding 守恒、行数守恒、14 项执行验证、独立 `/verify` 结果与 AI ledger 引用；快照不包含源行、record UID、模型请求/响应 payload 或 distinct examples。

更新回放只能执行导出脚本并通过 `tests/test_verified_replay.py`，不得手工修改展示数字。
