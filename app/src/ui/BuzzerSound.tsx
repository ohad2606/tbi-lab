/**
 * Optional sound for sounding buzzers (Sprint 10). PRESENTATION ONLY: the electrical model decides
 * whether a buzzer sounds (engine `state.sounding`); this only lets the user hear it.
 *
 * - Off by default; it never starts on its own. The audio context is created by the click that
 *   turns sound on (browsers allow audio only after a user gesture), so there is no autoplay.
 * - The toggle is the mute: one click silences everything at once.
 * - The tone is the part's rated frequency (CEM-1205-IC: 2400 Hz) at a low level.
 * - The choice is a per-browser convenience (localStorage), never project data.
 * Tests read `data-audible` (which buzzers would be heard), never actual audio output.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { BUZZER_TONE_HZ } from '@tbi-lab/engine';
import { useAppState, useT } from './context.js';

const KEY = 'tbi-lab.sound';
const readPref = () => {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
};

export function BuzzerSound() {
  const { doc, sim } = useAppState();
  const t = useT();
  const [on, setOn] = useState(false);
  const audio = useRef<{ ctx: AudioContext; osc: OscillatorNode; gain: GainNode } | null>(null);
  const buzzers = doc?.components.filter((c) => c.type === 'component.buzzer') ?? [];
  const outcome = sim.status === 'running' && sim.outcome.ok ? sim.outcome : null;
  const audible = outcome
    ? buzzers.filter((c) => outcome.components[c.id]?.state?.sounding === true).map((c) => c.id)
    : [];
  const sounding = on && audible.length > 0;

  // The remembered preference applies only after a click in this page (no autoplay).
  const remembered = useRef(readPref());

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    a.gain.gain.setTargetAtTime(sounding ? 0.04 : 0, a.ctx.currentTime, 0.01);
  }, [sounding]);

  useEffect(
    () => () => {
      void audio.current?.ctx.close();
      audio.current = null;
    },
    [],
  );

  if (buzzers.length === 0) return null;
  const toggle = () => {
    const next = !on;
    setOn(next);
    try {
      localStorage.setItem(KEY, next ? 'on' : 'off');
    } catch {
      /* a per-browser convenience only */
    }
    if (next && !audio.current && typeof AudioContext !== 'undefined') {
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = BUZZER_TONE_HZ;
        gain.gain.value = 0;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        audio.current = { ctx, osc, gain };
      } catch {
        /* no audio device: the toggle still shows the state */
      }
    }
  };
  return (
    <button
      type="button"
      class="button sound-toggle"
      data-testid="sound-toggle"
      aria-pressed={on ? 'true' : 'false'}
      data-audible={audible.join(' ')}
      data-remembered={remembered.current ? 'on' : 'off'}
      title={t(on ? 'sound.on.hint' : 'sound.off.hint')}
      onClick={toggle}
    >
      {t(on ? 'sound.on' : 'sound.off')}
    </button>
  );
}
