/**
 * 独立 PDF 阅读器 —— Electron 主进程
 *
 * 由 Zotero 的 reader (github.com/zotero/reader) 提供阅读 UI，
 * 本文件只负责：命令行取 PDF 路径、起本地 HTTP 服务、批注持久化。
 *
 * 用本地 HTTP 而不是 file:// 的原因：
 *   reader 的 PDF 视图通过 iframe 加载 'pdf/web/viewer.html'（相对路径），
 *   并用 ES module / Worker / wasm，file:// 下会被同源策略和 Worker 限制挡住。
 */

const { app, BrowserWindow, dialog, shell } = require('electron');
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

let mainWindow = null;
let server = null;
let port = 0;
let currentDoc = null;   // { path, name, key, annotations, state }

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

function startServer() {
	return new Promise((resolve) => {
		server = http.createServer(async (req, res) => {
			const url = new URL(req.url, 'http://127.0.0.1');
			const p = decodeURIComponent(url.pathname);

			// ---- 动态端点 ----
			if (p === '/__doc') {
				if (!currentDoc) return sendJson(res, { ok: false }, 404);
				return sendJson(res, {
					ok: true,
					name: currentDoc.name,
					path: currentDoc.path,
					title: currentDoc.name.replace(/\.[^.]+$/, ''),
				});
			}
			if (p === '/__pdf') {
				if (!currentDoc) return send(res, 404, 'no document');
				return sendFile(res, currentDoc.path);
			}
			if (p === '/__annotations') {
				if (!currentDoc) return sendJson(res, { ok: false }, 404);
				if (req.method === 'GET') {
					return sendJson(res, { ok: true, annotations: currentDoc.annotations });
				}
				if (req.method === 'POST') {
					const body = JSON.parse((await readBody(req)) || '{}');
					const incoming = body.annotations || [];
					// 按 id upsert，避免依赖 reader 传的是全量还是增量
					const map = new Map(currentDoc.annotations.map((a) => [a.id, a]));
					for (const a of incoming) map.set(a.id, a);
					if (Array.isArray(body.removed)) {
						for (const id of body.removed) map.delete(id);
					}
					currentDoc.annotations = [...map.values()];
					writeSidecar(currentDoc.path, { annotations: currentDoc.annotations });
					return sendJson(res, { ok: true, count: currentDoc.annotations.length });
				}
			}
			if (p === '/__state') {
				if (!currentDoc) return sendJson(res, { ok: false }, 404);
				if (req.method === 'GET') return sendJson(res, { ok: true, state: currentDoc.state });
				if (req.method === 'POST') {
					const body = JSON.parse((await readBody(req)) || '{}');
					currentDoc.state = body.state || null;
					writeSidecar(currentDoc.path, { state: currentDoc.state });
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
				if (!mainWindow) return send(res, 503, 'no window');
				try {
					const img = await mainWindow.webContents.capturePage();
					const out = path.join(app.getPath('userData'), 'screenshot.png');
					fs.writeFileSync(out, img.toPNG());
					return sendJson(res, { ok: true, file: out });
				}
				catch (e) {
					return sendJson(res, { ok: false, error: String(e) }, 500);
				}
			}
			if (p === '/__openExternal') {
				if (currentDoc) shell.openPath(currentDoc.path);
				return sendJson(res, { ok: true });
			}
			if (p === '/__pickFile') {
				const r = await dialog.showOpenDialog(mainWindow, {
					properties: ['openFile'],
					filters: [{ name: 'PDF', extensions: ['pdf'] }],
				});
				if (!r.canceled && r.filePaths[0]) {
					loadDocument(r.filePaths[0]);
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

		server.listen(0, '127.0.0.1', () => {
			port = server.address().port;
			// 把端口写下来，方便外部脚本/调试工具访问
			try {
				const f = path.join(app.getPath('userData'), 'port.txt');
				fs.mkdirSync(path.dirname(f), { recursive: true });
				fs.writeFileSync(f, String(port), 'utf8');
			}
			catch {}
			console.log(`[reader] listening on http://127.0.0.1:${port}  userData=${app.getPath('userData')}`);
			resolve(port);
		});
	});
}

// ---------------------------------------------------------------- 窗口

function loadDocument(pdfPath) {
	const meta = readSidecar(pdfPath);
	currentDoc = {
		path: pdfPath,
		name: path.basename(pdfPath),
		key: meta.key,
		annotations: meta.annotations,
		state: meta.state,
	};
	// 整个页面重新加载即可重新拉取 /__doc、/__pdf、/__annotations
	if (mainWindow) mainWindow.reload();
}

async function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1280,
		height: 900,
		backgroundColor: '#1c1c1e',
		title: currentDoc ? currentDoc.name : 'PDF 阅读器',
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	// 文档里的外链交给系统浏览器，不要在 Electron 里开新窗口
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/.test(url)) shell.openExternal(url);
		return { action: 'deny' };
	});

	mainWindow.on('closed', () => { mainWindow = null; });
	await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

// ---------------------------------------------------------------- 生命周期

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', (_e, argv) => {
		const p = docPathFromArgv(argv);
		if (p) loadDocument(p);
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
		}
	});

	app.whenReady().then(async () => {
		if (!fs.existsSync(path.join(READER_BUILD, 'reader.js'))) {
			dialog.showErrorBox(
				'阅读器构建产物缺失',
				`找不到:\n${path.join(READER_BUILD, 'reader.js')}\n\n请先运行 step050 构建脚本。`
			);
			app.quit();
			return;
		}

		currentDoc = null;
		const p = docPathFromArgv(process.argv);
		await startServer();
		if (p) loadDocument(p);
		await createWindow();

		app.on('activate', () => {
			if (BrowserWindow.getAllWindows().length === 0) createWindow();
		});
	});

	app.on('window-all-closed', () => {
		if (server) server.close();
		app.quit();
	});
}
