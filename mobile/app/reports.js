import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Link } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, spacing, radius, type, elevation, buttons } from '../lib/theme';
import { weekStartMs, plannedVsActual } from '../supabase/functions/hr-ai-bot/logic';

const DAY_MS = 24 * 3600 * 1000;
const WEEK_MS = 7 * DAY_MS;

function fmtHours(h) {
  const rounded = Math.round(h * 10) / 10;
  return `${rounded}h`;
}

export default function ReportsScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [isManager, setIsManager] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const [rows, setRows] = useState([]);
  const [names, setNames] = useState({});
  const [message, setMessage] = useState('');

  const weekStart = weekStartMs(Date.now()) + weekOffset * WEEK_MS;
  const weekLabel = new Date(weekStart).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  useEffect(() => { init(); }, []);
  useEffect(() => { if (!loading) loadWeek(); }, [weekOffset]);

  const init = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace('/'); return; }
    const { data: me } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
    const mgr = me && (me.role === 'manager' || me.role === 'admin');
    setIsManager(!!mgr);
    const { data: ppl } = await supabase.from('profiles').select('id, full_name');
    const map = {};
    (ppl || []).forEach((p) => { map[p.id] = p.full_name || 'Unknown'; });
    setNames(map);
    setLoading(false);
  };

  const loadWeek = async () => {
    setMessage('');
    const fromIso = new Date(weekStart).toISOString();
    const toIso = new Date(weekStart + WEEK_MS).toISOString();
    const { data: planned, error: e1 } = await supabase
      .from('shifts')
      .select('user_id, start_time, end_time')
      .eq('status', 'assigned')
      .gte('start_time', fromIso)
      .lt('start_time', toIso);
    const { data: logs, error: e2 } = await supabase
      .from('time_logs')
      .select('user_id, clock_in, clock_out')
      .gte('clock_in', fromIso)
      .lt('clock_in', toIso);
    if (e1 || e2) {
      setMessage('Could not load this week. ' + ((e1 || e2).message || ''));
      setRows([]);
      return;
    }
    setRows(plannedVsActual(planned || [], logs || [], weekStart, Date.now()));
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  const sorted = [...rows].sort((a, b) => (names[a.userId] || '').localeCompare(names[b.userId] || ''));
  const totals = rows.reduce((acc, r) => ({
    planned: acc.planned + r.plannedHours,
    actual: acc.actual + r.actualHours,
    missed: acc.missed + r.missedCount,
    unscheduled: acc.unscheduled + r.unscheduledCount,
  }), { planned: 0, actual: 0, missed: 0, unscheduled: 0 });
  const totalVariance = totals.actual - totals.planned;

  const variancePill = (v) => {
    if (Math.abs(v) < 0.25) return { label: 'On plan', fg: colors.success, bg: colors.accentSoft, border: colors.accentBorder };
    if (v < 0) return { label: `${fmtHours(v)} under`, fg: colors.danger, bg: colors.surface, border: colors.danger };
    return { label: `+${fmtHours(v)} over`, fg: colors.warning, bg: colors.warningSoft, border: colors.warning };
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Link href="/manager" asChild>
          <TouchableOpacity style={styles.navButton}>
            <Text style={styles.navButtonText}>← Back</Text>
          </TouchableOpacity>
        </Link>
        <Text style={styles.headerTitle}>Reports</Text>
        <View style={{ width: 80 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {!isManager ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Managers only</Text>
            <Text style={styles.cardText}>Planned vs actual reports are a manager tool. Your own hours live on your home screen.</Text>
          </View>
        ) : (
          <>
            <View style={styles.weekNav}>
              <TouchableOpacity style={styles.navButton} onPress={() => setWeekOffset(weekOffset - 1)}>
                <Text style={styles.navButtonText}>← Prev</Text>
              </TouchableOpacity>
              <View style={styles.weekLabelBox}>
                <Text style={styles.weekLabel}>Week of {weekLabel}</Text>
                {weekOffset !== 0 && (
                  <TouchableOpacity onPress={() => setWeekOffset(0)}>
                    <Text style={styles.thisWeek}>Back to this week</Text>
                  </TouchableOpacity>
                )}
              </View>
              <TouchableOpacity style={styles.navButton} onPress={() => setWeekOffset(weekOffset + 1)}>
                <Text style={styles.navButtonText}>Next →</Text>
              </TouchableOpacity>
            </View>

            {message ? <Text style={styles.message}>{message}</Text> : null}

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Team Totals</Text>
              <View style={styles.totalsRow}>
                <View style={styles.totalCell}>
                  <Text style={styles.totalNum}>{fmtHours(totals.planned)}</Text>
                  <Text style={styles.totalLabel}>Planned</Text>
                </View>
                <View style={styles.totalCell}>
                  <Text style={styles.totalNum}>{fmtHours(totals.actual)}</Text>
                  <Text style={styles.totalLabel}>Actual</Text>
                </View>
                <View style={styles.totalCell}>
                  <Text style={[styles.totalNum, { color: Math.abs(totalVariance) < 0.25 ? colors.success : totalVariance < 0 ? colors.danger : colors.warning }]}>
                    {totalVariance > 0 ? '+' : ''}{fmtHours(totalVariance)}
                  </Text>
                  <Text style={styles.totalLabel}>Variance</Text>
                </View>
              </View>
              {(totals.missed > 0 || totals.unscheduled > 0) && (
                <Text style={styles.cardText}>
                  {totals.missed > 0 ? `${totals.missed} missed shift${totals.missed === 1 ? '' : 's'}. ` : ''}
                  {totals.unscheduled > 0 ? `${totals.unscheduled} unscheduled shift${totals.unscheduled === 1 ? '' : 's'} worked.` : ''}
                </Text>
              )}
            </View>

            {sorted.length === 0 ? (
              <Text style={styles.emptyText}>No scheduled or worked shifts this week.</Text>
            ) : sorted.map((r) => {
              const pill = variancePill(r.varianceHours);
              return (
                <View key={r.userId} style={styles.card}>
                  <View style={styles.rowTop}>
                    <Text style={styles.personName}>{names[r.userId] || 'Unknown'}</Text>
                    <View style={[styles.pill, { backgroundColor: pill.bg, borderColor: pill.border }]}>
                      <Text style={[styles.pillText, { color: pill.fg }]}>{pill.label}</Text>
                    </View>
                  </View>
                  <Text style={styles.rowHours}>Planned {fmtHours(r.plannedHours)} · Actual {fmtHours(r.actualHours)}</Text>
                  <Text style={styles.rowDetail}>
                    {r.workedCount} of {r.plannedCount} scheduled shifts worked
                    {r.missedCount > 0 ? ` · ${r.missedCount} missed` : ''}
                    {r.unscheduledCount > 0 ? ` · ${r.unscheduledCount} unscheduled` : ''}
                  </Text>
                </View>
              );
            })}

            <Text style={styles.footnote}>Actual hours are gross clocked time (breaks not deducted), matching the overtime and audit views. A shift counts as worked when the person clocked in on the same day it was scheduled.</Text>
          </>
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
  content: { padding: spacing.lg, gap: spacing.lg },
  message: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary, textAlign: 'center' },
  weekNav: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  weekLabelBox: { alignItems: 'center' },
  weekLabel: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary },
  thisWeek: { color: colors.accent, fontFamily: fontFamily.semibold, fontSize: 13, marginTop: 2 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.lg, ...elevation.card },
  cardTitle: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary, marginBottom: spacing.sm },
  cardText: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary, marginTop: spacing.sm },
  totalsRow: { flexDirection: 'row', justifyContent: 'space-around', marginVertical: spacing.sm },
  totalCell: { alignItems: 'center' },
  totalNum: { fontSize: 24, fontFamily: fontFamily.bold, color: colors.textPrimary },
  totalLabel: { ...type.label, color: colors.textSecondary, marginTop: 2 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  personName: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary },
  rowHours: { fontFamily: fontFamily.semibold, fontSize: 14, color: colors.textPrimary },
  rowDetail: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  pill: { borderRadius: radius.pill, paddingVertical: 3, paddingHorizontal: 9, borderWidth: 1 },
  pillText: { ...type.label },
  emptyText: { fontFamily: fontFamily.regular, color: colors.textSecondary, fontSize: 13, textAlign: 'center' },
  footnote: { fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSecondary },
});
