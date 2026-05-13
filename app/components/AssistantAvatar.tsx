'use client';

interface Props {
  size?: number;
  className?: string;
  /** Subtle pulse animation — used on the floating launcher so the bot
   *  draws a bit of attention without being annoying. */
  pulse?: boolean;
}

/**
 * Branded assistant avatar — a gradient orb with a friendly minimal robot
 * face. Kept as inline SVG so we don't need an asset pipeline and so the
 * gradient tracks the app's accent palette through CSS where applicable.
 */
export default function AssistantAvatar({ size = 28, className, pulse }: Props) {
  return (
    <span className={`relative inline-block ${className ?? ''}`} style={{ width: size, height: size }}>
      {pulse && (
        <span
          className="absolute inset-0 rounded-full animate-ping opacity-20"
          style={{
            background:
              'linear-gradient(135deg, #7c3aed 0%, #3b82f6 50%, #06b6d4 100%)',
          }}
          aria-hidden
        />
      )}
      <svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        className="relative block"
        aria-hidden
      >
        <defs>
          <linearGradient id="th-bot-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#7c3aed" />
            <stop offset="50%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#06b6d4" />
          </linearGradient>
          <radialGradient id="th-bot-shine" cx="0.3" cy="0.25" r="0.7">
            <stop offset="0%" stopColor="rgba(255,255,255,0.45)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </radialGradient>
        </defs>
        <circle cx="20" cy="20" r="19" fill="url(#th-bot-grad)" />
        <circle cx="20" cy="20" r="19" fill="url(#th-bot-shine)" />
        {/* Robot head */}
        <rect
          x="11"
          y="14"
          width="18"
          height="14"
          rx="4.5"
          fill="rgba(255,255,255,0.95)"
        />
        {/* Eyes */}
        <circle cx="16" cy="20" r="1.8" fill="#1f2937" />
        <circle cx="24" cy="20" r="1.8" fill="#1f2937" />
        {/* Smile */}
        <path
          d="M 15.5 23.5 Q 20 26 24.5 23.5"
          stroke="#1f2937"
          strokeWidth="1.4"
          strokeLinecap="round"
          fill="none"
        />
        {/* Antenna */}
        <line
          x1="20"
          y1="10"
          x2="20"
          y2="14"
          stroke="rgba(255,255,255,0.95)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <circle cx="20" cy="9" r="1.6" fill="rgba(255,255,255,0.95)" />
      </svg>
    </span>
  );
}
