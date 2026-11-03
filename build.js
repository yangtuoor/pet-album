#!/usr/bin/env node
/*
 * 宠物图册 · 构建脚本
 * 把 public/ 下的 html/css/js 打进一个自包含的 dist/index.html，
 * 这样即使只是双击本地文件打开（file:// 协议）也能看到界面和演示动效。
 * 通过 http 服务访问时会自动走 /api 真数据。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DIST = path.join(ROOT, 'dist');

const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
let html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

html = html.replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${css}\n</style>`);
html = html.replace('<script src="app.js" defer></script>', () => `<script defer>\n${js}\n</script>`);

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'index.html'), html, 'utf8');
console.log('built dist/index.html', (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB');
