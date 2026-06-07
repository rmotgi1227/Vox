"use client";

import { useEffect, useRef } from "react";

export type AgentVizMode = "connecting" | "listening" | "thinking" | "speaking";

type AgentVisualizerProps = {
  /** Live agent audio track; drives the bars while the agent is speaking. */
  track: MediaStreamTrack | null;
  /** Current agent state — scripts the idle animation when not speaking. */
  mode: AgentVizMode;
  barCount?: number;
};

/**
 * A bar visualizer rendered inside the voice button.
 * Audio-reactive when the agent is speaking; otherwise plays a state-specific
 * idle animation (connecting sweep, thinking wave, listening breathe).
 * Bars are drawn in --ink (near-black).
 */
export function AgentVisualizer({ track, mode, barCount = 5 }: AgentVisualizerProps) {
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const modeRef = useRef<AgentVizMode>(mode);
  modeRef.current = mode;

  // Build a Web Audio analyser on the agent's remote track for amplitude.
  useEffect(() => {
    if (!track) {
      analyserRef.current = null;
      dataRef.current = null;
      return;
    }
    const Ctor =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.82;
    // Read-only tap: do NOT connect to destination — audio already plays via the <audio> element.
    source.connect(analyser);
    analyserRef.current = analyser;
    dataRef.current = new Uint8Array(analyser.frequencyBinCount);
    void ctx.resume().catch(() => {});
    return () => {
      source.disconnect();
      analyser.disconnect();
      void ctx.close().catch(() => {});
      analyserRef.current = null;
      dataRef.current = null;
    };
  }, [track]);

  // Single rAF loop that paints bar heights from audio + mode.
  useEffect(() => {
    let frame = 0;
    let raf = 0;
    const render = () => {
      frame += 1;
      const bars = barsRef.current;
      const n = bars.length;
      const m = modeRef.current;
      const analyser = analyserRef.current;
      const data = dataRef.current;

      const levels: number[] = [];
      let energy = 0;
      if (analyser && data) {
        analyser.getByteFrequencyData(data);
        const binsPer = Math.max(1, Math.floor(data.length / n));
        for (let i = 0; i < n; i++) {
          let sum = 0;
          for (let j = 0; j < binsPer; j++) sum += data[i * binsPer + j] ?? 0;
          const v = sum / binsPer / 255;
          levels[i] = v;
          energy += v;
        }
        energy /= n;
      }

      const hasAudio = energy > 0.04;
      const center = (n - 1) / 2;
      for (let i = 0; i < n; i++) {
        let h: number;
        if (hasAudio) {
          // real agent audio — react to it directly (covers "speaking")
          h = Math.max(0.16, Math.min(1, (levels[i] ?? 0) * 1.7));
        } else if (m === "speaking") {
          // status says speaking but analyser is silent — scripted lively wave
          h = 0.3 + 0.5 * (0.5 + 0.5 * Math.sin(frame / 5 - i * 1.1));
        } else if (m === "connecting") {
          h = 0.24 + 0.42 * (0.5 + 0.5 * Math.sin(frame / 7 - i * 0.6));
        } else if (m === "thinking") {
          h = 0.2 + 0.55 * (0.5 + 0.5 * Math.sin(frame / 9 - i * 0.95));
        } else {
          // listening / idle — visible breathing wave, taller in the middle
          const dist = Math.abs(i - center) / (center || 1);
          h = 0.4 + (1 - dist) * 0.18 + 0.16 * Math.sin(frame / 13 + i * 0.7);
        }
        const bar = bars[i];
        if (bar) bar.style.transform = `scaleY(${h.toFixed(3)})`;
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <span className="agent-viz" aria-hidden="true">
      {Array.from({ length: barCount }).map((_, i) => (
        <span
          key={i}
          className="agent-viz-bar"
          ref={(el) => {
            barsRef.current[i] = el;
          }}
        />
      ))}
    </span>
  );
}
