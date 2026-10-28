// NorthShift — Sand theme tokens (approved 2026-10-28).
// Sand background, warm-white cards, warm-ink text, NorthShift Teal
// primary buttons, Sora as the company-name/wordmark font only.
// Body text stays Inter — the approved font change was the wordmark
// standing apart from regular text, not a new body typeface.
// Single source of truth for colors, spacing, radius and type.
// Import: `import { colors, spacing, radius, type } from '../lib/theme';`

export const colors = {
  // Surfaces — sand background, warm-white cards, warm sand borders
  background: '#F4EDE0',
  backgroundSecondary: '#EDE3D2',
  surface: '#FFFDF7',
  surfaceBorder: '#DDD2BC',

  // Accent — NorthShift Teal, used sparingly (primary actions, active states)
  accent: '#0F766E',
  accentSoft: 'rgba(15, 118, 110, 0.10)',
  accentBorder: 'rgba(15, 118, 110, 0.35)',

  // Semantic — darkened for readability on the light sand background
  warning: '#B45309',
  warningSoft: 'rgba(180, 83, 9, 0.10)',
  success: '#15803D',
  danger: '#DC2626',

  // Text — warm ink on sand
  textPrimary: '#1C1917',
  textSecondary: '#57534E',
  textMuted: '#78716C',

  // Inputs — white fields with warm sand borders
  inputBackground: '#FFFFFF',
  inputBorder: '#DDD2BC',
  inputPlaceholder: '#A8A29E',
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
// brand is Sora (via @expo-google-fonts/sora) and is used ONLY for the
// "NorthShift" company name, so the wordmark stands apart from body text.
export const fontFamily = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  extrabold: 'Inter_800ExtraBold',
  brand: 'Sora_800ExtraBold',
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
};

// Light theme: soft warm shadows, no heavy glows.
export const elevation = {
  card: {
    shadowColor: '#1C1917',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 3,
  },
  raised: {
    shadowColor: '#1C1917',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 5,
  },
  // Accent glow — use ONLY on the single primary action per screen.
  accentGlow: {
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.25,
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
    color: '#FFFFFF',
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
    color: '#FFFFFF',
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
    color: '#FFFFFF',
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
  // Glass nav buttons — translucent white surface with a warm border, for
  // secondary navigation. JS-only glass: no native blur module, so
  // this stays rebuild-free. Primary actions stay solid teal so they pop.
  glass: {
    minHeight: 44,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255, 255, 255, 0.65)',
    borderWidth: 1,
    borderColor: '#DDD2BC',
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
