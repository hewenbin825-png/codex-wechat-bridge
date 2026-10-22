# Dot 私有接入

目标：官方 Dot 艾莉丝只调度，实际工作进入独立的本机 Codex 会话。接口不提供 Shell、任意文件、微信凭据或通用消息转发工具。

v2.0.0 使用已有本机连接器调用官方 Codex App Tools `create_thread`；当前验收环境中 Dot 原生 `cloud_threads.create` 无类型选择，不作为 Codex 创建的替代。远端 `dispatch_work_chat` 只接受已领取的本人请求 ID，提示词从本机认证微信原文读取，目标固定为独立本机 Codex 聊天，不接受命令、目录、模型或审批覆盖。旧的远端手工绑定工具已移除；真实 threadId 由本机执行器登记。

## 连接边界

- 微信和电脑的已有问答、题号补充、任务号续办及完成通知独立运行。
- 新需求入口为 `/艾莉丝 需求`，也支持 `/dot 需求`。明确题号和任务号不经过模型猜测。
- 接口通过本人私有 Secure MCP Tunnel 使用；只关联本人 Platform 组织和本人 ChatGPT 工作区，不安装到共享工作区，不开放本机控制 API 到公网。
- 隧道使用受限运行密钥，权限仅为 Tunnels Read + Use。长期运行不使用 Admin API Key。
- 签名事件仅投递经挑战验证的 OpenAI HTTPS 回调地址；不跟随重定向，连接时验证并固定公共 DNS 地址。
- 本机代理若将 OpenAI 回调域名解析为 `198.18/15` Fake-IP，只向 Cloudflare 官方 DNS-over-HTTPS 查询该公开主机名，再验证真实公网地址并固定连接；不向 DNS 服务发送路径、消息或密钥，不将 Fake-IP、其他私网地址放入允许列表。

## 安装和启用

1. 安装本机桥接更新，保留现有 `state` 和账号绑定。Dot 默认保持关闭。
2. 从 OpenAI 官方 `openai/tunnel-client/releases/latest` 获取 Windows 客户端，核对官方 SHA-256，将 `tunnel-client.exe` 放入安装目录 `tools/`。
3. 在 Platform 创建本人私有隧道，填写实际组织及 ChatGPT 工作区。创建运行密钥后，在本机可见终端运行 `scripts/start-dot-tunnel.ps1 -TunnelId 实际ID -StoreRuntimeKey`，在隐藏输入处粘贴受限密钥。不要将密钥写在参数、聊天、明文配置、截图或日志中。
4. 启动脚本使用受管理的 `tunnel-client runtimes connect`；随后检查 `runtimes status` 的 running/healthy/ready。密钥由当前用户 Windows DPAPI 保存，profile 只保留环境变量引用。
5. 本机受认证管理 API `POST /api/dot/configure` 接收 `{ "enabled": true }`；此时没有订阅，`ready` 仍为 false。原生 Codex 调度另以 `{ "native_dispatch": true }` 启用，默认关闭；必须有已验证并支持 `create_thread` 的本机 MCP 连接。更新后刷新原微信 MCP 连接，以加载新执行器。
6. 在 ChatGPT 的“添加自定义 MCP 服务器”中选择同一隧道，创建个人插件，确认发现 5 个调度工具和 2 个事件。私有 stdio 目标为安装目录中的 `src/dot-mcp.mjs`；本机控制令牌不会发给 ChatGPT。隧道访问控制由本人组织/工作区绑定及 Tunnel Use 权限承担，不得改为公开无认证端点。
7. 在 Dot 艾莉丝的原生对话中连接此插件，并使用下文的调度指令建立事件订阅。
8. 实测 `/艾莉丝` 创建一次独立工作会话、登记任务号、双端问答和完成通知后，再以 `-RegisterLogon` 启用当前用户登录恢复。该计划任务以普通用户权限持续运行 `-Watch`，每 15 秒检查受管连接，断开时重连同一隧道；不保存 Windows 密码。注册后可在任务计划程序中启动该任务，验证启动终端退出后连接仍保持，再主动停止受管连接验证自动恢复。

脚本只在已有真实隧道 ID 和 DPAPI 运行密钥时建立连接。未配置时明确报告尚未连接。停止/卸载桥接与停用 Dot 订阅分别处理，避免把停止一个工作聊天当成关闭整个 Dot 服务。

`-Watch` 模式下计划任务应保持“正在运行”，不能把一次启动返回 0 当作持续在线证据。临时停止 Dot 时，先停止此守护任务，再停止受管隧道，否则守护会重新连接。登录恢复不等同于 Windows 重启实测；无人登录、休眠或断网时的可用性需另行验收。

本机连接器在服务租约到期前验证官方 App Tools；连接关闭时以原调用聊天身份重新连接，不重新投递已有工作。`dispatch_work_chat` 在本次调用的 15 秒期限内等待短暂断连恢复；期限内一直不可用就返回错误，不遗留之后偷偷执行的工作。已创建但回执不明的任务仍保持 uncertain，不能用重连作为再次创建的理由。

## 交给艾莉丝的指令

> 你是调度者。使用“Dot 艾莉丝微信调度”私有插件订阅 `owner.message.created` 和 `task.completed`。新需求到达时先读取请求，以 `prepare_dispatch` 选择创建或续办并领取请求，再调用 `dispatch_work_chat`。本机执行器只使用本人微信原文，通过官方 Codex 接口创建或续办并登记真实 threadId；不使用 `cloud_threads.create` 替代。返回 pending 时重新读取同一请求状态；uncertain 时先检查 Activity，不能再次新建。不要在调度对话中承担具体实现。工作会话保留自己的上下文与项目目录；你只保留任务表、状态、必要摘要和产物引用。明确的题号/任务号保持原路由。普通问题允许微信和电脑回答，以先到的有效答复为准；执行审批留在 Codex。工作回合结束事件只表示本轮结束，需核对验收结果；现有通知出口已发送摘要，不要重复通知，子智能体完成不通知。

## 验收边界

本地自动测试覆盖身份绑定、订阅验证/续订/停用、密钥轮换、DNS/回调限制、重复事件、开会话领取一次、真实独立根会话登记、工作状态隔离、迟到与重复答案、主任务/子智能体通知边界，以及真实 MCP 子进程。

自动测试使用隔离数据，不代替真实 Dot 订阅、真实微信事件、原生任务创建或 Windows 重启验收。只有远端订阅、实际独立会话与双端问答均验证后，才可宣称端到端接入完成。

官方依据：[MCP Events](https://developers.openai.com/plugins/build/mcp-events)、[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。
