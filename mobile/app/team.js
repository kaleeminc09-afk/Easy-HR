import React, { useState, useCallback } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Link, useFocusEffect } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, spacing, radius, fontFamily, buttons } from '../lib/theme';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const POLL_MS = 30000;

export function formatElapsed(sinceIso, nowMs = Date.now()) {
  const ms = Math.max(0, nowMs - new Date(sinceIso).getTime());
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatSince(sinceIso) {
  const d = new Date(sinceIso);
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

function MemberRow({ member, dotColor, softColor }) {
  const initial = (member.name || '?').trim().charAt(0).toUpperCase();
  return (
    <View style={styles.row}>
      <View style={[styles.avatar, { backgroundColor: softColor }]}>
        <Text style={[styles.avatarText, { color: dotColor }]}>{initial}</Text>
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowName}>{member.name}</Text>
        <Text style={styles.rowMeta}>since {formatSince(member.since)} · {formatElapsed(member.since)}</Text>
      </View>
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
    </View>
  );
}

export default function TeamStatusScreen() {
  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [online, setOnline] = useState([]);
  const [onBreak, setOnBreak] = useState([]);
  const [, setTick] = useState(0);

  const fetchStatus = useCallback(async () => {
    try {
      // Audit item 6 fix: team-status now requires a signed-in user, so
      // send the session token — the old code sent the publishable anon
      // key, which is why the function answered anyone at all.
      const { data: { session: liveSession } } = await supabase.auth.getSession();
      if (!liveSession) { setLoading(false); setRefreshing(false); return; }
      const res = await fetch(`${SUPABASE_URL}/functions/v1/team-status`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${liveSession.access_token}`, 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setOnline(data.online || []);
      setOnBreak(data.on_break || []);
      setError('');
    } catch (e) {
      setError(e.message || 'Could not load team status.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!alive) return;
      setSession(data.session);
      setAuthChecked(true);
      if (data.session) fetchStatus();
      else setLoading(false);
    })();
    const poller = setInterval(() => { setTick(t => t + 1); fetchStatus(); }, POLL_MS);
    return () => { alive = false; clearInterval(poller); };
  }, [fetchStatus]));

  const onRefresh = useCallback(() => { setRefreshing(true); fetchStatus(); }, [fetchStatus]);

  if (!authChecked || loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.loadingText}>Loading team status...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.deniedText}>Please sign in to see the team board.</Text>
          <Link href="/" asChild>
            <TouchableOpacity style={buttons.primary}>
              <Text style={buttons.primaryText}>Back to Sign In</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </SafeAreaView>
    );
  }

  const empty = online.length === 0 && onBreak.length === 0;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Link href="/" asChild>
          <TouchableOpacity style={styles.backButton}>
            <Text style={styles.backButtonText}>&larr; Back</Text>
          </TouchableOpacity>
        </Link>
        <Text style={styles.title}>Team Status</Text>
        <View style={styles.livePill}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>LIVE</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        {error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity style={buttons.primary} onPress={onRefresh}>
              <Text style={buttons.primaryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : empty ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>Nobody clocked in right now</Text>
            <Text style={styles.emptyMeta}>The board lights up as soon as the first shift starts.</Text>
          </View>
        ) : (
          <>
            <View style={styles.statsRow}>
              <View style={styles.statCard}>
                <View style={[styles.dot, { backgroundColor: colors.success }]} />
                <Text style={styles.statCount}>{online.length}</Text>
                <Text style={styles.statLabel}>On shift</Text>
              </View>
              <View style={styles.statCard}>
                <View style={[styles.dot, { backgroundColor: colors.warning }]} />
                <Text style={styles.statCount}>{onBreak.length}</Text>
                <Text style={styles.statLabel}>On break</Text>
              </View>
            </View>

            {online.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>On shift</Text>
                {online.map((m, i) => (
                  <MemberRow key={`on-${i}`} member={m} dotColor={colors.success} softColor="rgba(52, 211, 153, 0.12)" />
                ))}
              </View>
            )}

            {onBreak.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>On break</Text>
                {onBreak.map((m, i) => (
                  <MemberRow key={`br-${i}`} member={m} dotColor={colors.warning} softColor={colors.warningSoft} />
                ))}
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
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.lg },
  loadingText: { marginTop: spacing.sm, color: colors.textSecondary, fontFamily: fontFamily.regular },
  deniedText: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 16, marginBottom: spacing.md, textAlign: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  backButton: { paddingVertical: spacing.sm, paddingRight: spacing.md, minHeight: 44, justifyContent: 'center' },
  backButtonText: { color: colors.accent, fontFamily: fontFamily.semibold, fontSize: 15 },
  title: { color: colors.textPrimary, fontFamily: fontFamily.bold, fontSize: 18 },
  livePill: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder, borderRadius: radius.pill, paddingVertical: 6, paddingHorizontal: 10 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success, marginRight: 6 },
  liveText: { color: colors.accent, fontFamily: fontFamily.bold, fontSize: 11, letterSpacing: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, flexGrow: 1 },
  statsRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
  statCard: { flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, padding: spacing.md, alignItems: 'center' },
  statCount: { color: colors.textPrimary, fontFamily: fontFamily.bold, fontSize: 28, marginTop: spacing.xs },
  statLabel: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 13, marginTop: 2 },
  section: { marginBottom: spacing.lg },
  sectionTitle: { color: colors.textSecondary, fontFamily: fontFamily.semibold, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginRight: spacing.md },
  avatarText: { fontFamily: fontFamily.bold, fontSize: 18 },
  rowText: { flex: 1 },
  rowName: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 16 },
  rowMeta: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 13, marginTop: 2 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  emptyCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, padding: spacing.xl, alignItems: 'center', marginTop: spacing.xl },
  emptyTitle: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 17, textAlign: 'center' },
  emptyMeta: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 14, marginTop: spacing.sm, textAlign: 'center' },
  errorCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, padding: spacing.xl, alignItems: 'center', marginTop: spacing.xl },
  errorText: { color: colors.danger, fontFamily: fontFamily.regular, fontSize: 14, marginBottom: spacing.md, textAlign: 'center' },
});
