// NorthShift — Midnight Executive theme tokens (toned down).
// Single source of truth for colors, spacing, radius and type.
// Import: `import { colors, spacing, radius, type } from '../lib/theme';`

export const colors = {
  // Surfaces — deep navy, never pure black
  background: '#0A0E1A',
  backgroundSecondary: '#0E1526',
  surface: 'rgba(255, 255, 255, 0.06)',
  surfaceBorder: 'rgba(255, 255, 255, 0.10)',

  // Accent — electric cyan, used sparingly (primary actions, active states)
  accent: '#00D4FF',
  accentSoft: 'rgba(0, 212, 255, 0.12)',
  accentBorder: 'rgba(0, 212, 255, 0.35)',

  // Semantic
  warning: '#FFB800',
  warningSoft: 'rgba(255, 184, 0, 0.12)',
  success: '#34D399',
  danger: '#F87171',

  // Text
  textPrimary: '#F2F5F9',
  textSecondary: '#9AA4B2',
  textMuted: '#6B7686',

  // Inputs
  inputBackground: 'rgba(255, 255, 255, 0.05)',
  inputBorder: 'rgba(255, 255, 255, 0.14)',
  inputPlaceholder: '#6B7686',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
};

// Toned down: restrained elevation, no heavy glows.
export const elevation = {
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 3,
  },
  raised: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 5,
  },
  // Accent glow — use ONLY on the single primary action per screen.
  accentGlow: {
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 6,
  },
};

export const type = {
  hero: { fontSize: 44, fontWeight: '700' as const, letterSpacing: -0.5 },
  title: { fontSize: 24, fontWeight: '700' as const },
  heading: { fontSize: 18, fontWeight: '600' as const },
  body: { fontSize: 16, fontWeight: '400' as const },
  caption: { fontSize: 13, fontWeight: '400' as const },
  label: {
    fontSize: 11,
    fontWeight: '600' as const,
    letterSpacing: 1.2,
    textTransform: 'uppercase' as const,
  },
  timer: { fontSize: 52, fontWeight: '700' as const, fontVariant: ['tabular-nums'] as const },
};

export const theme = { colors, spacing, radius, elevation, type };
export default theme;
