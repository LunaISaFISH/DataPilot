# DataPilot 招聘会 3 分钟演示

主入口：`https://datapilotgo.com`（Sites 前端重新发布后）

公网 API：`https://datapilotgo-api.fly.dev`

主数据：`uci_online_retail`，UCI Online Retail 2010 年 12 月原始子集，42,481 行 × 8 列，CC BY 4.0。

台上不要背最终人数；始终读屏。AI 可用且人批准提议时，会归一 `EIRE → Ireland` 的 403 个单元格；若模型不可用，确定性流程会保守回退，因此发布人数可能不同。这种差异必须如实展示。

## 0:00–0:15｜先讲 AI 的权限边界

操作：打开工作台，确认底栏显示 `API connected · Engine 0.2.0 · AI claude-opus-5 ready`，展开右侧 AI 权限卡。

台词：

> 先说规矩：DataPilot 里的 AI 看不到任何原始行和敏感字段，不写代码、不改数据、不定风险。它只能在 JSON Schema 内提议，策略、人和确定性校验器才拥有后续权限。右侧这张卡就是后端实际执行的权限契约。

指给评委看：模型可见字段、`rows_sent = 0`、允许的动作枚举、grounding reason codes。

## 0:15–0:35｜真实公开数据与确定性事实

操作：在 Samples 选择带 `real-data · cc-by-4.0` 标签的 UCI Online Retail，点击“带契约分析”。

台词：

> 这不是为演示种植的异常，而是 UCI 的真实公开交易数据。42,481 行先由 Polars 做指纹、画像和规则检测。基线质量分 89.43，但发布仍然是 BLOCKED——质量分和能不能发布是两回事，阻断项永远优先。

指给评委看：UCI 来源、source SHA-256、实际 pipeline events、7 个 findings、固定 score scope。不要把处理中的状态称为动画。

## 0:35–1:10｜AI 真正贡献，但不拥有决定权

操作：打开 `SEM-Country` 的 AI 监管区，先看发送信封，再看建议和接地结果。

AI 成功或命中预热缓存时：

> 模型只收到 Country 一列的聚合词频、候选词、允许的国家词表和证据编号，没有一行原始数据。它识别 `EIRE` 与 `Ireland` 的语义关系；但它报告的数量不可信，后端重新计算为 403 条。源值、目标词表、证据引用、输入哈希和敏感字段边界全部通过后，提议才有资格进入人工审批。

AI 超时、拒绝或预算耗尽时：

> 现在模型没有给出可采用结果，所以系统明确标记 deterministic fallback，提议不会自动变成动作，发布继续阻断。AI 在这里只影响效率，不影响安全。

指给评委看：provider/model、`served_from_cache`、真实 token/latency 或 fallback reason、`input_hash`、`affected_record_count = 403`、AI ledger call ID。

## 1:10–1:35｜现场攻击 AI 输出

操作：选择红队用例 `UNKNOWN_CANONICAL_TARGET`，展示原始提议和篡改提议的 diff。

台词：

> 如果模型幻觉或被提示词注入怎么办？我把目标替换成词表外值。生产用的同一个 grounding validator 立即返回 `UNKNOWN_CANONICAL_TARGET`，不创建 action，批准按钮也不会亮。系统是按 AI 一定会出错来设计的。

可替换演示：`AMBIGUITY_REGISTRY_HIT` 或 `TIMEOUT`；二者都必须显示未绕过发布门禁。

## 1:35–2:05｜策略和人工处置

操作：先尝试直接生成变更集，让未处置 findings 的门禁显现；随后按 UI 允许的选项完成审批、隔离和排除。

台词：

> 低风险且满足条件的动作可以由具名 policy rule 授权；中风险语义归一要人批准；高风险缺失、歧义或敏感问题只能隔离、排除或复核。每个 finding 必须恰好有一个处置，并记录 run revision、理由和授权来源。

## 2:05–2:40｜预演、执行和 14 道验证

操作：生成 Change Set，指出 `approved_action_set_hash` 与每个 action 的 `authorization_source/ref`；点击 Apply；进入 Validation & Release；再点击内存篡改测试。

台词：

> 先 dry run 锁定动作集、精确影响范围和遮蔽后的前后样例，再由 allowlist executor 执行。当前 AI 路径下读屏可见 25,653 条 eligible、16,341 条 quarantine、487 条 release exclusion，候选质量分 95.92；原始 scope 从未缩水。14 项 post-condition 全通过才发布。现在我在内存里翻转源文件一个字节，`SOURCE_IMMUTABLE` 立刻变红、状态回到 BLOCKED，而且不写出任何工件。

若 AI 回退，直接读屏上的真实人数；不要引用上一段数字，也不要把 exclusion 说成删除 source rows。

## 2:40–3:00｜哈希与可审计交付

操作：展示 source → candidate → release 哈希链、AI ledger、changes ledger，下载 `release.csv`、manifest 和 audit bundle。

台词：

> 最后不信一张漂亮报表，信可复算的哈希和账本：谁提议、谁授权、改了哪些 cell、哪些记录只在发布包中被隔离，都能追到。总结就是：AI 提议，策略决策，人来拍板，规则执行，验证门禁发布。

## 追问加演（每项 20–30 秒）

- 幂等：用同一 Idempotency-Key 再次 Apply，展示 `X-Idempotent-Replay: true` 和相同 manifest。
- 离线复验：运行 `.venv/bin/python -m datapilot verify <run_dir>`，复算所有工件和哈希。
- 换数据：切到电商或 HR 样例，展示相同引擎生成不同 detectors、风险和动作。
- AI 失败：红队选择 `TIMEOUT`，展示 fallback attribution 与发布仍受控。
- 观测模式：上传不带契约的 CSV，解释系统只报告事实、不擅自发明业务规则。
- 契约起草：展示 AI 草案与 rejected fields；草案必须经 schema/grounding 校验并由人采用，不能直接改变当前 run。

## 规模问题答法

> 当前 P0 明确限制 25 MiB、250,000 physical rows、200 columns；现场 42,481 行由单机 Polars 处理。它不是分布式大数据系统。下一阶段是将仍以 Python 循环实现的 detector 下推为 Polars expressions，并把 job runner 拆成独立 worker；接口和数据契约无需改变。

## 现场兜底阶梯

1. 首选公网 live 服务，样例语义请求使用已验证的 `input_hash` 缓存并明确标注 cached。
2. 公网 AI 不通：确定性引擎继续，AI 显示 fallback，发布仍 fail closed。
3. 公网 API 不通：打开 `/demo/clinical-nlp`，顶部必须保留 `Verified Demo Replay`，不能称为 live。
4. 设备故障：播放预先录制的一次完整 live run；明确说明它是录屏。

## 彩排清单

- 执行 `make test`、`make demo-reset`、`make demo-prewarm`。
- 执行 `.venv/bin/python scripts/demo_smoke.py --base https://datapilotgo-api.fly.dev --sample uci_online_retail --timeout 180`。
- 手机 5G 和会场 Wi-Fi 各扫码一次；检查中英文切换、UCI 来源和 API connected。
- 外接屏 125% 缩放、3 米距离确认 BLOCKED、reason code 和哈希可读；关闭 DevTools 和通知。
- 检查 Fly `/health`、AI daily budget、磁盘可写；不要在屏幕上打开 secrets。
- 下载文件前提醒：CSV 为审计一致的原始字节；用电子表格打开不受信任 CSV 时需采用隔离或安全导入流程。

## 冻结的合成回放基线

`clinical-nlp@1.2.0`：5,200 records × 18 fields，baseline 99.27，candidate 99.61，9 个 findings，316 cells transformed，56 quarantined，43 exact duplicates excluded from release，5,101 eligible，14/14 validations，最终 `CONDITIONAL_PASS`。这些数字来自 `fixtures/clinical_nlp/golden/report.json`；有意修改 fixture 或算法后运行 `make golden` 并同步文档。
