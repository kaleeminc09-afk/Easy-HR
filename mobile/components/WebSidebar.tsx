// Web-only right toolbar (rendered by app/_layout.tsx when
// Platform.OS === 'web' AND a session exists). Native never sees it.
// Links use router.push so history and the browser back button keep
// working; the active section is highlighted via usePathname.
// Manager links only appear once the signed-in user's role has loaded
// as manager/admin — while loading they are hidden, never flashed.
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, radius, spacing } from '../lib/theme';

const LINKS = [
  { label: 'Clock In', href: '/', managerOnly: false, adminOnly: false },
  { label: 'Schedule', href: '/schedule', managerOnly: false, adminOnly: false },
  { label: 'Time Off', href: '/timeoff', managerOnly: false, adminOnly: false },
  { label: 'Team', href: '/team', managerOnly: false, adminOnly: false },
  { label: 'Documents', href: '/documents', managerOnly: false, adminOnly: false },
  { label: 'Reports', href: '/reports', managerOnly: false, adminOnly: false },
  { label: '✦ Assistant', href: '/EmployeeChatScreen', managerOnly: false, adminOnly: false },
  { label: 'Profile', href: '/profile', managerOnly: false, adminOnly: false },
  { label: 'Manager Board', href: '/manager-board', managerOnly: true, adminOnly: false },
  { label: 'Manager Portal', href: '/manager', managerOnly: true, adminOnly: false },
  { label: 'Break Policy', href: '/break-policy', managerOnly: true, adminOnly: false },
  { label: 'Leave Policy', href: '/leave-policy', managerOnly: true, adminOnly: false },
  { label: 'QR Codes', href: '/qrcodes', managerOnly: true, adminOnly: false },
  { label: 'Subscription', href: '/subscription', managerOnly: false, adminOnly: true },
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
        return (
          <TouchableOpacity
            key={l.href}
            style={[styles.link, active && styles.linkActive]}
            onPress={() => router.push(l.href)}
          >
            <Text style={[styles.linkText, active && styles.linkTextActive]}>{l.label}</Text>
          </TouchableOpacity>
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
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.sm, marginBottom: spacing.xs },
  linkActive: { backgroundColor: colors.accentSoft },
  linkText: { fontSize: 15, fontFamily: fontFamily.regular, color: colors.textPrimary },
  linkTextActive: { fontFamily: fontFamily.semibold, color: colors.accent },
  spacer: { flex: 1 },
  signOut: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.sm },
  signOutText: { fontSize: 15, fontFamily: fontFamily.semibold, color: colors.danger },
});
