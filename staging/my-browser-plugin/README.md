# my-browser 插件（暂存，未定稿）

这是给 Cindy 做的浏览器插件，**放在这里只是暂存**，等你回头决定怎么归位。
它最终应该进 `makecindy/cindy-official-plugins`（一个插件一个顶层目录 + 在
`provisioning.json` 注册），不属于本仓（cindy 客户端）的任何模块。

**它和你个人那套（`zqchris/skills` 的 `search-gateway` + `chrome-bridge`）是两件事，
互不依赖，也不要合并。** 端口段已经刻意错开，两边可以同时装、同时跑。

## 它是什么

让 agent 用**用户自己日常 Chrome 的登录态**读写网页。

```
用户日常 Chrome（已登录，会话不变）
 └─ 随包 Chrome 扩展（extension/，用户手动 load unpacked 一次）
      ↕ HTTP，仅 127.0.0.1
    插件的 node worker（18810-18819 里挑空闲端口）
      ↕ JSON-RPC
    main.js → Cindy 的 5 个工具
```

为什么是这个形态：现有的自动操作浏览器是独立 profile，与用户日常登录态刻意隔离；
而小红书这类**单点登录**的站点，在独立浏览器里再登一次会把用户日常浏览器的会话
直接踢掉（实际踩过）。装在日常浏览器里的扩展是唯一不产生新会话的形态，也不需要
`--remote-debugging-port`（开那个端口意味着本机任何进程都能读用户全部标签页和 cookie）。

## 权限模型

- **读**（navigate/snapshot/extract/text/tabs）→ 黑名单，默认放行，出厂拦网银/邮箱/
  密码管理器/云控制台
- **交互**（click/type/press/select/hover/scroll）→ 白名单，**默认全站禁止**
- 粒度按站点（注册域 + 子域），不做路径级
- 判不出来一律拒

**搜索算交互**：它要往输入框打字再回车，与"点发送"是同一套 DOM 原语；DOM 上无法
区分一个 button 是"下一页"还是"确认支付"。按原语切，不按语义猜。

## 归位时要做的事

1. 把 `plugin/` 整个搬成 `cindy-official-plugins/my-browser/`
2. 把 `provisioning-entry.json` 的内容并进那边的 `provisioning.json`
3. 跑 `node --test .tests/localization.test.mjs` 和 `.tests/provisioning.test.mjs`
4. commit 要签 DCO；PR 标题 `feat(my-browser): …`

## 状态：已验证 / 未验证

**已验证**
- 官方插件仓的 localization 与 provisioning 门禁通过
- `ghost_forge_pack` 打包通过，插件已实际装入 Cindy
- 插件 id 不能叫 `cindy-browser`——会被宿主判为标识冲突，装入确认框**根本不弹且无
  任何报错**。实测踩到，用改 id 的对照实验证实，所以定为 `my-browser`

**未验证**
- **端到端一次都没跑**：工具调用 → node worker → 扩展 → 真实页面这条链
- 设置页 UI 与 main.js 的 BroadcastChannel 往返

同形态的前身（个人仓那套，固定端口 + Python 服务）实测跑通过读页面、抓结构化数据、
白名单内搜索、策略拒绝路径。核心设计是同一套移植过来的，**但本插件的 worker 是重写的，
不能拿那边的结果当本插件的验证**。

## 已知风险（PR 里要主动写明）

- 扩展持 `<all_urls>`，Chrome 的权限系统不把关，把关的只有 worker 里的策略判定
- 读默认放行 = agent 会读到任意页面内容；交互白名单里的站点能被真正操作。两者叠加，
  **prompt injection 是主要残余攻击面**——网页里藏一句话就可能让 agent 在白名单站上
  动手。白名单加得越宽风险越大
- 2026-07-30 在开发机上出过一次事故：所有 Chrome 标签变成 Error 15、Cindy 被关闭。
  事后查出扩展当时确有缺陷（不回收标签、URL 复用判定失效），但那次的标签数（约 16 个）
  对不上标签爆炸，**真正的触发机制没有查实**。当前版本已修掉那两个缺陷并加了硬上限
  与空闲回收，但这件事在验证充分之前应该记着
