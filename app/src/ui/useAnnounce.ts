import { useRef, useState } from 'preact/hooks';

/**
 * Text for a polite live region (WCAG 4.1.3): clear, then set on the next frame with an
 * alternating trailing nbsp, so the same message twice in a row is still announced.
 */
export function useAnnounce(): [string, (text: string) => void] {
  const [message, setMessage] = useState('');
  const raf = useRef(0);
  const flip = useRef(false);
  const announce = (text: string) => {
    cancelAnimationFrame(raf.current);
    setMessage('');
    flip.current = !flip.current;
    raf.current = requestAnimationFrame(() => setMessage(text + (flip.current ? ' ' : '')));
  };
  return [message, announce];
}
