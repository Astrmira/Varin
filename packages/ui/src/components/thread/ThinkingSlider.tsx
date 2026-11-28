import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { Icon } from '@/components/icon/Icon';
import { SwapText } from '@/components/motion/SwapText';
import { useMotionLevel } from '@/hooks/usePrefersReducedMotion';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { mountThinkingTrack, thinkingInset } from './thinking-track';
import './thinking-slider.css';

export interface ThinkingStop<T extends string> { id: T; name: string }
interface SliderProps<T extends string> {
  label: string; stops: readonly ThinkingStop<T>[]; value?: T; disabled?: boolean; budgetTokens?: number;
  onSelect(value: T): void | Promise<void>; children?: React.ReactNode;
}

/** A drag previews locally. Only its release, a label click, or a key commits a model choice. */
export function ThinkingSlider<T extends string>({ label, stops, value, disabled, budgetTokens, onSelect, children }: SliderProps<T>) {
  const { t } = useI18n();
  const track = React.useRef<HTMLDivElement>(null);
  const surface = React.useRef<ReturnType<typeof mountThinkingTrack>>(null);
  const drag = React.useRef<{ pointer: number; offset: number } | null>(null);
  const [preview, setPreview] = React.useState<number | null>(null);
  const [saving, setSaving] = React.useState<{ index: number } | null>(null);
  const motion = useMotionLevel();
  const last = stops.length - 1;
  const selected = stops.findIndex(stop => stop.id === value);
  const index = preview ?? saving?.index ?? selected;
  const stop = stops[index];
  const name = stop?.name ?? t('external.notReported');
  const budget = stop?.id === 'budget' && budgetTokens ? budgetTokens.toLocaleString(getCurrentIntlLocale()) + ' tokens' : '';
  const hasOff = stops[0]?.id === 'off';
  const target = Math.max(0, saving?.index ?? selected) / last;
  const initial = React.useRef({ target, motion });
  React.useLayoutEffect(() => {
    const owner = mountThinkingTrack(track.current!, last + 1, hasOff, initial.current.target, initial.current.motion);
    surface.current = owner;
    return () => { owner.dispose(); surface.current = null; };
  }, [last, hasOff]);
  React.useLayoutEffect(() => { surface.current?.setMotion(motion); }, [motion]);
  React.useLayoutEffect(() => { if (!drag.current) surface.current?.settle(target); }, [target, preview]);
  const release = React.useCallback((cancel: boolean) => {
    const active = drag.current;
    drag.current = null;
    if (active && track.current?.hasPointerCapture(active.pointer)) track.current.releasePointerCapture(active.pointer);
    setPreview(null);
    if (cancel) surface.current?.settle(target);
  }, [target]);
  React.useLayoutEffect(() => { if (disabled && drag.current) release(true); }, [disabled, release]);
  function commit(i: number) {
    if (disabled) return;
    const result = onSelect(stops[i].id);
    if (result) {
      const change = { index: i };
      setSaving(change);
      const finish = () => setSaving(current => current === change ? null : current);
      void result.then(finish, finish);
    }
  }
  return <div className="thinking-slider" style={{ '--thinking-inset': thinkingInset(hasOff) + 'px' } as React.CSSProperties}>
    <div className="thinking-slider-head"><span title={label}><Icon name="brain" className="size-3.5 shrink-0" /><span className="truncate">{label}</span></span>
      <strong>{name}{budget && <small> · {budget}</small>}</strong></div>
    <div className="thinking-slider-track" ref={track} role="slider" tabIndex={disabled ? -1 : 0}
      aria-orientation="horizontal" aria-label={label} aria-disabled={disabled || undefined}
      aria-valuemin={0} aria-valuemax={last} aria-valuenow={Math.max(index,0)} aria-valuetext={budget ? name + ', ' + budget : name}
      data-dragging={preview !== null || undefined} data-unreported={!stop || undefined}
      onPointerDown={event => {
        if (disabled || drag.current || event.button !== 0 || !surface.current) return;
        event.preventDefault();
        const offset = surface.current.grab(event.clientX);
        drag.current = { pointer: event.pointerId, offset };
        event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
        setPreview(surface.current.drag(event.clientX, offset));
      }}
      onPointerMove={event => {
        if (drag.current?.pointer === event.pointerId && surface.current) setPreview(surface.current.drag(event.clientX, drag.current.offset));
      }}
      onPointerUp={event => {
        if (drag.current?.pointer !== event.pointerId || !surface.current) return;
        const next = surface.current.drag(event.clientX, drag.current.offset);
        release(false); commit(next);
      }}
      onPointerCancel={event => { if (drag.current?.pointer === event.pointerId) release(true); }}
      onLostPointerCapture={event => { if (drag.current?.pointer === event.pointerId) release(true); }}
      onKeyDownCapture={event => {
        if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); release(true); return; }
        if (disabled || drag.current) return;
        const steps: Record<string, number> = { ArrowLeft:index-1, ArrowDown:index-1, PageDown:index-1, ArrowRight:index+1, ArrowUp:index+1, PageUp:index+1, Home:0, End:last };
        if (Object.hasOwn(steps,event.key)) { event.preventDefault(); event.stopPropagation(); commit(Math.max(0, Math.min(last,steps[event.key]))); }
      }}>
      <span className="thinking-slider-thumb" aria-hidden="true" />
    </div>
    <div className="thinking-slider-labels">{stops.map((item,i) => <button type="button" key={item.id} disabled={disabled} tabIndex={-1}
      aria-current={index === i} title={item.name} style={{ left: (100*i/last) + '%', maxWidth: i === 0 || i === last ? '58px' : (100/last) + '%' }}
      onClick={() => { commit(i); track.current?.focus({ preventScroll: true }); }}>{item.name}</button>)}</div>
    {children}
  </div>;
}

export function ThinkingControl<T extends string>(props: SliderProps<T> & { onOpen?(): void; badge?: string; triggerLabel?: string }) {
  const name = props.stops.find(stop => stop.id === props.value)?.name ?? props.value ?? props.label;
  if (props.stops.length < 2) {
    const only = props.stops[0];
    return only && only.id !== 'off' ? <span className="thinking-control text-muted-foreground">
      <Icon name="brain" className="size-3.5" />{only.name}{only.id === 'budget' && props.budgetTokens ? ' · ' + props.budgetTokens.toLocaleString(getCurrentIntlLocale()) + ' tokens' : ''}
    </span> : null;
  }
  return <Popover.Root modal={false} onOpenChange={open => { if (open) props.onOpen?.(); }}>
    <Popover.Trigger disabled={props.disabled} aria-label={props.triggerLabel ?? props.label} title={props.label + ' · ' + name}
      className="thinking-control rounded-md text-muted-foreground hover:bg-interactive-hover data-[popup-open]:bg-interactive-hover">
      <Icon name="brain" className="size-3.5 shrink-0" /><span className="truncate"><SwapText text={name} hold={0} resize /></span>
      {props.badge && <small>{props.badge}</small>}
    </Popover.Trigger>
    <Popover.Portal><Popover.Positioner side="top" align="end" sideOffset={7} collisionPadding={8} className="z-50">
      <Popover.Popup aria-label={props.label} className="thinking-slider-popup motion-popover" initialFocus={kind => kind === 'keyboard'}>
        <ThinkingSlider key={JSON.stringify(props.stops.map(item => item.id))} {...props} />
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}
