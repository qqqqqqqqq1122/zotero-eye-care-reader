/**
 * 渲染进程：创建 reader 实例
 *
 * reader 的 web 构建（src/index.web.js）暴露 window.createReader(options)，
 * 且不像 dev 构建那样自动实例化，所以这里由我们自己构造。
 *
 * 数据流向：
 *   PDF 字节   ← GET  /__pdf             （主进程读文件）
 *   批注       ↔ GET/POST /__annotations （主进程写 userData/docs/<sha1>.json）
 *   阅读状态   ↔ GET/POST /__state       （同上）
 *   自定义主题 ↔ GET/POST /__themes      （主进程写 userData/settings.json）
 */

const $ = (sel) => document.querySelector(sel);

function fatal(msg, err) {
	document.body.innerHTML = '';
	const box = document.createElement('div');
	box.style.cssText = 'font:14px/1.7 system-ui,sans-serif;color:#ddd;background:#1c1c1e;'
		+ 'padding:40px;height:100vh;box-sizing:border-box;white-space:pre-wrap';
	box.textContent = msg + (err ? '\n\n' + (err.stack || err.message || err) : '');
	document.body.appendChild(box);
}

async function postJSON(url, obj) {
	try {
		const r = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(obj),
		});
		return await r.json();
	}
	catch (e) {
		console.error('POST ' + url + ' failed', e);
		return null;
	}
}

async function getJSON(url) {
	try {
		const r = await fetch(url);
		if (!r.ok) return null;
		return await r.json();
	}
	catch {
		return null;
	}
}

(async function main() {
	if (typeof window.createReader !== 'function') {
		fatal('reader.js 未能加载（window.createReader 不存在）。\n'
			+ '请检查 step010_reader_src/build/web/reader.js 是否存在。');
		return;
	}

	const doc = await getJSON('/__doc');
	if (!doc || !doc.ok) {
		fatal('没有指定要打开的 PDF。\n\n请用「双击 PDF 文件」或「把 PDF 拖到本程序图标上」的方式启动。');
		return;
	}

	let buf, annotations, savedState, settings;
	try {
		const [pdfRes, annJson, stateJson, settingsJson] = await Promise.all([
			fetch('/__pdf'),
			getJSON('/__annotations'),
			getJSON('/__state'),
			getJSON('/__settings'),
		]);
		if (!pdfRes.ok) throw new Error('读取 PDF 失败: HTTP ' + pdfRes.status);
		buf = new Uint8Array(await pdfRes.arrayBuffer());
		annotations = (annJson && annJson.annotations) || [];
		savedState = (stateJson && stateJson.state) || null;
		settings = (settingsJson && settingsJson.settings) || {};
	}
	catch (e) {
		fatal('加载文档失败。', e);
		return;
	}

	// 护眼主题：内置预设 + 用户自己加的主题（去重，预设优先保留原样）
	const builtinThemes = window.EYE_CARE_THEMES || [];
	const userThemes = Array.isArray(settings.themes) ? settings.themes : [];
	const customThemes = [
		...builtinThemes,
		...userThemes.filter(t => !builtinThemes.some(b => b.id === t.id)),
	];

	document.title = doc.title || 'PDF 阅读器';

	try {
		const reader = window.createReader({
			type: 'pdf',
			title: doc.title,
			authorName: '',
			readOnly: false,
			// 独立版没有 Zotero 账号。设 true 是为了不弹登录提示，
			// 并非真的登录了 —— 我们不接任何同步。
			loggedIn: true,

			data: {
				buf,
				url: new URL('/', window.location).toString(),
			},
			annotations,

			// ---- 护眼主题 ----
			customThemes,
			// 恢复上次选中的主题。reader 按系统配色在 light / dark 两个槽里取值，
			// 所以两个都要恢复。不传就是 reader 内置的默认值。
			lightTheme: settings.lightTheme || undefined,
			darkTheme: settings.darkTheme || undefined,

			// ---- 界面初始状态（从设置恢复上次的侧栏布局）----
			sidebarOpen: typeof settings.sidebarOpen === 'boolean' ? settings.sidebarOpen : true,
			sidebarWidth: typeof settings.sidebarWidth === 'number' ? settings.sidebarWidth : 240,
			sidebarView: settings.sidebarView || 'annotations',
			showAnnotations: true,
			bottomPlaceholderHeight: null,
			toolbarPlaceholderWidth: 0,
			primaryViewState: savedState || undefined,

			// ---- 批注持久化 ----
			onSaveAnnotations: (anns) => postJSON('/__annotations', { annotations: anns }),
			onDeleteAnnotations: (ids) => postJSON('/__annotations', { removed: ids }),

			// ---- 阅读状态持久化 ----
			onChangeViewState: (state, primary) => {
				if (primary) postJSON('/__state', { state });
			},

			// ---- 主题持久化 ----
			// 注意：一旦提供了 onSetLightTheme / onSetDarkTheme，reader 就**不再自己调用**
			// setLightTheme / setDarkTheme（见 src/common/reader.js:430-448），
			// 所以这两个回调必须自己完成「应用 + 存盘」两件事，否则表现就是
			// 「换了主题，重开又变回默认」。
			onSetLightTheme: (themeId) => {
				reader.setLightTheme(themeId);
				postJSON('/__settings', { lightTheme: themeId });
			},
			onSetDarkTheme: (themeId) => {
				reader.setDarkTheme(themeId);
				postJSON('/__settings', { darkTheme: themeId });
			},
			onSaveCustomThemes: (all) => postJSON('/__settings', {
				themes: all.filter(t => !builtinThemes.some(b => b.id === t.id)),
			}),

			// ---- 以下回调 reader 会调用，按需接实现 ----
			onOpenContextMenu: (params) => reader.openContextMenu(params),
			onAddToNote: () => {},
			onOpenTagsPopup: () => {},
			onClosePopup: () => {},
			onOpenLink: (url) => {
				if (/^https?:/.test(url)) window.open(url, '_blank');
			},
			// ---- 侧栏布局持久化 ----
			// 注意：这三个回调**不是独占的** —— reader 自己已经应用了变更
			// （见 src/common/reader.js:418-429），宿主只需存盘，不要再调 setSidebarXxx。
			// 另外 onToggleSidebar 的入参可能是 undefined（表示"切换"），
			// 所以以 reader._state 里的实际值为准（_updateState 是同步赋值）。
			onToggleSidebar: () => {
				const actual = reader._state && reader._state.sidebarOpen;
				if (typeof actual === 'boolean') postJSON('/__settings', { sidebarOpen: actual });
			},
			onChangeSidebarWidth: (width) => {
				if (typeof width === 'number') postJSON('/__settings', { sidebarWidth: width });
			},
			onChangeSidebarView: (view) => {
				if (view) postJSON('/__settings', { sidebarView: view });
			},
			onSetDataTransferAnnotations: () => {},
			onConfirm: (_title, text) => window.confirm(text),
			onRotatePages: () => {},
			onDeletePages: () => {},
			onToggleContextPane: () => {},
			onTextSelectionAnnotationModeChange: () => {},

			// 朗读需要 Zotero 的 TTS 服务，独立版关掉
			enableReadAloud: false,
		});

		reader.enableAddToNote(true);
		window._reader = reader;
		await reader.initializedPromise;
		console.log('[reader] initialized for', doc.path,
			'| annotations:', annotations.length,
			'| eye-care themes:', builtinThemes.length);
	}
	catch (e) {
		fatal('创建阅读器失败。', e);
	}
})();
