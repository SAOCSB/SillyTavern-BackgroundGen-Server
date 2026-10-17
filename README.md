# SillyTavern 后台生成 · 服务端插件

[SillyTavern-BackgroundGen](https://github.com/SAOCSB/SillyTavern-BackgroundGen) 的服务端部分：浏览器断开（关页面、锁屏、断网）时让生成继续在服务器上跑完，并保存结果供页面续传或事后取回。

> **English:** Server plugin for [SillyTavern-BackgroundGen](https://github.com/SAOCSB/SillyTavern-BackgroundGen). It relays generation requests to SillyTavern's own generate endpoints over loopback (as the same user and session), buffers the response bytes and keeps going when the browser disconnects, so the page can resume by byte offset or collect the result later. No external network access, no extra dependencies.

## 安装

```bash
cd SillyTavern/plugins
git clone https://github.com/SAOCSB/SillyTavern-BackgroundGen-Server
```

在 `config.yaml` 中设置：

```yaml
enableServerPlugins: true
```

重启 SillyTavern，日志出现 `[bg-gen] v1.0.0 ready` 即加载成功。然后安装前端扩展 [SillyTavern-BackgroundGen](https://github.com/SAOCSB/SillyTavern-BackgroundGen)。

如果 `config.yaml` 里 `enableServerPluginsAutoUpdate` 为 `true`（默认值），SillyTavern 每次启动都会自动拉取本插件的更新。

## 它做什么

插件在 `/api/plugins/bg-gen/` 下提供这些接口（都需要登录，并受 SillyTavern 的 CSRF 保护）：

| 接口 | 作用 |
|---|---|
| `POST /start` | 开始一个任务：用当前请求的 Cookie / CSRF 令牌回环调用 SillyTavern 的生成接口，边缓存边把数据流回浏览器 |
| `GET /stream/:id?offset=N` | 从第 N 个字节续传，直到任务结束 |
| `GET /status/:id` | 任务状态、已缓存的字节数 |
| `GET /jobs` | 当前用户待处理的任务（页面关闭后需要补写的回复） |
| `POST /claim/:id` | 由另一个页面接手任务 |
| `POST /ack/:id` | 确认结果已写入聊天，删除缓存 |
| `POST /abort/:id` | 停止任务 |
| `GET /health` | 健康检查 |

## 数据与安全

- 只会转发到 SillyTavern **自己的**生成接口（chat-completions、text-completions、kobold、novelai），请求内容原样转发，不访问任何外部地址。
- 任务按用户隔离，用户只能访问自己的任务。
- 回环请求使用独立的 `http.Agent`：SillyTavern 的私有地址过滤（`privateAddressWhitelist`）会替换全局 Agent，而这里访问的是 SillyTavern 本身。
- 页面关闭后需要补写的结果保存在插件目录的 `data/<用户名>/` 下，写入聊天后立即删除，最长保留 7 天，每个用户最多 40 条。
- 后台辅助请求（例如总结类扩展发起的生成）如果所在页面消失超过 5 分钟，会按原版行为停止，避免浪费额度。
- 单个任务最长运行 3 小时，最多缓存 64 MB。

这些数值都在 `index.mjs` 开头的常量里，可以按需修改。

## 卸载

删除 `plugins/SillyTavern-BackgroundGen-Server` 目录（或把 `enableServerPlugins` 改回 `false`），然后重启 SillyTavern。

## 许可证

[MIT](LICENSE)
