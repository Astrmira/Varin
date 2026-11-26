import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import light from '@/lib/theme/themes/varin-light.json';
import dark from '@/lib/theme/themes/varin-dark.json';
import type { Theme } from '@/types/theme';
import '@/index.css';
import '@/workbenches/bot/bot-group-chat.css';
import { Compose, Glyph, IconButton, type Draft } from './controls';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { DocumentPage, Inbox, RoomDetails, Services, Timeline } from './screens';
import { fileName, initialRooms, isGroup, type Mode, type Person, type Room } from './sample';
import { initialBots, makeBot, Roster } from './roster';
import type { BotAppearance } from '@varin/application-client';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { previewRuntime } from './runtime';
import { PreviewBotPanel } from './bot-panel';
import { ConversationHeading } from './conversation-heading';
import './preview.css';
import './conversation-motion.css';

const themeCss = new CSSVariableGenerator();
const style = document.createElement('style');
style.textContent = ':root{' + themeCss.generate(light as Theme) + '}:root.dark{' + themeCss.generate(dark as Theme) + '}';
document.head.append(style);

type Page = 'list' | 'chat' | 'details' | 'file' | 'settings';
type Route = { page: Page; id: string; mode: Mode; tab?: string };
type Entry = { mobilePreview: true; route: Route; depth: number; chatDepth: number };
type Notes = Record<string, Draft>;
const initial: Route = { page: 'chat', id: 'outline', mode: 'bot' };
function load<T,>(key: string, fallback: T): T {
  try { return JSON.parse(sessionStorage.getItem('design.' + key) ?? 'null') ?? fallback; } catch { return fallback; }
}
function store(key: string, value: unknown) { sessionStorage.setItem('design.' + key, JSON.stringify(value)); }
function entry(route: Route, depth: number): Entry {
  return { mobilePreview: true, route, depth, chatDepth: route.page === 'chat' ? depth : history.state?.chatDepth ?? 0 };
}
if (!history.state?.mobilePreview) {
  const linked = initialRooms.find(r => r.id === new URLSearchParams(location.search).get('room'));
  const route = linked ? { ...initial, id: linked.id, mode: linked.mode } : load('lastChat', initial);
  history.replaceState(entry({ ...route, page: 'list' }, 0), '');
  history.pushState(entry(route, 1), '');
}

function usePreviewRoute() {
  const [route, setRoute] = React.useState<Route>(history.state.route);
  const latest = React.useRef<Entry>(history.state);
  const animation = React.useRef<ViewTransition | null>(null);
  const show = React.useCallback((next: Entry) => {
    const prior = latest.current;
    latest.current = next;
    animation.current?.skipTransition();
    const changed = prior.route.page !== next.route.page || prior.route.id !== next.route.id;
    if (!changed || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRoute(next.route);
      return;
    }
    const pages = [prior.route.page, next.route.page];
    const panel = prior.route.id === next.route.id && pages.includes('chat') && pages.includes('details');
    const direction = next.depth < prior.depth ? 'back' : 'forward';
    if (!document.startViewTransition) {
      flushSync(() => setRoute(next.route));
      const screen = document.querySelector('.device .content, .device:not(.split) .list-pane:not([hidden])');
      const offset = direction === 'back' ? -12 : 12;
      screen?.animate([{ opacity: .7, transform: panel ? 'translateY(' + offset + 'px)' : 'translateX(' + offset + 'px)' },
        { opacity: 1, transform: 'none' }], { duration: 230, easing: 'cubic-bezier(.22,1,.36,1)' });
      return;
    }
    const root = document.documentElement;
    root.dataset.previewMotion = (panel ? 'panel-' : '') + direction;
    const active = document.startViewTransition(() => {
      if (latest.current === next) flushSync(() => setRoute(next.route));
    });
    animation.current = active;
    void active.ready.catch(() => {}); // Rapid navigation may skip the previous snapshot.
    void active.finished.finally(() => {
      if (animation.current !== active) return;
      animation.current = null;
      delete root.dataset.previewMotion;
    });
  }, []);
  React.useEffect(() => {
    const pop = () => { if (history.state?.mobilePreview) show(history.state); };
    window.addEventListener('popstate', pop);
    return () => { window.removeEventListener('popstate', pop); animation.current?.skipTransition(); };
  }, [show]);
  return { route, show };
}

function App() {
  const { route, show } = usePreviewRoute();
  const [rooms, setRooms] = React.useState(() => load('rooms', initialRooms));
  const [bots, setBots] = React.useState(() => load('bots', initialBots));
  const [notes, setNotes] = React.useState<Notes>(() => load('drafts', {}));
  const [theme, setTheme] = React.useState(() => load('theme', 'light'));
  const [width, setWidth] = React.useState<'phone' | 'tablet'>(() => load('width',
    matchMedia('(min-width: 760px) and (pointer: coarse)').matches ? 'tablet' : 'phone'));
  const [wideWindow, setWideWindow] = React.useState(false);
  const [models, setModels] = React.useState<Record<string, string>>({});
  const [efforts, setEfforts] = React.useState<Record<string, string>>({});
  const [diffOpen, setDiffOpen] = React.useState(false);
  const scroll = React.useRef<HTMLDivElement>(null);
  const editor = React.useRef<ComposerEditorHandle>(null);
  const offsets = React.useRef(new Map<string, number>());
  const focusOnReturn = React.useRef(false);
  const room = rooms.find(r => r.id === route.id) ?? rooms[0];
  const group = isGroup(room);
  const bot = bots.find(b => b.id === room.people[0]) ?? bots[0];
  const draft = notes[room.id] ?? { text: '' };
  const split = width === 'tablet' && wideWindow;
  React.useEffect(() => {
    const media = matchMedia('(min-width: 760px)');
    const update = () => setWideWindow(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  React.useEffect(() => { store('rooms', rooms); }, [rooms]);
  React.useEffect(() => { store('bots', bots); }, [bots]);
  React.useEffect(() => { store('drafts', notes); }, [notes]);
  React.useLayoutEffect(() => { document.documentElement.classList.toggle('dark', theme === 'dark'); store('theme', theme); }, [theme]);
  React.useEffect(() => { store('width', width); }, [width]);
  React.useLayoutEffect(() => {
    if (route.page === 'chat') store('lastChat', route);
    const el = scroll.current;
    if (el) el.scrollTop = offsets.current.get(room.id) ?? el.scrollHeight;
    if (el && focusOnReturn.current) {
      focusOnReturn.current = false;
      focusEditor();
    }
  }, [route, room.id]);
  function nav(next: Route, replace = false) {
    const depth = history.state?.depth ?? 0;
    const target = entry(next, replace ? depth : depth + 1);
    if (replace) history.replaceState(target, '');
    else history.pushState(target, '');
    show(target);
  }
  function back() {
    if (history.state?.depth) history.back();
    else nav({ ...route, page: 'list' }, true);
  }
  function open(id: string) {
    const target = rooms.find(r => r.id === id);
    if (target) nav({ page: 'chat', id, mode: target.mode });
  }
  function mode(m: Mode) {
    const first = rooms.find(r => r.mode === m)!;
    nav({ page: split ? 'chat' : 'list', mode: m, id: first.id }, true);
  }
  function newChat(person?: Person, fork?: number) {
    const child: Room = { id: crypto.randomUUID(), title: fork !== undefined ? room.title + ' · 分支' : route.mode === 'work' ? '新任务' : '新会话',
      time: '刚刚', people: [person ?? room.people[0]], mode: route.mode, messages: fork !== undefined ? room.messages.slice(0, fork + 1) : [] };
    setRooms(prev => [child, ...prev]); nav({ ...route, id: child.id, page: 'chat' });
  }
  function edit(d: Draft) { setNotes(prev => ({ ...prev, [room.id]: d })); }
  function createBot(name: string, appearance?: BotAppearance) {
    const id = crypto.randomUUID();
    setBots(prev => [...prev, makeBot(id, name, appearance)]);
    newChat(id);
  }
  function createGroup(title: string, people: string[]) {
    const id = crypto.randomUUID();
    setRooms(prev => [{ id, title, mode: 'bot', group: true, people, messages: [], time: '刚刚' }, ...prev]);
    nav({ page: 'chat', mode: 'bot', id });
  }
  function answer(index: number, value: string) {
    setRooms(prev => prev.map(r => r.id === room.id ? { ...r, messages: [
      ...r.messages.map((m, i) => i === index ? { ...m, answer: value } : m), { who: '我', text: value },
    ] } : r));
  }
  function send() {
    if (!draft.text.trim() && !draft.attachment) return;
    setRooms(prev => [{ ...room, time: '刚刚', title: group || room.messages.length ? room.title : (draft.text.trim() || draft.attachment || room.title).slice(0, 22),
      messages: [...room.messages, { who: '我', text: draft.text.trim(), quote: draft.quote, attachment: draft.attachment }] }, ...prev.filter(r => r.id !== room.id)]);
    edit({ text: '' }); requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; });
  }
  const effectivePage = split && route.page === 'list' ? 'chat' : route.page;
  const file = () => nav({ ...route, page: 'file' });
  const focusEditor = () => requestAnimationFrame(() => {
    const input = editor.current;
    if (!input) return;
    input.setSelection(input.getValue().length);
    input.focus({ preventScroll: true });
  });
  function quoteFile(text: string) {
    edit({ ...draft, quote: text });
    focusOnReturn.current = true;
    history.go(history.state.chatDepth - history.state.depth);
  }
  function mentionMember(id: string) {
    const name = bots.find(b => b.id === id)?.name;
    if (!name) return;
    edit({ ...draft, text: [draft.text.trimEnd(), '@' + name + ' '].filter(Boolean).join(' ') });
    focusOnReturn.current = true;
    history.go(history.state.chatDepth - history.state.depth);
  }
  const inbox = <Inbox mode={route.mode} selected={room.id} rooms={rooms} changeMode={mode} open={open} create={p => newChat(p)} createBot={createBot} createGroup={createGroup}
    settings={() => nav({ ...route, page: 'settings' })} />;
  return <Roster.Provider value={bots}><div className="studio">
    <nav className="preview-tools" aria-label="设计稿预览"><div className="switcher"><button aria-pressed={width === 'phone'} onClick={() => setWidth('phone')}><Glyph name="smartphone" />手机</button>
      <button aria-pressed={width === 'tablet'} onClick={() => setWidth('tablet')}><Glyph name="layout-column" />平板</button></div>
      <IconButton label="切换明暗主题" name={theme === 'light' ? 'moon' : 'palette'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} /></nav>
    <main className={'device' + (split ? ' split' : '')}>
      <div className="list-pane" hidden={!split && effectivePage !== 'list'}>{inbox}</div>
      {effectivePage !== 'list' && <section key={effectivePage + room.id} className="screen content">
        {effectivePage === 'chat' ? <ConversationHeading room={room} back={split ? undefined : back}
          details={() => nav({ ...route, page: 'details' })} services={room.mode === 'work' && <Services />} /> : <header className="page-bar">
          <IconButton name="arrow-left" label="返回" onClick={back} />
          <h1>{effectivePage === 'file' ? fileName : effectivePage === 'settings' ? '设置' : group ? '群聊详情' : room.mode === 'bot' ? 'Bot 面板' : '会话详情'}</h1>
        </header>}
        {effectivePage === 'chat' ? <>
          <div ref={scroll} className="screen-body conversation-scroll" onScroll={event => offsets.current.set(room.id, event.currentTarget.scrollTop)}>
            <Timeline room={room} openFile={file} answer={answer} quote={m => { edit({ ...draft, quote: m.who + ' · ' + m.text }); focusEditor(); }} branch={i => newChat(undefined, i)} />
            {!room.messages.length && <div className="welcome"><h2>{group ? '用 @ 叫一个成员来接话。' : room.mode === 'work' ? '我们要做什么？' : '和' + bot.name + '聊点什么'}</h2></div>}
          </div><Compose editor={editor} room={room} draft={draft} change={edit} send={send} model={models[room.id] ?? 'DeepSeek V4.1 Flash'} setModel={v => setModels({ ...models, [room.id]: v })}
            effort={efforts[room.id] ?? '高'} setEffort={v => setEfforts({ ...efforts, [room.id]: v })} /></> :
          effectivePage === 'details' && !group && room.mode === 'bot' ? <PreviewBotPanel bot={bot} room={room} rooms={rooms} open={open} openFile={file}
            updateBot={next => setBots(prev => prev.map(b => b.id === next.id ? next : b))} newChat={() => newChat(bot.id)} /> :
          <div className="screen-body">{effectivePage === 'file' ? <DocumentPage reply={quoteFile} /> : effectivePage === 'settings' ?
            <div className="detail-body"><h3>外观</h3><div className="switcher">{['light', 'dark'].map(v => <button key={v} aria-pressed={theme === v} onClick={() => setTheme(v)}>{v === 'dark' ? '深色' : '浅色'}</button>)}</div></div> :
            <RoomDetails room={room} open={open} openFile={file} mention={mentionMember} files={diffOpen} setFiles={setDiffOpen}
              selectedTab={route.tab} selectTab={tab => nav({ ...route, tab }, true)} />}</div>}
      </section>}
    </main>
  </div></Roster.Provider>;
}
void useI18nStore.getState().setLocale('zh-CN').then(() => {
  createRoot(document.getElementById('root')!).render(<I18nProvider><TooltipProvider><RuntimeAPIContext.Provider value={previewRuntime}><App /></RuntimeAPIContext.Provider></TooltipProvider></I18nProvider>);
});
