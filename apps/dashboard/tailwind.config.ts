import type { Config } from 'tailwindcss';

/**
 * Design tokens.
 *
 * A single restrained accent over a neutral slate ground. Semantic names
 * (`surface`, `border`, `muted`) rather than colour names, so a change of
 * palette is one edit here and not a search across every component.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: '#0a0c10',
        surface: {
          DEFAULT: '#12151c',
          raised: '#171b24',
          hover: '#1c212c',
        },
        line: {
          DEFAULT: '#232833',
          strong: '#2e3542',
        },
        content: {
          DEFAULT: '#e6e9ef',
          muted: '#8b93a4',
          subtle: '#646c7d',
        },
        accent: {
          DEFAULT: '#4a8fe7',
          hover: '#5f9dec',
          muted: 'rgba(74, 143, 231, 0.12)',
          line: 'rgba(74, 143, 231, 0.35)',
        },
        allow: {
          DEFAULT: '#3fb27f',
          muted: 'rgba(63, 178, 127, 0.12)',
          line: 'rgba(63, 178, 127, 0.32)',
        },
        deny: {
          DEFAULT: '#e5544b',
          muted: 'rgba(229, 84, 75, 0.12)',
          line: 'rgba(229, 84, 75, 0.32)',
        },
        warn: {
          DEFAULT: '#d9a441',
          muted: 'rgba(217, 164, 65, 0.12)',
          line: 'rgba(217, 164, 65, 0.32)',
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          '-apple-system',
          'Segoe UI',
          'Inter',
          'Roboto',
          'Helvetica Neue',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        DEFAULT: '0.5rem',
        lg: '0.625rem',
        xl: '0.875rem',
      },
      boxShadow: {
        panel: '0 1px 2px rgba(0,0,0,.3), 0 8px 24px -12px rgba(0,0,0,.6)',
        pop: '0 16px 48px -16px rgba(0,0,0,.75)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(2px)' },
          to: { opacity: '1', transform: 'none' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-in': 'fade-in .18s ease-out',
        shimmer: 'shimmer 1.6s infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
