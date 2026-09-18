/**
 * 临时测试服务器（非交付物）
 *
 * 目的：扩展的 reader/app.js 写了 chrome.storage 缺失时回退到 localStorage，
 * 所以可以脱离扩展环境，直接用 HTTP 把阅读器逻辑整个跑通再装扩展。
 *
 * 用法: node step110_testserver.mjs "<某个.pdf的绝对路径>"
 * 然后打开 http://127.0.0.1:8791/reader.html?src=/test.pdf
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'step110_edge_ext', 'reader');
const PDF = process.argv[2];
const PORT = 8791;

if (!PDF || !fs.existsSync(PDF)) {
	console.error('用法: node step110_testserver.mjs "<pdf 绝对路径>"');
	process.exit(1);
}

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
	'.ttf': 'font/ttf',
	'.pdf': 'application/pdf',
};

http.createServer((req, res) => {
	const url = new URL(req.url, 'http://127.0.0.1');
	const p = decodeURIComponent(url.pathname);

	if (p === '/test.pdf') {
		res.writeHead(200, { 'Content-Type': 'application/pdf' });
		return fs.createReadStream(PDF).pipe(res);
	}

	const file = path.join(ROOT, p);
	if (!file.startsWith(ROOT)) {
		res.writeHead(403); return res.end('forbidden');
	}
	fs.readFile(file, (err, buf) => {
		if (err) { res.writeHead(404); return res.end('not found: ' + p); }
		res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
		res.end(buf);
	});
}).listen(PORT, '127.0.0.1', () => {
	console.log(`测试服务器: http://127.0.0.1:${PORT}/reader.html?src=/test.pdf`);
	console.log(`PDF: ${PDF}`);
});
