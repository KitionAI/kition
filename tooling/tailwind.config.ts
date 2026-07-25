import type { Config } from 'tailwindcss'
import animate from 'tailwindcss-animate'

export default {
  darkMode: ['class'],
  content: {
    relative: true,
    files: [
      '../index.html',
      '../src/main.tsx',
      '../src/app/**/*.{ts,tsx}',
      '../src/components/**/*.{ts,tsx}',
      '../src/features/**/*.{ts,tsx}',
      '../src/registry/**/*.{ts,tsx}',
    ],
  },
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      screens: {
                                                                        
                                                          
                                                             
                                  
        narrow: { max: '1023px' },                             
        compact: { max: '767px' },                                 
        tiny: { max: '479px' },                                    
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        'surface-soft': 'hsl(var(--surface-soft))',
        'surface-strong': 'hsl(var(--surface-strong))',
        'hairline-strong': 'hsl(var(--hairline-strong))',
        'hairline-soft': 'hsl(var(--hairline-soft))',
        brand: {
          DEFAULT: 'hsl(var(--brand))',
          foreground: 'hsl(var(--brand-foreground))',
        },
        'brand-active': 'hsl(var(--brand-active))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
          border: 'hsl(var(--destructive-border))',
          background: 'hsl(var(--destructive-background))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
          border: 'hsl(var(--success-border))',
          background: 'hsl(var(--success-background))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
          border: 'hsl(var(--warning-border))',
          background: 'hsl(var(--warning-background))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        subtle: {
          foreground: 'hsl(var(--subtle-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        tint: {
          peach: 'hsl(var(--tint-peach))',
          rose: 'hsl(var(--tint-rose))',
          mint: 'hsl(var(--tint-mint))',
          lavender: 'hsl(var(--tint-lavender))',
          sky: 'hsl(var(--tint-sky))',
          yellow: 'hsl(var(--tint-yellow))',
          'yellow-bold': 'hsl(var(--tint-yellow-bold))',
          cream: 'hsl(var(--tint-cream))',
          gray: 'hsl(var(--tint-gray))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          active: 'hsl(var(--sidebar-active))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'SF Pro Text', 'Segoe UI', 'Roboto', 'PingFang SC', 'Noto Sans SC', 'sans-serif'],
      },
      boxShadow: {
        soft: 'var(--shadow-soft)',
        floating: 'var(--shadow-floating)',
        toolbar: 'var(--shadow-toolbar)',
        elevated: 'var(--shadow-elevated)',
      },
      transitionTimingFunction: {
                                                      
                                               
        standard: 'cubic-bezier(0.2, 0, 0, 1)',
        emphasized: 'cubic-bezier(0.3, 0, 0, 1)',
        'spring-out': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
      transitionDuration: {
                                        
        fast: '120ms',
        base: '180ms',
        slow: '260ms',
      },
      keyframes: {
        'ai-bounce': {
          '0%, 80%, 100%': { transform: 'scale(0)' },
          '40%': { transform: 'scale(1)' },
        },
        popover: {
          '0%': { opacity: '0', transform: 'scale(0.98) translateY(-2px)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        zoom: {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'ai-bounce': 'ai-bounce 1.4s infinite ease-in-out both',
        popover: 'popover 120ms ease-out',
        zoom: 'zoom 120ms ease-out',
        'fade-in-up': 'fade-in-up 260ms cubic-bezier(0.2, 0, 0, 1) both',
        'fade-in': 'fade-in 180ms cubic-bezier(0.2, 0, 0, 1) both',
        shimmer: 'shimmer 1.6s ease-in-out infinite',
      },
      spacing: {
        13: '3.25rem',
      },
      transitionProperty: {
        'bg-ease': 'background-color, border-color, color, fill, stroke',
      },
      zIndex: {
        1: '1',
        2: '2',
        500: '500',
      },
    },
  },
  plugins: [animate],
} satisfies Config
