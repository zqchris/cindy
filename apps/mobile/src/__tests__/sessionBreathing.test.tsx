// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ reduced: false as boolean | null, start: vi.fn(), stop: vi.fn(),
  timing: vi.fn((_value: unknown, options: unknown) => options) }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => h.reduced }));
vi.mock('react-native', () => ({
  Animated: {
    Value: class { value: number; constructor(value: number) { this.value = value; } setValue(value: number) { this.value = value; } stopAnimation() {} },
    timing: h.timing,
    sequence: (steps: unknown) => steps,
    loop: () => ({ start: h.start, stop: h.stop }),
    View: ({ style }: any) => createElement('i', { 'data-opacity': style.opacity.value }),
  },
  Easing: { ease: 'ease', inOut: (value: unknown) => `inOut(${value})` },
  View: ({ children, testID, accessibilityLabel }: any) => createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/theme', () => ({ radius: { pill: 9999 }, useTheme: () => ({ colors: {} }) }));
vi.mock('@/components/MobileAgentMark', () => ({ MobileAgentMark: () => null }));
vi.mock('@/session/RemoteSourceMark', () => ({ RemoteSourceMark: () => null }));
import { TeammateStatusDot } from '@/session/TeammateStatusDot';
import { MobileVendorIcon } from '@/components/MobileVendorIcon';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  h.reduced = false; vi.clearAllMocks();
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

// Unit: preserve task/teammate animation behavior across the shared-hook extraction.
// The old Home guard only looked for an inline easing literal in the task icon file.
it.each(['task', 'teammate'] as const)('keeps the established native breath on the %s', kind => {
  act(() => root.render(kind === 'task' ? <MobileVendorIcon vendor="codex" running /> : <TeammateStatusDot status="running" />));
  expect(h.start).toHaveBeenCalledOnce();
  expect(host.querySelector('i')?.getAttribute('data-opacity')).toBe('0.3');
  expect(h.timing.mock.calls.map(([, options]) => options)).toEqual([
    { toValue: 1, duration: 750, easing: 'inOut(ease)', useNativeDriver: true },
    { toValue: 0.3, duration: 750, easing: 'inOut(ease)', useNativeDriver: true },
  ]);
});

// Unit: the former solid dot never started an animation. Exercise the real dot +
// shared hook; roster tests cover status priority but replace native animation.
it('starts only while running and stops when the result becomes unread', () => {
  act(() => root.render(<TeammateStatusDot status="running" />));
  expect(h.start).toHaveBeenCalledOnce();
  act(() => root.render(<TeammateStatusDot status="done" />));
  expect(h.stop).toHaveBeenCalledOnce();
  expect(host.querySelector('[data-testid="teammate.status.done"]')).not.toBeNull();
  act(() => root.render(<TeammateStatusDot status="unread" />));
  expect(host.querySelector('i')?.getAttribute('data-opacity')).toBe('1');
  expect(h.start).toHaveBeenCalledOnce();
  act(() => root.render(<TeammateStatusDot status="idle" />));
  expect(host.childElementCount).toBe(0);
});

it.each([true, null])('keeps the running signal static with reduced motion %s', reduced => {
  h.reduced = reduced;
  act(() => root.render(<TeammateStatusDot status="running" />));
  expect(h.start).not.toHaveBeenCalled();
  expect(host.querySelector('i')?.getAttribute('data-opacity')).toBe('1');
});

it('stops the loop on unmount', () => {
  act(() => root.render(<TeammateStatusDot status="running" />));
  act(() => root.render(null));
  expect(h.stop).toHaveBeenCalledOnce();
});

it('stops and resumes when the accessibility preference changes', () => {
  act(() => root.render(<TeammateStatusDot status="running" />));
  h.reduced = true;
  act(() => root.render(<TeammateStatusDot status="running" />));
  expect(h.stop).toHaveBeenCalledOnce();
  h.reduced = false;
  act(() => root.render(<TeammateStatusDot status="running" />));
  expect(h.start).toHaveBeenCalledTimes(2);
});
