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

// ---------------------------------------------------------------- 启动页（打开历史）

function formatOpenedAt(iso) {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return '';
	const diff = Math.max(0, Date.now() - t);
	const MIN = 60 * 1000;
	if (diff < MIN) return '刚刚';
	if (diff < 60 * MIN) return Math.floor(diff / MIN) + ' 分钟前';
	if (diff < 24 * 60 * MIN) return Math.floor(diff / (60 * MIN)) + ' 小时前';
	if (diff < 7 * 24 * 60 * MIN) return Math.floor(diff / (24 * 60 * MIN)) + ' 天前';
	const d = new Date(t);
	const pad = (n) => String(n).padStart(2, '0');
	return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/**
 * 没有指定 PDF 时显示的启动页：
 * 「打开文件」按钮 + 最近打开列表（存于 userData/recent.json，由主进程维护）。
 * 点历史条目会让主进程 loadDocument() 后整页 reload 进入阅读界面。
 */
async function renderStartScreen() {
	document.title = 'PDF 阅读器';
	document.body.classList.add('zr-start-screen');
	document.body.innerHTML = '';

	const wrap = document.createElement('div');
	wrap.className = 'zr-start';
	const card = document.createElement('div');
	card.className = 'zr-start-card';
	wrap.appendChild(card);

	const title = document.createElement('h1');
	title.textContent = 'PDF 阅读器';

	const openBtn = document.createElement('button');
	openBtn.type = 'button';
	openBtn.className = 'zr-open-btn';
	openBtn.textContent = '打开 PDF 文件…';

	const status = document.createElement('p');
	status.className = 'zr-status';

	const head = document.createElement('div');
	head.className = 'zr-recent-head';
	const headLabel = document.createElement('span');
	headLabel.textContent = '最近打开';
	const clearBtn = document.createElement('button');
	clearBtn.type = 'button';
	clearBtn.className = 'zr-clear-btn';
	clearBtn.textContent = '清空历史';
	head.append(headLabel, clearBtn);

	const list = document.createElement('ul');
	list.className = 'zr-recent-list';

	const hint = document.createElement('p');
	hint.className = 'zr-start-hint';
	hint.textContent = '提示：也可以双击 PDF 文件，或把 PDF 拖到本程序图标上打开。';

	card.append(title, openBtn, status, head, list, hint);

	let lastFiles = [];

	const setStatus = (msg, isError = true) => {
		status.textContent = msg || '';
		status.classList.toggle('zr-status-ok', !!msg && !isError);
		if (msg) setTimeout(() => { if (status.textContent === msg) status.textContent = ''; }, 6000);
	};

	// ---- 历史条目的右键菜单 ----
	let ctxMenu = null;
	const closeCtxMenu = () => {
		if (ctxMenu) {
			ctxMenu.remove();
			ctxMenu = null;
		}
	};
	document.addEventListener('mousedown', (e) => {
		if (ctxMenu && !ctxMenu.contains(e.target)) closeCtxMenu();
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') closeCtxMenu();
	});
	window.addEventListener('blur', closeCtxMenu);
	window.addEventListener('resize', closeCtxMenu);

	const showItemMenu = (x, y, f) => {
		closeCtxMenu();
		const menu = document.createElement('div');
		menu.className = 'zr-ctx-menu';

		const addItem = (label, disabled, action) => {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.textContent = label;
			btn.disabled = !!disabled;
			btn.addEventListener('click', () => {
				closeCtxMenu();
				action();
			});
			menu.appendChild(btn);
		};

		addItem('复制绝对路径', false, async () => {
			const r = await postJSON('/__clipboard', { text: f.path });
			setStatus(r && r.ok ? '已复制绝对路径' : '复制失败', !(r && r.ok));
		});
		addItem('在文件资源管理器中打开', !f.exists, async () => {
			const r = await postJSON('/__showInFolder', { path: f.path });
			if (!r || !r.ok) setStatus('文件不存在或已被移动。');
		});

		const sep = document.createElement('div');
		sep.className = 'zr-ctx-sep';
		menu.appendChild(sep);

		addItem('从历史中移除', false, async () => {
			const r = await postJSON('/__recent', { remove: f.path });
			if (r && r.ok) paint(r.files);
		});

		document.body.appendChild(menu);
		const rect = menu.getBoundingClientRect();
		menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
		menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
		ctxMenu = menu;
	};

	const paint = (files) => {
		lastFiles = Array.isArray(files) ? files : [];
		clearBtn.disabled = !lastFiles.length;
		list.innerHTML = '';

		if (!lastFiles.length) {
			const empty = document.createElement('li');
			empty.className = 'zr-recent-empty';
			empty.textContent = '还没有打开记录。';
			list.appendChild(empty);
			return;
		}

		for (const f of lastFiles) {
			const item = document.createElement('li');
			item.className = 'zr-recent-item' + (f.exists ? '' : ' zr-recent-missing');

			const open = document.createElement('button');
			open.type = 'button';
			open.className = 'zr-recent-open';
			open.disabled = !f.exists;
			if (!f.exists) open.title = '文件不存在或已被移动';

			const name = document.createElement('span');
			name.className = 'zr-recent-name';
			name.textContent = f.name;
			const dir = document.createElement('span');
			dir.className = 'zr-recent-dir';
			dir.textContent = f.exists ? f.dir : '文件不存在 — ' + f.dir;
			open.append(name, dir);

			open.addEventListener('click', async () => {
				open.disabled = true;
				const r = await postJSON('/__open', { path: f.path });
				if (r && r.ok) return;   // 主进程会 reload 页面
				open.disabled = false;
				setStatus('打开失败：文件不存在或已被移动。');
			});

			const time = document.createElement('span');
			time.className = 'zr-recent-time';
			time.textContent = formatOpenedAt(f.openedAt);

			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'zr-recent-remove';
			remove.title = '从历史中移除';
			remove.textContent = '×';
			remove.addEventListener('click', async (e) => {
				e.stopPropagation();
				const r = await postJSON('/__recent', { remove: f.path });
				if (r && r.ok) paint(r.files);
			});

			item.addEventListener('contextmenu', (e) => {
				e.preventDefault();
				e.stopPropagation();
				showItemMenu(e.clientX, e.clientY, f);
			});

			item.append(open, time, remove);
			list.appendChild(item);
		}
	};

	openBtn.addEventListener('click', async () => {
		setStatus('');
		openBtn.disabled = true;
		openBtn.textContent = '正在选择…';
		const r = await postJSON('/__pickFile', {});
		openBtn.disabled = false;
		openBtn.textContent = '打开 PDF 文件…';
		if (r && r.ok) return;   // 主进程会 reload 页面
		if (!r || !r.canceled) setStatus('打开失败，请重试。');
	});

	clearBtn.addEventListener('click', async () => {
		if (!lastFiles.length) return;
		if (!window.confirm('确定清空全部打开历史吗？（不会删除 PDF 文件本身）')) return;
		const r = await postJSON('/__recent', { clear: true });
		if (r && r.ok) paint(r.files);
	});

	document.body.appendChild(wrap);

	const data = await getJSON('/__recent');
	paint(data && data.files);
}

(async function main() {
	if (typeof window.createReader !== 'function') {
		fatal('reader.js 未能加载（window.createReader 不存在）。\n'
			+ '请检查 step010_reader_src/build/web/reader.js 是否存在。');
		return;
	}

	const doc = await getJSON('/__doc');
	if (!doc || !doc.ok) {
		// 启动时没有带 PDF 参数：显示「打开文件 + 最近打开」启动页
		await renderStartScreen();
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

	/**
	 * 让 PDF 上的右键菜单可用。
	 *
	 * src/pdf/pdf-view.js:3668 里有 `if (this._options.platform === 'web') return;`
	 * —— 也就是说 web 构建里 PDF 的右键菜单**根本不弹**。
	 * 而 src/index.web.js 会把 platform 写死成 'web'。
	 * 独立版需要这个菜单（不只为那个开关，单机版右键本身就该有东西）。
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
	// 停靠位置由 index.html 里的 CSS 负责（右侧空白处），这里只管开关
	let popupEnabled = settings.showSelectionPopup !== false;   // 默认开
	document.body.classList.toggle('zr-hide-selection-popup', !popupEnabled);
	const setPopupEnabled = (on) => {
		popupEnabled = on;
		document.body.classList.toggle('zr-hide-selection-popup', !on);
		postJSON('/__settings', { showSelectionPopup: on });
	};

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
							label: '复制绝对路径',
							onCommand: () => postJSON('/__clipboard', { text: doc.path }),
						},
						{
							label: '在文件资源管理器中打开',
							onCommand: () => postJSON('/__showInFolder', { path: doc.path }),
						}],
					],
				});
			},
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
		enablePdfContextMenu(reader);
		window._reader = reader;
		await reader.initializedPromise;
		// 视图可能在这之后才建好，再补一次
		enablePdfContextMenu(reader);
		console.log('[reader] initialized for', doc.path,
			'| annotations:', annotations.length,
			'| eye-care themes:', builtinThemes.length);
	}
	catch (e) {
		fatal('创建阅读器失败。', e);
	}
})();
