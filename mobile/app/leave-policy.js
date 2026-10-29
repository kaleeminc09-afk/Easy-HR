import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, ScrollView, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Link } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, spacing, radius, type, elevation, buttons } from '../lib/theme';

// Leave policy — manager/admin only. One policy per business.
// Vacation is deliberately NOT here: each employee's vacation days live
// on their profile (vacation_days_entitlement, edited in Manage Users).
// This screen sets the business-wide rules: sick and personal annual
// caps (empty = no annual limit) and which leave types employees may
// request at all. Unpaid leave is always available and never capped.
// Turning a type off removes it from the employee's request dropdown;
// it does not delete existing requests of that type.
export default function LeavePolicyScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [isManager, setIsManager] = useState(false);
  const [myBusinessId, setMyBusinessId] = useState(null);
  const [sickDays, setSickDays] = useState('');
  const [personalDays, setPersonalDays] = useState('');
  const [sickOffered, setSickOffered] = useState(true);
  const [personalOffered, setPersonalOffered] = useState(true);
  const [otherOffered, setOtherOffered] = useState(true);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { init(); }, []);

  const init = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace('/'); return; }
    const { data: me } = await supabase.from('profiles').select('role, business_id').eq('id', session.user.id).single();
    if (!me || (me.role !== 'manager' && me.role !== 'admin')) { setLoading(false); return; }
    setIsManager(true);
    setMyBusinessId(me.business_id || null);
    if (me.business_id) {
      const { data: pol } = await supabase.from('leave_policies').select('*').eq('business_id', me.business_id).maybeSingle();
      if (pol) {
        setSickDays(pol.sick_days != null ? String(pol.sick_days) : '');
        setPersonalDays(pol.personal_days != null ? String(pol.personal_days) : '');
        setSickOffered(pol.sick_offered !== false);
        setPersonalOffered(pol.personal_offered !== false);
        setOtherOffered(pol.other_offered !== false);
      }
    }
    setLoading(false);
  };

  // Empty = no annual limit. Otherwise a whole number, 0 or more.
  const parseDays = (raw, label) => {
    const v = raw.trim();
    if (v === '') return { ok: true, value: null };
    if (!/^\d+$/.test(v)) return { ok: false, value: null, error: `${label} must be a whole number of 0 or more, or empty for no limit.` };
    return { ok: true, value: parseInt(v, 10) };
  };

  const save = async () => {
    if (!myBusinessId) { setMessage('No business is linked to your account, so a policy cannot be saved yet.'); return; }
    const sick = parseDays(sickDays, 'Sick days');
    if (!sick.ok) { setMessage(sick.error); return; }
    const personal = parseDays(personalDays, 'Personal days');
    if (!personal.ok) { setMessage(personal.error); return; }
    setSaving(true);
    setMessage('');
    const { error } = await supabase.from('leave_policies').upsert([{
      business_id: myBusinessId,
      sick_days: sick.value,
      personal_days: personal.value,
      sick_offered: sickOffered,
      personal_offered: personalOffered,
      other_offered: otherOffered,
      updated_at: new Date().toISOString(),
    }], { onConflict: 'business_id' });
    setMessage(error ? 'Could not save: ' + error.message : 'Leave policy saved. Employees will see it on their next Time Off visit.');
    setSaving(false);
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (!isManager) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.deniedContainer}>
          <Text style={styles.deniedTitle}>Managers only</Text>
          <Text style={styles.deniedText}>You need a manager or admin account to set the leave policy.</Text>
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
            <Text style={styles.navButtonText}>← Back</Text>
          </TouchableOpacity>
        </Link>
        <Text style={styles.headerTitle}>Leave Policy</Text>
        <View style={{ width: 80 }} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {message ? <Text style={styles.message}>{message}</Text> : null}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Sick days</Text>
          <Text style={styles.label}>Annual limit (empty = no limit)</Text>
          <TextInput style={styles.input} value={sickDays} onChangeText={setSickDays} placeholder="No limit" placeholderTextColor={colors.inputPlaceholder} keyboardType="numbers-and-punctuation" />
          <TouchableOpacity style={styles.toggleRow} onPress={() => setSickOffered(!sickOffered)}>
            <Text style={styles.toggleBox}>{sickOffered ? '☑' : '☐'}</Text>
            <Text style={styles.toggleText}>Employees can request sick days</Text>
          </TouchableOpacity>
          <Text style={styles.cardText}>Example: 4 means each employee gets 4 approved sick days per year; a request past that is stopped with the days they have left.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Personal days</Text>
          <Text style={styles.label}>Annual limit (empty = no limit)</Text>
          <TextInput style={styles.input} value={personalDays} onChangeText={setPersonalDays} placeholder="No limit" placeholderTextColor={colors.inputPlaceholder} keyboardType="numbers-and-punctuation" />
          <TouchableOpacity style={styles.toggleRow} onPress={() => setPersonalOffered(!personalOffered)}>
            <Text style={styles.toggleBox}>{personalOffered ? '☑' : '☐'}</Text>
            <Text style={styles.toggleText}>Employees can request personal days</Text>
          </TouchableOpacity>
          <Text style={styles.cardText}>Turn this off and Personal disappears from the employee's request dropdown entirely.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Other leave</Text>
          <TouchableOpacity style={styles.toggleRow} onPress={() => setOtherOffered(!otherOffered)}>
            <Text style={styles.toggleBox}>{otherOffered ? '☑' : '☐'}</Text>
            <Text style={styles.toggleText}>Employees can request "Other" leave</Text>
          </TouchableOpacity>
          <Text style={styles.cardText}>Other has no annual limit — it is a catch-all for leave that fits no other type. Vacation stays per employee (set on Manage Users) and Unpaid is always available.</Text>
        </View>

        <TouchableOpacity style={styles.primaryButton} onPress={save} disabled={saving || !myBusinessId}>
          {saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Save Leave Policy</Text>}
        </TouchableOpacity>
        {!myBusinessId ? <Text style={styles.cardText}>No business is linked to your account, so this policy cannot be saved yet.</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingContainer: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, backgroundColor: colors.backgroundSecondary, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  headerTitle: { color: colors.textPrimary, fontFamily: fontFamily.bold, fontSize: 17 },
  navButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.sm },
  navButtonText: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 13 },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  message: { color: colors.textPrimary, fontFamily: fontFamily.regular, fontSize: 14, textAlign: 'center' },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, padding: spacing.lg, gap: spacing.sm },
  cardTitle: { color: colors.textPrimary, fontFamily: fontFamily.bold, fontSize: 16 },
  cardText: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 13, lineHeight: 19 },
  label: { color: colors.textSecondary, fontFamily: fontFamily.semibold, fontSize: 12, marginTop: spacing.sm },
  input: { backgroundColor: colors.inputBackground, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: radius.md, padding: spacing.md, fontSize: 16, fontFamily: fontFamily.regular, color: colors.textPrimary },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: spacing.sm },
  toggleBox: { color: colors.textPrimary, fontSize: 18 },
  toggleText: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 13, flex: 1 },
  primaryButton: { backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', minHeight: 56, justifyContent: 'center' },
  primaryButtonText: { color: '#FFFFFF', fontFamily: fontFamily.semibold, fontSize: 15 },
  deniedContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  deniedTitle: { color: colors.danger, fontFamily: fontFamily.bold, fontSize: 20 },
  deniedText: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 14, textAlign: 'center' },
});
