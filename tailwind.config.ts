import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: {
          DEFAULT: '#1E1E1E',
          secondary: '#252525',
          tertiary: '#2B2B2B',
          elevated: '#333333',
        },
        foreground: {
          DEFAULT: '#D9D9D9',
          muted: '#9CA3AF',
          subtle: '#6B7280',
        },
        accent: {
          DEFAULT: '#2962FF',
          hover: '#1E50E6',
        },
        success: '#26A69A',
        danger: '#EF5350',
        warning: '#FF9800',
        purple: '#9C27B0',
        border: '#2B2B43',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.2s ease-in',
        'slide-up': 'slideUp 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
