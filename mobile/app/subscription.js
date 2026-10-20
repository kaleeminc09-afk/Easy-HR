import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Link } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, spacing, radius, type, elevation, buttons } from '../lib/theme';

// First month free on every plan — no permanent free tier.
const PLANS = {
  starter: { name: 'Starter', price: '$25/mo', limit: 5, features: ['Up to 5 employees', 'Geofenced clock in/out', 'Shift logs & exceptions'] },
  growth: { name: 'Growth', price: '$59/mo', limit: 15, features: ['Up to 15 employees', 'Everything in Starter', 'AI assistant & anomaly review', 'Payroll CSV export'] },
  business: { name: 'Business', price: '$119/mo', limit: 40, features: ['Up to 40 employees', 'Everything in Growth', 'Priority support'] },
};

export default function SubscriptionScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [plan, setPlan] = useState('starter');
  const [status, setStatus] = useState('trialing');
  const [periodEnd, setPeriodEnd] = useState(null);
  const [employeeCount, setEmployeeCount] = useState(0);
  const [businessId, setBusinessId] = useState(null);
  const [businessName, setBusinessName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [savingBiz, setSavingBiz] = useState(false);
  const [bizMessage, setBizMessage] = useState('');

  useEffect(() => { init(); }, []);

  const init = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace('/'); return; }
    const { data: me } = await supabase.from('profiles').select('role, business_id').eq('id', session.user.id).single();
    if (!me || me.role !== 'admin') { setLoading(false); return; }
    setIsAdmin(true);

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('plan, status, current_period_end')
      .eq('owner_id', session.user.id)
      .maybeSingle();
    if (sub) {
      setPlan(sub.plan || 'starter');
      setStatus(sub.status || 'trialing');
      setPeriodEnd(sub.current_period_end);
    }

    if (me.business_id) {
      const { data: biz } = await supabase
        .from('businesses')
        .select('id, business_name, account_number')
        .eq('id', me.business_id)
        .single();
      if (biz) {
        setBusinessId(biz.id);
        setBusinessName(biz.business_name || '');
        setAccountNumber(biz.account_number || '');
      }
    }

    const { count } = await supabase.from('profiles').select('id', { count: 'exact', head: true });
    setEmployeeCount(count || 0);
    setLoading(false);
  };

  const saveBusiness = async () => {
    if (!businessId) return;
    setSavingBiz(true);
    setBizMessage('');
    const { error } = await supabase
      .from('businesses')
      .update({ business_name: businessName.trim() })
      .eq('id', businessId);
    setBizMessage(error ? 'Could not save. Check your connection and try again.' : 'Business name updated.');
    setSavingBiz(false);
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
          <Text style={styles.deniedText}>Subscription details are visible to administrators.</Text>
          <Link href="/manager" asChild>
            <TouchableOpacity style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>← Back to Dashboard</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </SafeAreaView>
    );
  }

  const planInfo = PLANS[plan] || PLANS.starter;
  const usagePct = Math.min(100, Math.round((employeeCount / planInfo.limit) * 100));
  const isTrial = status === 'trialing';
  const daysLeft = periodEnd
    ? Math.max(0, Math.ceil((new Date(periodEnd).getTime() - Date.now()) / 86400000))
    : 30;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Link href="/manager" asChild>
          <TouchableOpacity style={styles.navButton}>
            <Text style={styles.navButtonText}>← Dashboard</Text>
          </TouchableOpacity>
        </Link>
        <Text style={styles.headerTitle}>Subscription</Text>
        <View style={{ width: 110 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.planCard}>
          <View style={styles.planHeader}>
            <View>
              <Text style={styles.planName}>{planInfo.name}</Text>
              <Text style={styles.planPrice}>{planInfo.price}</Text>
            </View>
            <View style={styles.statusBadge}>
              <Text style={styles.statusText}>{isTrial ? 'TRIAL' : status.toUpperCase()}</Text>
            </View>
          </View>

          {isTrial && (
            <View style={styles.trialBanner}>
              <Text style={styles.trialText}>
                First month free — {daysLeft} day{daysLeft === 1 ? '' : 's'} left. Then {planInfo.price} after the trial.
              </Text>
            </View>
          )}

          <Text style={styles.sectionLabel}>Team usage</Text>
          <View style={styles.usageRow}>
            <Text style={styles.usageText}>{employeeCount} of {planInfo.limit} employees</Text>
            <Text style={styles.usageText}>{usagePct}%</Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${usagePct}%` }]} />
          </View>

          {periodEnd && !isTrial && (
            <Text style={styles.renewText}>
              Renews {new Date(periodEnd).toLocaleDateString()}
            </Text>
          )}

          <Text style={styles.sectionLabel}>What's included</Text>
          {planInfo.features.map((f) => (
            <Text key={f} style={styles.feature}>✓ {f}</Text>
          ))}

          <Link href="/payment" asChild>
            <TouchableOpacity style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Change Plan</Text>
            </TouchableOpacity>
          </Link>
        </View>

        <View style={styles.allPlansCard}>
          <Text style={styles.sectionLabel}>All plans</Text>
          <Text style={styles.trialNote}>Every plan starts with a free first month.</Text>
          {Object.entries(PLANS).map(([key, p]) => (
            <View key={key} style={[styles.planRow, key === plan && styles.planRowActive]}>
              <View>
                <Text style={styles.planRowName}>{p.name} · {p.price}</Text>
                <Text style={styles.planRowMeta}>Up to {p.limit} employees</Text>
              </View>
              {key === plan && <Text style={styles.currentTag}>CURRENT</Text>}
            </View>
          ))}
        </View>

        <View style={styles.allPlansCard}>
          <Text style={styles.sectionLabel}>Business</Text>
          <Text style={styles.trialNote}>Shown to every employee and manager. Only admins can change it.</Text>
          <Text style={styles.fieldLabel}>Business name</Text>
          <TextInput
            style={styles.input}
            value={businessName}
            onChangeText={setBusinessName}
            placeholder="Your company name"
            placeholderTextColor={colors.inputPlaceholder}
          />
          <Text style={styles.fieldLabel}>Account number</Text>
          <Text style={styles.accountNumber}>{accountNumber || '—'}</Text>
          {bizMessage ? <Text style={styles.bizMessage}>{bizMessage}</Text> : null}
          <TouchableOpacity style={styles.primaryButton} onPress={saveBusiness} disabled={savingBiz || !businessId}>
            {savingBiz ? <ActivityIndicator color="#0A0E1A" /> : <Text style={styles.primaryButtonText}>Save Business Name</Text>}
          </TouchableOpacity>
        </View>
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
  planCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.xl, ...elevation.card },
  planHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  planName: { fontSize: 22, fontFamily: fontFamily.bold, color: colors.textPrimary },
  planPrice: { fontSize: 15, color: colors.accent, fontFamily: fontFamily.semibold, marginTop: 2 },
  statusBadge: { backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder, borderRadius: radius.pill, paddingVertical: 4, paddingHorizontal: 12 },
  statusText: { ...type.label, color: colors.accent },
  trialBanner: { backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  trialText: { fontSize: 13, color: colors.textPrimary, fontFamily: fontFamily.semibold, textAlign: 'center' },
  sectionLabel: { ...type.label, color: colors.textSecondary, marginTop: spacing.md, marginBottom: spacing.xs },
  trialNote: { fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSecondary, marginBottom: spacing.sm },
  usageRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.xs },
  usageText: { fontSize: 13, color: colors.textPrimary, fontFamily: fontFamily.semibold },
  progressTrack: { height: 8, backgroundColor: colors.inputBackground, borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: 8, backgroundColor: colors.accent, borderRadius: 4 },
  renewText: { fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSecondary, marginTop: spacing.sm },
  feature: { fontFamily: fontFamily.regular, fontSize: 14, color: colors.textPrimary, marginTop: spacing.xs },
  primaryButton: { ...buttons.primary, marginTop: spacing.xl },
  primaryButtonText: { ...buttons.primaryText },
  allPlansCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.lg },
  planRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  planRowActive: { borderBottomWidth: 0 },
  planRowName: { fontSize: 14, fontFamily: fontFamily.semibold, color: colors.textPrimary },
  planRowMeta: { fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  currentTag: { ...type.label, color: colors.accent },
  fieldLabel: { ...type.label, color: colors.textSecondary, marginTop: spacing.sm, marginBottom: spacing.xs },
  input: { fontFamily: fontFamily.regular, backgroundColor: colors.inputBackground, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: radius.md, padding: spacing.md, fontSize: 16, color: colors.textPrimary },
  accountNumber: { fontSize: 16, fontFamily: fontFamily.bold, color: colors.accent, letterSpacing: 1 },
  bizMessage: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.sm },
  deniedContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  deniedBadge: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  deniedBadgeText: { fontSize: 28, fontFamily: fontFamily.bold, color: colors.accent },
  deniedTitle: { fontSize: 20, fontFamily: fontFamily.bold, color: colors.textPrimary, marginBottom: spacing.sm },
  deniedText: { fontFamily: fontFamily.regular, fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.xl },
});
