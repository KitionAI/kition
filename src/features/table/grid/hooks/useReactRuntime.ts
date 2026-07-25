import type { DependencyList, Dispatch, EffectCallback, RefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

export type MousePosition = {
  docX: number;
  docY: number;
  posX: number;
  posY: number;
  elX: number;
  elY: number;
  elH: number;
  elW: number;
};

export function useUnmount(callback: () => void): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  useEffect(() => () => callbackRef.current(), []);
}

export function useUpdateEffect(effect: EffectCallback, dependencies?: DependencyList): void {
  const firstRenderRef = useRef(true);
  const isFirstRender = firstRenderRef.current;
  firstRenderRef.current = false;
  useEffect(() => {
    if (!isFirstRender) return effect();
  }, dependencies);
}

export function useRafState<State>(
  initialState: State | (() => State),
): [State, Dispatch<SetStateAction<State>>] {
  const frameRef = useRef(0);
  const [state, setState] = useState(initialState);
  const setRafState = useCallback<Dispatch<SetStateAction<State>>>((value) => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => setState(value));
  }, []);
  useUnmount(() => cancelAnimationFrame(frameRef.current));
  return [state, setRafState];
}

export function useMousePosition(ref: RefObject<Element | null>): MousePosition {
  const [position, setPosition] = useRafState<MousePosition>({
    docX: 0,
    docY: 0,
    posX: 0,
    posY: 0,
    elX: 0,
    elY: 0,
    elH: 0,
    elW: 0,
  });

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      const element = ref.current;
      if (!element) return;
      const { left, top, width, height } = element.getBoundingClientRect();
      const posX = left + window.scrollX;
      const posY = top + window.scrollY;
      setPosition({
        docX: event.pageX,
        docY: event.pageY,
        posX,
        posY,
        elX: event.pageX - posX,
        elY: event.pageY - posY,
        elH: height,
        elW: width,
      });
    };
    document.addEventListener('mousemove', handleMove);
    return () => document.removeEventListener('mousemove', handleMove);
  }, [ref, setPosition]);

  return position;
}
