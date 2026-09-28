import { useId } from "react";
import clsx from "clsx";

/** The Nova mark: a four-point star — a star flaring up. */
export function NovaStar({ size = 40, className, glow }: { size?: number; className?: string; glow?: boolean }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="rgb(var(--star))" />
          <stop offset="1" stopColor="rgb(var(--star-2))" />
        </linearGradient>
        {glow && (
          <radialGradient id={`${id}r`}>
            <stop offset="0" stopColor="rgb(var(--star))" stopOpacity="0.55" />
            <stop offset="1" stopColor="rgb(var(--star))" stopOpacity="0" />
          </radialGradient>
        )}
      </defs>
      {glow && <circle cx="50" cy="50" r="48" fill={`url(#${id}r)`} />}
      <path d="M50 4 C53.5 36 64 46.5 96 50 C64 53.5 53.5 64 50 96 C46.5 64 36 53.5 4 50 C36 46.5 46.5 36 50 4Z" fill={`url(#${id}g)`} />
      <circle cx="50" cy="50" r="5" fill="rgb(255 250 235)" opacity="0.9" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={clsx("font-display font-semibold tracking-[-0.02em]", className)}>
      Concord <span className="text-star">Nova</span>
    </span>
  );
}

/** Launch moment: the star ignites, a shockwave ring expands, the name settles in. */
export function Ignition({ status }: { status?: string }) {
  return (
    <div className="relative z-10 flex h-full flex-col items-center justify-center gap-6">
      <div className="relative flex h-28 w-28 items-center justify-center">
        <span className="absolute inset-0 rounded-full border-2 border-star/60" style={{ animation: "ignite-ring 1.4s cubic-bezier(.2,.7,.2,1) 0.15s both" }} />
        <span className="absolute inset-0 rounded-full border border-star/30" style={{ animation: "ignite-ring 1.8s cubic-bezier(.2,.7,.2,1) 0.35s both" }} />
        <div style={{ animation: "ignite 0.9s cubic-bezier(.2,.9,.25,1.2) both" }}>
          <NovaStar size={96} glow />
        </div>
      </div>
      <div className="text-center anim-fade" style={{ animationDelay: "0.45s" }}>
        <Wordmark className="text-2xl" />
        {status && <p className="mt-3 text-[14px] text-fg-3">{status}</p>}
      </div>
    </div>
  );
}
