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
