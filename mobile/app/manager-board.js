import React, { useState, useCallback } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, ScrollView, RefreshControl, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Link, useRouter, useFocusEffect } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, spacing, radius, fontFamily, buttons } from '../lib/theme';

// Manager board — WEB APP STEP 1 (read-only).
//
// This is the web app's manager surface: who is on shift / on break right
// now, from the same team-status edge function the phone app's Team board
// (team.js) already uses. Deliberately READ-ONLY: no approvals, no
// scheduling, no AI chat, no exports — those are later steps. The phone
// manager portal (/manager) is untouched and stays the phone surface
// until a later step audits its chat/export paths on web.
//
// Guards, mirroring the phone app:
//  - no session → sign-in prompt (same as team.js)
//  - role must be manager or admin → otherwise Access Denied (same check
//    as manager.js checkManagerAccessAndFetchData)
//  - no business_id → /onboarding (same redirect as index.js: a signed-in
//    user with no business is a brand-new owner, not a manager)
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
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

export default function ManagerBoardScreen() {
  const router = useRouter();
  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [online, setOnline] = useState([]);
  const [onBreak, setOnBreak] = useState([]);
  const [, setTick] = useState(0);

  const fetchStatus = useCallback(async () => {
    try {
      // Same as team.js (audit item 6): team-status requires a signed-in
      // user, so send the session token — never the anon key.
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
      if (!data.session) { setAuthChecked(true); setLoading(false); return; }
      const { data: profile } = await supabase
        .from('profiles')
        .select('role, business_id')
        .eq('id', data.session.user.id)
        .single();
      if (!alive) return;
      // No business yet: brand-new owner — same redirect as index.js.
      if (profile && !profile.business_id) { router.replace('/onboarding'); return; }
      if (!profile || (profile.role !== 'manager' && profile.role !== 'admin')) {
        setAuthorized(false);
        setAuthChecked(true);
        setLoading(false);
        return;
      }
      setAuthorized(true);
      setAuthChecked(true);
      if (profile.business_id) {
        const { data: biz } = await supabase.from('businesses').select('business_name').eq('id', profile.business_id).single();
        if (biz) setBusinessName(biz.business_name || '');
      }
      fetchStatus();
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
          <Text style={styles.loadingText}>Loading manager board...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.deniedText}>Please sign in to see the manager board.</Text>
          <Link href="/" asChild>
            <TouchableOpacity style={buttons.primary}>
              <Text style={buttons.primaryText}>Back to Sign In</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </SafeAreaView>
    );
  }

  if (!authorized) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.deniedTitle}>Access Denied</Text>
          <Text style={styles.deniedText}>You must be signed in with a Manager account to view this board.</Text>
          <Link href="/" asChild>
            <TouchableOpacity style={buttons.primary}>
              <Text style={buttons.primaryText}>Back to Home</Text>
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
        <View>
          <View style={styles.brandRow}>
            <Image source={require('../assets/images/icon.png')} style={styles.brandLogo} />
            <Text style={styles.title}>NorthShift</Text>
          </View>
          <Text style={styles.subtitle}>{businessName ? `${businessName} · Manager board` : 'Manager board'}</Text>
        </View>
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
          <View style={styles.card}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity style={buttons.primary} onPress={onRefresh}>
              <Text style={buttons.primaryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : empty ? (
          <View style={styles.card}>
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

        <Link href="/manager" asChild>
          <TouchableOpacity style={buttons.secondary}>
            <Text style={buttons.secondaryText}>Full manager portal →</Text>
          </TouchableOpacity>
        </Link>
        <Text style={styles.footNote}>Approvals, scheduling and the AI assistant arrive in later steps — this board is read-only for now.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.lg },
  loadingText: { marginTop: spacing.sm, color: colors.textSecondary, fontFamily: fontFamily.regular },
  deniedTitle: { fontSize: 20, fontFamily: fontFamily.bold, color: colors.danger, marginBottom: spacing.sm, textAlign: 'center' },
  deniedText: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 16, marginBottom: spacing.md, textAlign: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  brandRow: { flexDirection: 'row', alignItems: 'center' },
  brandLogo: { width: 30, height: 30, borderRadius: 9, marginRight: 8 },
  title: { color: colors.textPrimary, fontFamily: fontFamily.brand, fontSize: 20 },
  subtitle: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 13, marginTop: 2 },
  livePill: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder, borderRadius: radius.pill, paddingVertical: 6, paddingHorizontal: 10 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success, marginRight: 6 },
  liveText: { color: colors.accent, fontFamily: fontFamily.bold, fontSize: 11, letterSpacing: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, maxWidth: 800, width: '100%', alignSelf: 'center', flexGrow: 1 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, padding: spacing.xl, alignItems: 'center', marginTop: spacing.xl },
  emptyTitle: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 17, textAlign: 'center' },
  emptyMeta: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 14, marginTop: spacing.sm, textAlign: 'center' },
  errorText: { color: colors.danger, fontFamily: fontFamily.regular, fontSize: 14, marginBottom: spacing.md, textAlign: 'center' },
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
  footNote: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 12, marginTop: spacing.md, textAlign: 'center' },
});
