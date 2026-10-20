import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Link } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, spacing, radius, type, elevation, buttons } from '../lib/theme';

export default function UsersScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [users, setUsers] = useState([]);
  const [myId, setMyId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState('');
  const [employeeLimit, setEmployeeLimit] = useState(null);
  const [businessName, setBusinessName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');

  useEffect(() => { init(); }, []);

  const init = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace('/'); return; }
    setMyId(session.user.id);
    const { data: me } = await supabase.from('profiles').select('role, business_id').eq('id', session.user.id).single();
    if (!me || me.role !== 'admin') { setLoading(false); return; }
    setIsAdmin(true);
    if (me.business_id) {
      const { data: biz } = await supabase.from('businesses').select('business_name, account_number').eq('id', me.business_id).single();
      if (biz) { setBusinessName(biz.business_name || ''); setAccountNumber(biz.account_number || ''); }
    }
    const { data: sub } = await supabase.from('subscriptions').select('employee_limit').eq('owner_id', session.user.id).maybeSingle();
    if (sub) setEmployeeLimit(sub.employee_limit);
    await loadUsers();
    setLoading(false);
  };

  const loadUsers = async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, role, created_at')
      .order('created_at', { ascending: true });
    if (!error) setUsers(data || []);
  };

  const changeRole = async (userId, newRole) => {
    if (userId === myId) { setMessage('You cannot change your own role.'); return; }
    setBusyId(userId);
    setMessage('');
    const { error } = await supabase.from('profiles').update({ role: newRole }).eq('id', userId);
    if (error) {
      setMessage('Could not update role: ' + error.message);
    } else {
      setMessage('Role updated.');
      await loadUsers();
    }
    setBusyId(null);
  };

  const roleStyle = (role) => {
    if (role === 'admin') return [styles.roleBadge, styles.roleAdmin];
    if (role === 'manager') return [styles.roleBadge, styles.roleManager];
    return [styles.roleBadge, styles.roleEmployee];
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (!isAdmin) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.deniedContainer}>
          <View style={styles.deniedBadge}><Text style={styles.deniedBadgeText}>!</Text></View>
          <Text style={styles.deniedTitle}>Admins only</Text>
          <Text style={styles.deniedText}>You need an administrator account to manage users.</Text>
          <Link href="/manager" asChild>
            <TouchableOpacity style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>← Back to Dashboard</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Link href="/manager" asChild>
          <TouchableOpacity style={styles.navButton}>
            <Text style={styles.navButtonText}>← Dashboard</Text>
          </TouchableOpacity>
        </Link>
        <Text style={styles.headerTitle}>Manage Users</Text>
        <View style={{ width: 110 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {message ? <Text style={styles.message}>{message}</Text> : null}
        {employeeLimit !== null && (
          <View style={styles.usageCard}>
            <Text style={styles.usageText}>{users.length} of {employeeLimit} employees</Text>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${Math.min(100, Math.round((users.length / employeeLimit) * 100))}%` }]} />
            </View>
          </View>
        )}
        {employeeLimit !== null && users.length >= employeeLimit && (
          <View style={styles.limitCard}>
            <Text style={styles.limitTitle}>Team limit reached</Text>
            <Text style={styles.limitText}>
              Your plan covers {employeeLimit} employees. Upgrade your plan, or email support@northshiftapp.com with your account number ({accountNumber || '—'}) and company name ({businessName || '—'}) and we'll raise the limit.
            </Text>
            <Link href="/subscription" asChild>
              <TouchableOpacity style={styles.limitButton}>
                <Text style={styles.limitButtonText}>Upgrade Plan</Text>
              </TouchableOpacity>
            </Link>
          </View>
        )}
        {users.map((u) => (
          <View key={u.id} style={styles.userCard}>
            <View style={styles.userInfo}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{(u.full_name || '?').charAt(0).toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.userName}>{u.full_name || 'Unnamed user'}{u.id === myId ? ' (you)' : ''}</Text>
                <Text style={styles.userMeta}>Joined {new Date(u.created_at).toLocaleDateString()}</Text>
              </View>
              <View style={roleStyle(u.role)}>
                <Text style={styles.roleText}>{u.role.toUpperCase()}</Text>
              </View>
            </View>
            {u.id !== myId && u.role !== 'admin' && (
              <View style={styles.actions}>
                {u.role === 'employee' ? (
                  <TouchableOpacity
                    style={styles.actionButton}
                    onPress={() => changeRole(u.id, 'manager')}
                    disabled={busyId === u.id}
                  >
                    {busyId === u.id
                      ? <ActivityIndicator size="small" color={colors.accent} />
                      : <Text style={styles.actionButtonText}>Make Manager</Text>}
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={styles.actionButton}
                    onPress={() => changeRole(u.id, 'employee')}
                    disabled={busyId === u.id}
                  >
                    {busyId === u.id
                      ? <ActivityIndicator size="small" color={colors.accent} />
                      : <Text style={styles.actionButtonText}>Make Employee</Text>}
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>
        ))}
        {users.length === 0 && (
          <Text style={styles.emptyText}>No users yet.</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingContainer: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  headerTitle: { fontSize: 17, fontFamily: fontFamily.bold, color: colors.textPrimary },
  navButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.sm },
  navButtonText: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 13 },
  content: { padding: spacing.lg, gap: spacing.md },
  message: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary, textAlign: 'center' },
  usageCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.lg },
  usageText: { fontSize: 13, fontFamily: fontFamily.semibold, color: colors.textPrimary, marginBottom: spacing.xs },
  progressTrack: { height: 8, backgroundColor: colors.inputBackground, borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: 8, backgroundColor: colors.accent, borderRadius: 4 },
  limitCard: { backgroundColor: colors.warningSoft, borderWidth: 1, borderColor: colors.warning, borderRadius: radius.lg, padding: spacing.lg },
  limitTitle: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.warning, marginBottom: spacing.xs },
  limitText: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textPrimary, marginBottom: spacing.md },
  limitButton: { ...buttons.primary },
  limitButtonText: { ...buttons.primaryText },
  userCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.lg, ...elevation.card },
  userInfo: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder, justifyContent: 'center', alignItems: 'center' },
  avatarText: { fontSize: 18, fontFamily: fontFamily.bold, color: colors.accent },
  userName: { fontSize: 15, fontFamily: fontFamily.semibold, color: colors.textPrimary },
  userMeta: { fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  roleBadge: { borderRadius: radius.pill, paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1 },
  roleAdmin: { backgroundColor: 'rgba(192,132,245,0.12)', borderColor: 'rgba(192,132,245,0.35)' },
  roleManager: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  roleEmployee: { backgroundColor: colors.surface, borderColor: colors.surfaceBorder },
  roleText: { ...type.label, color: colors.textPrimary },
  actions: { marginTop: spacing.md, flexDirection: 'row', justifyContent: 'flex-end' },
  actionButton: { ...buttons.compactOutline },
  actionButtonText: { ...buttons.compactOutlineText },
  emptyText: { fontFamily: fontFamily.regular, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.xl },
  deniedContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  deniedBadge: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  deniedBadgeText: { fontSize: 28, fontFamily: fontFamily.bold, color: colors.accent },
  deniedTitle: { fontSize: 20, fontFamily: fontFamily.bold, color: colors.textPrimary, marginBottom: spacing.sm },
  deniedText: { fontFamily: fontFamily.regular, fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.xl },
  primaryButton: { ...buttons.primary, paddingHorizontal: spacing.xl },
  primaryButtonText: { ...buttons.primaryText },
});
