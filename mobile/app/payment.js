import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Link, useLocalSearchParams } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, spacing, radius, type, elevation, buttons } from '../lib/theme';

// Plans mirror the Subscription screen. First month free, month-to-month.
const PLANS = {
  starter: { name: 'Starter', price: 25, limit: 5 },
  growth: { name: 'Growth', price: 59, limit: 15 },
  business: { name: 'Business', price: 119, limit: 40 },
};

// RevenueCat integration point (post-launch):
//  1. `npx expo install react-native-purchases`
//  2. Configure products in App Store Connect / Play Console, link in RevenueCat.
//  3. Replace handleSubscribe's stub with Purchases.purchasePackage() and
//     write the resulting entitlement back to public.subscriptions.
const BILLING_WIRED = false;

export default function PaymentScreen() {
  const router = useRouter();
  const { plan: planParam } = useLocalSearchParams();
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [plan, setPlan] = useState('starter');
  const [status, setStatus] = useState('trialing');
  const [periodEnd, setPeriodEnd] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => { init(); }, []);

  const init = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace('/'); return; }
    const { data: me } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
    if (!me || me.role !== 'admin') { setLoading(false); return; }
    setIsAdmin(true);

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('plan, status, current_period_end')
      .eq('owner_id', session.user.id)
      .maybeSingle();
    const current = sub?.plan || 'starter';
    setPlan(PLANS[planParam] ? planParam : current);
    setStatus(sub?.status || 'trialing');
    setPeriodEnd(sub?.current_period_end || null);
    setLoading(false);
  };

  const handleSubscribe = async () => {
    if (!BILLING_WIRED) {
      setMessage('Checkout opens at launch — your free trial is already active. Nothing is charged today.');
      return;
    }
    setProcessing(true);
    setMessage('');
    try {
      // RevenueCat purchase flow goes here (see BILLING_WIRED note above).
    } catch (e) {
      setMessage('Payment failed: ' + e.message);
    } finally {
      setProcessing(false);
    }
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
          <Text style={styles.deniedText}>Billing is managed by administrators.</Text>
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
  const isTrial = status === 'trialing';
  const daysLeft = periodEnd
    ? Math.max(0, Math.ceil((new Date(periodEnd).getTime() - Date.now()) / 86400000))
    : 30;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Link href="/subscription" asChild>
          <TouchableOpacity style={styles.navButton}>
            <Text style={styles.navButtonText}>← Plans</Text>
          </TouchableOpacity>
        </Link>
        <Text style={styles.headerTitle}>Payment</Text>
        <View style={{ width: 80 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Order summary</Text>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>{planInfo.name} plan</Text>
            <Text style={styles.rowValue}>${planInfo.price}/mo</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Employees included</Text>
            <Text style={styles.rowValue}>Up to {planInfo.limit}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>First month</Text>
            <Text style={[styles.rowValue, styles.freeText]}>Free</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={styles.totalLabel}>Due today</Text>
            <Text style={styles.totalValue}>$0</Text>
          </View>
          <Text style={styles.finePrint}>
            {isTrial
              ? `Your free trial has ${daysLeft} day${daysLeft === 1 ? '' : 's'} left. Billing starts at $${planInfo.price}/mo after the trial.`
              : `Billing continues at $${planInfo.price}/mo.`} Month-to-month — cancel anytime, no lock-in.
          </Text>

          {message ? <Text style={styles.message}>{message}</Text> : null}

          <TouchableOpacity style={styles.primaryButton} onPress={handleSubscribe} disabled={processing}>
            {processing
              ? <ActivityIndicator color="#FFFFFF" />
              : <Text style={styles.primaryButtonText}>Subscribe — ${planInfo.price}/mo</Text>}
          </TouchableOpacity>

          <Text style={styles.secureNote}>Processed securely through the App Store / Google Play</Text>
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
  content: { padding: spacing.lg },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.xl, ...elevation.card },
  cardTitle: { fontSize: 18, fontFamily: fontFamily.bold, color: colors.textPrimary, marginBottom: spacing.md },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.sm },
  rowLabel: { fontFamily: fontFamily.regular, fontSize: 14, color: colors.textSecondary },
  rowValue: { fontSize: 14, fontFamily: fontFamily.semibold, color: colors.textPrimary },
  freeText: { color: colors.success },
  divider: { height: 1, backgroundColor: colors.surfaceBorder, marginVertical: spacing.sm },
  totalLabel: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary },
  totalValue: { fontSize: 18, fontFamily: fontFamily.bold, color: colors.accent },
  finePrint: { fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSecondary, marginTop: spacing.md, lineHeight: 18 },
  message: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.md },
  primaryButton: { ...buttons.primary, marginTop: spacing.xl },
  primaryButtonText: { ...buttons.primaryText },
  secureNote: { fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.md },
  deniedContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  deniedBadge: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  deniedBadgeText: { fontSize: 28, fontFamily: fontFamily.bold, color: colors.accent },
  deniedTitle: { fontSize: 20, fontFamily: fontFamily.bold, color: colors.textPrimary, marginBottom: spacing.sm },
  deniedText: { fontFamily: fontFamily.regular, fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.xl },
});
