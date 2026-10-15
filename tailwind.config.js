// Tailwind cannot apply an opacity modifier (bg-surface/80) to a plain var()
// color and silently emits no rule. Plain classes keep the variable; an
// opacity modifier mixes it with transparent.
const themeColor = name => ({ opacityVariable, opacityValue }) => {
  if (opacityVariable || opacityValue === undefined) return `var(--${name})`
  const alpha = Number(opacityValue)
  const amount = Number.isFinite(alpha) ? `${Math.round(alpha * 1000) / 10}%` : `calc(${opacityValue} * 100%)`
  return `color-mix(in srgb, var(--${name}) ${amount}, transparent)`
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}', '!./src/components/ConfigStudio.tsx', '!./src/config-studio.tsx'],
  darkMode: 'class',
  future: {
    hoverOnlyWhenSupported: true,
  },
  theme: {
    screens: {
      sm: '640px',
      md: '768px',
      lg: '1024px',
      xl: '1200px',
      '2xl': '1536px',
    },
    extend: {
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'],
      },
      colors: {
        surface: themeColor('surface'),
        elevated: themeColor('elevated'),
        border: themeColor('border'),
        'border-strong': themeColor('border-strong'),
        accent: 'rgb(var(--accent-rgb) / <alpha-value>)',
        'accent-hover': themeColor('accent-hover'),
        'text-primary': themeColor('text-primary'),
        'text-muted': themeColor('text-muted'),
        'text-dim': themeColor('text-dim'),
        ok: 'rgb(var(--ok-rgb) / <alpha-value>)',
        danger: 'rgb(var(--danger-rgb) / <alpha-value>)',
        warn: 'rgb(var(--warn-rgb) / <alpha-value>)',
        info: 'rgb(var(--info-rgb) / <alpha-value>)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        blink: 'blink 1s step-end infinite',
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
      },
    },
  },
  plugins: [],
}
