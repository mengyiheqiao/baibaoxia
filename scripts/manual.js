// 生成 GitHub 上看的使用手册 docs/使用手册.md：npm run manual
// 正文来自软件自带的 defaults/记忆区/百宝匣使用说明.md（改说明只改那一篇，再运行这个脚本）。
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = path.resolve(__dirname, '..');
const body = fs.readFileSync(path.join(SRC, 'defaults', '记忆区', '百宝匣使用说明.md'), 'utf8')
  .replace(/^\uFEFF/, '')
  .replace(/^# .*\n/, '')
  .replace(/^标签:.*\n/m, '')
  .trim();

// GitHub 给标题生成锚点的规则
const anchor = t => t.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
const toc = body.split('\n').filter(l => /^###? /.test(l) && !/^## 详细/.test(l)).map(l => {
  const t = l.replace(/^#+ /, '');
  return `- [${t}](#${anchor(t)})`;
}).join('\n');

const head = `# 百宝匣使用手册

> 这份手册和软件里自带的《百宝匣使用说明》内容一样，在百宝匣的记忆区里随时能看、能搜。

## 第一次使用

1. 到 [Releases 页面](https://github.com/mengyiheqiao/baibaoxia/releases/latest) 下载 \`Baibaoxia-Desktop-x.x.x.zip\`
2. 解压到一个常用的地方，比如 \`D:\\百宝匣\`（别放在 \`C:\\Program Files\` 里）
3. 双击 \`百宝匣.exe\`。Windows 提示"已保护你的电脑"时，点"更多信息"→"仍要运行"
4. 工具区已经放了几个示例抽屉，点一下试试；点最后一格"加一个工具"放进你自己的
5. 点上面的"记忆区"，"新建说明"写下第一篇笔记，或者把 PDF、Word 文件直接拖进窗口

![工具区](images/tools.png)

![记忆区和活页](images/memory.png)

想在浏览器里用、或者用的是 macOS / Linux：装好 [Node.js](https://nodejs.org)（20 或更新）后下载网页版，运行 \`启动百宝匣.bat\` 或 \`node server.js\`，然后打开 http://127.0.0.1:3456 。

## 目录

${toc}
- [常见问题](#常见问题)
`;

const faq = `
## 常见问题

**解压或覆盖时提示"目标文件夹访问被拒绝"**
百宝匣还在后台运行。先右键托盘图标 →"退出"；还不行就打开任务管理器，结束"百宝匣"（网页版是"Node.js"）再试。如果文件夹在 \`C:\\Program Files\` 里，挪到比如 \`D:\\百宝匣\`。

**双击"启动百宝匣.bat"一闪就没了，或者提示 Node.js not found**
网页版需要先装 [Node.js](https://nodejs.org)。装好后重新双击。不想装的话，用桌面版。

**提示端口 3456 被占用**
多半是已经开着一个百宝匣（看看右下角托盘），或者上次没关干净。重启电脑最省事。

**换了皮肤以后界面乱了、找不到按钮**
按 Ctrl+Alt+0 换回原皮，或者打开 http://127.0.0.1:3456/?skin=off 。

**截图识字提示没装语言包**
Windows 设置 → 时间和语言 → 语言和区域 → 中文（简体）旁边的 ⋯ → 语言选项 → 安装"光学字符识别"。

**换电脑了，东西怎么搬**
整个百宝匣文件夹拷过去就行，工具、说明、资料、设置都在里面。开了自动备份的话，也可以在新电脑上"从备份恢复"。

**我的数据会被上传吗**
不会。百宝匣没有服务器，所有东西都在你自己的电脑上。只有你主动使用 AI 功能时，相关内容会发给你在设置里填的那家 AI 服务。

还有问题？到 [Issues](https://github.com/mengyiheqiao/baibaoxia/issues) 提出来。
`;

const out = path.join(SRC, 'docs', '使用手册.md');
fs.writeFileSync(out, head + '\n' + body + '\n' + faq);
console.log('写好了', path.relative(SRC, out));

// 末影箱网页版：GitHub Pages 上那份（docs/box/index.html）和软件里的 public/box.html 保持一样
fs.mkdirSync(path.join(SRC, 'docs', 'box'), { recursive: true });
fs.copyFileSync(path.join(SRC, 'public', 'box.html'), path.join(SRC, 'docs', 'box', 'index.html'));
console.log('写好了 docs/box/index.html');
