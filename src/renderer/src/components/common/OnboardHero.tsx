import { useEffect, useRef, useState, type ReactNode } from "react";
import jingyuaiIcon from "../../assets/jingyuai-icon.png";

// Deterministic twinkling starfield — golden-angle spread so dots never clump.
// Generated once at module load, not per render.
const PARTICLES = Array.from({ length: 22 }, (_, i) => ({
  x: (i * 137.508) % 100,
  y: (i * 61.803 + 13) % 100,
  delay: (i % 7) * 0.6,
  dur: 2.6 + (i % 5) * 0.9,
  size: i % 3 === 0 ? 2.5 : 1.5,
}));

// The same JingYuAI mark is used by the app shell and onboarding animation so
// first-run screens cannot drift from the packaged desktop icon.
function Emblem(): React.JSX.Element {
  return <img src={jingyuaiIcon} alt="" aria-hidden="true" />;
}

type Phase = "draw" | "settle" | "done";

// Let the JingYuAI mark establish itself, then fly it into the settled slot.
const DRAW_MS = 900;
const SETTLE_MS = 700;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

interface OnboardHeroProps {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  // Play the full big-centre → draw → fly-up intro. Off = emblem fades in place
  // and content cascades immediately (used on downstream onboarding screens).
  intro?: boolean;
  // Widen the content column (installing progress / terminal log).
  wide?: boolean;
}

/**
 * Shared cinematic chrome for the onboarding screens. Renders the aurora
 * backdrop, starfield, animated Hermes emblem, eyebrow, upright title, and the
 * page-specific `children` inside a reveal-on-settle body.
 */
function OnboardHero({
  eyebrow,
  title,
  children,
  intro = false,
  wide = false,
}: OnboardHeroProps): React.JSX.Element {
  const emblemRef = useRef<HTMLDivElement>(null);
  const reduced = useRef(prefersReducedMotion()).current;
  const runIntro = intro && !reduced;

  const [phase, setPhase] = useState<Phase>(runIntro ? "draw" : "done");
  // Transform applied to the flying logo once we know where its slot is.
  const [flyStyle, setFlyStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (!runIntro) return;
    const timers: ReturnType<typeof setTimeout>[] = [];

    timers.push(
      setTimeout(() => {
        // Measure the settled slot and fly the big centred logo into it.
        const el = emblemRef.current;
        if (el) {
          const r = el.getBoundingClientRect();
          const tx = r.left + r.width / 2 - window.innerWidth / 2;
          const ty = r.top + r.height / 2 - window.innerHeight / 2;
          const s = r.width / 180;
          setFlyStyle({
            transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(${s})`,
          });
        }
        setPhase("settle");
      }, DRAW_MS),
    );

    timers.push(setTimeout(() => setPhase("done"), DRAW_MS + SETTLE_MS));

    return () => timers.forEach(clearTimeout);
  }, [runIntro]);

  return (
    <div className="screen onboard-screen" data-phase={phase}>
      <div className="onboard-fx" aria-hidden="true">
        <div className="onboard-aurora" />
        <div className="onboard-vignette" />
        {PARTICLES.map((p, i) => (
          <span
            key={i}
            className="onboard-particle"
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              width: p.size,
              height: p.size,
              animation: `onboardTwinkle ${p.dur}s ease ${p.delay}s infinite`,
            }}
          />
        ))}
      </div>

      <div className={`onboard-hero${wide ? " onboard-hero--wide" : ""}`}>
        <div className="onboard-emblem" ref={emblemRef}>
          <div className="onboard-emblem-glow" />
          <Emblem />
        </div>

        <div className="onboard-eyebrow">{eyebrow}</div>
        <h1 className="onboard-title">{title}</h1>
        <div className="onboard-body">{children}</div>
      </div>

      {runIntro && phase !== "done" && (
        <div className="onboard-fly" style={flyStyle} aria-hidden="true">
          <div className="onboard-fly-glow" />
          <Emblem />
        </div>
      )}
    </div>
  );
}

export default OnboardHero;
