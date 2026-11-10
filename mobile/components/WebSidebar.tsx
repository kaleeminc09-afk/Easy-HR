// Web-only right toolbar (rendered by app/_layout.tsx when
// Platform.OS === 'web' AND a session exists). Native never sees it.
// Links use router.push so history and the browser back button keep
// working; the active section is highlighted via usePathname.
// Manager links only appear once the signed-in user's role has loaded
// as manager/admin — while loading they are hidden, never flashed.
// Icons are small stroke-based inline SVGs (react-native-svg, already
// installed via react-native-qrcode-svg) — no new dependencies.
// Break Policy + Leave Policy sit under a "Policies" section label.
import React, { useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, radius, spacing } from '../lib/theme';

// Every icon is drawn on a 24x24 grid, stroke-based, 18px on screen.
// The stroke color follows the link text (accent when active).
const ICONS = {
  clock: (c) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="12" cy="12" r="9" />
      <Path d="M12 7v5l3 2" />
    </Svg>
  ),
  calendar: (c) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="4" width="18" height="18" rx="2" />
      <Path d="M16 2v4M8 2v4M3 10h18" />
    </Svg>
  ),
  // Time Off: calendar with an x — time away from the schedule.
  calendarX: (c) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="4" width="18" height="18" rx="2" />
      <Path d="M16 2v4M8 2v4M3 10h18" />
      <Path d="M10 15l4 4M14 15l-4 4" />
    </Svg>
  ),
  people: (c) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <Circle cx="9" cy="7" r="4" />
      <Path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <Path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  ),
  file: (c) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <Path d="M14 2v6h6" />
      <Path d="M16 13H8M16 17H8M10 9H8" />
    </Svg>
  ),
  chart: (c) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 20V10M18 20V4M6 20v-4" />
    </Svg>
  ),
  person: (c) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <Circle cx="12" cy="7" r="4" />
    </Svg>
  ),
  grid: (c) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="3" width="7" height="7" rx="1" />
      <Rect x="14" y="3" width="7" height="7" rx="1" />
      <Rect x="14" y="14" width="7" height="7" rx="1" />
      <Rect x="3" y="14" width="7" height="7" rx="1" />
    </Svg>
  ),
  // Manager Portal: briefcase.
  briefcase: (c) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="2" y="7" width="20" height="14" rx="2" />
      <Path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </Svg>
  ),
  shield: (c) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </Svg>
  ),
  // Leave Policy: calendar with a check — approved time away.
  calendarCheck: (c) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="4" width="18" height="18" rx="2" />
      <Path d="M16 2v4M8 2v4M3 10h18" />
      <Path d="M9 16l2 2 4-4" />
    </Svg>
  ),
  qr: (c) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="3" width="7" height="7" rx="1" />
      <Rect x="14" y="3" width="7" height="7" rx="1" />
      <Rect x="3" y="14" width="7" height="7" rx="1" />
      <Rect x="14" y="14" width="3" height="3" fill={c} stroke="none" />
      <Rect x="18" y="18" width="3" height="3" fill={c} stroke="none" />
    </Svg>
  ),
  card: (c) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="1" y="4" width="22" height="16" rx="2" />
      <Path d="M1 10h22" />
    </Svg>
  ),
  // Support: question mark in a circle.
  help: (c) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="12" cy="12" r="9" />
      <Path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <Path d="M12 17h.01" />
    </Svg>
  ),
};

const LINKS = [
  { label: 'Clock In', href: '/', managerOnly: false, adminOnly: false, icon: 'clock' },
  { label: 'Schedule', href: '/schedule', managerOnly: false, adminOnly: false, icon: 'calendar' },
  { label: 'Time Off', href: '/timeoff', managerOnly: false, adminOnly: false, icon: 'calendarX' },
  { label: 'Team', href: '/team', managerOnly: false, adminOnly: false, icon: 'people' },
  { label: 'Documents', href: '/documents', managerOnly: false, adminOnly: false, icon: 'file' },
  { label: 'Reports', href: '/reports', managerOnly: false, adminOnly: false, icon: 'chart' },
  // Assistant keeps its existing ✦ mark — no SVG icon on this row.
  { label: '✦ Assistant', href: '/EmployeeChatScreen', managerOnly: false, adminOnly: false, icon: null },
  { label: 'Profile', href: '/profile', managerOnly: false, adminOnly: false, icon: 'person' },
  { label: 'Manager Board', href: '/manager-board', managerOnly: true, adminOnly: false, icon: 'grid' },
  { label: 'Manager Portal', href: '/manager', managerOnly: true, adminOnly: false, icon: 'briefcase' },
  // section: a muted label rendered above this link, grouping the policies.
  { label: 'Break Policy', href: '/break-policy', managerOnly: true, adminOnly: false, icon: 'shield', section: 'Policies' },
  { label: 'Leave Policy', href: '/leave-policy', managerOnly: true, adminOnly: false, icon: 'calendarCheck' },
  { label: 'QR Codes', href: '/qrcodes', managerOnly: true, adminOnly: false, icon: 'qr' },
  { label: 'Subscription', href: '/subscription', managerOnly: false, adminOnly: true, icon: 'card' },
  // Support opens the user's mail app — not a route, so mailto: true
  // branches the press handler to Linking instead of router.push.
  // Visible to everyone, above Sign out.
  { label: 'Support', href: 'mailto:support@northshiftapp.com', managerOnly: false, adminOnly: false, icon: 'help', mailto: true },
];

export default function WebSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const [role, setRole] = useState<string | null>(null);
  const [roleLoaded, setRoleLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setRoleLoaded(true); return; }
      // Same role read as schedule.js: profiles.role for this user.
      const { data } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
      setRole(data?.role || 'employee');
      setRoleLoaded(true);
    })();
  }, []);

  const isManager = role === 'manager' || role === 'admin';

  return (
    <View style={styles.sidebar}>
      <Text style={styles.title}>NorthShift</Text>
      {LINKS.filter((l) => (!l.managerOnly || (roleLoaded && isManager)) && (!l.adminOnly || (roleLoaded && role === 'admin'))).map((l) => {
        const active = pathname === l.href;
        const iconColor = active ? colors.accent : colors.textPrimary;
        return (
          <React.Fragment key={l.href}>
            {l.section ? <Text style={styles.sectionLabel}>{l.section}</Text> : null}
            <TouchableOpacity
              style={[styles.link, active && styles.linkActive]}
              onPress={() => (l.mailto ? Linking.openURL(l.href) : router.push(l.href))}
            >
              <View style={styles.linkRow}>
                {l.icon ? <View style={styles.iconWrap}>{ICONS[l.icon](iconColor)}</View> : null}
                <Text style={[styles.linkText, active && styles.linkTextActive]}>{l.label}</Text>
              </View>
            </TouchableOpacity>
          </React.Fragment>
        );
      })}
      <View style={styles.spacer} />
      <TouchableOpacity style={styles.signOut} onPress={() => supabase.auth.signOut()}>
        <Text style={styles.signOutText}>Sign out</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  sidebar: {
    width: 220,
    backgroundColor: colors.backgroundSecondary,
    borderLeftWidth: 1,
    borderColor: colors.surfaceBorder,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
  },
  // Sora is used ONLY for the "NorthShift" company name (theme rule).
  title: { fontFamily: fontFamily.brand, fontSize: 18, color: colors.textPrimary, paddingHorizontal: spacing.sm, marginBottom: spacing.md },
  sectionLabel: { fontSize: 11, fontFamily: fontFamily.semibold, letterSpacing: 1.2, textTransform: 'uppercase', color: colors.textSecondary, paddingHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: spacing.xs },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.sm, marginBottom: spacing.xs },
  linkActive: { backgroundColor: colors.accentSoft },
  linkRow: { flexDirection: 'row', alignItems: 'center' },
  iconWrap: { width: 18, height: 18, marginRight: spacing.sm, justifyContent: 'center', alignItems: 'center' },
  linkText: { fontSize: 15, fontFamily: fontFamily.regular, color: colors.textPrimary },
  linkTextActive: { fontFamily: fontFamily.semibold, color: colors.accent },
  spacer: { flex: 1 },
  signOut: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.sm },
  signOutText: { fontSize: 15, fontFamily: fontFamily.semibold, color: colors.danger },
});
