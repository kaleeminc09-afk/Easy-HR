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
import { Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { NAV_ICONS } from './NavIcons';
import { colors, fontFamily, radius, spacing } from '../lib/theme';

const LINKS = [
  { label: 'Clock In', href: '/', managerOnly: false, adminOnly: false, icon: 'clock' },
  { label: 'Schedule', href: '/schedule', managerOnly: false, adminOnly: false, icon: 'calendar' },
  { label: 'Time Off', href: '/timeoff', managerOnly: false, adminOnly: false, icon: 'calendarX' },
  { label: 'Team', href: '/team', managerOnly: false, adminOnly: false, icon: 'people' },
  { label: 'Documents', href: '/documents', managerOnly: false, adminOnly: false, icon: 'file' },
  { label: 'Expenses', href: '/expenses', managerOnly: false, adminOnly: false, icon: 'receipt' },
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
      {/* Links scroll when the list is taller than the screen; the title
          and Sign out stay pinned so both are always reachable. */}
      <ScrollView style={styles.linksScroll}>
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
                {l.icon ? <View style={styles.iconWrap}>{NAV_ICONS[l.icon](iconColor)}</View> : null}
                <Text style={[styles.linkText, active && styles.linkTextActive]}>{l.label}</Text>
              </View>
            </TouchableOpacity>
          </React.Fragment>
        );
      })}
      </ScrollView>
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
  // flex: 1 inside the full-height sidebar bounds the scroll area: the
  // list scrolls, the title above and Sign out below never move.
  linksScroll: { flex: 1 },
  sectionLabel: { fontSize: 11, fontFamily: fontFamily.semibold, letterSpacing: 1.2, textTransform: 'uppercase', color: colors.textSecondary, paddingHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: spacing.xs },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.sm, marginBottom: spacing.xs },
  linkActive: { backgroundColor: colors.accentSoft },
  linkRow: { flexDirection: 'row', alignItems: 'center' },
  iconWrap: { width: 18, height: 18, marginRight: spacing.sm, justifyContent: 'center', alignItems: 'center' },
  linkText: { fontSize: 15, fontFamily: fontFamily.regular, color: colors.textPrimary },
  linkTextActive: { fontFamily: fontFamily.semibold, color: colors.accent },
  signOut: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.sm },
  signOutText: { fontSize: 15, fontFamily: fontFamily.semibold, color: colors.danger },
});
