// NorthShift — Midnight Executive theme tokens (toned down).
// Single source of truth for colors, spacing, radius and type.
// Import: `import { colors, spacing, radius, type } from '../lib/theme';`

export const colors = {
  // Surfaces — brighter dark navy, never pure black
  background: '#121A2B',
  backgroundSecondary: '#182238',
  surface: 'rgba(255, 255, 255, 0.10)',
  surfaceBorder: 'rgba(255, 255, 255, 0.16)',

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
  textSecondary: '#B8C0CE',
  textMuted: '#8A94A6',

  // Inputs
  inputBackground: 'rgba(255, 255, 255, 0.08)',
  inputBorder: 'rgba(255, 255, 255, 0.20)',
  inputPlaceholder: '#8A94A6',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

// Inter — loaded once in app/_layout.tsx via @expo-google-fonts/inter.
// Use these instead of fontWeight-only styling so the typeface is consistent.
export const fontFamily = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  extrabold: 'Inter_800ExtraBold',
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
  hero: { fontSize: 44, fontFamily: fontFamily.bold, letterSpacing: -0.5 },
  title: { fontSize: 24, fontFamily: fontFamily.bold },
  heading: { fontSize: 18, fontFamily: fontFamily.semibold },
  body: { fontSize: 16, fontFamily: fontFamily.regular },
  caption: { fontSize: 13, fontFamily: fontFamily.regular },
  label: {
    fontSize: 11,
    fontFamily: fontFamily.semibold,
    letterSpacing: 1.2,
    textTransform: 'uppercase' as const,
  },
  // Hero wall clock — big, tabular numerals so digits never jitter.
  heroClock: { fontSize: 64, fontFamily: fontFamily.bold, fontVariant: ['tabular-nums'] as const, letterSpacing: -1 },
  timer: { fontSize: 52, fontFamily: fontFamily.bold, fontVariant: ['tabular-nums'] as const },
};


// Button system — the approved shapes, app-wide. Full-width 56px primary
// actions, 56px outlined secondary, compact 44px row/card actions.
// Nothing below 44px touch targets. Primary carries the accent glow;
// it is the single main action on its screen, so the rule holds.
export const buttons = {
  primary: {
    width: '100%',
    minHeight: 56,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    ...elevation.accentGlow,
  },
  primaryText: {
    color: colors.background,
    fontSize: 16,
    fontFamily: fontFamily.semibold,
  },
  secondary: {
    width: '100%',
    minHeight: 56,
    borderRadius: radius.md,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.accentBorder,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  secondaryText: {
    color: colors.accent,
    fontSize: 16,
    fontFamily: fontFamily.semibold,
  },
  danger: {
    width: '100%',
    minHeight: 56,
    borderRadius: radius.md,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.danger,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  dangerText: {
    color: colors.danger,
    fontSize: 16,
    fontFamily: fontFamily.semibold,
  },
  dangerArmedText: {
    color: colors.background,
    fontSize: 16,
    fontFamily: fontFamily.semibold,
  },
  compact: {
    minHeight: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.md,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  compactText: {
    color: colors.background,
    fontSize: 13,
    fontFamily: fontFamily.bold,
  },
  compactOutline: {
    minHeight: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    paddingHorizontal: spacing.md,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  compactOutlineText: {
    color: colors.accent,
    fontSize: 13,
    fontFamily: fontFamily.bold,
  },
  // Glass nav buttons — translucent surface with a light border, for
  // secondary navigation. JS-only glass: no native blur module, so
  // this stays rebuild-free. Primary actions stay solid cyan so they pop.
  glass: {
    minHeight: 44,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255, 255, 255, 0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  glassText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontFamily: fontFamily.semibold,
  },
};

export const theme = { colors, spacing, radius, elevation, type, fontFamily, buttons };
export default theme;
