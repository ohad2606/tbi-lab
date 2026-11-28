import { useLayoutEffect, useRef } from 'preact/hooks';
import { useAppState, useStore } from './context.js';
import { useAnnounce } from './useAnnounce.js';

/**
 * The polite status of a selection list (Wires, Junctions). A message belongs to the selection the
 * list made and to the mode it was made in: a selection from elsewhere, or several-selection
 * turning on or off, clears it without announcing anything.
 */
export function useListStatus(severalOn: boolean): [string, (text: string) => void] {
  const { selection } = useAppState();
  const store = useStore();
  const [message, say, clear] = useAnnounce();
  const selected = JSON.stringify(selection);
  const saidFor = useRef(selected);
  useLayoutEffect(() => {
    if (saidFor.current !== selected) clear();
  }, [selected]);
  useLayoutEffect(() => clear(), [severalOn]);
  /** Call after the selection the message describes has been made. */
  const announce = (text: string) => {
    saidFor.current = JSON.stringify(store.state.selection);
    say(text);
  };
  return [message, announce];
}
