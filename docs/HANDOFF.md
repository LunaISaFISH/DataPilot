# DataPilot v0.2 已发布交接

Updated: 2026-09-05 (Asia/Singapore)

`docs/BUILD-SPEC.md` 是实现规格，`docs/TASK.md` 是最新运行状态，`docs/DEMO.md` 是招聘会现场脚本。本文只保留下一次接手真正需要的信息。

## 当前结论

- 分支为 `main`；v0.2 主体发布提交为 `7a1a607`，作者身份是已确认的 Luna。
- 现有站点和域名继续复用：`https://datapilotgo.com`。不要创建第二个 Site。
- 现有 API 继续复用：`https://datapilotgo-api.fly.dev`。公网已运行 engine `0.2.0`，默认模型为 Haiku。
- 招聘会主入口改为 `/demo`：真实 UCI 已完成运行的四步验证回放，即开即用、零后端请求、零模型费用，并始终标注为非实时。
- `/workbench` 保留真实 CSV、四个样例、快速扫描、契约分析、人工处置、执行、验证与下载能力。

## 本轮完成

- 前端改成安静的 Dashboard 信息结构：紧凑顶栏、独立首页、四步演示、聚焦上传页；中英文均为自然用户文案，技术证明放在展开层。
- 修复 SSE：前端同时监听后端的具名 `run_event`，已打开的事件流断开后立即转轮询。
- 无契约的快速扫描与 AI 完全隔离，AI 台账为空；服务重启后可从完整报告恢复终态。
- 新增 `scripts/export_verified_replay.py` 和隐私最小化 UCI 快照；页面数字全部来自已应用运行，导出前验证哈希、守恒、14 项执行验证和 10 项独立复验。
- 新实时默认模型为 `claude-haiku-4-5-20251001`；全站每日上限 40 次。历史回放继续忠实显示当时使用的 Opus，不篡改 provenance。
- Haiku 4.5 不接受 `output_config.effort` 或服务端 `fallbacks`，provider 会按模型能力省略二者，并继续使用 DataPilot 自己的 fail-closed 回退。
- 公网运行限制、24 小时访客清理、样例预置、持久 AI 日预算、运行时 API 地址切换均已实现。

## 已验证

- `make test`：283 tests passed；Ruff、mypy（38 files）、oxlint、vinext production build 全绿。
- `scripts/e2e_smoke.mjs`：回放零 API 请求、完整四步、真实 UCI 快速扫描低于 0.4 秒、契约流程执行至 14/14、390 × 844 双语无横向溢出。
- 真实浏览器复核：中文与英文文案、四步切换、工作台折叠样例、公开快速扫描均通过。
- Sites 本地构建和 tar 包结构已验证；现有 Site 为公开状态，`datapilotgo.com` 的 DNS 与 SSL 状态正常，两个公开运行时地址变量已配置。
- `fly.toml` 校验通过；`Dockerfile.api` 本地构建成功，镜像启动后的 `/health` 返回 engine `0.2.0` 与四个样例。
- 最小 Haiku 实测通过：语义映射 7.9 秒（1,279 input / 191 output tokens）且 grounding 通过；契约草案 14.2 秒（2,542 / 1,069），一条未知格式规则被 validator 拒绝，证明 AI 结果不会绕过监管。

## 已验证的演示数据

- UCI Online Retail：42,481 records × 8 columns，CC BY 4.0。
- 7 findings，5 个初始 blocker，固定 scope 质量分 89.43 → 95.92。
- 最终 25,653 eligible + 16,341 quarantined + 487 duplicate-only excluded = 42,481。
- 42,884 affected cells；7/7 findings dispositioned；14/14 validations；10/10 independent verification；`CONDITIONAL_PASS`。
- 快照位于 `lib/data/uci-online-retail-replay.json`，生成与校验逻辑位于 `scripts/export_verified_replay.py`。

## 发布结果

1. `datapilotgo-api` 已完成滚动发布；公网 `/health`、完整 demo smoke、14/14 validation 和独立 verify 全部通过。
2. 现有公开 Site 已从精确提交构建并发布，运行时后端地址为 `https://datapilotgo-api.fly.dev`。
3. `https://datapilotgo.com/demo` 已在 390 × 844 下完成中英文四步检查，零 API 请求且无横向溢出。
4. `https://datapilotgo.com/workbench` 已从公网完成 UCI 快速扫描；测试 run 随后删除，未污染现场列表。
5. 回放审计区明确说明 Opus 是历史运行记录、打开回放不会发起调用；新的实时运行默认使用 Haiku。

## 安全提醒

- 不要打印任何 secret。此前交接曾记录本机密钥在旧工具输出中被回显；若尚未轮换，正式上线前应轮换 GitHub/Fly 使用的 Anthropic key。
- 回放只发布聚合事实，不含原始行、record UID、模型请求/响应 payload 或 distinct examples。
- 实时模型只接收脱敏聚合值；模型异常、超时、格式错误或预算耗尽都必须如实进入台账并 fail closed。
- 不要把回放说成实时运行，不要把隔离或发布排除说成删除源数据。

## 下一次接手

先运行 `git status --short --branch` 和 `make test`。招聘会优先使用 `/demo`；只有需要展示实时上传、契约或 AI 台账时才进入 `/workbench`。若改动前端，继续复用当前 Site 与域名；若改动后端，继续复用当前 Fly app。
