## v0.4.3 修复（仅扩展）

**下载 PDF 不再被拦截。**

以前点一个"下载"链接，会被扩展直接带进阅读器 —— 导航被中止，**文件根本没存到磁盘上**，事后想找回原文件也找不到。

原因：自动打开只检查了响应头的 `Content-Type`，看到 `application/pdf` 就跳，没管 `Content-Disposition`。现在两道闸：

1. **`Content-Disposition: attachment` 直接放行** —— 服务器明确说"这是下载"，就绝不拦
2. 其余情况**延后 250ms 再跳**，跳之前确认标签页还停在这个 URL 上。下载时浏览器会中止导航、标签页留在原来那一页，于是不跳。这样连 `<a download>`、右键「链接另存为」这种没有响应头线索的下载也能区分开，且不需要申请 `downloads` 权限

实测：普通 PDF 照常自动打开；带 `attachment` 的 PDF 标签页不乱跳，文件正常下载到磁盘。

> **桌面版没有变化**，无需重新下载 —— 桌面版本身没有"自动打开 PDF"的行为。需要桌面版的请到 [v0.4.2](https://github.com/qqqqqqqqq1122/zotero-eye-care-reader/releases/tag/v0.4.2)。
>
> 已装扩展的：在 `edge://extensions/` 点一下「重新加载」，版本号变成 0.4.3 即可。

---

## v0.4.2 新增

**选中文字时的批注弹窗，不再盖在正文中间。**

以前它跟着选区跑，正好挡在你正在读的那一行上。现在固定在**窗口右侧、竖直居中**的纸张外空白处。同时加了开关：在 PDF 上**右键** → 「关闭选中弹窗」/「开启选中弹窗」，状态会记住。

![选中弹窗停靠在窗口右侧](https://github.com/qqqqqqqqq1122/zotero-eye-care-reader/raw/main/docs/popup-docked-right.png)

**顺带修复：PDF 上的右键菜单之前根本弹不出来。**

`zotero/reader` 的 web 构建里有一行 `if (this._options.platform === 'web') return;`（`src/pdf/pdf-view.js:3668`），把 PDF 的右键菜单整个禁掉了。本项目用的是 web 构建，所以独立版在 PDF 上右键没有任何反应。现已改为只把**视图对象**的 platform 改掉，不动全局 —— 全局改会波及缩略图、外观面板、批注列表等好几处。

> **扩展用户注意**：右键菜单生效后，它会取代浏览器原生菜单，所以右键不再有「另存为 / 打印 / 检查」。桌面版没有这个问题。

---

## v0.4.1 修复

**侧栏布局不记忆** —— 每次打开 PDF，左侧栏都是默认展开的，不管上次收没收起来。原因是 `sidebarOpen` / `sidebarWidth` / `sidebarView` 三个初始值被硬编码，而对应的变更回调是空实现。现已改为从设置恢复、变更时落盘。

实测：点 `Toggle Sidebar` 收起 → 重启程序 / 重新加载页面 → **侧栏保持收起**。

> 从 v0.4.0 升上来的话，桌面版直接换用新 exe；扩展在 `edge://extensions/` 点一下「重新加载」（版本号显示 0.4.1 即到位）。
> 旧版的批注和主题设置都保留，不受影响。

---

把 [Zotero](https://github.com/zotero/reader) 的阅读器单独拿出来做成的纯 PDF 阅读器 —— 双击即开、支持高亮/墨迹/笔记批注、四套护眼主题，**不复制文件、不建文献库、不依赖 Zotero 桌面端**。

## 换色是真替换像素，不是盖蒙版

主题走 pdf.js 的 `pageColors`：渲染每一页时把背景色和前景色**真正替换掉**。所以

- 正文被画成主题设定的前景色（如 `#26352A`），而不是"黑字透过一层绿膜看"
- **彩色插图保持原样**，不会被一起染绿
- 工具栏、侧栏等界面元素不受影响

像素级验证（画布采样）：桌面版与 Edge 扩展版的直方图**逐字节一致** —— 背景像素 `220,234,216`、文字像素 `38,53,42`，正是主题里定义的那两个值。

## 四套护眼主题

| 名称 | 背景 | 前景 |
|---|---|---|
| 淡豆沙绿 | `#DCEAD8` | `#26352A` |
| 暖米黄 | `#F5E9CE` | `#40372A` |
| 雾蓝灰 | `#E3EBF1` | `#293742` |
| 深灰夜读 | `#252A2E` | `#D7DDD9` |

主题定义取自 [zotero-eye-care](https://github.com/ZhaoPuEE/zotero-eye-care) 插件（作者 ZhaoPuEE）。原插件是 Zotero 应用层扩展，装不进独立程序；这里把它的主题数据原样搬了过来，通过 reader 原生的 `customThemes` 选项注入。

## 附件说明

| 文件 | 说明 |
|---|---|
| `ZoteroReader.exe` | 独立桌面版，双击即用。约 235 MB —— 内含整个 Chromium 运行时（Electron），这是必须的体积 |
| `zotero-eye-care-reader-edge-ext.zip` | Edge 扩展，解压后在 `edge://extensions/` 里「加载解压缩的扩展」 |

## Edge 扩展安装

1. 解压 zip
2. `edge://extensions/` → 打开左下角**「开发人员模式」**
3. **「加载解压缩的扩展」** → 选解压出来的目录
4. **必做**：点扩展的「详细信息」，打开**「允许访问文件 URL」**

第 4 步不能省 —— 不开的话本地 PDF（双击打开、下载后点开）一律不生效，扩展连 `file://` 标签页的 URL 都读不到。网页 PDF 不受影响。缺权限时工具栏图标会显示红色 `!` 徽标。

装好后，在 Edge 里打开 PDF 会**自动**跳转到护眼阅读器。想用 Edge 原生查看器时，在工具栏图标上右键关掉「自动用护眼阅读器打开 PDF」即可。

## 已知限制

- **批注不与 Zotero 同步**。桌面版和扩展各自独立存储，互不相通，也不回写 `zotero.sqlite`
- **标签弹窗未实现**（`onOpenTagsPopup` 是空实现）
- **朗读功能关闭** —— 依赖 Zotero 的 TTS 服务
- **扩展会接管 PDF 下载**。`webRequest` 看到 `Content-Type: application/pdf` 就重定向，所以点 PDF 下载链接也会被带进阅读器。想下载就先关掉自动打开
- **本地 PDF 依赖「允许访问文件 URL」**，这是 Chromium 的权限设计，代码无法代劳

## 许可

**AGPL-3.0**。阅读器部分来自 [zotero/reader](https://github.com/zotero/reader)（AGPL-3.0），未做修改；本项目在其之上提供 Electron 外壳与 Edge 扩展。PDF 渲染由 [pdf.js](https://github.com/mozilla/pdf.js)（Apache-2.0）承担。

若要分发衍生作品，源码需按 AGPL 开放。
