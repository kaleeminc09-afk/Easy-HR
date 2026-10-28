import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Link } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, spacing, radius, type, elevation, buttons } from '../lib/theme';
import { PROVINCE_BREAK_RULES, PROVINCE_CODES, DEFAULT_BREAK_POLICY } from '../supabase/functions/hr-ai-bot/logic';

// Break policy — manager/admin only. One policy per business.
// The meal length can never go below the selected province's legal
// minimum: on province change and on save it is clamped up, with a
// plain explanation, so a business can be more generous than the law
// but never less. Paid rest is business policy, not law, so its
// length and per-shift cap are the business's own choice.
// This screen is the supervision layer: employees never set their
// own pay treatment — they only tap "Start Break" and the policy
// decides the type.
export default function BreakPolicyScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [isManager, setIsManager] = useState(false);
  const [myBusinessId, setMyBusinessId] = useState(null);
  const [province, setProvince] = useState('ON');
  const [mealMinutes, setMealMinutes] = useState(DEFAULT_BREAK_POLICY.meal_minutes);
  const [restMinutes, setRestMinutes] = useState(DEFAULT_BREAK_POLICY.rest_minutes);
  const [restMax, setRestMax] = useState(DEFAULT_BREAK_POLICY.rest_max_per_shift);
  const [mealPaidIfAvailable, setMealPaidIfAvailable] = useState(true);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const rule = PROVINCE_BREAK_RULES[province] || PROVINCE_BREAK_RULES.ON;
  const legalMin = rule.meal_minutes || 0;
  const mealOptions = [...new Set([legalMin, 30, 45, 60].filter((m) => m >= legalMin && m > 0))].sort((a, b) => a - b);

  useEffect(() => { init(); }, []);

  const init = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace('/'); return; }
    const { data: me } = await supabase.from('profiles').select('role, business_id').eq('id', session.user.id).single();
    if (!me || (me.role !== 'manager' && me.role !== 'admin')) { setLoading(false); return; }
    setIsManager(true);
    setMyBusinessId(me.business_id || null);
    if (me.business_id) {
      const { data: pol } = await supabase.from('break_policies').select('*').eq('business_id', me.business_id).maybeSingle();
      if (pol) {
        const savedRule = PROVINCE_BREAK_RULES[pol.province] || PROVINCE_BREAK_RULES.ON;
        const savedMin = savedRule.meal_minutes || 0;
        setProvince(pol.province || 'ON');
        setMealMinutes(Math.max(pol.meal_minutes || 0, savedMin));
        setRestMinutes(pol.rest_minutes || DEFAULT_BREAK_POLICY.rest_minutes);
        setRestMax(pol.rest_max_per_shift ?? DEFAULT_BREAK_POLICY.rest_max_per_shift);
        setMealPaidIfAvailable(pol.meal_paid_if_available ?? true);
        if ((pol.meal_minutes || 0) < savedMin) {
          setMessage(`Meal length was below the legal minimum for ${savedRule.name}, so it was raised to ${savedMin} minutes.`);
        }
      }
    }
    setLoading(false);
  };

  const pickProvince = (code) => {
    setProvince(code);
    const r = PROVINCE_BREAK_RULES[code] || PROVINCE_BREAK_RULES.ON;
    const min = r.meal_minutes || 0;
    if (mealMinutes < min) {
      setMealMinutes(min);
      setMessage(`Meal length raised to ${min} minutes — the legal minimum for ${r.name}.`);
    } else {
      setMessage('');
    }
  };

  const save = async () => {
    if (!myBusinessId) { setMessage('No business is linked to your account, so a policy cannot be saved yet.'); return; }
    const clampedMeal = Math.max(mealMinutes, legalMin);
    if (clampedMeal !== mealMinutes) setMealMinutes(clampedMeal);
    setSaving(true);
    setMessage('');
    const { error } = await supabase.from('break_policies').upsert([{
      business_id: myBusinessId,
      province,
      meal_minutes: clampedMeal,
      rest_minutes: restMinutes,
      rest_max_per_shift: restMax,
      meal_paid_if_available: mealPaidIfAvailable,
      updated_at: new Date().toISOString(),
    }], { onConflict: 'business_id' });
    setMessage(error ? 'Could not save: ' + error.message : 'Break policy saved. Employees will use it on their next break.');
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
          <Text style={styles.deniedText}>You need a manager or admin account to set the break policy.</Text>
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
        <Text style={styles.headerTitle}>Break Policy</Text>
        <View style={{ width: 80 }} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {message ? <Text style={styles.message}>{message}</Text> : null}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Jurisdiction</Text>
          <Text style={styles.cardText}>Meal-break minimums differ by province and territory. Pick where this business operates — the meal rule below follows that jurisdiction.</Text>
          {PROVINCE_CODES.map((code) => {
            const r = PROVINCE_BREAK_RULES[code];
            return (
              <TouchableOpacity key={code} style={[styles.row, province === code && styles.rowActive]} onPress={() => pickProvince(code)}>
                <Text style={[styles.rowText, province === code && styles.rowTextActive]}>{r.name}</Text>
                <Text style={styles.rowNote}>{r.meal_minutes ? `${r.meal_minutes} min after ${Math.round((r.meal_threshold_minutes || 0) / 60)}h` : 'No statutory meal break'}</Text>
              </TouchableOpacity>
            );
          })}
          <Text style={styles.cardText}>{rule.note} Minimums summarised 2026-10-28 — confirm against the official employment-standards source before payroll use. This is not legal advice.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Meal break</Text>
          <Text style={styles.label}>Length (never below the legal minimum of {legalMin} minutes for {rule.name})</Text>
          <View style={styles.chipRow}>
            {mealOptions.map((m) => (
              <TouchableOpacity key={m} style={[styles.chip, mealMinutes === m && styles.chipActive]} onPress={() => setMealMinutes(m)}>
                <Text style={[styles.chipText, mealMinutes === m && styles.chipTextActive]}>{m} min</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity style={styles.toggleRow} onPress={() => setMealPaidIfAvailable(!mealPaidIfAvailable)}>
            <Text style={styles.toggleBox}>{mealPaidIfAvailable ? '☑' : '☐'}</Text>
            <Text style={styles.toggleText}>Meal is paid when the employee must stay available (on-call meal)</Text>
          </TouchableOpacity>
          <Text style={styles.cardText}>On-call meals are flagged for manager review — they are paid only when this toggle is on.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Paid rest breaks (business policy, not law)</Text>
          <Text style={styles.label}>Rest length</Text>
          <View style={styles.chipRow}>
            {[10, 15, 20].map((m) => (
              <TouchableOpacity key={m} style={[styles.chip, restMinutes === m && styles.chipActive]} onPress={() => setRestMinutes(m)}>
                <Text style={[styles.chipText, restMinutes === m && styles.chipTextActive]}>{m} min</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.label}>Max paid rest breaks per shift</Text>
          <View style={styles.chipRow}>
            {[1, 2, 3].map((n) => (
              <TouchableOpacity key={n} style={[styles.chip, restMax === n && styles.chipActive]} onPress={() => setRestMax(n)}>
                <Text style={[styles.chipText, restMax === n && styles.chipTextActive]}>{n}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.cardText}>After the cap, the employee is offered no more paid rest that shift. The meal break is never capped.</Text>
        </View>

        <TouchableOpacity style={styles.primaryButton} onPress={save} disabled={saving || !myBusinessId}>
          {saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Save Break Policy</Text>}
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: colors.backgroundSecondary, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.pill, paddingVertical: 8, paddingHorizontal: 14 },
  chipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  chipText: { color: colors.textSecondary, fontFamily: fontFamily.semibold, fontSize: 13 },
  chipTextActive: { color: colors.accent },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: colors.backgroundSecondary, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.sm, paddingVertical: 12, paddingHorizontal: spacing.md, minHeight: 44 },
  rowActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  rowText: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 14 },
  rowTextActive: { color: colors.accent },
  rowNote: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 12 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: spacing.sm },
  toggleBox: { color: colors.textPrimary, fontSize: 18 },
  toggleText: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 13, flex: 1 },
  primaryButton: { backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', minHeight: 56, justifyContent: 'center' },
  primaryButtonText: { color: '#FFFFFF', fontFamily: fontFamily.semibold, fontSize: 15 },
  deniedContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  deniedTitle: { color: colors.danger, fontFamily: fontFamily.bold, fontSize: 20 },
  deniedText: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 14, textAlign: 'center' },
});
