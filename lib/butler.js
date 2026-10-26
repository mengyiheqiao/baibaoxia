// AI 管家：会自己翻资料的助手。
// AI 每一步只说一件事：要么"用一个工具查东西"，要么"给出最后的回答"。
// 查到的东西喂回去，最多来回几轮。工具全是只读的；新建说明、放进活页这种事写在最后的回答里，由百宝匣去做。
'use strict';
const fs = require('fs');
const path = require('path');

const MOODS = ['待机', '思考', '说话', '找到了', '开心', '惊讶', '困', '玩游戏'];
const MAX_STEPS = 6;
const READ_LIMIT = 12000;

const DEFAULT_PERSONA = {
  main: { 名字: '百宝匣', 设定: '你是用户的百宝匣管家。说话亲切、自然、简洁，像一个靠谱的朋友。' },
  private: { 名字: '百宝匣', 设定: '你是用户的百宝匣管家（夜间）。说话安静、简短。' },
};

const pad = n => String(n).padStart(2, '0');
const ymd = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const cut = (s, n) => (s.length > n ? s.slice(0, n) + `\n……（后面还有 ${s.length - n} 字没给你）` : s);

function parseDay(s, end) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return end ? d.getTime() + 86400000 - 1 : d.getTime();
}

// 存进来的时间：剪藏的看正文里写的日期，其他的看文件创建时间
function savedTime(full, st, text) {
  if (text) {
    const m = /> 来源：.*?，\s*(\d{4})\/(\d{1,2})\/(\d{1,2}) 剪藏/.exec(text);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime();
  }
  const b = st.birthtimeMs;
  return b && b > 0 && b <= st.mtimeMs + 1000 ? b : st.mtimeMs;
}

function createButler(deps) {
  // deps: { aiChat, listNotes, listFiles, readIndex, retrieve, binderView, statsReport, readTools, createNote, putInPage, settings }

  function catalog(d) {
    const view = deps.binderView(d);
    const pageName = id => (view.pages.find(p => p.id === id) || {}).name || '';
    const notes = deps.listNotes(d).map(n => {
      const full = path.join(d.root, n.id + '.md');
      let st; try { st = fs.statSync(full); } catch { return null; }
      return { kind: 'note', id: n.id, title: n.title, tags: n.tags, text: n.text, saved: savedTime(full, st, n.text), updated: n.updated, page: pageName(view.items['note:' + n.id]), clip: n.tags.includes('剪藏') };
    }).filter(Boolean);
    const files = deps.listFiles(d).map(f => {
      const full = path.join(d.files, f.name);
      let st; try { st = fs.statSync(full); } catch { return null; }
      return { kind: 'file', name: f.name, title: f.name, size: f.size, saved: savedTime(full, st), updated: f.updated, indexed: f.indexed, page: pageName(view.items['file:' + f.name]) };
    }).filter(Boolean);
    return { notes, files, pages: view.pages };
  }

  async function run({ question, history, free, space, d, persona, privateBlind, onStep }) {
    const sources = []; // 出处，编号从 1 开始
    const refOf = item => {
      const key = item.kind === 'note' ? 'n:' + item.id : 'f:' + item.name + (item.page ? '#' + item.page : '') + (item.chapter != null ? '@' + item.chapter : '');
      let s = sources.find(x => x.key === key);
      if (!s) {
        s = { key, n: sources.length + 1, kind: item.kind, id: item.id, name: item.name, title: item.title, label: item.label || '', page: item.pdfPage || null, chapter: item.chapter ?? null };
        sources.push(s);
      }
      return s.n;
    };
    const blind = !!privateBlind;
    const cat = blind ? { notes: [], files: [], pages: [] } : catalog(d);
    const findItem = a => {
      if (a.ref) { const s = sources.find(x => x.n === Number(a.ref)); if (s) return s.kind === 'note' ? cat.notes.find(n => n.id === s.id) : cat.files.find(f => f.name === s.name); }
      const t = String(a.title || a.note || a.file || a.name || '').trim();
      if (!t) return null;
      return cat.notes.find(n => n.title === t || n.id === t) || cat.files.find(f => f.name === t)
        || cat.notes.find(n => n.title.includes(t)) || cat.files.find(f => f.name.includes(t));
    };
    const brief = it => ({ ref: refOf(it), 类型: it.kind === 'note' ? (it.clip ? '剪藏' : '说明') : '资料', 标题: it.title, 存进来: ymd(it.saved), 修改: ymd(it.updated), ...(it.page ? { 活页: it.page } : {}), ...(it.tags && it.tags.length ? { 标签: it.tags.slice(0, 6).join('、') } : {}) });

    const tools = {
      search(a) {
        const hits = deps.retrieve(String(a.query || question), d, 8);
        return hits.map(h => {
          const item = h.kind === 'note' ? { kind: 'note', id: h.id, title: h.title, label: h.label } : { kind: 'file', name: h.name, title: h.title, label: h.label, pdfPage: h.page, chapter: h.chapter };
          return { ref: refOf(item), 来自: (h.kind === 'note' ? '说明《' : '资料《') + h.title + '》' + (h.label ? ' ' + h.label : ''), 片段: h.text.slice(0, 700) };
        });
      },
      list(a) {
        let items = a.kind === 'note' ? cat.notes : a.kind === 'file' ? cat.files : [...cat.notes, ...cat.files];
        if (a.kind === 'clip') items = cat.notes.filter(n => n.clip);
        const from = parseDay(a.date_from || a.date, false), to = parseDay(a.date_to || a.date, true);
        const field = a.by === 'updated' ? 'updated' : 'saved';
        if (from != null) items = items.filter(i => i[field] >= from);
        if (to != null) items = items.filter(i => i[field] <= to);
        if (a.page) items = items.filter(i => i.page === a.page);
        if (a.tag) items = items.filter(i => (i.tags || []).some(t => t.includes(a.tag)));
        if (a.keyword) items = items.filter(i => i.title.toLowerCase().includes(String(a.keyword).toLowerCase()));
        items = [...items].sort((x, y) => (a.sort === 'old' ? x[field] - y[field] : y[field] - x[field]));
        const limit = Math.min(Number(a.limit) || 30, 60);
        return { 共: items.length, 列表: items.slice(0, limit).map(brief) };
      },
      read(a) {
        const it = findItem(a);
        if (!it) return { 错误: '找不到这一项。先用 list 或 search 查出准确的标题或 ref。' };
        if (it.kind === 'note') return { ref: refOf(it), 标题: it.title, 内容: cut(it.text, READ_LIMIT) };
        const ix = deps.readIndex(d, it.name);
        if (!ix || !ix.parts || !ix.parts.length) return { ref: refOf(it), 标题: it.name, 错误: it.indexed === 'done' ? '这个文件里没有文字（可能是扫描件或图片）。' : '这个文件的文字还没读出来，稍后再试。' };
        let parts = ix.parts;
        if (a.page) parts = parts.filter(p => p.page === Number(a.page));
        else if (a.chapter != null) parts = parts.filter(p => p.chapter === Number(a.chapter));
        const body = parts.map(p => (p.label ? `【${p.label}】\n` : '') + p.text).join('\n\n');
        const ref = refOf({ ...it, pdfPage: a.page ? Number(a.page) : null, chapter: a.chapter != null ? Number(a.chapter) : null });
        return { ref, 标题: it.name, 共几部分: ix.parts.length, 内容: cut(body, READ_LIMIT) };
      },
      pages() {
        return cat.pages.map(p => ({ 活页: p.name, 件数: p.count, ...(p.pinned ? { 钉住: true } : {}), ...(p.archived ? { 在档案盒: true } : {}) }));
      },
      stats() {
        if (space === 'private') return { 错误: '私密区没有统计。' };
        const r = deps.statsReport().memory;
        return {
          说明数: r.notes, 资料数: r.files, 最近30天: r.month,
          好久没看的说明: r.stale.map(s => ({ 标题: s.title, 上次打开: s.last ? ymd(s.last) : '从没打开过' })),
          最常看的说明: r.topNotes.map(x => x.name), 最常翻的资料: r.topFiles.map(x => x.name),
          在读的书: r.books.map(b => `${b.title}（第 ${b.chapter + 1}/${b.total} 章）`),
          搜了没找到的词: r.misses.map(x => x.name),
        };
      },
    };

    const toolList = blind ? [] : deps.readTools().tools.filter(t => (space === 'private' ? t.private : !t.private));
    const now = new Date();
    const sys = `【你的身份】
名字：${persona.名字}
${persona.设定}

【你的工作】
你住在用户的"百宝匣"里。百宝匣是用户自己的工具箱和资料库：工具区放着常用工具，记忆区放着用户写的说明、剪藏的网页、存进来的资料（PDF、电子书、Word 等），用"活页"分类。
始终保持上面的身份和说话方式，但内容必须准确：用户资料里的东西一律先用工具查，查到什么说什么，没查到就直说，绝不编造资料的内容、日期或标题。
${blind ? '现在在私密区，用户没有允许你看私密区的资料，你看不到任何资料和工具。可以正常聊天；问到资料时，告诉用户需要先在私密区的设置里打开"允许管家看私密区的资料"。\n' : ''}${free ? '用户打开了"自由回答"：和资料无关的问题，可以用你自己的知识完整、详细地回答。\n' : '优先依据用户自己的资料回答，简洁一些；资料里没有的可以用常识补充，但要说明资料里没记。\n'}
今天是 ${ymd(now)}（星期${'日一二三四五六'[now.getDay()]}）。用户说"昨天""上周""10月20日"时，换算成具体日期再查。

【怎么回复】每次只输出一个 JSON 对象，二选一：
1. 需要查东西时：{"tool":"工具名","args":{...},"say":"告诉用户你在做什么，一句话，用你的语气"}
2. 可以回答时：{"answer":"给用户看的回答，可以用 Markdown","mood":"表情","actions":[...]}

${blind ? '' : `【工具】（只读，可以连着用好几次，最多 ${MAX_STEPS} 次）
- search {"query":"关键词"}：在所有说明和资料的全文里找相关片段
- list {"date":"YYYY-MM-DD"} 或 {"date_from":"…","date_to":"…"}，还可以加 "kind":"note|file|clip"、"page":"活页名"、"tag":"标签"、"keyword":"标题里的词"、"by":"updated"（按修改时间，默认按存进来的时间）、"sort":"old"、"limit":30：按条件列出说明和资料
- read {"ref":编号} 或 {"title":"标题或文件名"}，资料可以加 "page":页码 或 "chapter":章：读完整内容
- pages {}：列出所有活页
- stats {}：使用统计（好久没看的说明、常看的、在读的书、搜了没找到的词）
工具返回的每一项都有 ref 编号。回答里用到的内容，在句子后面标 [编号]。
要总结某天或某个主题的资料：先 list 或 search 找到，再 read 读内容，读完再总结，不要只看标题就总结。

【actions】用户要你做事时才加，可以有多个：
- {"type":"launch","tool":"工具名"}：打开工具
- {"type":"open","ref":编号}：打开一篇说明或资料给用户看
- {"type":"create_note","title":"标题","text":"完整 Markdown，第一行 # 标题，第二行 标签: 词1, 词2","page":"活页名（可选）"}：新建说明（用户要你记下来、整理成说明时）
- {"type":"put_in_page","page":"活页名","refs":[编号,…]}：把东西放进活页，活页不存在会新建
不能删除任何东西；用户要删时告诉他自己去删。
`}【mood】从这些里选一个最符合你此刻状态的：${MOODS.join('、')}。找到用户要的东西用"找到了"，没找到用"惊讶"，闲聊开心用"开心"，普通回答用"说话"。

${toolList.length ? `柜子里的工具：${toolList.map(t => t.name + (t.desc ? `（${t.desc}）` : '')).join('；')}\n` : ''}${blind ? '' : `记忆区：${cat.notes.length} 篇说明，${cat.files.length} 份资料，活页：${cat.pages.filter(p => !p.archived).map(p => p.name).join('、') || '还没有'}`}`;

    const msgs = [{ role: 'system', content: sys }];
    for (const m of (Array.isArray(history) ? history : []).slice(-8)) {
      msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) });
    }
    msgs.push({ role: 'user', content: question });

    const steps = [];
    let final = null;
    for (let i = 0; i <= MAX_STEPS && !final; i++) {
      const last = i === MAX_STEPS;
      if (last) msgs.push({ role: 'user', content: '查得够多了，现在根据已经查到的内容给出最后的回答（answer 格式）。' });
      const r = await deps.aiChat(msgs, { json: true, maxTokens: free ? 4000 : 2500 });
      let out = null;
      const m = /\{[\s\S]*\}/.exec(r.text);
      try { out = JSON.parse(m ? m[0] : r.text); } catch {}
      if (!out) { final = { answer: r.text.trim(), mood: '说话', actions: [] }; break; }
      if (typeof out.answer === 'string') { final = out; break; }
      const name = String(out.tool || '');
      if (!tools[name] || blind || last) {
        msgs.push({ role: 'assistant', content: JSON.stringify(out) });
        msgs.push({ role: 'user', content: blind ? '你现在没有工具可用，直接回答（answer 格式）。' : `没有"${name}"这个工具。可用：search、list、read、pages、stats。` });
        continue;
      }
      const say = String(out.say || '').slice(0, 80);
      steps.push({ tool: name, say });
      if (onStep) onStep({ tool: name, say, mood: '思考' });
      let result;
      try { result = tools[name](out.args || {}); } catch (e) { result = { 错误: e.message }; }
      msgs.push({ role: 'assistant', content: JSON.stringify(out) });
      msgs.push({ role: 'user', content: `工具 ${name} 的结果：\n${JSON.stringify(result).slice(0, 16000)}` });
    }
    if (!final) final = { answer: '……查着查着有点乱了，换个说法再问我一次吧。', mood: '困', actions: [] };

    // 做用户吩咐的事
    const actions = [];
    for (const a of (Array.isArray(final.actions) ? final.actions : []).slice(0, 6)) {
      if (!a || typeof a !== 'object' || blind) continue;
      if (a.type === 'launch') {
        const t = toolList.find(x => x.name === a.tool);
        if (t) actions.push({ type: 'launch', tool: t.name, id: t.id });
      } else if (a.type === 'open' || a.type === 'open_note') {
        const it = findItem(a.ref ? { ref: a.ref } : { title: a.note || a.title || a.file });
        if (it) actions.push({ type: 'open', kind: it.kind, id: it.id, name: it.name, title: it.title });
      } else if (a.type === 'create_note' && a.title && a.text) {
        const r = deps.createNote(d, String(a.title), String(a.text), a.page ? String(a.page) : '');
        actions.push({ type: 'create_note', title: String(a.title), ok: r.ok, id: r.id, page: r.page || '', message: r.message });
        if (r.ok) cat.notes.push({ kind: 'note', id: r.id, title: String(a.title), tags: [], text: String(a.text), saved: Date.now(), updated: Date.now(), page: r.page || '' });
      } else if (a.type === 'put_in_page' && a.page) {
        const items = (Array.isArray(a.refs) ? a.refs : []).map(n => findItem({ ref: n })).filter(Boolean)
          .concat((Array.isArray(a.titles) ? a.titles : []).map(t => findItem({ title: t })).filter(Boolean));
        if (!items.length) continue;
        const r = deps.putInPage(d, String(a.page), items.map(it => ({ kind: it.kind, id: it.kind === 'note' ? it.id : it.name })));
        actions.push({ type: 'put_in_page', page: String(a.page), count: items.length, ok: r.ok, created: r.created });
      }
    }
    const answer = String(final.answer || '');
    const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map(x => Number(x[1])));
    const mood = MOODS.includes(final.mood) ? final.mood : (cited.size ? '找到了' : '说话');
    return {
      ok: true, answer, mood, steps, actions, free,
      name: persona.名字,
      sources: sources.filter(s => cited.has(s.n)).map(({ key, ...s }) => s),
    };
  }

  return { run, MOODS, DEFAULT_PERSONA };
}

module.exports = { createButler, MOODS, DEFAULT_PERSONA, savedTime };
