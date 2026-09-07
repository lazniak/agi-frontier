/**
 * Gyroscope parallax — the chart's layers drift by a few pixels with device tilt, which reads
 * as depth without ever moving anything far enough to mislead. Off when the user asked for
 * reduced motion, and completely inert when no sensor exists.
 */
import type { LayerName } from '../chart';
import { el, prefersReducedMotion } from '../dom';

/** Per-layer amplitude in px — grid barely moves, labels move most. */
const DEPTH: Record<LayerName, number> = {
  grid: 2,
  stripes: 3,
  fans: 4,
  lines: 6,
  points: 6,
  markers: 5,
  labels: 8,
  pace: 2,
  overlay: 1,
};

const MAX = 8;
const LERP = 0.08;

interface IOSOrientation {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
}

export interface ParallaxApi {
  destroy(): void;
}

export function initParallax(layers: Record<LayerName, SVGGElement>, host: HTMLElement): ParallaxApi {
  if (prefersReducedMotion() || typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
    return { destroy(): void {} };
  }

  let targetX = 0;
  let targetY = 0;
  let curX = 0;
  let curY = 0;
  let raf = 0;
  let running = false;
  let sawEvent = false;

  const clamp = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

  const onOrient = (ev: DeviceOrientationEvent): void => {
    if (ev.gamma === null && ev.beta === null) return;
    sawEvent = true;
    // gamma = left/right tilt (−90…90); beta = front/back (−180…180), 45° is a natural hold.
    targetX = clamp((ev.gamma ?? 0) / 28);
    targetY = clamp(((ev.beta ?? 45) - 45) / 28);
    start();
  };

  const tick = (): void => {
    curX += (targetX - curX) * LERP;
    curY += (targetY - curY) * LERP;
    for (const [name, depth] of Object.entries(DEPTH) as [LayerName, number][]) {
      const g = layers[name];
      if (!g) continue;
      const dx = Math.max(-MAX, Math.min(MAX, curX * depth));
      const dy = Math.max(-MAX, Math.min(MAX, curY * depth * 0.6));
      g.style.transform = `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0)`;
    }
    if (Math.abs(targetX - curX) < 0.001 && Math.abs(targetY - curY) < 0.001) {
      running = false;
      raf = 0;
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  function start(): void {
    if (running) return;
    running = true;
    raf = requestAnimationFrame(tick);
  }

  const listen = (): void => {
    window.addEventListener('deviceorientation', onOrient, { passive: true });
  };

  // iOS 13+ needs an explicit user gesture before it will hand over the sensor.
  const needsPermission =
    typeof (DeviceOrientationEvent as unknown as IOSOrientation).requestPermission === 'function';

  let pill: HTMLElement | null = null;
  if (needsPermission) {
    pill = el('button', { type: 'button', class: 'pill motion-pill', text: 'Enable motion' });
    pill.addEventListener('click', () => {
      const req = (DeviceOrientationEvent as unknown as IOSOrientation).requestPermission;
      void req?.()
        .then((state) => {
          if (state === 'granted') listen();
          pill?.remove();
          pill = null;
        })
        .catch(() => {
          pill?.remove();
          pill = null;
        });
    });
    host.append(pill);
  } else {
    listen();
    // If nothing ever arrives (desktop), leave the layers untouched — nothing to clean up.
    window.setTimeout(() => {
      if (!sawEvent) window.removeEventListener('deviceorientation', onOrient);
    }, 4000);
  }

  return {
    destroy(): void {
      window.removeEventListener('deviceorientation', onOrient);
      if (raf) cancelAnimationFrame(raf);
      pill?.remove();
      for (const g of Object.values(layers)) g.style.transform = '';
    },
  };
}
