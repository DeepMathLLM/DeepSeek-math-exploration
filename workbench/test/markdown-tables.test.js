'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('const escapeHtml ='), source.indexOf('\nfunction typesetMath(')), context);
const render = vm.runInContext('renderMarkdown', context);
const table = '| Agent | 职责 |\n|---|---|\n| **dLLM-理论分析师** | 追踪扩散语言模型的数学原理与统一框架 |\n| **Clover-架构审查员** | 分析技术细节、Benchmark 与竞品对比 |\n| **产业趋势观察员** | 跟踪商业化进展、投融资、生态建设 |';

test('research role tables render as a header and three rows with inline emphasis', () => {
  const html = render('我可以创建：\n\n' + table + '\n\n请确认研究方向。');
  assert.equal((html.match(/<table /g) || []).length, 1);
  assert.equal((html.match(/<th /g) || []).length, 2);
  assert.equal((html.match(/<td /g) || []).length, 6);
  assert.match(html, /<strong>dLLM-理论分析师<\/strong>/);
  assert.match(html, /^<p>我可以创建：<\/p>/);
  assert.match(html, /<p>请确认研究方向。<\/p>$/);
});

test('pasted escaped table edges render without changing pipes inside cells', () => {
  const pasted = table.split('\n').map(line => '\\' + line + '\\').join('\n');
  assert.equal(render(pasted), render(table));
  const html = render('| Code | Literal | Math |\n|:---|:---:|---:|\n| `a|b` | c\\|d | $x|y$ |');
  assert.equal((html.match(/<td /g) || []).length, 3);
  assert.match(html, /<code>a\|b<\/code>/);
  assert.match(html, /md-align-center">c\|d/);
  assert.match(html, /md-align-right">\\\(x\|y\\\)/);
});

test('table cell HTML remains escaped and unsafe link schemes cannot become links', () => {
  const html = render('| Input | Value |\n|---|---|\n| <img src=x onerror=alert(1)> | [bad](javascript:alert) |\n| **safe** | [source](https://example.com) |');
  assert.doesNotMatch(html, /<img|<script|href="javascript:/i);
  assert.match(html, /&lt;img/);
  assert.match(html, /<a href="https:\/\/example.com"/);
});

test('code fences and malformed dividers remain literal while incomplete body rows are padded', () => {
  assert.doesNotMatch(render('```text\n' + table + '\n```'), /<table /);
  assert.doesNotMatch(render('| A | B |\n|---|\n| one | two |'), /<table /);
  const html = render('| A | B |\n|---|---|\n| one |');
  assert.match(html, /<td class="md-align-left">one<\/td><td class="md-align-left"><\/td>/);
});
