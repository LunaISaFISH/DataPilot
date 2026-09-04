# 交接说明（2026-09-04 晚，v0.2 重建中途收尾）

> 读这份文件的人：下一个接手的 Claude 会话或人类工程师。目标不变：招聘会现场用**真实公网服务 + 真实数据**演示 DataPilot，
> 体现含金量、AI 赋能、AI 监管。唯一的规格权威是 `docs/BUILD-SPEC.md`，任何实现与它冲突以它为准（或同步改它）。

## 1. 现在的状态（收尾时实测）

后端 v0.2（`services/api/datapilot/`）**已重建完成并通过全部门禁**：

| 门禁 | 结果 |
|---|---|
| `.venv/bin/pytest -q` | 243 passed |
| `.venv/bin/ruff check services tests conftest.py scripts` | 通过 |
| `.venv/bin/mypy services/api/datapilot` | 通过（strict，36 个文件） |

已落地的后端能力（对照 BUILD-SPEC）：
- 数据契约 v2（`contracts/policy.py`，兼容 v1），磁盘存储（`storage.py`），后台流水线 + SSE 事件（`pipeline.py`, `api/sse.py`）。
- 契约驱动的通用引擎（`engine/`：解析含 GB18030、列画像、通用检测器 DUP/CAT/SEM/AMB/MISS/FMT/VAL/PHI、敏感遮蔽），任何 CSV 不再崩溃。
- 治理层（`governance.py`）：通用 dry-run / preview / execute、13 项验证、逐格变更账本、`verify_run`、结构化 409。
- AI 层（`ai/`）：官方 anthropic SDK + `claude-opus-5` 结构化输出；三项任务（语义映射、契约起草、发布简报）全部经接地校验；脱敏聚合负载；调用台账；红队 harness；响应缓存。
- 四个样例（`samples/`）：clinical_nlp、ecommerce_orders、hr_roster、**uci_online_retail（真实公开数据，见 `fixtures/uci_online_retail/PROVENANCE.md`）**。
- API v2 全部端点（`api/main.py`），含 `/verify`、`/tamper-test`、`/redteam`、`/ai/contract`、`/artifacts`、`/replay`。

前端 v0.2（`app/`, `lib/`, `components/datapilot/`）**代码已写完，三个门禁在收尾时实测通过**：`npx tsc --noEmit -p tsconfig.json` 无错误、`npm run lint` 通过、`npm run build` 成功。收尾时正在跑的最后一个 gate agent 被中止，它剩余的工作只是 Playwright 截图巡检，未完成也不影响构建。
已落地：工作台 `/`、历史 `/runs`、`/engine`、运行控制台 `/runs/[id]`（三栏 + 底部 API 日志抽屉 + AI 监管栏 + 红队面板 + 篡改测试 + 本地哈希复验）、离线回放 `/demo/clinical-nlp` 重构、共享组件库 `/kit`。旧的营销壳、setTimeout 假进度、chatgpt-auth、service worker、未用的 shadcn 组件都已删除。

**尚未做过一次真实环境端到端联调**：前端从未对着 v0.2 后端跑过。这是下一步的第一件事。

## 2. 未完成清单（按优先级）

1. **重新确认门禁**：收尾时后端集成 agent 被中止（它当时在重写 `docs/SAMPLES.md` 并已重新生成 golden，pytest 243 全绿），下一步先原样跑一遍 `make test`（pytest / ruff / mypy / lint / build），确认仍然全绿，再看 `docs/SAMPLES.md`、`docs/DEMO.md` 里的数字是否与 `fixtures/clinical_nlp/golden/report.json` 一致。
2. **端到端联调**（脚本已备好：`scripts/agents/integration-qa.workflow.js`，也可手工照着做）：
   - 停掉旧 Docker 栈释放端口：`docker compose stop`（它现在还在 8000/3000 上跑旧代码）。
   - 起 API：`DATAPILOT_DATA_DIR=.data DATAPILOT_AI_MODE=auto PYTHONPATH=services/api .venv/bin/uvicorn datapilot.api.main:app --host 127.0.0.1 --port 8000`
   - 起前端：`npm run dev`（3000）。
   - 走完：样例创建 → 事件流 → 发现/AI 信封 → 红队 → 处置 → 变更集 → 应用 → 验证 → 篡改测试 → 本地复验 → 工件/verify。四个样例都走一遍，修类型与字段不一致。
   - `make demo-reset` / `make demo-prewarm` / `scripts/demo_smoke.py` / `scripts/e2e_smoke.mjs` 若缺失按 BUILD-SPEC §12 补。
3. **后端对抗评审**（原计划的三视角评审 + 修复未执行）：不变量与正确性、安全/脱敏/注入、恶意输入与性能（100k 行 < 5 s）。提示词在 `scripts/agents/backend-v2.workflow.js` 的 Review 阶段。
4. **公网就绪改造**（fly.toml 里的环境变量已预留，后端可能尚未实现，需核对 `api/main.py`）：
   `DATAPILOT_PUBLIC_MODE`（按 IP 限流：上传 10/分钟、AI 20/小时）、`DATAPILOT_AI_DAILY_CALL_CAP`（超限走确定性回退并如实标注）、`DATAPILOT_RUN_RETENTION_HOURS`（访客上传 24 小时自动清理，样例预置运行不清理）、`DATAPILOT_SEED_SAMPLES`（启动时预置四个样例运行并预热 AI 缓存）。
   前端：运行时可切换后端地址（`?api=` 查询参数 → localStorage → `NEXT_PUBLIC_API_BASE_URL` → localhost），状态条里加"后端连接"设置；UCI 样例显示"真实公开数据 · CC BY 4.0 · 出处"。
5. **部署到 Fly.io**（账号已登录，`flyctl auth whoami` = franzxu28@gmail.com）：
   - 应用 `datapilotgo-api`（东京 nrt）和 3 GB 卷 `datapilot_data` 已创建，`fly.toml` 已就位。
   - 密钥：`flyctl secrets set ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -a datapilotgo-api --stage`（由人来执行；收尾时尚未确认已设置，用 `flyctl secrets list -a datapilotgo-api` 核对）。
   - 部署：`flyctl deploy -a datapilotgo-api --config fly.toml --dockerfile Dockerfile.api`；然后 `curl https://datapilotgo-api.fly.dev/health`，跑 `scripts/demo_smoke.py` 指向公网地址。
   - 首次部署 Fly 可能要求绑卡，只能由账号所有者操作。
6. **公网前端重新发布**：`datapilotgo.com` 由 OpenAI Sites 托管（项目 ID 见 `.openai/hosting.json`），底层 Cloudflare Workers，目前仍是旧回放版。需在 Sites 里以 `NEXT_PUBLIC_API_BASE_URL=https://datapilotgo-api.fly.dev`（或自定义域 `api.datapilotgo.com`，需在 Namecheap 加 CNAME 并 `flyctl certs add`）重新构建发布。`DATAPILOT_ALLOWED_ORIGINS` 已含 `https://datapilotgo.com`。
7. **文档**：`docs/DEMO.md` 需按 `docs/design-panel-judges.md` 里的"Recommended demo story"重写为 3 分钟现场脚本（每个 AI 节拍两套台词、encore、兜底阶梯、规模问题卡、彩排清单）；README/TASK/PRODUCT 对齐 v0.2；新建 CLAUDE.md。
8. 未提交：工作树有 140+ 处改动，本会话按规则没有提交。建议先 `git add -A && git commit -m "feat: v0.2 rebuild (WIP: frontend gate + e2e pending)"` 再继续。

## 3. 重要事实与坑

- 本机 shell 里有 `ANTHROPIC_API_KEY`；本会话早期一条检查命令曾把它回显到工具输出里，建议轮换。
- 模型 `claude-opus-5`：不能传 `temperature`；结构化输出用 `output_config.format`；已用 `betas=["server-side-fallback-2026-07-01"], fallbacks="default"`，若线上 400 就去掉。
- 红队结果存 `runs/<id>/redteam/`，不进决策状态，`verify` 忽略它。
- 会场网络：Anthropic 不支持中国大陆/香港节点，Fly 用东京；AI 响应按 `input_hash` 缓存（`DATAPILOT_AI_CACHE=fallback|prefer`），样例请求每次相同，`make demo-prewarm` 后断网也能演示且如实标注"缓存"。
- 评委的硬性告诫：不要有任何假动画；浏览器只对下载字节做哈希，不要在浏览器重算 canonical JSON；通用引擎未经证实前，不要在台上邀请陌生 CSV。
- 设计评审四份提案 + 两位评委结论在 `docs/design-panel-judges.md`（提案原文见会话 scratchpad，已丢失也无妨，评委稿已合并要点）。

## 4. 交接提示词（复制到新会话）

```
你在 /Users/franz/Desktop/DataPilot 继续 DataPilot v0.2 的收尾。先读 docs/HANDOFF.md、docs/BUILD-SPEC.md、docs/design-panel-judges.md，
再看 git status。目标：招聘会现场用公网真实服务 + 真实数据集（uci_online_retail）演示，体现含金量、AI 赋能、AI 监管。

按 HANDOFF §2 的顺序做，每步给我一句进度：
1. 让前端三个门禁（tsc / lint / build）全绿。
2. docker compose stop 释放端口，起 v0.2 API 和前端，做真实环境端到端联调（四个样例 + 观测模式 + 契约起草），修所有前后端不一致；补齐 make demo-reset / demo-prewarm / scripts/demo_smoke.py / scripts/e2e_smoke.mjs。
3. 用 scripts/agents/backend-v2.workflow.js 里 Review 阶段的三个视角做后端对抗评审并修复。
4. 实现 fly.toml 里预留的公网就绪环境变量（限流、AI 每日上限、访客运行 24h 清理、启动预置样例与预热）和前端运行时后端地址切换。
5. 部署到 Fly（app datapilotgo-api，已建好卷和 fly.toml；密钥 ANTHROPIC_API_KEY 由我设置，先用 flyctl secrets list 核对），公网 /health 与 demo_smoke 通过后告诉我。
6. 重写 docs/DEMO.md 为 3 分钟现场脚本（评委推荐版），更新 README/TASK/PRODUCT，新建 CLAUDE.md。
7. 给我 OpenAI Sites 重新发布所需的构建参数和步骤（我来操作）。

规则：规格以 BUILD-SPEC 为准；不要有假数据或假动画；AI 元素必须能追溯到台账；不要打印密钥；提交代码前先问我。
```
