import React from 'react';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Choices, Face, Flyout, Glyph, IconButton } from './controls';
import { fileName, outline, people, type Message, type Mode, type Room, type Person } from './sample';

export function Inbox({ mode, changeMode, rooms, selected, open, create, settings }: {
  mode: Mode; changeMode(m: Mode): void; rooms: Room[]; selected: string; open(id: string): void; create(name?: Person): void; settings(): void;
}) {
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState('全部');
  const [expanded, setExpanded] = React.useState(false);
  const visible = rooms.filter(r => r.mode === mode && (mode === 'work' || filter === '全部' || r.people.some(p => p === filter))
    && (r.title + r.people.join('') + r.messages.map(m => m.text).join('')).toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="screen inbox">
    <header className="page-bar"><h1>会话</h1><div className="bar-actions"><IconButton name="settings-3" label="设置" onClick={settings} />
      {mode === 'bot' ? <Choices label="新建会话" trigger={<Glyph name="chat-new" />} values={people} onSelect={p => create(p as Person)} /> :
        <IconButton name="chat-new" label="新建任务" onClick={() => create()} />}</div></header>
    <div className="list-tools"><div className="switcher">{(['bot', 'work'] as const).map(m => <button key={m} aria-pressed={mode === m} onClick={() => { setQuery(''); changeMode(m); }}><Glyph name={m === 'bot' ? 'varin' : 'workbench-agent'} />{m === 'bot' ? 'Bot' : '工作台'}</button>)}</div>
      <label className="find"><Glyph name="search" /><input type="search" aria-label="搜索会话" placeholder="搜索会话" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    <div className="screen-body"><div className="list-heading"><span>{mode === 'bot' ? '最近' : 'Varin · 演示项目'}</span>
      {mode === 'bot' && <Choices label="筛选 Bot" trigger={<>{filter === '全部' ? '全部 Bot' : filter}<Glyph name="arrow-down-s" /></>} values={['全部', ...people]} selected={filter} onSelect={setFilter} />}</div>
      {visible.filter(r => !r.parent || expanded || query).map(r => <div className={'room-row' + (r.parent ? ' child' : '')} key={r.id}>
        <button onClick={() => open(r.id)} className="room-link" aria-current={r.id === selected ? 'page' : undefined}>
          {mode === 'bot' ? <span className="list-face"><Face names={r.people} size={r.people.length > 1 ? 26 : 37} /></span> : <span className="work-icon"><Glyph name={r.parent ? 'git-branch' : 'chat-thread'} /></span>}
          <span className="room-copy"><strong>{r.title}</strong><small>{r.messages.some(m => m.choices && !m.answer) && <span className="needs-reply">等你回复 · </span>}{r.messages.at(-1)?.text || '新会话'}</small></span><time>{r.time}</time></button>
        {mode === 'work' && rooms.some(child => child.parent === r.id) && <button className="child-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Glyph name={expanded ? 'arrow-down-s' : 'arrow-right-s'} />1 个子任务</button>}
      </div>)}
      {!visible.length && <p className="empty">没有匹配的会话</p>}
    </div>
  </section>;
}

export function Services() {
  const [tab, setTab] = React.useState('用量');
  return <Flyout label="用量和 MCP" trigger={<Glyph name="stack" />}>{close => <div className="services">
    <div className="service-head"><div className="switcher">{['用量', 'MCP'].map(t => <button aria-pressed={t === tab} key={t} onClick={() => setTab(t)}>{t}</button>)}</div><IconButton name="close" label="关闭" onClick={close} /></div>
    {tab === '用量' ? <><h3>本次会话</h3><p>输入 <b>12,480</b></p><p>输出 <b>368</b></p><p>缓存读取 <b>9,216</b></p></> : <><h3>MCP 连接</h3><p><span><Glyph name="github" /> GitHub</span><small>已连接</small></p></>}
  </div>}</Flyout>;
}

export function DocumentLink({ open }: { open(): void }) {
  return <button className="doc-link" onClick={open}><span className="doc-icon"><Glyph name="file-text" /></span><span><strong>{fileName}</strong><small>Markdown 文档</small></span><Glyph name="arrow-right-s" /></button>;
}

export function Timeline({ room, openFile, quote, branch, answer }: {
  room: Room; openFile(): void; quote(m: Message): void; branch(index: number): void; answer(index: number, value: string): void;
}) {
  const group = room.people.length > 1;
  return <div className="timeline"><div className="day">{room.time.includes(':') ? '今天' : room.time}</div>
    {room.messages.map((m, i) => {
      const self = m.who === '我';
      return <article key={i} className={'turn ' + (self ? 'own' : '') + (group ? ' group-turn' : '')}>
        {!self && <div className="byline"><Face names={[m.who as Person]} size={group ? 25 : 20} />{m.who}</div>}
        {m.process && <details className="process"><summary><Glyph name="arrow-right-s" />工作过程</summary>{m.process.map(step => <p key={step}><Glyph name="check" />{step}</p>)}</details>}
        <ContextMenu><ContextMenuTrigger render={<div className={group ? 'group-chat-bubble message' : 'message'} tabIndex={0} />}>
          {m.quote && <blockquote>{m.quote}</blockquote>}{m.text}{m.attachment && <small className="sent-file"><Glyph name="attachment-2" />{m.attachment}</small>}
        </ContextMenuTrigger><ContextMenuContent><ContextMenuItem onClick={() => quote(m)}><Glyph name="chat-quote" />引用回复</ContextMenuItem>
          <ContextMenuItem onClick={() => void navigator.clipboard.writeText(m.text)}><Glyph name="clipboard" />复制</ContextMenuItem>
          {!group && <ContextMenuItem onClick={() => branch(i)}><Glyph name="git-branch" />从这里分支</ContextMenuItem>}
        </ContextMenuContent></ContextMenu>
        {m.file && <DocumentLink open={openFile} />}
        {m.choices && !m.answer && <div className="answer-choices">{m.choices.map(v => <Button variant="outline" size="sm" key={v} onClick={() => answer(i, v)}>{v}</Button>)}</div>}
      </article>;
    })}
  </div>;
}

export function RoomDetails({ room, open, openFile, files, setFiles, selectedTab, selectTab }: {
  room: Room; open(id: string): void; openFile(): void; files: boolean; setFiles(v: boolean): void;
  selectedTab?: string; selectTab(tab: string): void;
}) {
  const group = room.people.length > 1;
  const tabs = group ? ['成员', '协作', '日程'] : room.mode === 'work' ? ['任务', '文件', '改动'] : ['工作', '日程'];
  const tab = selectedTab && tabs.includes(selectedTab) ? selectedTab : tabs[0];
  return <div className="detail-body">
    <div className="profile"><Face names={room.people} size={42} /><h2>{group ? room.title : room.mode === 'work' ? room.title : room.people[0]}</h2>
      <small>{group ? '3 位成员' : room.mode === 'work' ? 'Varin · 演示项目' : room.title}</small></div>
    <div className="switcher detail-tabs">{tabs.map(t => <button key={t} aria-pressed={t === tab} onClick={() => selectTab(t)}>{t}</button>)}</div>
    {tab === '成员' ? room.people.map(p => <div key={p} className="person-row"><Face names={[p]} size={30} /><strong>{p}</strong><small>提及时接收</small></div>) :
      !['outline', 'group', 'check', 'review'].includes(room.id) ? <p className="empty">暂无{tab}</p> :
      tab === '日程' ? <div className="info-row"><Glyph name="calendar" /><span>合作方演示彩排<small>今天 14:30</small></span></div> :
      tab === '改动' ? <><button className="info-row" aria-expanded={files} onClick={() => setFiles(!files)}><Glyph name="git-branch" /><span>{fileName}</span><Glyph name={files ? 'arrow-down-s' : 'arrow-right-s'} /></button>
        {files && <div className="diff"><del>− 先演示群聊分工</del><ins>+ 先用手机连接桌面</ins></div>}</> : tab === '文件' ? <DocumentLink open={openFile} /> :
      <><button className="info-row" onClick={() => open(room.id === 'check' ? 'review' : 'check')}><Glyph name="task" /><span>{room.id === 'check' ? '演示前走查' : '群聊走查'}<small>{room.id === 'check' ? '所属任务' : '蓝汐 · 已完成'}</small></span><Glyph name="arrow-right-s" /></button>
        {room.mode === 'bot' && <button className="info-row" onClick={() => group ? open('outline') : open('group')}><Glyph name={group ? 'chat-1' : 'group'} /><span>{group ? '合作演示' : '演示筹备群'}<small>关联会话</small></span><Glyph name="arrow-right-s" /></button>}</>}
  </div>;
}

export function DocumentPage({ reply }: { reply(text: string): void }) {
  return <div className="document"><div className="paper"><small>Markdown</small><h1>合作演示提纲</h1>
    {outline.map(([title, body]) => <section key={title}><h2>{title}</h2><p>{body}</p></section>)}</div>
    <Button variant="outline" onClick={() => reply(window.getSelection()?.toString().trim() || fileName)}><Glyph name="chat-quote" />引用到对话</Button>
  </div>;
}
