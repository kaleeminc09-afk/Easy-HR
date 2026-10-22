import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Link } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, spacing, radius, type, elevation, buttons } from '../lib/theme';
import { countBusinessDays, dateRangesOverlap, vacationBalance } from '../supabase/functions/hr-ai-bot/logic';

const TYPES = ['Vacation', 'Sick', 'Personal', 'Unpaid'];

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDate(str) {
  if (!str) return '';
  return new Date(str + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function statusBadge(status) {
  if (status === 'approved') return { label: 'APPROVED', bg: colors.successSoft || colors.accentSoft, fg: colors.success };
  if (status === 'denied') return { label: 'DENIED', bg: colors.surface, fg: colors.danger };
  return { label: 'PENDING', bg: colors.warningSoft, fg: colors.warning };
}

export default function TimeOffScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [setupMissing, setSetupMissing] = useState(false);
  const [myId, setMyId] = useState(null);
  const [myRole, setMyRole] = useState('employee');
  const [businessId, setBusinessId] = useState(null);
  const [entitlement, setEntitlement] = useState(10);
  const [people, setPeople] = useState([]);
  const [mine, setMine] = useState([]);
  const [pendingAll, setPendingAll] = useState([]);
  const [teamApproved, setTeamApproved] = useState([]);
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [confirmingCancelId, setConfirmingCancelId] = useState(null);

  // Request form
  const [formType, setFormType] = useState('Vacation');
  const [formStart, setFormStart] = useState(todayStr());
  const [formEnd, setFormEnd] = useState(todayStr());
  const [formHalf, setFormHalf] = useState(false);
  const [formReason, setFormReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isManager = myRole === 'manager' || myRole === 'admin';
  const year = new Date().getFullYear();
  const balance = vacationBalance(entitlement, mine, year);
  const formDays = countBusinessDays(formStart, formEnd, formHalf && formStart === formEnd);

  useEffect(() => { init(); }, []);

  const init = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace('/'); return; }
    setMyId(session.user.id);
    const { data: me } = await supabase.from('profiles').select('role, business_id').eq('id', session.user.id).single();
    if (me) { setMyRole(me.role || 'employee'); setBusinessId(me.business_id || null); }
    const { data: ent } = await supabase.from('profiles').select('vacation_days_entitlement').eq('id', session.user.id).single();
    if (ent && ent.vacation_days_entitlement != null) setEntitlement(Number(ent.vacation_days_entitlement));
    const { data: ppl } = await supabase.from('profiles').select('id, full_name').order('full_name', { ascending: true });
    if (ppl) setPeople(ppl);
    await loadRequests(session.user.id, me?.role);
    setLoading(false);
  };

  const loadRequests = async (uid, role) => {
    const { data: myReqs, error } = await supabase
      .from('time_off_requests')
      .select('id, user_id, type, start_date, end_date, half_day, reason, status, created_at')
      .eq('user_id', uid)
      .order('created_at', { ascending: false });
    if (error) { setSetupMissing(true); return; }
    setSetupMissing(false);
    setMine(myReqs || []);
    if (role === 'manager' || role === 'admin') {
      const { data: pend } = await supabase
        .from('time_off_requests')
        .select('id, user_id, type, start_date, end_date, half_day, reason, status, created_at')
        .eq('status', 'pending')
        .order('start_date', { ascending: true });
      setPendingAll((pend || []).filter((r) => r.user_id !== uid));
      const { data: appr } = await supabase
        .from('time_off_requests')
        .select('id, user_id, type, start_date, end_date, half_day, reason, status')
        .eq('status', 'approved')
        .gte('end_date', todayStr())
        .order('start_date', { ascending: true })
        .limit(30);
      setTeamApproved(appr || []);
    }
  };

  const nameOf = (id) => {
    const p = people.find((x) => x.id === id);
    return (p && p.full_name) || 'A team member';
  };

  const submitRequest = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(formStart) || !/^\d{4}-\d{2}-\d{2}$/.test(formEnd)) {
      setMessage('Dates must be YYYY-MM-DD.');
      return;
    }
    if (formEnd < formStart) { setMessage('End date must be on or after the start date.'); return; }
    if (formDays <= 0) { setMessage('That range has no business days (Mon-Fri). Pick weekdays.'); return; }
    const clash = mine.find((r) =>
      (r.status === 'pending' || r.status === 'approved') &&
      dateRangesOverlap(r, { start_date: formStart, end_date: formEnd }));
    if (clash) {
      setMessage(`That overlaps your ${clash.type.toLowerCase()} request (${fmtDate(clash.start_date)} to ${fmtDate(clash.end_date)}).`);
      return;
    }
    if (formType === 'Vacation' && formDays > balance.remaining) {
      setMessage(`You have ${balance.remaining} vacation days left this year, but this request is ${formDays}. Ask your manager if you need more.`);
      return;
    }
    setSubmitting(true);
    setMessage('');
    const { error } = await supabase.from('time_off_requests').insert([{
      business_id: businessId,
      user_id: myId,
      type: formType,
      start_date: formStart,
      end_date: formEnd,
      half_day: formHalf && formStart === formEnd,
      reason: formReason.trim() || null,
      status: 'pending',
    }]);
    if (error) {
      setMessage('Could not submit: ' + error.message);
    } else {
      setMessage('Request sent. Your manager will review it.');
      setFormReason('');
      setFormHalf(false);
      await loadRequests(myId, myRole);
    }
    setSubmitting(false);
  };

  const cancelRequest = async (req) => {
    if (confirmingCancelId !== req.id) { setConfirmingCancelId(req.id); return; }
    setBusyId(req.id);
    const { error } = await supabase.from('time_off_requests').delete().eq('id', req.id);
    if (error) setMessage('Could not cancel: ' + error.message);
    setConfirmingCancelId(null);
    await loadRequests(myId, myRole);
    setBusyId(null);
  };

  const review = async (req, status) => {
    setBusyId(req.id);
    setMessage('');
    const { error } = await supabase.from('time_off_requests')
      .update({ status, reviewed_by: myId })
      .eq('id', req.id);
    setMessage(error ? 'Could not update: ' + error.message : `Request ${status}.`);
    await loadRequests(myId, myRole);
    setBusyId(null);
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  const renderRequest = (r, showName) => {
    const b = statusBadge(r.status);
    const days = countBusinessDays(r.start_date, r.end_date, r.half_day);
    return (
      <View key={r.id} style={styles.reqCard}>
        <View style={styles.reqTop}>
          <Text style={styles.reqType}>{r.type}{r.half_day ? ' · Half day' : ''}</Text>
          <View style={[styles.badge, { backgroundColor: b.bg, borderColor: b.fg }]}>
            <Text style={[styles.badgeText, { color: b.fg }]}>{b.label}</Text>
          </View>
        </View>
        {showName ? <Text style={styles.reqName}>{nameOf(r.user_id)}</Text> : null}
        <Text style={styles.reqDates}>{fmtDate(r.start_date)} → {fmtDate(r.end_date)} · {days} business day{days === 1 ? '' : 's'}</Text>
        {r.reason ? <Text style={styles.reqReason}>{r.reason}</Text> : null}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Link href={isManager ? '/manager' : '/'} asChild>
          <TouchableOpacity style={styles.navButton}>
            <Text style={styles.navButtonText}>← Back</Text>
          </TouchableOpacity>
        </Link>
        <Text style={styles.headerTitle}>Time Off</Text>
        <View style={{ width: 80 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {message ? <Text style={styles.message}>{message}</Text> : null}

        {setupMissing ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Time off is not set up yet</Text>
            <Text style={styles.cardText}>The time-off database update has not been applied to this workspace yet. Once it runs, you can request vacation, sick days, and more right here.</Text>
          </View>
        ) : (
          <>
            {isManager && pendingAll.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Waiting for your review ({pendingAll.length})</Text>
                {pendingAll.map((r) => (
                  <View key={r.id}>
                    {renderRequest(r, true)}
                    <View style={styles.reviewRow}>
                      <TouchableOpacity style={styles.smallPrimary} onPress={() => review(r, 'approved')} disabled={busyId === r.id}>
                        <Text style={styles.smallPrimaryText}>Approve</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.smallOutline} onPress={() => review(r, 'denied')} disabled={busyId === r.id}>
                        <Text style={styles.smallOutlineText}>Deny</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Vacation Balance · {year}</Text>
              <View style={styles.balanceRow}>
                <View style={styles.balanceCell}>
                  <Text style={styles.balanceNum}>{balance.entitlement}</Text>
                  <Text style={styles.balanceLabel}>Entitled</Text>
                </View>
                <View style={styles.balanceCell}>
                  <Text style={styles.balanceNum}>{balance.used}</Text>
                  <Text style={styles.balanceLabel}>Used</Text>
                </View>
                <View style={styles.balanceCell}>
                  <Text style={[styles.balanceNum, { color: colors.accent }]}>{balance.remaining}</Text>
                  <Text style={styles.balanceLabel}>Remaining</Text>
                </View>
              </View>
              <Text style={styles.cardText}>Approved vacation days count against the balance. Sick, personal, and unpaid days do not.</Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Request Time Off</Text>
              <Text style={styles.label}>Type</Text>
              <View style={styles.chipRow}>
                {TYPES.map((t) => (
                  <TouchableOpacity key={t} style={[styles.chip, formType === t && styles.chipActive]} onPress={() => setFormType(t)}>
                    <Text style={[styles.chipText, formType === t && styles.chipTextActive]}>{t}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.dateRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Start date</Text>
                  <TextInput style={styles.input} value={formStart} onChangeText={setFormStart} placeholder="YYYY-MM-DD" placeholderTextColor={colors.inputPlaceholder} keyboardType="numbers-and-punctuation" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>End date</Text>
                  <TextInput style={styles.input} value={formEnd} onChangeText={setFormEnd} placeholder="YYYY-MM-DD" placeholderTextColor={colors.inputPlaceholder} keyboardType="numbers-and-punctuation" />
                </View>
              </View>
              {formStart === formEnd && (
                <TouchableOpacity style={[styles.chip, formHalf && styles.chipActive, { alignSelf: 'flex-start', marginBottom: spacing.md }]} onPress={() => setFormHalf(!formHalf)}>
                  <Text style={[styles.chipText, formHalf && styles.chipTextActive]}>Half day</Text>
                </TouchableOpacity>
              )}
              <Text style={styles.label}>Reason (optional)</Text>
              <TextInput style={styles.input} value={formReason} onChangeText={setFormReason} placeholder="Anything your manager should know" placeholderTextColor={colors.inputPlaceholder} />
              <Text style={styles.daysPreview}>
                {formDays > 0 ? `This request is ${formDays} business day${formDays === 1 ? '' : 's'}.` : 'Pick a weekday range to see the day count.'}
              </Text>
              <TouchableOpacity style={styles.primaryButton} onPress={submitRequest} disabled={submitting}>
                {submitting ? <ActivityIndicator color="#0A0E1A" /> : <Text style={styles.primaryButtonText}>Send Request</Text>}
              </TouchableOpacity>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>My Requests</Text>
              {mine.length === 0 ? (
                <Text style={styles.emptyText}>No requests yet.</Text>
              ) : mine.map((r) => (
                <View key={r.id}>
                  {renderRequest(r, false)}
                  {r.status === 'pending' && (
                    <TouchableOpacity style={styles.cancelLink} onPress={() => cancelRequest(r)} disabled={busyId === r.id}>
                      <Text style={styles.cancelLinkText}>{confirmingCancelId === r.id ? 'Tap again to cancel this request' : 'Cancel request'}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ))}
            </View>

            {isManager && teamApproved.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Team Time Off Coming Up</Text>
                {teamApproved.map((r) => renderRequest(r, true))}
              </View>
            )}
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
  section: { gap: spacing.sm },
  sectionTitle: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary, marginBottom: spacing.xs },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.lg, ...elevation.card },
  cardTitle: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary, marginBottom: spacing.sm },
  cardText: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary },
  balanceRow: { flexDirection: 'row', justifyContent: 'space-around', marginVertical: spacing.md },
  balanceCell: { alignItems: 'center' },
  balanceNum: { fontSize: 26, fontFamily: fontFamily.bold, color: colors.textPrimary },
  balanceLabel: { ...type.label, color: colors.textSecondary, marginTop: 2 },
  label: { ...type.label, color: colors.textSecondary, marginBottom: spacing.xs },
  input: { fontFamily: fontFamily.regular, width: '100%', backgroundColor: colors.inputBackground, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: radius.md, padding: spacing.md, fontSize: 15, color: colors.textPrimary, marginBottom: spacing.md },
  dateRow: { flexDirection: 'row', gap: spacing.md },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: { borderWidth: 1, borderColor: colors.surfaceBorder, backgroundColor: colors.surface, borderRadius: radius.pill, paddingVertical: 8, paddingHorizontal: 14 },
  chipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  chipText: { fontFamily: fontFamily.semibold, fontSize: 13, color: colors.textSecondary },
  chipTextActive: { color: colors.accent },
  daysPreview: { fontFamily: fontFamily.semibold, fontSize: 13, color: colors.textPrimary, marginBottom: spacing.md },
  primaryButton: { ...buttons.primary },
  primaryButtonText: { ...buttons.primaryText },
  reqCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.lg, ...elevation.card },
  reqTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  reqType: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary },
  reqName: { fontFamily: fontFamily.semibold, fontSize: 13, color: colors.textPrimary, marginBottom: 2 },
  reqDates: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary },
  reqReason: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textPrimary, marginTop: spacing.xs },
  badge: { borderRadius: radius.pill, paddingVertical: 3, paddingHorizontal: 9, borderWidth: 1 },
  badgeText: { ...type.label },
  reviewRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  smallPrimary: { ...buttons.compact },
  smallPrimaryText: { ...buttons.compactText },
  smallOutline: { ...buttons.compactOutline },
  smallOutlineText: { ...buttons.compactOutlineText },
  cancelLink: { marginTop: spacing.xs, alignSelf: 'flex-start' },
  cancelLinkText: { color: colors.danger, fontFamily: fontFamily.semibold, fontSize: 13 },
  emptyText: { fontFamily: fontFamily.regular, color: colors.textSecondary, fontSize: 13 },
});
