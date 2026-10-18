/**
 * 独立 PDF 阅读器 —— Electron 主进程
 *
 * 由 Zotero 的 reader (github.com/zotero/reader) 提供阅读 UI，
 * 本文件只负责：命令行取 PDF 路径、起本地 HTTP 服务、批注持久化。
 *
 * 用本地 HTTP 而不是 file:// 的原因：
 *   reader 的 PDF 视图通过 iframe 加载 'pdf/web/viewer.html'（相对路径），
 *   并用 ES module / Worker / wasm，file:// 下会被同源策略和 Worker 限制挡住。
 *
 * 多窗口：每个窗口有自己的一套 { BrowserWindow, HTTP server, currentDoc }，
 * 互不干扰。双击新的 PDF、菜单「打开…」「最近打开」都会新开一个窗口，
 * 已经打开的文档保持不动。
 */

const { app, BrowserWindow, Menu, clipboard, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

// reader 构建产物的查找顺序：
//   1. reader-build/            —— 打包后（由 step080 复制进来）
//   2. ../step010_reader_src/build/web —— 开发时直接用构建输出
const READER_BUILD_CANDIDATES = [
	path.join(__dirname, 'reader-build'),
	path.resolve(__dirname, '..', 'step010_reader_src', 'build', 'web'),
];
const READER_BUILD = READER_BUILD_CANDIDATES.find((p) => fs.existsSync(path.join(p, 'reader.js')))
	|| READER_BUILD_CANDIDATES[0];
const RENDERER_DIR = path.join(__dirname, 'renderer');

/** 每个窗口一个上下文：{ win, server, port, doc } */
let windows = [];

// ---------------------------------------------------------------- 工具

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.wasm': 'application/wasm',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.gif': 'image/gif',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.pfb': 'application/octet-stream',
	'.bcmap': 'application/octet-stream',
	'.icc': 'application/octet-stream',
	'.pdf': 'application/pdf',
	'.epub': 'application/epub+zip',
	'.txt': 'text/plain; charset=utf-8',
};

function mimeFor(file) {
	return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** 阅读器把每个 PDF 的批注/阅读状态存在 userData/docs/<sha1>.json */
function sidecarPath(pdfPath) {
	const key = crypto.createHash('sha1').update(path.resolve(pdfPath).toLowerCase()).digest('hex');
	return { key, file: path.join(app.getPath('userData'), 'docs', key + '.json') };
}

function readSidecar(pdfPath) {
	const { key, file } = sidecarPath(pdfPath);
	try {
		const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
		return { key, annotations: raw.annotations || [], state: raw.state || null };
	}
	catch {
		return { key, annotations: [], state: null };
	}
}

function writeSidecar(pdfPath, patch) {
	const { file } = sidecarPath(pdfPath);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	let cur = {};
	try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
	const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
	fs.writeFileSync(file, JSON.stringify(next, null, '\t'), 'utf8');
	return next;
}

/** 全局设置（自定义主题 + 当前选中的主题）存在 userData/settings.json */
function settingsPath() {
	return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
	try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
	catch { return {}; }
}

function writeSettings(patch) {
	const file = settingsPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const next = { ...readSettings(), ...patch };
	fs.writeFileSync(file, JSON.stringify(next, null, '\t'), 'utf8');
	return next;
}

// ---------------------------------------------------------------- 打开历史

/** 最近打开列表存在 userData/recent.json，最新的排在最前面 */
const RECENT_MAX = 30;

function recentPath() {
	return path.join(app.getPath('userData'), 'recent.json');
}

function readRecent() {
	try {
		const raw = JSON.parse(fs.readFileSync(recentPath(), 'utf8'));
		const files = Array.isArray(raw) ? raw : (Array.isArray(raw.files) ? raw.files : []);
		return files.filter((f) => f && typeof f.path === 'string');
	}
	catch {
		return [];
	}
}

/** 去重（Windows 路径大小写不敏感）、截断到 RECENT_MAX 后写盘 */
function writeRecent(files) {
	const seen = new Set();
	const clean = [];
	for (const f of files) {
		if (!f || typeof f.path !== 'string') continue;
		let resolved;
		try { resolved = path.resolve(f.path); }
		catch { continue; }
		const key = resolved.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		clean.push({
			path: resolved,
			name: path.basename(resolved),
			openedAt: f.openedAt || new Date().toISOString(),
		});
		if (clean.length >= RECENT_MAX) break;
	}
	try {
		const file = recentPath();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ files: clean }, null, '\t'), 'utf8');
	}
	catch (e) {
		console.error('[recent] 写入失败', e);
	}
	return clean;
}

function rememberDocument(pdfPath) {
	const resolved = path.resolve(pdfPath);
	const key = resolved.toLowerCase();
	const rest = readRecent().filter((f) => {
		try { return path.resolve(f.path).toLowerCase() !== key; }
		catch { return true; }
	});
	const list = writeRecent([
		{ path: resolved, name: path.basename(resolved), openedAt: new Date().toISOString() },
		...rest,
	]);
	rebuildMenu();
	return list;
}

function forgetRecent(target) {
	const key = path.resolve(target).toLowerCase();
	return writeRecent(readRecent().filter((f) => {
		try { return path.resolve(f.path).toLowerCase() !== key; }
		catch { return true; }
	}));
}

function clearRecent() {
	return writeRecent([]);
}

/** 给渲染进程用：附带目录和文件是否还存在 */
function recentForClient() {
	return readRecent().map((f) => ({
		...f,
		dir: path.dirname(f.path),
		exists: fs.existsSync(f.path),
	}));
}

/** 从命令行取出要打开的 PDF/EPUB 路径 */
function docPathFromArgv(argv) {
	// 打包后: [app.exe, file.pdf]      开发时: [electron.exe, ., file.pdf]
	const args = argv.slice(app.isPackaged ? 1 : 2);
	for (const a of args) {
		if (a.startsWith('-')) continue;
		if (/\.(pdf|epub)$/i.test(a) && fs.existsSync(a)) return path.resolve(a);
	}
	return null;
}

/**
 * 扩展调用的自定义协议：
 *   zoteroreader://show?path=<encodeURIComponent(Windows 路径)>
 * 只用于「在文件资源管理器中打开」——扩展本身没有权限启动 explorer.exe。
 */
function protocolActionFromArgv(argv) {
	for (const a of argv.slice(1)) {
		if (typeof a !== 'string' || !/^zoteroreader:\/\//i.test(a)) continue;
		try {
			const u = new URL(a);
			if (u.hostname.toLowerCase() !== 'show') continue;
			const p = u.searchParams.get('path');
			if (p) return { type: 'showInFolder', path: p };
		}
		catch {}
	}
	return null;
}

function runProtocolAction(action) {
	if (!action) return;
	if (action.type === 'showInFolder') {
		const p = path.resolve(action.path);
		if (fs.existsSync(p)) shell.showItemInFolder(p);
		else dialog.showErrorBox('无法定位文件', `文件不存在或已被移动：\n${p}`);
	}
}

// ---------------------------------------------------------------- HTTP 服务

function send(res, status, body, type) {
	res.writeHead(status, {
		'Content-Type': type || 'text/plain; charset=utf-8',
		'Cache-Control': 'no-store',
	});
	res.end(body);
}

function sendJson(res, obj, status = 200) {
	send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function sendFile(res, file) {
	fs.readFile(file, (err, buf) => {
		if (err) return send(res, 404, 'Not found: ' + path.basename(file));
		res.writeHead(200, { 'Content-Type': mimeFor(file), 'Cache-Control': 'no-store' });
		res.end(buf);
	});
}

function readBody(req) {
	return new Promise((resolve) => {
		let chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
	});
}

/** 每个窗口起一个独立的本地服务，端点只操作该窗口的 ctx.doc */
function startServer(ctx) {
	return new Promise((resolve) => {
		ctx.server = http.createServer(async (req, res) => {
			const url = new URL(req.url, 'http://127.0.0.1');
			const p = decodeURIComponent(url.pathname);

			// ---- 动态端点 ----
			if (p === '/__recent') {
				if (req.method === 'GET') return sendJson(res, { ok: true, files: recentForClient() });
				if (req.method === 'POST') {
					const body = JSON.parse((await readBody(req)) || '{}');
					if (body.clear) clearRecent();
					else if (typeof body.remove === 'string' && body.remove) forgetRecent(body.remove);
					rebuildMenu();
					return sendJson(res, { ok: true, files: recentForClient() });
				}
			}
			if (p === '/__open' && req.method === 'POST') {
				const body = JSON.parse((await readBody(req)) || '{}');
				if (body.path && loadDocument(ctx, body.path)) return sendJson(res, { ok: true });
				return sendJson(res, { ok: false, error: '文件不存在或无法读取' }, 404);
			}
			if (p === '/__doc') {
				if (!ctx.doc) return sendJson(res, { ok: false }, 404);
				return sendJson(res, {
					ok: true,
					name: ctx.doc.name,
					path: ctx.doc.path,
					title: ctx.doc.name.replace(/\.[^.]+$/, ''),
				});
			}
			if (p === '/__pdf') {
				if (!ctx.doc) return send(res, 404, 'no document');
				return sendFile(res, ctx.doc.path);
			}
			if (p === '/__annotations') {
				if (!ctx.doc) return sendJson(res, { ok: false }, 404);
				if (req.method === 'GET') {
					return sendJson(res, { ok: true, annotations: ctx.doc.annotations });
				}
				if (req.method === 'POST') {
					const body = JSON.parse((await readBody(req)) || '{}');
					const incoming = body.annotations || [];
					// 按 id upsert，避免依赖 reader 传的是全量还是增量
					const map = new Map(ctx.doc.annotations.map((a) => [a.id, a]));
					for (const a of incoming) map.set(a.id, a);
					if (Array.isArray(body.removed)) {
						for (const id of body.removed) map.delete(id);
					}
					ctx.doc.annotations = [...map.values()];
					writeSidecar(ctx.doc.path, { annotations: ctx.doc.annotations });
					return sendJson(res, { ok: true, count: ctx.doc.annotations.length });
				}
			}
			if (p === '/__state') {
				if (!ctx.doc) return sendJson(res, { ok: false }, 404);
				if (req.method === 'GET') return sendJson(res, { ok: true, state: ctx.doc.state });
				if (req.method === 'POST') {
					const body = JSON.parse((await readBody(req)) || '{}');
					ctx.doc.state = body.state || null;
					writeSidecar(ctx.doc.path, { state: ctx.doc.state });
					return sendJson(res, { ok: true });
				}
			}
			// 全局设置：自定义主题 + 当前选中的 light/dark 主题
			if (p === '/__settings') {
				if (req.method === 'GET') return sendJson(res, { ok: true, settings: readSettings() });
				if (req.method === 'POST') {
					const body = JSON.parse((await readBody(req)) || '{}');
					delete body.ok;
					return sendJson(res, { ok: true, settings: writeSettings(body) });
				}
			}
			// 调试用：用 Electron 自身的合成器抓图，不受窗口层级/焦点影响
			if (p === '/__screenshot') {
				if (!ctx.win) return send(res, 503, 'no window');
				try {
					const img = await ctx.win.webContents.capturePage();
					const out = path.join(app.getPath('userData'), 'screenshot.png');
					fs.writeFileSync(out, img.toPNG());
					return sendJson(res, { ok: true, file: out });
				}
				catch (e) {
					return sendJson(res, { ok: false, error: String(e) }, 500);
				}
			}
			if (p === '/__openExternal') {
				if (ctx.doc) shell.openPath(ctx.doc.path);
				return sendJson(res, { ok: true });
			}
			// 复制文本到系统剪贴板（渲染进程没有 Node，统一走主进程）
			if (p === '/__clipboard' && req.method === 'POST') {
				const body = JSON.parse((await readBody(req)) || '{}');
				if (typeof body.text !== 'string') return sendJson(res, { ok: false }, 400);
				clipboard.writeText(body.text);
				return sendJson(res, { ok: true });
			}
			// 在资源管理器中定位文件
			if (p === '/__showInFolder' && req.method === 'POST') {
				const body = JSON.parse((await readBody(req)) || '{}');
				if (typeof body.path === 'string' && fs.existsSync(body.path)) {
					shell.showItemInFolder(path.resolve(body.path));
					return sendJson(res, { ok: true });
				}
				return sendJson(res, { ok: false, error: '文件不存在' }, 404);
			}
			if (p === '/__pickFile') {
				const r = await pickAndLoad(ctx);
				if (!r.canceled && r.filePaths[0]) {
					return sendJson(res, { ok: true, path: r.filePaths[0] });
				}
				return sendJson(res, { ok: false, canceled: true });
			}

			// ---- 外壳自己的静态文件 ----
			if (p === '/' || p === '/index.html') return sendFile(res, path.join(RENDERER_DIR, 'index.html'));
			if (p === '/app.js') return sendFile(res, path.join(RENDERER_DIR, 'app.js'));
			if (p === '/eye-care-themes.js') return sendFile(res, path.join(RENDERER_DIR, 'eye-care-themes.js'));

			// ---- reader 构建产物（含 /pdf/**） ----
			const target = path.join(READER_BUILD, p);
			if (!target.startsWith(READER_BUILD)) return send(res, 403, 'forbidden');
			if (fs.existsSync(target) && fs.statSync(target).isFile()) return sendFile(res, target);

			send(res, 404, 'Not found: ' + p);
		});

		ctx.server.listen(0, '127.0.0.1', () => {
			ctx.port = ctx.server.address().port;
			// 把端口写下来，方便外部脚本/调试工具访问（多窗口时是最后一个窗口的）
			try {
				const f = path.join(app.getPath('userData'), 'port.txt');
				fs.mkdirSync(path.dirname(f), { recursive: true });
				fs.writeFileSync(f, String(ctx.port), 'utf8');
			}
			catch {}
			console.log(`[reader] window ${ctx.port} listening on http://127.0.0.1:${ctx.port}  userData=${app.getPath('userData')}`);
			resolve(ctx.port);
		});
	});
}

// ---------------------------------------------------------------- 窗口

/** 在指定窗口上下文里打开文档；路径不存在时返回 false，不改变当前文档 */
function loadDocument(ctx, pdfPath) {
	if (!ctx || typeof pdfPath !== 'string' || !pdfPath) return false;
	const resolved = path.resolve(pdfPath);
	if (!fs.existsSync(resolved)) return false;
	const meta = readSidecar(resolved);
	ctx.doc = {
		path: resolved,
		name: path.basename(resolved),
		key: meta.key,
		annotations: meta.annotations,
		state: meta.state,
	};
	// 记入打开历史（最新的排最前），同时刷新「文件 → 最近打开」菜单
	rememberDocument(resolved);
	// 整个页面重新加载即可重新拉取 /__doc、/__pdf、/__annotations
	if (ctx.win && !ctx.win.isDestroyed()) {
		ctx.win.setTitle(ctx.doc.name);
		ctx.win.reload();
	}
	return true;
}

/** 弹系统文件选择框；parent 可以是 null */
async function pickFile(parent) {
	const options = {
		title: '打开 PDF',
		properties: ['openFile'],
		filters: [{ name: 'PDF', extensions: ['pdf'] }],
	};
	return (parent && !parent.isDestroyed())
		? dialog.showOpenDialog(parent, options)
		: dialog.showOpenDialog(options);
}

/** 启动页的「打开 PDF 文件…」：在当前窗口里打开 */
async function pickAndLoad(ctx) {
	const r = await pickFile(ctx && ctx.win);
	if (!r.canceled && r.filePaths[0]) loadDocument(ctx, r.filePaths[0]);
	return r;
}

/**
 * 菜单/双击打开的入口：
 *   - 当前焦点窗口还是空白启动页 → 直接在该窗口打开，避免留下空窗口
 *   - 否则新开一个窗口，原文档不受影响
 */
function openDocumentFromMenu(pdfPath) {
	const focused = BrowserWindow.getFocusedWindow();
	const ctx = windows.find((c) => c.win === focused);
	if (ctx && !ctx.doc) {
		if (!loadDocument(ctx, pdfPath)) {
			dialog.showErrorBox('无法打开文件', `文件不存在或已被移动：\n${path.resolve(pdfPath)}`);
		}
		return;
	}
	createWindow(pdfPath).catch((e) => {
		dialog.showErrorBox('无法打开文件', String(e && e.message || e));
	});
}

/** 菜单「文件 → 打开…」：选择后按 openDocumentFromMenu 的规则打开 */
async function pickAndOpenFromMenu() {
	const r = await pickFile(BrowserWindow.getFocusedWindow());
	if (!r.canceled && r.filePaths[0]) openDocumentFromMenu(r.filePaths[0]);
	return r;
}

/** 「文件 → 最近打开」子菜单；只列出仍然存在的文件 */
function recentMenuItems() {
	const list = readRecent().filter((f) => fs.existsSync(f.path));
	if (!list.length) return [{ label: '（暂无历史）', enabled: false }];
	return list.map((f) => ({
		label: f.name,
		click: () => {
			if (!fs.existsSync(f.path)) {
				dialog.showErrorBox('无法打开文件', `文件不存在或已被移动：\n${f.path}`);
				return;
			}
			openDocumentFromMenu(f.path);
		},
	}));
}

function rebuildMenu() {
	const template = [
		{
			label: '文件',
			submenu: [
				{ label: '打开…', accelerator: 'CmdOrCtrl+O', click: () => pickAndOpenFromMenu() },
				{ label: '最近打开', submenu: recentMenuItems() },
				{ type: 'separator' },
				{ label: '关闭窗口', role: 'close' },
				{ label: '退出', role: 'quit' },
			],
		},
		{
			label: '编辑',
			submenu: [
				{ label: '撤销', role: 'undo' },
				{ label: '重做', role: 'redo' },
				{ type: 'separator' },
				{ label: '剪切', role: 'cut' },
				{ label: '复制', role: 'copy' },
				{ label: '粘贴', role: 'paste' },
				{ label: '全选', role: 'selectAll' },
			],
		},
		{
			label: '视图',
			submenu: [
				{ label: '重新加载', role: 'reload' },
				{ label: '开发者工具', role: 'toggleDevTools' },
				{ type: 'separator' },
				{ label: '实际大小', role: 'resetZoom' },
				{ label: '放大', role: 'zoomIn' },
				{ label: '缩小', role: 'zoomOut' },
				{ type: 'separator' },
				{ label: '全屏', role: 'togglefullscreen' },
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** 新开一个窗口；pdfPath 可为 null（显示启动页） */
async function createWindow(pdfPath) {
	const ctx = { win: null, server: null, port: 0, doc: null };
	await startServer(ctx);

	if (pdfPath && !loadDocument(ctx, pdfPath)) {
		dialog.showErrorBox('无法打开文件', `文件不存在或已被移动：\n${path.resolve(pdfPath)}`);
	}

	const win = new BrowserWindow({
		width: 1280,
		height: 900,
		backgroundColor: '#1c1c1e',
		title: ctx.doc ? ctx.doc.name : 'PDF 阅读器',
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	ctx.win = win;
	windows.push(ctx);

	// 文档里的外链交给系统浏览器，不要在 Electron 里开新窗口
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/.test(url)) shell.openExternal(url);
		return { action: 'deny' };
	});

	win.on('closed', () => {
		if (ctx.server) {
			try { ctx.server.close(); } catch {}
		}
		windows = windows.filter((c) => c !== ctx);
	});

	await win.loadURL(`http://127.0.0.1:${ctx.port}/`);
	return ctx;
}

// ---------------------------------------------------------------- 生命周期

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', (_e, argv) => {
		// 扩展通过自定义协议请求「在资源管理器中打开」：只执行动作，不建窗口
		const action = protocolActionFromArgv(argv);
		if (action) {
			runProtocolAction(action);
			return;
		}
		const p = docPathFromArgv(argv);
		if (p) {
			// 再次双击 PDF：新开窗口，不替换已经打开的文档
			openDocumentFromMenu(p);
			return;
		}
		// 只是又点了一次程序图标：聚焦已有窗口
		const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
		if (win) {
			if (win.isMinimized()) win.restore();
			win.focus();
		}
		else {
			createWindow();
		}
	});

	app.whenReady().then(async () => {
		// 自定义协议（通常来自 Edge 扩展）：执行完即退出，不创建窗口
		const action = protocolActionFromArgv(process.argv);
		if (action) {
			runProtocolAction(action);
			app.quit();
			return;
		}

		if (!fs.existsSync(path.join(READER_BUILD, 'reader.js'))) {
			dialog.showErrorBox(
				'阅读器构建产物缺失',
				`找不到:\n${path.join(READER_BUILD, 'reader.js')}\n\n请先运行 step050 构建脚本。`
			);
			app.quit();
			return;
		}

		rebuildMenu();
		const p = docPathFromArgv(process.argv);
		await createWindow(p);

		app.on('activate', () => {
			if (BrowserWindow.getAllWindows().length === 0) createWindow();
		});
	});

	app.on('window-all-closed', () => {
		for (const ctx of windows) {
			if (ctx.server) {
				try { ctx.server.close(); } catch {}
			}
		}
		windows = [];
		app.quit();
	});
}
