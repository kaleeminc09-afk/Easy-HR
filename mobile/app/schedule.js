import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, spacing, radius, type, elevation, buttons } from '../lib/theme';
import { weekStartMs, shiftDurationHours } from '../supabase/functions/hr-ai-bot/logic';

const DAY_MS = 24 * 3600 * 1000;

function fmtTime12(iso) {
  const d = new Date(iso);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function fmtDateShort(ms) {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dateKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export default function ScheduleScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [setupMissing, setSetupMissing] = useState(false);
  const [myId, setMyId] = useState(null);
  const [myRole, setMyRole] = useState('employee');
  const [businessId, setBusinessId] = useState(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [shifts, setShifts] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [people, setPeople] = useState([]);
  const [worksites, setWorksites] = useState([]);
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);

  // Mini month calendar: days with at least one shift are highlighted;
  // tapping a day jumps the week view to that day's week.
  const [calMonth, setCalMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [monthShifts, setMonthShifts] = useState([]);

  const isManager = myRole === 'manager' || myRole === 'admin';

  // Back means back: return to the screen we came from, not a
  // role-based destination. A manager who came from the employee
  // home goes back to the employee home, not the Manager Portal.
  // A deep link with no history falls back to the employee home.
  const handleBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  const weekStart = weekStartMs(Date.now()) + weekOffset * 7 * DAY_MS;
  const weekEnd = weekStart + 7 * DAY_MS;

  useEffect(() => { init(); }, []);
  useEffect(() => { if (myId) loadShifts(); }, [weekOffset, myId]);
  useEffect(() => { if (myId) loadMonthShifts(calMonth); }, [calMonth, myId]);

  const init = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace('/'); return; }
    setMyId(session.user.id);
    const { data: me } = await supabase.from('profiles').select('role, business_id').eq('id', session.user.id).single();
    if (me) { setMyRole(me.role || 'employee'); setBusinessId(me.business_id || null); }
    const { data: ppl } = await supabase.from('profiles').select('id, full_name').order('full_name', { ascending: true });
    if (ppl) setPeople(ppl);
    const { data: ws } = await supabase.from('worksites').select('id, name').order('name', { ascending: true });
    if (ws) setWorksites(ws);
    setLoading(false);
  };

  const loadShifts = async () => {
    const { data, error } = await supabase
      .from('shifts')
      .select('id, user_id, worksite_id, start_time, end_time, status, claimed_by, notes')
      .gte('start_time', new Date(weekStart).toISOString())
      .lt('start_time', new Date(weekEnd).toISOString())
      .order('start_time', { ascending: true });
    if (error) { setSetupMissing(true); setShifts([]); return; }
    setSetupMissing(false);
    setShifts(data || []);
    // Approved time off overlapping this week (tolerant: table may not
    // exist yet if the time-off update has not been applied).
    const p2 = (n) => String(n).padStart(2, '0');
    const fmtD = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
    const { data: lv } = await supabase
      .from('time_off_requests')
      .select('user_id, type, start_date, end_date')
      .eq('status', 'approved')
      .lte('start_date', fmtD(weekEnd - DAY_MS))
      .gte('end_date', fmtD(weekStart));
    setLeaves(lv || []);
    loadMonthShifts(calMonth);
  };

  const loadMonthShifts = async (monthStart) => {
    const start = new Date(monthStart);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const { data } = await supabase
      .from('shifts')
      .select('id, start_time')
      .gte('start_time', start.toISOString())
      .lt('start_time', end.toISOString());
    setMonthShifts(data || []);
  };

  const nameOf = (id) => {
    if (!id) return null;
    const p = people.find((x) => x.id === id);
    return (p && p.full_name) || 'A team member';
  };
  const worksiteOf = (id) => {
    const w = worksites.find((x) => x.id === id);
    return w ? w.name : null;
  };

  const claimShift = async (shift) => {
    setBusyId(shift.id);
    setMessage('');
    const { error } = await supabase.from('shifts')
      .update({ status: 'claim_pending', claimed_by: myId })
      .eq('id', shift.id)
      .eq('status', 'open');
    setMessage(error ? 'Could not claim that shift — it may already be taken.' : 'Request sent. Your manager will approve it.');
    await loadShifts();
    setBusyId(null);
  };

  const cancelClaim = async (shift) => {
    setBusyId(shift.id);
    const { error } = await supabase.from('shifts')
      .update({ status: 'open', claimed_by: null })
      .eq('id', shift.id);
    if (error) setMessage('Could not cancel the request: ' + error.message);
    await loadShifts();
    setBusyId(null);
  };

  const approveClaim = async (shift) => {
    setBusyId(shift.id);
    const { error } = await supabase.from('shifts')
      .update({ status: 'assigned', user_id: shift.claimed_by, claimed_by: null })
      .eq('id', shift.id);
    setMessage(error ? 'Could not approve: ' + error.message : `Shift assigned to ${nameOf(shift.claimed_by)}.`);
    await loadShifts();
    setBusyId(null);
  };

  const denyClaim = async (shift) => {
    setBusyId(shift.id);
    const { error } = await supabase.from('shifts')
      .update({ status: 'open', claimed_by: null })
      .eq('id', shift.id);
    if (error) setMessage('Could not deny: ' + error.message);
    await loadShifts();
    setBusyId(null);
  };

  const deleteShift = async (shift) => {
    if (confirmingDeleteId !== shift.id) { setConfirmingDeleteId(shift.id); return; }
    setBusyId(shift.id);
    const { error } = await supabase.from('shifts').delete().eq('id', shift.id);
    if (error) setMessage('Could not delete: ' + error.message);
    setConfirmingDeleteId(null);
    await loadShifts();
    setBusyId(null);
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  const days = [];
  for (let i = 0; i < 7; i++) {
    const dayMs = weekStart + i * DAY_MS;
    const key = dateKey(new Date(dayMs).toISOString());
    days.push({ dayMs, key, shifts: shifts.filter((s) => dateKey(s.start_time) === key) });
  }
  const todayKey = dateKey(new Date().toISOString());

  const calCells = () => {
    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    const firstDow = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const filled = new Set(monthShifts.map((s) => dateKey(s.start_time)));
    const todayK = dateKey(new Date().toISOString());
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push(<View key={`b${i}`} style={styles.calCell} />);
    for (let d = 1; d <= daysInMonth; d++) {
      const dayMs = new Date(y, m, d).getTime();
      const key = `${y}-${m}-${d}`;
      const isFilled = filled.has(key);
      const isToday = key === todayK;
      cells.push(
        <TouchableOpacity key={key} style={[styles.calCell, isFilled && styles.calCellFilled, isToday && styles.calCellToday]} onPress={() => setWeekOffset(Math.round((weekStartMs(dayMs) - weekStartMs(Date.now())) / (7 * DAY_MS)))}>
          <Text style={[styles.calCellText, isFilled && styles.calCellTextFilled]}>{d}</Text>
        </TouchableOpacity>
      );
    }
    return cells;
  };

  const badgeFor = (s) => {
    if (s.user_id === myId) return { text: 'YOUR SHIFT', style: styles.badgeMine, textStyle: styles.badgeMineText };
    if (s.status === 'open') return { text: 'OPEN SHIFT', style: styles.badgeOpen, textStyle: styles.badgeOpenText };
    if (s.status === 'claim_pending') return { text: 'CLAIM PENDING', style: styles.badgePending, textStyle: styles.badgePendingText };
    return { text: 'ASSIGNED', style: styles.badgeAssigned, textStyle: styles.badgeAssignedText };
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.navButton} onPress={handleBack}>
          <Text style={styles.navButtonText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Schedule</Text>
        <View style={{ width: 80 }} />
      </View>

      <View style={styles.weekBar}>
        <TouchableOpacity style={styles.weekButton} onPress={() => setWeekOffset(weekOffset - 1)}>
          <Text style={styles.weekButtonText}>‹ Prev</Text>
        </TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={styles.weekLabel}>{fmtDateShort(weekStart)} – {fmtDateShort(weekEnd - DAY_MS)}</Text>
          {weekOffset !== 0 && (
            <TouchableOpacity onPress={() => setWeekOffset(0)}>
              <Text style={styles.weekToday}>Back to this week</Text>
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity style={styles.weekButton} onPress={() => setWeekOffset(weekOffset + 1)}>
          <Text style={styles.weekButtonText}>Next ›</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {message ? <Text style={styles.message}>{message}</Text> : null}

        <View style={styles.card}>
          <View style={styles.calHeader}>
            <TouchableOpacity style={styles.weekButton} onPress={() => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1))}>
              <Text style={styles.weekButtonText}>‹ Prev</Text>
            </TouchableOpacity>
            <Text style={styles.cardTitle}>{calMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</Text>
            <TouchableOpacity style={styles.weekButton} onPress={() => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1))}>
              <Text style={styles.weekButtonText}>Next ›</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.calGrid}>
            {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => (
              <View key={d} style={styles.calHeadCell}><Text style={styles.calHeadText}>{d}</Text></View>
            ))}
            {calCells()}
          </View>
        </View>

        {setupMissing ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Scheduling is not set up yet</Text>
            <Text style={styles.cardText}>The shifts database update has not been applied to this workspace yet. Once it runs, managers can post shifts here and the team can claim open ones.</Text>
          </View>
        ) : (
          <>
            {shifts.length === 0 && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>No shifts this week</Text>
                <Text style={styles.cardText}>{isManager ? 'No shifts posted yet — build them in the Manager Portal.' : 'Nothing is scheduled for this week yet. Open shifts will appear here when your manager posts them.'}</Text>
                {isManager && (
                  <TouchableOpacity style={[styles.primaryButton, { marginTop: spacing.md }]} onPress={() => router.push('/manager')}>
                    <Text style={styles.primaryButtonText}>Build Schedule →</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {days.map((d) => (
              <View key={d.key} style={styles.dayBlock}>
                <TouchableOpacity style={styles.dayHeader} onPress={() => { if (!isManager) return; const dd = new Date(d.dayMs); const p2 = (n) => String(n).padStart(2, '0'); const dayStr = `${dd.getFullYear()}-${p2(dd.getMonth() + 1)}-${p2(dd.getDate())}`; router.push({ pathname: '/manager', params: { scheduleDate: dayStr } }); }}>
                  <Text style={styles.dayTitle}>
                    {new Date(d.dayMs).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}{isManager ? ' — tap to schedule' : ''}
                  </Text>
                  {d.key === todayKey && (
                    <View style={styles.todayPill}><Text style={styles.todayPillText}>TODAY</Text></View>
                  )}
                </TouchableOpacity>
                {(() => {
                  const p2 = (n) => String(n).padStart(2, '0');
                  const dd = new Date(d.dayMs);
                  const dayStr = `${dd.getFullYear()}-${p2(dd.getMonth() + 1)}-${p2(dd.getDate())}`;
                  const onLeave = leaves.filter((l) => l.start_date <= dayStr && l.end_date >= dayStr);
                  return onLeave.length > 0 ? (
                    <Text style={styles.leaveLine}>On leave: {onLeave.map((l) => `${nameOf(l.user_id)} (${l.type})`).join(', ')}</Text>
                  ) : null;
                })()}
                {d.shifts.length === 0 ? (
                  <Text style={styles.dayEmpty}>No shifts</Text>
                ) : d.shifts.map((s) => {
                  const badge = badgeFor(s);
                  return (
                    <View key={s.id} style={[styles.shiftCard, s.user_id === myId && styles.shiftCardMine]}>
                      <View style={styles.shiftTop}>
                        <Text style={styles.shiftTime}>{fmtTime12(s.start_time)} – {fmtTime12(s.end_time)}</Text>
                        <View style={[styles.badge, badge.style]}>
                          <Text style={[styles.badgeText, badge.textStyle]}>{badge.text}</Text>
                        </View>
                      </View>
                      <Text style={styles.shiftMeta}>
                        {shiftDurationHours(s).toFixed(1)}h
                        {worksiteOf(s.worksite_id) ? ` · ${worksiteOf(s.worksite_id)}` : ''}
                        {s.status !== 'open' && nameOf(s.user_id) ? ` · ${nameOf(s.user_id)}` : ''}
                        {s.status === 'open' ? ' · Unassigned' : ''}
                      </Text>
                      {s.status === 'claim_pending' && isManager && (
                        <Text style={styles.shiftClaim}>Claimed by {nameOf(s.claimed_by) || 'a team member'}</Text>
                      )}
                      {s.notes ? <Text style={styles.shiftNotes}>{s.notes}</Text> : null}

                      {!isManager && s.status === 'open' && (
                        <TouchableOpacity style={styles.smallPrimary} onPress={() => claimShift(s)} disabled={busyId === s.id}>
                          {busyId === s.id ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={styles.smallPrimaryText}>Claim This Shift</Text>}
                        </TouchableOpacity>
                      )}
                      {!isManager && s.status === 'claim_pending' && s.claimed_by === myId && (
                        <View style={styles.actionRow}>
                          <Text style={styles.pendingText}>Request sent — waiting for approval</Text>
                          <TouchableOpacity style={styles.smallOutline} onPress={() => cancelClaim(s)} disabled={busyId === s.id}>
                            <Text style={styles.smallOutlineText}>Cancel</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                      {isManager && s.status === 'claim_pending' && (
                        <View style={styles.actionRow}>
                          <TouchableOpacity style={styles.smallPrimary} onPress={() => approveClaim(s)} disabled={busyId === s.id}>
                            <Text style={styles.smallPrimaryText}>Approve</Text>
                          </TouchableOpacity>
                          <TouchableOpacity style={styles.smallOutline} onPress={() => denyClaim(s)} disabled={busyId === s.id}>
                            <Text style={styles.smallOutlineText}>Deny</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                      {isManager && (
                        <TouchableOpacity style={styles.deleteLink} onPress={() => deleteShift(s)} disabled={busyId === s.id}>
                          <Text style={styles.deleteLinkText}>{confirmingDeleteId === s.id ? 'Tap again to delete this shift' : 'Delete shift'}</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}
              </View>
            ))}
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
  weekBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  weekButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.sm },
  weekButtonText: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 13 },
  weekLabel: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary },
  weekToday: { color: colors.accent, fontFamily: fontFamily.semibold, fontSize: 12, marginTop: 2 },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  message: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary, textAlign: 'center' },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.lg, ...elevation.card },
  cardTitle: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary, marginBottom: spacing.xs },
  cardText: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary },
  addButton: { ...buttons.primary },
  addButtonText: { ...buttons.primaryText },
  label: { ...type.label, color: colors.textSecondary, marginBottom: spacing.xs },
  input: { fontFamily: fontFamily.regular, width: '100%', backgroundColor: colors.inputBackground, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: radius.md, padding: spacing.md, fontSize: 15, color: colors.textPrimary, marginBottom: spacing.md },
  timeRow: { flexDirection: 'row', gap: spacing.md },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: { borderWidth: 1, borderColor: colors.surfaceBorder, backgroundColor: colors.surface, borderRadius: radius.pill, paddingVertical: 8, paddingHorizontal: 14 },
  chipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  chipText: { fontFamily: fontFamily.semibold, fontSize: 13, color: colors.textSecondary },
  chipTextActive: { color: colors.accent },
  primaryButton: { ...buttons.primary },
  primaryButtonText: { ...buttons.primaryText },
  calHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  calGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calHeadCell: { width: '14.28%', alignItems: 'center', paddingVertical: 6 },
  calHeadText: { fontSize: 12, fontFamily: fontFamily.semibold, color: colors.textSecondary },
  calCell: { width: '14.28%', minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  calCellFilled: { backgroundColor: colors.accentSoft },
  calCellToday: { borderWidth: 1, borderColor: colors.accent },
  calCellText: { fontSize: 14, fontFamily: fontFamily.regular, color: colors.textPrimary },
  calCellTextFilled: { fontFamily: fontFamily.bold, color: colors.accent },
  dayBlock: { gap: spacing.sm },
  dayHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dayTitle: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary },
  todayPill: { backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder, borderRadius: radius.pill, paddingVertical: 2, paddingHorizontal: 8 },
  todayPillText: { ...type.label, color: colors.accent },
  dayEmpty: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary, paddingLeft: spacing.xs },
  leaveLine: { fontFamily: fontFamily.semibold, fontSize: 13, color: colors.warning, paddingLeft: spacing.xs },
  shiftCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.lg, ...elevation.card },
  shiftCardMine: { borderColor: colors.accentBorder },
  shiftTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  shiftTime: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary },
  badge: { borderRadius: radius.pill, paddingVertical: 3, paddingHorizontal: 9, borderWidth: 1 },
  badgeText: { ...type.label },
  badgeMine: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  badgeMineText: { color: colors.accent },
  badgeOpen: { backgroundColor: colors.warningSoft, borderColor: colors.warning },
  badgeOpenText: { color: colors.warning },
  badgePending: { backgroundColor: colors.surface, borderColor: colors.surfaceBorder },
  badgePendingText: { color: colors.textSecondary },
  badgeAssigned: { backgroundColor: colors.surface, borderColor: colors.surfaceBorder },
  badgeAssignedText: { color: colors.textSecondary },
  shiftMeta: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary },
  shiftClaim: { fontFamily: fontFamily.semibold, fontSize: 13, color: colors.warning, marginTop: spacing.xs },
  shiftNotes: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textPrimary, marginTop: spacing.xs },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  pendingText: { flex: 1, fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary },
  smallPrimary: { ...buttons.compact, alignSelf: 'flex-start', marginTop: spacing.md },
  smallPrimaryText: { ...buttons.compactText },
  smallOutline: { ...buttons.compactOutline, alignSelf: 'flex-start', marginTop: spacing.md },
  smallOutlineText: { ...buttons.compactOutlineText },
  deleteLink: { marginTop: spacing.md, alignSelf: 'flex-start' },
  deleteLinkText: { color: colors.danger, fontFamily: fontFamily.semibold, fontSize: 13 },
});
