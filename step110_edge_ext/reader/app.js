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

function fatal(msg, detail) {
	document.body.innerHTML = '';
	const box = document.createElement('div');
	box.style.cssText = 'font:14px/1.8 system-ui,"Microsoft YaHei",sans-serif;color:#ddd;'
		+ 'background:#1c1c1e;padding:48px;min-height:100vh;box-sizing:border-box;'
		+ 'white-space:pre-wrap;max-width:820px';
	box.textContent = msg + (detail ? '\n\n' + detail : '');
	document.body.appendChild(box);
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

			// ---- 界面初始状态 ----
			sidebarOpen: true,
			sidebarWidth: 240,
			sidebarView: 'annotations',
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
			onOpenContextMenu: (params) => reader.openContextMenu(params),
			onAddToNote: () => {},
			onOpenTagsPopup: () => {},
			onClosePopup: () => {},
			onOpenLink: (url) => { if (/^https?:/.test(url)) window.open(url, '_blank'); },
			onToggleSidebar: () => {},
			onChangeSidebarWidth: () => {},
			onChangeSidebarView: () => {},
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
		window._reader = reader;
		await reader.initializedPromise;
		console.log('[eye-care-reader] ready | annotations:', (saved.annotations || []).length,
			'| eye-care themes:', builtinThemes.length, '| key:', key);
	}
	catch (e) {
		fatal('创建阅读器失败。', e.stack || String(e));
	}
}

(async function main() {
	const src = new URLSearchParams(location.search).get('src');
	if (!src) {
		landing();
		return;
	}

	let buf;
	try {
		const res = await fetch(src);
		if (!res.ok) throw new Error('HTTP ' + res.status);
		buf = new Uint8Array(await res.arrayBuffer());
	}
	catch (e) {
		fatal('读取 PDF 失败。\n\n' + src, String(e)
			+ '\n\n如果是 file:// 本地文件，需要在 edge://extensions 里'
			+ '为本扩展打开「允许访问文件 URL」。');
		return;
	}

	// 用 location.href 作 base：src 在扩展里总是绝对 URL，但用相对路径测试时
	// new URL(src) 会抛 TypeError，这里统一处理
	let name = src;
	try {
		name = decodeURIComponent(new URL(src, location.href).pathname.split('/').pop() || src);
	}
	catch {}
	await start(buf, await docKey(src), name.replace(/\.[^.]+$/, ''));
})();
