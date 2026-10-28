import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, ScrollView, TextInput } from 'react-native';
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
  const [businessId, setBusinessId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [accountNumber, setAccountNumber] = useState('');
  const [worksites, setWorksites] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [savingEmp, setSavingEmp] = useState(false);
  const [empForm, setEmpForm] = useState({ job_title: '', department: '', employee_number: '', start_date: '', employment_type: '', primary_worksite_id: '', vacation_days_entitlement: '10' });

  useEffect(() => { init(); }, []);

  const init = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace('/'); return; }
    setMyId(session.user.id);
    const { data: me } = await supabase.from('profiles').select('role, business_id').eq('id', session.user.id).single();
    if (!me || me.role !== 'admin') { setLoading(false); return; }
    setIsAdmin(true);
    if (me.business_id) {
      setBusinessId(me.business_id);
      const { data: biz } = await supabase.from('businesses').select('business_name, account_number').eq('id', me.business_id).single();
      if (biz) { setBusinessName(biz.business_name || ''); setRenameDraft(biz.business_name || ''); setAccountNumber(biz.account_number || ''); }
    }
    const { data: sub } = await supabase.from('subscriptions').select('employee_limit').eq('owner_id', session.user.id).maybeSingle();
    if (sub) setEmployeeLimit(sub.employee_limit);
    const { data: wsData } = await supabase.from('worksites').select('id, name').order('name', { ascending: true });
    if (wsData) setWorksites(wsData);
    await loadUsers();
    setLoading(false);
  };

  const loadUsers = async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, role, created_at, job_title, department, start_date, employment_type, primary_worksite_id, employee_number, vacation_days_entitlement')
      .order('created_at', { ascending: true });
    if (!error) setUsers(data || []);
  };

  // Business rename (admin only; the screen already gates on admin).
  // The account number and all history stay exactly the same — only
  // the displayed name changes, which is what a sale/handover needs.
  const handleRenameBusiness = async () => {
    const name = (renameDraft || '').trim();
    if (!businessId) { setMessage('No business linked to this account.'); return; }
    if (!name) { setMessage('Enter a business name first.'); return; }
    setRenaming(true); setMessage('');
    const { error } = await supabase.from('businesses').update({ business_name: name }).eq('id', businessId);
    if (error) {
      setMessage('Could not rename the business. Please try again.');
    } else {
      setBusinessName(name);
      setMessage('Business renamed. Your account number and all history stay the same.');
    }
    setRenaming(false);
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

  const openEditor = (user) => {
    setMessage('');
    if (editingId === user.id) { setEditingId(null); return; }
    setEmpForm({
      job_title: user.job_title || '',
      department: user.department || '',
      employee_number: user.employee_number || '',
      start_date: user.start_date || '',
      employment_type: user.employment_type || '',
      primary_worksite_id: user.primary_worksite_id || '',
      vacation_days_entitlement: user.vacation_days_entitlement != null ? String(user.vacation_days_entitlement) : '10',
    });
    setEditingId(user.id);
  };

  const saveEmployment = async (userId) => {
    if (empForm.start_date && !/^\d{4}-\d{2}-\d{2}$/.test(empForm.start_date.trim())) {
      setMessage('Start date must be YYYY-MM-DD.');
      return;
    }
    const ent = parseFloat(empForm.vacation_days_entitlement);
    if (Number.isNaN(ent) || ent < 0) {
      setMessage('Vacation entitlement must be a number, 0 or more.');
      return;
    }
    setSavingEmp(true);
    setMessage('');
    const { error } = await supabase.from('profiles').update({
      job_title: empForm.job_title.trim() || null,
      department: empForm.department.trim() || null,
      employee_number: empForm.employee_number.trim() || null,
      start_date: empForm.start_date.trim() || null,
      employment_type: empForm.employment_type || null,
      primary_worksite_id: empForm.primary_worksite_id || null,
      vacation_days_entitlement: ent,
    }).eq('id', userId);
    if (error) {
      setMessage('Could not save employment details: ' + error.message);
    } else {
      setMessage('Employment details saved.');
      setEditingId(null);
      await loadUsers();
    }
    setSavingEmp(false);
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
        <View style={styles.usageCard}>
          <Text style={styles.usageText}>Business name</Text>
          <TextInput style={styles.input} value={renameDraft} onChangeText={setRenameDraft} placeholder="Business name" autoCapitalize="words" placeholderTextColor={colors.inputPlaceholder} />
          <Text style={styles.usageText}>Account #{accountNumber || '—'} — this never changes, even on a rename.</Text>
          <TouchableOpacity style={styles.limitButton} onPress={handleRenameBusiness} disabled={renaming}>
            {renaming ? <ActivityIndicator color="#0A0E1A" /> : <Text style={styles.limitButtonText}>Save Business Name</Text>}
          </TouchableOpacity>
        </View>
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
            <TouchableOpacity style={styles.empToggle} onPress={() => openEditor(u)}>
              <Text style={styles.empToggleText}>{editingId === u.id ? 'Close Employment Details' : 'Employment Details'}</Text>
            </TouchableOpacity>
            {editingId === u.id && (
              <View style={styles.empForm}>
                <Text style={styles.empLabel}>Job title</Text>
                <TextInput style={styles.empInput} value={empForm.job_title} onChangeText={(v) => setEmpForm({ ...empForm, job_title: v })} placeholder="e.g. Shift Supervisor" placeholderTextColor={colors.inputPlaceholder} />
                <Text style={styles.empLabel}>Department</Text>
                <TextInput style={styles.empInput} value={empForm.department} onChangeText={(v) => setEmpForm({ ...empForm, department: v })} placeholder="e.g. Kitchen" placeholderTextColor={colors.inputPlaceholder} />
                <Text style={styles.empLabel}>Employee #</Text>
                <TextInput style={styles.empInput} value={empForm.employee_number} onChangeText={(v) => setEmpForm({ ...empForm, employee_number: v })} placeholder="e.g. 1042" placeholderTextColor={colors.inputPlaceholder} />
                <Text style={styles.empLabel}>Vacation entitlement (days per year)</Text>
                <TextInput style={styles.empInput} value={empForm.vacation_days_entitlement} onChangeText={(v) => setEmpForm({ ...empForm, vacation_days_entitlement: v })} placeholder="10" placeholderTextColor={colors.inputPlaceholder} keyboardType="decimal-pad" />
                <Text style={styles.empLabel}>Start date</Text>
                <TextInput style={styles.empInput} value={empForm.start_date} onChangeText={(v) => setEmpForm({ ...empForm, start_date: v })} placeholder="YYYY-MM-DD" placeholderTextColor={colors.inputPlaceholder} keyboardType="numbers-and-punctuation" />
                <Text style={styles.empLabel}>Employment type</Text>
                <View style={styles.chipRow}>
                  {['Full-time', 'Part-time', 'Casual', 'Contract'].map((t) => (
                    <TouchableOpacity key={t} style={[styles.chip, empForm.employment_type === t && styles.chipActive]} onPress={() => setEmpForm({ ...empForm, employment_type: empForm.employment_type === t ? '' : t })}>
                      <Text style={[styles.chipText, empForm.employment_type === t && styles.chipTextActive]}>{t}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.empLabel}>Primary worksite</Text>
                <View style={styles.chipRow}>
                  <TouchableOpacity style={[styles.chip, !empForm.primary_worksite_id && styles.chipActive]} onPress={() => setEmpForm({ ...empForm, primary_worksite_id: '' })}>
                    <Text style={[styles.chipText, !empForm.primary_worksite_id && styles.chipTextActive]}>None</Text>
                  </TouchableOpacity>
                  {worksites.map((w) => (
                    <TouchableOpacity key={w.id} style={[styles.chip, empForm.primary_worksite_id === w.id && styles.chipActive]} onPress={() => setEmpForm({ ...empForm, primary_worksite_id: w.id })}>
                      <Text style={[styles.chipText, empForm.primary_worksite_id === w.id && styles.chipTextActive]}>{w.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TouchableOpacity style={styles.empSave} onPress={() => saveEmployment(u.id)} disabled={savingEmp}>
                  {savingEmp ? <ActivityIndicator color="#0A0E1A" /> : <Text style={styles.empSaveText}>Save Employment Details</Text>}
                </TouchableOpacity>
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
  input: { fontFamily: fontFamily.regular, width: '100%', backgroundColor: colors.inputBackground, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: radius.md, padding: spacing.md, fontSize: 16, color: colors.textPrimary, marginVertical: spacing.sm },
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
  empToggle: { marginTop: spacing.md, alignSelf: 'flex-start' },
  empToggleText: { color: colors.accent, fontFamily: fontFamily.semibold, fontSize: 13 },
  empForm: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.surfaceBorder, paddingTop: spacing.md },
  empLabel: { ...type.label, color: colors.textSecondary, marginBottom: spacing.xs },
  empInput: { fontFamily: fontFamily.regular, backgroundColor: colors.inputBackground, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: radius.md, padding: spacing.md, fontSize: 15, color: colors.textPrimary, marginBottom: spacing.md },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: { borderWidth: 1, borderColor: colors.surfaceBorder, backgroundColor: colors.surface, borderRadius: radius.pill, paddingVertical: 8, paddingHorizontal: 14 },
  chipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  chipText: { fontFamily: fontFamily.semibold, fontSize: 13, color: colors.textSecondary },
  chipTextActive: { color: colors.accent },
  empSave: { ...buttons.primary },
  empSaveText: { ...buttons.primaryText },
  emptyText: { fontFamily: fontFamily.regular, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.xl },
  deniedContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  deniedBadge: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  deniedBadgeText: { fontSize: 28, fontFamily: fontFamily.bold, color: colors.accent },
  deniedTitle: { fontSize: 20, fontFamily: fontFamily.bold, color: colors.textPrimary, marginBottom: spacing.sm },
  deniedText: { fontFamily: fontFamily.regular, fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.xl },
  primaryButton: { ...buttons.primary, paddingHorizontal: spacing.xl },
  primaryButtonText: { ...buttons.primaryText },
});
