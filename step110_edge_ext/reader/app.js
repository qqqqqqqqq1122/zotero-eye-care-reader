/**
 * 渲染进程：创建 reader 实例（Edge 扩展版）
 *
 * 与桌面版（step060_app）的区别：
 *   - PDF 来源：fetch(src) 而不是本地 HTTP 端点
 *   - 持久化：chrome.storage.local 而不是写 JSON 文件
 *   - 多了本地文件选择器（扩展页里也能直接开本地 PDF）
 *
 * reader 的 web 构建（src/index.web.js）暴露 window.createReader(options)
 * 且不会自动实例化，所以这里由我们自己构造。
 *
 * 护眼主题通过 reader 原生的 customThemes 选项注入 ——
 * 这条路和桌面版完全一致，走的是 pdf.js 的 pageColors，是真换色不是盖蒙版。
 */

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- 存储层
// 优先用 chrome.storage.local（扩展环境）；
// 没有就退回 localStorage —— 这样可以用本地 HTTP 服务直接测，不必先装扩展。

const storage = {
	async get(key, fallback) {
		if (globalThis.chrome && chrome.storage && chrome.storage.local) {
			const o = await chrome.storage.local.get(key);
			return o[key] !== undefined ? o[key] : fallback;
		}
		try {
			const raw = localStorage.getItem(key);
			return raw ? JSON.parse(raw) : fallback;
		}
		catch {
			return fallback;
		}
	},
	async set(key, value) {
		if (globalThis.chrome && chrome.storage && chrome.storage.local) {
			await chrome.storage.local.set({ [key]: value });
			return;
		}
		try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
	},
};

/**
 * 合并写入全局设置。
 * applySlot 非空时顺便把主题应用到 reader —— 因为提供了 onSet*Theme 回调后，
 * reader 自己就不调 setLightTheme/setDarkTheme 了。
 */
async function patchSettings(patch, reader, applySlot) {
	const cur = await storage.get('settings', {});
	await storage.set('settings', Object.assign({}, cur, patch));
	if (!reader || !applySlot) return;
	if (applySlot === 'light') reader.setLightTheme(patch.lightTheme);
	else reader.setDarkTheme(patch.darkTheme);
}

async function docKey(src) {
	const data = new TextEncoder().encode(src);
	const digest = await crypto.subtle.digest('SHA-1', data);
	const hex = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0')).join('');
	return 'doc:' + hex;
}

// ---------------------------------------------------------------- 界面

function fatal(msg, detail, buttons) {
	document.body.innerHTML = '';
	const box = document.createElement('div');
	box.style.cssText = 'font:14px/1.8 system-ui,"Microsoft YaHei",sans-serif;color:#ddd;'
		+ 'background:#1c1c1e;padding:48px;min-height:100vh;box-sizing:border-box;'
		+ 'white-space:pre-wrap;max-width:820px';
	box.textContent = msg + (detail ? '\n\n' + detail : '');
	document.body.appendChild(box);

	// 出错时给几个可点的出口，别让用户对着一段死文字发呆
	if (Array.isArray(buttons) && buttons.length) {
		const row = document.createElement('div');
		row.style.cssText = 'margin-top:24px;display:flex;gap:12px;flex-wrap:wrap';
		for (const { label, onClick } of buttons) {
			const b = document.createElement('button');
			b.textContent = label;
			b.style.cssText = 'font:14px system-ui,"Microsoft YaHei",sans-serif;'
				+ 'padding:8px 16px;border-radius:8px;border:1px solid #555;'
				+ 'background:#2a2a2e;color:#e5e5e5;cursor:pointer;white-space:normal';
			b.addEventListener('click', onClick);
			row.appendChild(b);
		}
		box.appendChild(row);
	}
}

function landing() {
	document.body.innerHTML = '';
	const box = document.createElement('div');
	box.style.cssText = 'font:14px/2 system-ui,"Microsoft YaHei",sans-serif;color:#ddd;'
		+ 'background:#1c1c1e;padding:64px;min-height:100vh;box-sizing:border-box';
	box.innerHTML = '<h2 style="margin:0 0 8px;font-weight:600">护眼 PDF 阅读器</h2>'
		+ '<p style="color:#999;margin:0 0 28px">没有指定要打开的 PDF。</p>'
		+ '<p style="color:#999;margin:0 0 28px">用法：在 PDF 页面上点工具栏图标，'
		+ '或在 PDF 链接上右键选「用护眼阅读器打开」。</p>'
		+ '<p style="color:#999;margin:0 0 28px">打开 PDF 后在正文上右键，'
		+ '可「复制绝对路径 / 复制链接」或「在文件资源管理器中打开」。'
		+ '本地 PDF 的后者需要先运行桌面版目录里的 Register-PdfAssociation.cmd 注册协议。</p>'
		+ '<p style="margin:0 0 12px">或者直接选一个本地文件：</p>';

	const input = document.createElement('input');
	input.type = 'file';
	input.accept = 'application/pdf,.pdf';
	input.style.cssText = 'font-size:14px;color:#ddd';
	input.addEventListener('change', async () => {
		const f = input.files && input.files[0];
		if (!f) return;
		const buf = new Uint8Array(await f.arrayBuffer());
		// 本地文件用文件名做键（file:// 或 blob 都拿不到稳定路径）
		await start(buf, 'local:' + f.name, f.name.replace(/\.[^.]+$/, ''));
	});

	box.appendChild(input);
	document.body.appendChild(box);
}

// ---------------------------------------------------------------- 主流程

function buildReaderCallbacks(key) {
	const saveDoc = async (patch) => {
		const cur = await storage.get(key, {});
		await storage.set(key, Object.assign({}, cur, patch, {
			updatedAt: new Date().toISOString(),
		}));
	};

	return {
		onSaveAnnotations: async (annotations) => {
			const cur = await storage.get(key, { annotations: [] });
			const map = new Map((cur.annotations || []).map((a) => [a.id, a]));
			for (const a of annotations) map.set(a.id, a);
			await saveDoc({ annotations: Array.from(map.values()) });
		},
		onDeleteAnnotations: async (ids) => {
			const cur = await storage.get(key, { annotations: [] });
			const drop = new Set(ids);
			await saveDoc({ annotations: (cur.annotations || []).filter((a) => !drop.has(a.id)) });
		},
		onChangeViewState: async (state, primary) => {
			if (primary) await saveDoc({ state });
		},
	};
}

// ---------------------------------------------------------------- 下载当前 PDF
// 自动打开会把"点下载链接"这种情况也带进阅读器，所以给阅读器配一个下载按钮兜底：
// 文件随时能存下来，不用担心原来那一下下载丢了。

let pdfBytes = null;
let pdfFileName = 'document.pdf';
let sourceUrl = null;   // reader 页面 ?src= 的原始地址（file:// 或 http(s)://）
let toastTimer = null;

// ---------------------------------------------------------------- 右键：复制路径 / 在资源管理器中打开
//
// Chromium 扩展没有权限直接启动 explorer.exe，所以本地文件走桌面版注册的
// zoteroreader:// 协议（Register-PdfAssociation.cmd 注册），由桌面版调用
// shell.showItemInFolder。网页 PDF 则先下载，再用 downloads.show 在资源管理器里显示。

function isLocalSource() {
	return typeof sourceUrl === 'string' && sourceUrl.startsWith('file:');
}

/** file:///D:/a/b.pdf → D:\a\b.pdf；file://server/share/a.pdf → \\server\share\a.pdf */
function windowsPathFromFileUrl(src) {
	try {
		const u = new URL(src);
		if (u.protocol !== 'file:') return null;
		let p = decodeURIComponent(u.pathname);
		if (u.host) {
			return '\\\\' + u.host + p.replace(/\//g, '\\');
		}
		if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
		return p.replace(/\//g, '\\');
	}
	catch {
		return null;
	}
}

function toast(msg) {
	let el = document.getElementById('zrToast');
	if (!el) {
		el = document.createElement('div');
		el.id = 'zrToast';
		el.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:99999;'
			+ 'max-width:420px;padding:10px 14px;border-radius:10px;'
			+ 'background:rgba(40,40,46,.97);color:#eaeaea;border:1px solid #3a3a42;'
			+ 'font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;'
			+ 'box-shadow:0 8px 24px rgba(0,0,0,.45);opacity:0;'
			+ 'transition:opacity .15s;pointer-events:none;white-space:pre-wrap';
		document.body.appendChild(el);
	}
	el.textContent = msg;
	el.style.opacity = '1';
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 5000);
}

async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	}
	catch {}
	try {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.style.cssText = 'position:fixed;left:-9999px;top:0';
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand('copy');
		ta.remove();
		return ok;
	}
	catch {
		return false;
	}
}

async function copySourcePath() {
	const text = isLocalSource()
		? (windowsPathFromFileUrl(sourceUrl) || sourceUrl)
		: sourceUrl;
	if (!text) {
		toast('没有可复制的路径。');
		return;
	}
	const ok = await copyText(text);
	toast(ok ? '已复制：' + text : '复制失败，请手动选择路径。');
}

function openInExplorer() {
	if (isLocalSource()) {
		const p = windowsPathFromFileUrl(sourceUrl);
		if (!p) {
			toast('无法解析本地文件路径。');
			return;
		}
		// 交给桌面版处理；桌面版没注册协议时浏览器不会有反应
		const a = document.createElement('a');
		a.href = 'zoteroreader://show?path=' + encodeURIComponent(p);
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		a.remove();
		toast('已请求在资源管理器中打开。\n若没反应，请先运行桌面版的 Register-PdfAssociation.cmd 注册协议。');
		return;
	}

	// 网页 PDF：下载后用浏览器的 downloads.show 在资源管理器中显示
	if (!(globalThis.chrome && chrome.downloads && chrome.downloads.download)) {
		toast('当前环境不支持下载，无法定位文件。');
		return;
	}
	chrome.downloads.download({ url: sourceUrl, saveAs: false }, (id) => {
		if (chrome.runtime.lastError || id === undefined) {
			toast('下载失败：' + (chrome.runtime.lastError && chrome.runtime.lastError.message || '未知错误'));
			return;
		}
		toast('正在下载，随后会在资源管理器中显示…');
		// 给下载一点时间把目标文件建出来，再让资源管理器定位它
		setTimeout(() => {
			try { chrome.downloads.show(id); } catch (e) { toast('无法在资源管理器中显示：' + e.message); }
		}, 600);
	});
}

function downloadCurrentPdf() {
	if (!pdfBytes) return;
	const blob = new Blob([pdfBytes], { type: 'application/pdf' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = pdfFileName;
	document.body.appendChild(a);
	a.click();
	a.remove();
	// 稍后再回收，给浏览器留出开始下载的时间
	setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const DOWNLOAD_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" '
	+ 'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">'
	+ '<path d="M8 2.5v7.5"/><path d="M4.6 7.2 8 10.6l3.4-3.4"/><path d="M2.8 13.2h10.4"/></svg>';

/**
 * 往工具栏里插一个下载按钮。
 *
 * 工具栏是 React 渲染的，往里塞原生节点属于"非受控"操作 ——
 * React 一般不清理它不认识的节点，但状态变化时有可能被挤掉，
 * 所以挂一个 MutationObserver 兜底，发现不在了就补回去。
 */
function injectDownloadButton() {
	const anchor = document.getElementById('sidebarToggle');
	const bar = anchor && anchor.parentElement;
	if (!bar) return;
	if (document.getElementById('zrDownload')) return;

	const btn = document.createElement('button');
	btn.id = 'zrDownload';
	btn.className = 'toolbar-button';
	btn.title = '下载此 PDF';
	btn.tabIndex = -1;
	btn.innerHTML = DOWNLOAD_ICON;
	btn.addEventListener('click', downloadCurrentPdf);
	bar.appendChild(btn);
}

function watchDownloadButton() {
	injectDownloadButton();
	new MutationObserver(injectDownloadButton).observe(document.body, {
		childList: true,
		subtree: true,
	});
}

async function start(buf, key, title) {
	if (typeof window.createReader !== 'function') {
		fatal('reader.js 未能加载（window.createReader 不存在）。',
			'请检查扩展的 reader/reader.js 是否存在。');
		return;
	}

	const saved = await storage.get(key, { annotations: [], state: null });
	// 主题相关是全局设置（不随文档走），和阅读状态分开存
	const settings = await storage.get('settings', {});

	const builtinThemes = window.EYE_CARE_THEMES || [];
	const userThemes = Array.isArray(settings.themes) ? settings.themes : [];
	const customThemes = [
		...builtinThemes,
		...userThemes.filter((t) => !builtinThemes.some((b) => b.id === t.id)),
	];

	document.title = title || '护眼 PDF 阅读器';

	/**
	 * 让 PDF 上的右键菜单可用。
	 *
	 * src/pdf/pdf-view.js:3668 里有 `if (this._options.platform === 'web') return;`
	 * —— 也就是说 web 构建里 PDF 的右键菜单**根本不弹**。
	 * 而 src/index.web.js 会把 platform 写死成 'web'。
	 *
	 * 只改视图对象的 _options.platform，不动全局 platform ——
	 * 全局改会波及缩略图、外观面板、批注列表等好几处 platform === 'web' 的分支。
	 */
	function enablePdfContextMenu(r) {
		for (const v of (r._views || [])) {
			if (v && v._options && v._options.platform === 'web') {
				v._options.platform = 'electron';
			}
		}
	}

	// ---- 选中弹窗开关 ----
	// 停靠位置由 reader.html 里的 CSS 负责（右侧空白处），这里只管开关
	let popupEnabled = settings.showSelectionPopup !== false;   // 默认开
	document.body.classList.toggle('zr-hide-selection-popup', !popupEnabled);
	const setPopupEnabled = (on) => {
		popupEnabled = on;
		document.body.classList.toggle('zr-hide-selection-popup', !on);
		patchSettings({ showSelectionPopup: on });
	};

	const callbacks = buildReaderCallbacks(key);

	try {
		const reader = window.createReader({
			type: 'pdf',
			title: title || '',
			authorName: '',
			readOnly: false,
			// 独立版没有 Zotero 账号。设 true 只为不弹登录提示，不接任何同步。
			loggedIn: true,

			data: { buf },
			annotations: saved.annotations || [],

			// ---- 护眼主题（走 pdf.js pageColors，真换色）----
			customThemes,
			// 恢复上次选中的主题。reader 按系统配色在 light / dark 两个槽里取值，
			// 所以两个都要恢复；不传就是内置默认值。
			lightTheme: settings.lightTheme || undefined,
			darkTheme: settings.darkTheme || undefined,

			// ---- 界面初始状态（从设置恢复上次的侧栏布局）----
			sidebarOpen: typeof settings.sidebarOpen === 'boolean' ? settings.sidebarOpen : true,
			sidebarWidth: typeof settings.sidebarWidth === 'number' ? settings.sidebarWidth : 240,
			sidebarView: settings.sidebarView || 'annotations',
			showAnnotations: true,
			bottomPlaceholderHeight: null,
			toolbarPlaceholderWidth: 0,
			primaryViewState: saved.state || undefined,

			onSaveAnnotations: callbacks.onSaveAnnotations,
			onDeleteAnnotations: callbacks.onDeleteAnnotations,
			onChangeViewState: callbacks.onChangeViewState,
			// 一旦提供了 onSetLightTheme / onSetDarkTheme，reader 就不再自己调用
			// setLightTheme / setDarkTheme（见 src/common/reader.js:430-448），
			// 所以这两个回调必须自己「应用 + 存盘」，否则换了主题重开就变回默认。
			onSetLightTheme: (themeId) => patchSettings({ lightTheme: themeId }, reader, 'light'),
			onSetDarkTheme: (themeId) => patchSettings({ darkTheme: themeId }, reader, 'dark'),
			onSaveCustomThemes: (all) => patchSettings({
				themes: all.filter((t) => !builtinThemes.some((b) => b.id === t.id)),
			}),

			// ---- reader 会调用这些回调，按需接实现 ----
			// reader 的各类右键菜单都分发到这里，我们在末尾补一项来开关选中弹窗。
			// 跳过 internal 菜单（颜色选择器那种小浮层，塞进去会很怪）。
			onOpenContextMenu: (params) => {
				if (params.internal || !Array.isArray(params.itemGroups)) {
					return reader.openContextMenu(params);
				}
				return reader.openContextMenu({
					...params,
					itemGroups: [
						...params.itemGroups,
						[{
							label: popupEnabled ? '关闭选中弹窗' : '开启选中弹窗',
							onCommand: () => setPopupEnabled(!popupEnabled),
						}],
						[{
							label: isLocalSource() ? '复制绝对路径' : '复制链接',
							onCommand: () => copySourcePath(),
						},
						{
							label: '在文件资源管理器中打开',
							onCommand: () => openInExplorer(),
						}],
					],
				});
			},
			onAddToNote: () => {},
			onOpenTagsPopup: () => {},
			onClosePopup: () => {},
			onOpenLink: (url) => { if (/^https?:/.test(url)) window.open(url, '_blank'); },
			// ---- 侧栏布局持久化 ----
			// 这三个回调**不是独占的** —— reader 自己已经应用了变更
			// （见 src/common/reader.js:418-429），宿主只需存盘，不要再调 setSidebarXxx。
			// 另外 onToggleSidebar 的入参可能是 undefined（表示"切换"），
			// 所以以 reader._state 里的实际值为准（_updateState 是同步赋值）。
			onToggleSidebar: () => {
				const actual = reader._state && reader._state.sidebarOpen;
				if (typeof actual === 'boolean') patchSettings({ sidebarOpen: actual });
			},
			onChangeSidebarWidth: (width) => {
				if (typeof width === 'number') patchSettings({ sidebarWidth: width });
			},
			onChangeSidebarView: (view) => {
				if (view) patchSettings({ sidebarView: view });
			},
			onSetDataTransferAnnotations: () => {},
			onConfirm: (_t, text) => window.confirm(text),
			onRotatePages: () => {},
			onDeletePages: () => {},
			onToggleContextPane: () => {},
			onTextSelectionAnnotationModeChange: () => {},

			// 朗读依赖 Zotero 的 TTS 服务，独立版关掉
			enableReadAloud: false,
		});

		reader.enableAddToNote(true);
		enablePdfContextMenu(reader);
		window._reader = reader;
		// 放在 await 之前 —— initializedPromise 在某些时序下不 resolve，
		// 放后面会导致按钮永远插不上。MutationObserver 会自己等到工具栏渲染出来。
		watchDownloadButton();
		await reader.initializedPromise;
		// 视图可能在这之后才建好，再补一次
		enablePdfContextMenu(reader);
		console.log('[eye-care-reader] ready | annotations:', (saved.annotations || []).length,
			'| eye-care themes:', builtinThemes.length, '| key:', key);
	}
	catch (e) {
		fatal('创建阅读器失败。', e.stack || String(e));
	}
}

// ---------------------------------------------------------------- 取 PDF 字节
//
// 有的站点会在 PDF 前面挡一层人机验证。econstor.eu 用的是 Anubis
// （techaro.lol）：对浏览器 UA 返回一张 HTML 验证页，页面里的脚本要做一次
// SHA-256 工作量证明，再请求 pass-challenge 换 cookie，最后 302 到真正的 PDF。
//
// 扩展里的 fetch 不会执行对方页面里的脚本，直接拿只能拿到那张验证页 ——
// 这就是「跳进阅读器后什么都不显示」的根因。下面按 Anubis 公开的算法
// （static/js/main.mjs 与 worker/sha256-*.mjs）自己解一遍。
//
// credentials: 'include' 不能省：验证用的 cookie 是
// SameSite=None; Secure; Partitioned 的跨站分区 cookie，
// fetch 默认的 same-origin 模式既不会接收、也不会发送它。

const ANUBIS_PASS_PATH = '/.within.website/x/cmd/anubis/api/pass-challenge';
const ANUBIS_MAX_NONCE = 20000000;

function isPdfBytes(buf) {
	// PDF 规范允许 %PDF- 前面有少量垃圾字节，所以扫前 1 KiB
	const head = buf.subarray(0, Math.min(buf.length, 1024));
	for (let i = 0; i + 5 <= head.length; i++) {
		if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44
			&& head[i + 3] === 0x46 && head[i + 4] === 0x2D) return true;
	}
	return false;
}

/** 从 Anubis 验证页里取出挑战参数；不是验证页就返回 null */
function parseAnubisChallenge(html) {
	let doc;
	try {
		doc = new DOMParser().parseFromString(html, 'text/html');
	}
	catch {
		return null;
	}
	const el = doc.getElementById('anubis_challenge');
	if (!el) return null;

	let data;
	try {
		data = JSON.parse(el.textContent || '{}');
	}
	catch {
		return null;
	}
	if (!data.challenge || !data.challenge.randomData || !data.rules) return null;

	// base prefix 一般为空字符串；子路径部署时才非空
	let prefix = '';
	const prefixEl = doc.getElementById('anubis_base_prefix');
	if (prefixEl) {
		try { prefix = JSON.parse(prefixEl.textContent || '""') || ''; } catch {}
	}
	return { challenge: data.challenge, rules: data.rules, prefix: String(prefix) };
}

async function sha256Hex(text) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Anubis 的 fast 算法：从 nonce = 0 递增，
 * 找 sha256(randomData + nonce) 的十六进制前 difficulty 位全为 0。
 * 难度 2 时平均只要 256 次，几毫秒。
 */
async function solveAnubisPoW(randomData, difficulty, onProgress) {
	for (let nonce = 0; nonce <= ANUBIS_MAX_NONCE; nonce++) {
		const hash = await sha256Hex(randomData + nonce);
		if (hash.startsWith('0'.repeat(difficulty))) return { nonce, hash };
		if ((nonce & 1023) === 1023 && onProgress) onProgress(nonce);
	}
	return null;
}

/** 解挑战并换取 PDF；失败返回 null */
async function passAnubis({ challenge, rules, prefix }, redirectUrl, onProgress) {
	const difficulty = Number(rules.difficulty);
	if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 6) return null;

	const started = Date.now();
	const solved = await solveAnubisPoW(
		String(challenge.randomData), difficulty,
		(step) => onProgress && onProgress(step),
	);
	if (!solved) return null;

	const passUrl = new URL((prefix || '') + ANUBIS_PASS_PATH, redirectUrl);
	passUrl.searchParams.set('id', String(challenge.id));
	passUrl.searchParams.set('response', solved.hash);
	passUrl.searchParams.set('nonce', String(solved.nonce));
	passUrl.searchParams.set('redir', redirectUrl);
	passUrl.searchParams.set('elapsedTime', String(Math.max(1, Date.now() - started)));

	// 302 会带着刚换到的 cookie 跳到 redirectUrl，fetch 自动跟随，
	// 正常情况下拿到的就是 PDF 本身。
	const res = await fetch(passUrl.href, { credentials: 'include', redirect: 'follow' });
	if (!res.ok) return null;
	return new Uint8Array(await res.arrayBuffer());
}

function showStatus(msg) {
	let el = document.getElementById('zrStatus');
	if (!el) {
		el = document.createElement('div');
		el.id = 'zrStatus';
		el.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;'
			+ 'justify-content:center;font:15px/1.8 system-ui,"Microsoft YaHei",sans-serif;'
			+ 'color:#bbb;background:#1c1c1e;z-index:9999;white-space:pre-wrap;'
			+ 'text-align:center;padding:24px;box-sizing:border-box';
		document.body.appendChild(el);
	}
	el.textContent = msg;
}

function hideStatus() {
	const el = document.getElementById('zrStatus');
	if (el) el.remove();
}

/** 读取 URL 并返回 { buf, url }；能自动过 Anubis 人机验证 */
async function fetchPdf(url) {
	const res = await fetch(url, { credentials: 'include' });
	const finalUrl = res.url || url;

	// 先读 body 再判断状态码：有的 Anubis 部署会用 403 返回验证页
	let buf = new Uint8Array(await res.arrayBuffer());
	if (isPdfBytes(buf)) return { buf, url: finalUrl };

	// 不是 PDF —— 先看看是不是 Anubis 的人机验证页
	const html = new TextDecoder('utf-8').decode(buf);
	const anubis = parseAnubisChallenge(html);
	if (anubis) {
		showStatus('该网站启用了人机验证（Anubis），正在自动完成验证…');
		try {
			const passed = await passAnubis(anubis, finalUrl, (step) => {
				showStatus('该网站启用了人机验证（Anubis），正在自动完成验证…\n'
					+ '已计算 ' + step.toLocaleString() + ' 次');
			});
			if (passed && isPdfBytes(passed)) return { buf: passed, url: finalUrl };
		}
		finally {
			hideStatus();
		}
		const err = new Error('这个网站的人机验证没有通过。'
			+ '\n\n可以点「在普通标签页打开」，让浏览器自己完成验证；'
			+ '验证成功看到 PDF 后，回到这个标签页点「已通过验证，重试」。');
		err.openNatively = finalUrl;
		err.retryable = true;
		throw err;
	}

	const type = res.headers.get('content-type') || '未知类型';
	const err = new Error((res.ok ? '服务器返回的不是 PDF' : '服务器返回 HTTP ' + res.status)
		+ '（Content-Type: ' + type + '）。'
		+ '\n\n这个链接需要浏览器自己处理站点的人机验证、登录或下载确认，'
		+ '扩展里的请求过不去。');
	err.openNatively = finalUrl;
	err.retryable = true;
	throw err;
}

/**
 * 把当前标签页交还给浏览器，让站点自己的人机验证 / 登录流程接管。
 *
 * 用同一个标签页，不新开：少一步、也不把用户的注意力引到别处。
 * 导航前先请后台放行这个 URL，否则一跳到 .pdf 又会被自动打开逻辑弹回阅读器。
 */
async function handBackToBrowser(url, delayMs = 0) {
	try {
		await chrome.runtime.sendMessage({ type: 'eye-care-allow-url', url });
	}
	catch {}
	if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
	location.href = url;
}

(async function main() {
	const src = new URLSearchParams(location.search).get('src');
	if (!src) {
		landing();
		return;
	}

	let buf;
	let finalUrl = src;
	try {
		({ buf, url: finalUrl } = await fetchPdf(src));
	}
	catch (e) {
		const target = (e && e.openNatively) || src;

		// 站点挡了人机验证 / 登录 / 下载确认页：扩展里的 fetch 过不去。
		// 直接把当前标签页交还给浏览器，不要求用户再点一次按钮。
		if (e && e.retryable) {
			showStatus('这个链接需要浏览器自己处理（站点要求人机验证、登录或下载确认）。\n\n'
				+ '正在转到原页面，请按站点提示操作…');
			await handBackToBrowser(target, 1200);
			return;
		}

		const isFile = /^file:/i.test(src);
		fatal('读取 PDF 失败。\n\n' + src,
			(e && (e.message || String(e)))
				+ (isFile ? '\n\n如果是 file:// 本地文件，需要在 edge://extensions 里'
					+ '为本扩展打开「允许访问文件 URL」。' : ''),
			[{
				label: '在普通标签页打开',
				onClick: () => handBackToBrowser(target),
			}]);
		return;
	}

	// 用 location.href 作 base：src 在扩展里总是绝对 URL，但用相对路径测试时
	// new URL(src) 会抛 TypeError，这里统一处理
	let name = src;
	try {
		name = decodeURIComponent(new URL(src, location.href).pathname.split('/').pop() || src);
	}
	catch {}

	// 留给工具栏里的下载按钮和右键菜单用。
	// 用 finalUrl 而不是 src：Anubis 这类站点验证前后地址可能不同。
	sourceUrl = finalUrl;
	pdfBytes = buf;
	pdfFileName = /\.pdf$/i.test(name) ? name : name + '.pdf';

	await start(buf, await docKey(src), name.replace(/\.[^.]+$/, ''));
})();
