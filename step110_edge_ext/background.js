/**
 * Service worker：把 PDF 送进阅读器页面
 *
 * 触发方式：
 *   1. 自动打开（默认开）—— webRequest 看到 application/pdf 响应就重定向过来，
 *      可在工具栏图标右键里关掉
 *   2. 工具栏图标        —— 当前标签页是 PDF 时直接打开
 *   3. 右键菜单          —— 在 PDF 链接 / PDF 页面上
 *
 * 阅读器页面是扩展自己的页面（同源），所以 pdf.js 的 iframe、Worker、wasm
 * 都不需要 web_accessible_resources，只要 CSP 里放开 'wasm-unsafe-eval'。
 */

const READER_PAGE = 'reader/reader.html';
const MENU_LINK = 'eye-care-open-link';
const MENU_PAGE = 'eye-care-open-page';
const MENU_TOGGLE = 'eye-care-toggle-auto';
const AUTO_OPEN_KEY = 'autoOpenPdf';

let autoOpen = true;

// 刚被我们重定向过的 URL。用于让「后退」正常工作 ——
// 否则用户按返回键回到 PDF，内容脚本又立刻把他弹回阅读器，后退键等于失灵。
const recentRedirects = new Map();
// 30 秒：够用户按一次「后退」并停在原生查看器上
const REDIRECT_MEMORY_MS = 30000;

function wasJustRedirected(url) {
	const now = Date.now();
	for (const [k, t] of recentRedirects) {
		if (now - t > REDIRECT_MEMORY_MS) recentRedirects.delete(k);
	}
	return recentRedirects.has(url);
}

function isPdfUrl(url) {
	if (!url) return false;
	try {
		const u = new URL(url);
		if (!['http:', 'https:', 'file:'].includes(u.protocol)) return false;
		return /\.pdf$/i.test(u.pathname) || /[?&]file=.*\.pdf/i.test(u.search);
	}
	catch {
		return false;
	}
}

function readerUrl(pdfUrl) {
	return chrome.runtime.getURL(READER_PAGE)
		+ (pdfUrl ? '?src=' + encodeURIComponent(pdfUrl) : '');
}

function openReader(pdfUrl) {
	chrome.tabs.create({ url: readerUrl(pdfUrl) });
}

// ---------------------------------------------------------------- 菜单

function buildMenus() {
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({
			id: MENU_TOGGLE,
			title: '自动用护眼阅读器打开 PDF',
			type: 'checkbox',
			checked: autoOpen,
			contexts: ['action'],
		});
		chrome.contextMenus.create({
			id: MENU_LINK,
			title: '用护眼阅读器打开',
			contexts: ['link'],
			targetUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*', 'file:///*.pdf'],
		});
		chrome.contextMenus.create({
			id: MENU_PAGE,
			title: '用护眼阅读器打开这个 PDF',
			contexts: ['page'],
			documentUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*', 'file:///*.pdf'],
		});
	});
}

/**
 * 自检：没有 file:// 访问权限的话，本地 PDF 一律看不到，必须明确告诉用户。
 * 这个权限只能由用户在 edge://extensions 里手动打开，代码无法代劳。
 */
function checkFileAccess() {
	chrome.extension.isAllowedFileSchemeAccess((allowed) => {
		if (allowed) {
			chrome.action.setBadgeText({ text: '' });
			chrome.action.setTitle({ title: '用护眼阅读器打开当前 PDF（右键可切换自动打开）' });
			return;
		}
		chrome.action.setBadgeText({ text: '!' });
		chrome.action.setBadgeBackgroundColor({ color: '#D32F2F' });
		chrome.action.setTitle({
			title: '本地 PDF 打不开：请在 edge://extensions 里打开本扩展的'
				+ '「允许访问文件 URL」。（网页 PDF 不受影响）',
		});
	});
}

(async () => {
	const stored = await chrome.storage.local.get(AUTO_OPEN_KEY);
	if (stored[AUTO_OPEN_KEY] !== undefined) {
		autoOpen = stored[AUTO_OPEN_KEY];
	}
	buildMenus();
	checkFileAccess();
})();

// 安装/更新时也重建一次（removeAll 保证不重复）
chrome.runtime.onInstalled.addListener(() => {
	buildMenus();
});

chrome.contextMenus.onClicked.addListener(async (info) => {
	if (info.menuItemId === MENU_TOGGLE) {
		autoOpen = !!info.checked;
		await chrome.storage.local.set({ [AUTO_OPEN_KEY]: autoOpen });
		return;
	}
	const url = info.menuItemId === MENU_LINK ? info.linkUrl : info.pageUrl;
	if (url) openReader(url);
});

// ---------------------------------------------------------------- 自动打开
//
// 为什么不用内容脚本：实测 PDF 页面**不会注入内容脚本** ——
// 在 PDF 标签页上调 chrome.runtime.getContexts() 只返回 BACKGROUND，
// 没有 CONTENT_SCRIPT。而且 PDF 查看器本体是
// chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/edge_pdf/index.html，
// 文档在 OOPIF 里，从外面都够不着。
//
// 改用 webRequest.onHeadersReceived（只读观测，不需要 webRequestBlocking，
// MV3 下允许）：直接看响应头的 Content-Type，比匹配 .pdf 后缀可靠得多 ——
// arxiv.org/pdf/2401.12345 这类没有后缀的链接也能抓到。

// 兜底：按 URL 后缀判断。
// webRequest 对 file:// 完全不触发，而本地 PDF（双击打开、下载后点开）正是
// 最常见的用法，所以必须有一条不依赖响应头的路径。
// 代价是抓不到无后缀的链接 —— 那条路由上面的 webRequest 负责，两者互补。
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (!autoOpen) return;
	const url = changeInfo.url || (changeInfo.status === 'loading' ? tab && tab.url : null);
	if (!url || typeof url !== 'string') return;
	if (url.startsWith('chrome-extension://')) return;
	if (!/\.pdf($|[?#])/i.test(url)) return;
	if (wasJustRedirected(url)) return;
	recentRedirects.set(url, Date.now());
	chrome.tabs.update(tabId, { url: readerUrl(url) });
});

chrome.webRequest.onHeadersReceived.addListener(
	(details) => {
		if (!autoOpen) return;
		if (details.tabId < 0) return;
		if (details.type !== 'main_frame') return;   // 只看主框架，忽略阅读器自己的 fetch

		const headers = details.responseHeaders || [];
		const ct = headers.find((h) => h.name.toLowerCase() === 'content-type');
		if (!ct || !/application\/(x-)?pdf/i.test(ct.value || '')) return;

		// 刚重定向过的不再重定向，否则按「后退」会被立刻弹回来
		if (wasJustRedirected(details.url)) return;
		recentRedirects.set(details.url, Date.now());

		chrome.tabs.update(details.tabId, { url: readerUrl(details.url) });
	},
	{ urls: ['<all_urls>'] },
	['responseHeaders']
);

// ---------------------------------------------------------------- 工具栏图标

chrome.action.onClicked.addListener((tab) => {
	// 当前标签页是 PDF 就直接开；否则开一个空的阅读器页（里面有文件选择器）
	openReader(isPdfUrl(tab && tab.url) ? tab.url : null);
});
