import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Link } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, spacing, radius, type, elevation, buttons } from '../lib/theme';
import { weekStartMs, shiftsOverlap, validateShiftInput, shiftDurationHours } from '../supabase/functions/hr-ai-bot/logic';

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

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

  // New-shift form (managers)
  const [showForm, setShowForm] = useState(false);
  const [formEmployee, setFormEmployee] = useState('');
  const [formWorksite, setFormWorksite] = useState('');
  const [formDate, setFormDate] = useState(todayStr());
  // Tap-specific-dates multi-day: one shift per tapped date, same times.
  // Tapping one date behaves exactly like the old single-date form.
  const [formDates, setFormDates] = useState([todayStr()]);
  const [formTypedDate, setFormTypedDate] = useState('');
  const [formStart, setFormStart] = useState('09:00');
  const [formEnd, setFormEnd] = useState('17:00');
  const [formNextDay, setFormNextDay] = useState(false);
  const [formNotes, setFormNotes] = useState('');
  const [creating, setCreating] = useState(false);

  const isManager = myRole === 'manager' || myRole === 'admin';
  const weekStart = weekStartMs(Date.now()) + weekOffset * 7 * DAY_MS;
  const weekEnd = weekStart + 7 * DAY_MS;

  useEffect(() => { init(); }, []);
  useEffect(() => { if (myId) loadShifts(); }, [weekOffset, myId]);

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

  const createShift = async () => {
    // One shift per tapped date. A clashing date (overlap or approved
    // leave) is skipped and reported — it does not fail the batch.
    // Note: clash/leave checks use the loaded week only; dates outside
    // the current week are created without that check, matching the
    // old single-date behaviour for typed dates.
    if (formDates.length === 0) { setMessage('Tap at least one date.'); return; }
    const created = [];
    const skipped = [];
    setCreating(true);
    setMessage('');
    for (const formDate of [...formDates].sort()) {
      const startD = new Date(`${formDate}T${formStart}:00`);
      const endD = new Date(`${formDate}T${formEnd}:00`);
      if (formNextDay) endD.setDate(endD.getDate() + 1);
      const err = validateShiftInput(startD.toISOString(), endD.toISOString());
      if (err) { skipped.push(`${formDate} (${err})`); continue; }
      if (formEmployee) {
        const clash = shifts.find((s) =>
          s.user_id === formEmployee && s.status === 'assigned' &&
          shiftsOverlap(s, { start_time: startD.toISOString(), end_time: endD.toISOString() }));
        if (clash) { skipped.push(`${formDate} (overlaps an existing shift)`); continue; }
        const onLeave = leaves.some((l) => l.user_id === formEmployee && l.start_date <= formDate && l.end_date >= formDate);
        if (onLeave) { skipped.push(`${formDate} (approved leave)`); continue; }
      }
      const { error } = await supabase.from('shifts').insert([{
        business_id: businessId,
        user_id: formEmployee || null,
        worksite_id: formWorksite || null,
        start_time: startD.toISOString(),
        end_time: endD.toISOString(),
        status: formEmployee ? 'assigned' : 'open',
        notes: formNotes.trim() || null,
        created_by: myId,
      }]);
      if (error) skipped.push(`${formDate} (${error.message})`);
      else created.push(formDate);
    }
    if (created.length > 0) {
      setMessage((formEmployee ? 'Shift created for ' : 'Open shift posted for ') + created.join(', ') + (skipped.length > 0 ? `. Skipped: ${skipped.join(', ')}.` : '.'));
      setShowForm(false);
      setFormNotes('');
      await loadShifts();
    } else {
      setMessage('Nothing created. Skipped: ' + skipped.join(', ') + '.');
    }
    setCreating(false);
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

  const badgeFor = (s) => {
    if (s.user_id === myId) return { text: 'YOUR SHIFT', style: styles.badgeMine, textStyle: styles.badgeMineText };
    if (s.status === 'open') return { text: 'OPEN SHIFT', style: styles.badgeOpen, textStyle: styles.badgeOpenText };
    if (s.status === 'claim_pending') return { text: 'CLAIM PENDING', style: styles.badgePending, textStyle: styles.badgePendingText };
    return { text: 'ASSIGNED', style: styles.badgeAssigned, textStyle: styles.badgeAssignedText };
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Link href={isManager ? '/manager' : '/'} asChild>
          <TouchableOpacity style={styles.navButton}>
            <Text style={styles.navButtonText}>← Back</Text>
          </TouchableOpacity>
        </Link>
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

        {setupMissing ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Scheduling is not set up yet</Text>
            <Text style={styles.cardText}>The shifts database update has not been applied to this workspace yet. Once it runs, managers can post shifts here and the team can claim open ones.</Text>
          </View>
        ) : (
          <>
            {isManager && (
              <TouchableOpacity style={styles.addButton} onPress={() => setShowForm(!showForm)}>
                <Text style={styles.addButtonText}>{showForm ? 'Close' : '+ Add Shift'}</Text>
              </TouchableOpacity>
            )}

            {isManager && showForm && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>New Shift</Text>
                <Text style={styles.label}>Employee</Text>
                <View style={styles.chipRow}>
                  <TouchableOpacity style={[styles.chip, !formEmployee && styles.chipActive]} onPress={() => setFormEmployee('')}>
                    <Text style={[styles.chipText, !formEmployee && styles.chipTextActive]}>Open shift</Text>
                  </TouchableOpacity>
                  {people.map((p) => (
                    <TouchableOpacity key={p.id} style={[styles.chip, formEmployee === p.id && styles.chipActive]} onPress={() => setFormEmployee(p.id)}>
                      <Text style={[styles.chipText, formEmployee === p.id && styles.chipTextActive]}>{p.full_name || 'Unnamed'}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.label}>Worksite</Text>
                <View style={styles.chipRow}>
                  <TouchableOpacity style={[styles.chip, !formWorksite && styles.chipActive]} onPress={() => setFormWorksite('')}>
                    <Text style={[styles.chipText, !formWorksite && styles.chipTextActive]}>None</Text>
                  </TouchableOpacity>
                  {worksites.map((w) => (
                    <TouchableOpacity key={w.id} style={[styles.chip, formWorksite === w.id && styles.chipActive]} onPress={() => setFormWorksite(w.id)}>
                      <Text style={[styles.chipText, formWorksite === w.id && styles.chipTextActive]}>{w.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.label}>Dates — tap each date (one shift per date)</Text>
                <View style={styles.chipRow}>
                  {[0, 1, 2, 3, 4, 5, 6].map((i) => {
                    const d = new Date(weekStart + i * DAY_MS);
                    const p2 = (n) => String(n).padStart(2, '0');
                    const dayStr = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
                    const on = formDates.includes(dayStr);
                    return (
                      <TouchableOpacity key={dayStr} style={[styles.chip, on && styles.chipActive]} onPress={() => setFormDates(on ? formDates.filter((x) => x !== dayStr) : [...formDates, dayStr])}>
                        <Text style={[styles.chipText, on && styles.chipTextActive]}>{d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <Text style={styles.label}>Or type a date (YYYY-MM-DD) to add it</Text>
                <TextInput style={styles.input} value={formTypedDate} onChangeText={(v) => { setFormTypedDate(v); if (/^\d{4}-\d{2}-\d{2}$/.test(v) && !formDates.includes(v)) { setFormDates([...formDates, v]); setFormTypedDate(''); } }} placeholder="YYYY-MM-DD" placeholderTextColor={colors.inputPlaceholder} keyboardType="numbers-and-punctuation" />
                <View style={styles.timeRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.label}>Start (24h)</Text>
                    <TextInput style={styles.input} value={formStart} onChangeText={setFormStart} placeholder="09:00" placeholderTextColor={colors.inputPlaceholder} keyboardType="numbers-and-punctuation" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.label}>End (24h)</Text>
                    <TextInput style={styles.input} value={formEnd} onChangeText={setFormEnd} placeholder="17:00" placeholderTextColor={colors.inputPlaceholder} keyboardType="numbers-and-punctuation" />
                  </View>
                </View>
                <TouchableOpacity style={[styles.chip, formNextDay && styles.chipActive, { alignSelf: 'flex-start', marginBottom: spacing.md }]} onPress={() => setFormNextDay(!formNextDay)}>
                  <Text style={[styles.chipText, formNextDay && styles.chipTextActive]}>Ends next day (overnight)</Text>
                </TouchableOpacity>
                <Text style={styles.label}>Notes (optional)</Text>
                <TextInput style={styles.input} value={formNotes} onChangeText={setFormNotes} placeholder="e.g. Delivery day — arrive 15 min early" placeholderTextColor={colors.inputPlaceholder} />
                <TouchableOpacity style={styles.primaryButton} onPress={createShift} disabled={creating}>
                  {creating ? <ActivityIndicator color="#0A0E1A" /> : <Text style={styles.primaryButtonText}>{formEmployee ? 'Create Shift' : 'Post Open Shift'}</Text>}
                </TouchableOpacity>
              </View>
            )}

            {shifts.length === 0 && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>No shifts this week</Text>
                <Text style={styles.cardText}>{isManager ? 'Tap + Add Shift to post the first one.' : 'Nothing is scheduled for this week yet. Open shifts will appear here when your manager posts them.'}</Text>
              </View>
            )}

            {days.map((d) => (
              <View key={d.key} style={styles.dayBlock}>
                <TouchableOpacity style={styles.dayHeader} onPress={() => { const dd = new Date(d.dayMs); const p2 = (n) => String(n).padStart(2, '0'); const dayStr = `${dd.getFullYear()}-${p2(dd.getMonth() + 1)}-${p2(dd.getDate())}`; setFormDates([dayStr]); setShowForm(true); }}>
                  <Text style={styles.dayTitle}>
                    {new Date(d.dayMs).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })} — tap to schedule
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
                          {busyId === s.id ? <ActivityIndicator size="small" color="#0A0E1A" /> : <Text style={styles.smallPrimaryText}>Claim This Shift</Text>}
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
  content: { padding: spacing.lg, gap: spacing.lg },
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
