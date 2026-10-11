import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, SafeAreaView, ActivityIndicator, ScrollView } from 'react-native';
import { Link } from 'expo-router';
import * as Location from 'expo-location';
import { supabase } from '../lib/supabase';
import { colors, spacing, radius, type, elevation } from '../lib/theme';

export default function App() {
  const [session, setSession] = useState(null);
  const [businessName, setBusinessName] = useState('');
  const [loading, setLoading] = useState(true);

  // Auth Form State
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');

  // Time Tracker State
  const [activeSession, setActiveSession] = useState(null);
  const [activeBreak, setActiveBreak] = useState(null);
  const [breakSeconds, setBreakSeconds] = useState(0);
  const [now, setNow] = useState(new Date());
  const [todayHours, setTodayHours] = useState(0);
  const [activeSessionSeconds, setActiveSessionSeconds] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [locationChecking, setLocationChecking] = useState(false);

  // Exception Flow State
  const [outOfRangeData, setOutOfRangeData] = useState(null);
  const [exceptionNote, setExceptionNote] = useState('');
  const [submittingException, setSubmittingException] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) fetchTimeData(session.user.id);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) fetchTimeData(session.user.id);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setBusinessName(''); return; }
    (async () => {
      const { data } = await supabase.from('profiles').select('business_id').eq('id', session.user.id).single();
      if (data && data.business_id) {
        const { data: biz } = await supabase.from('businesses').select('business_name').eq('id', data.business_id).single();
        if (biz) setBusinessName(biz.business_name || '');
      }
    })();
  }, [session]);

  useEffect(() => {
    let timer = null;
    if (activeSession) {
      const shiftStart = new Date(activeSession.clock_in).getTime();
      const breakStart = activeBreak ? new Date(activeBreak.start_time).getTime() : null;
      const updateTicker = () => {
        const t = Date.now();
        setActiveSessionSeconds(Math.max(0, Math.floor((t - shiftStart) / 1000)));
        if (breakStart) setBreakSeconds(Math.max(0, Math.floor((t - breakStart) / 1000)));
        else setBreakSeconds(0);
      };
      updateTicker();
      timer = setInterval(updateTicker, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [activeSession, activeBreak]);

  // Live clock (device timezone), ticks every second
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const handleLogin = async () => {
    setAuthLoading(true);
    setAuthError('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setAuthError(error.message);
    setAuthLoading(false);
  };

  const handleSignUp = async () => {
    setAuthLoading(true);
    setAuthError('');
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: email.split('@')[0], role: 'employee' } }
    });
    if (error) setAuthError(error.message);
    else setStatusMessage('Account created! You can now sign in.');
    setAuthLoading(false);
  };

  const handleBiometric = async () => {
    // TODO(next): npx expo install expo-local-authentication, then replace with
    // LocalAuthentication.authenticateAsync() -> Supabase session restore.
    setStatusMessage('Biometric sign-in arrives in the next update — use your password for now.');
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setActiveSession(null);
    setActiveBreak(null);
    setTodayHours(0);
    setOutOfRangeData(null);
  };

  const fetchTimeData = async (userId) => {
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const { data: activeData } = await supabase
        .from('time_logs')
        .select('*')
        .eq('user_id', userId)
        .is('clock_out', null)
        .maybeSingle();

      setActiveSession(activeData || null);

      if (activeData) {
        const { data: breakData } = await supabase
          .from('time_breaks')
          .select('*')
          .eq('time_log_id', activeData.id)
          .is('end_time', null)
          .maybeSingle();
        setActiveBreak(breakData || null);
      } else {
        setActiveBreak(null);
      }

      const { data: logsData } = await supabase
        .from('time_logs')
        .select('*')
        .eq('user_id', userId)
        .gte('clock_in', todayStart.toISOString());

      if (logsData) {
        let totalMs = 0;
        logsData.forEach(log => {
          const start = new Date(log.clock_in).getTime();
          const end = log.clock_out ? new Date(log.clock_out).getTime() : new Date().getTime();
          if (end > start) totalMs += (end - start);
        });
        setTodayHours((totalMs / (1000 * 60 * 60)).toFixed(2));
      }
    } catch (err) {
      console.error('Error fetching time data:', err);
    }
  };

  const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  };

  const handleClockIn = async () => {
    if (!session?.user) return;
    // Double clock-in guard: resume an already-open shift instead of duplicating it
    const { data: openShifts } = await supabase
      .from('time_logs')
      .select('id')
      .eq('user_id', session.user.id)
      .is('clock_out', null)
      .order('clock_in', { ascending: false })
      .limit(1);
    if (openShifts && openShifts.length > 0) {
      setStatusMessage('You already have an active shift — resuming it.');
      fetchTimeData(session.user.id);
      return;
    }
    try {
      setLocationChecking(true);
      setOutOfRangeData(null);
      setStatusMessage('Verifying GPS location...');

      const { data: worksites, error: worksitesError } = await supabase.from('worksites').select('*');
      if (worksitesError || !worksites || worksites.length === 0) {
        setStatusMessage('❌ Error: No worksites configured.');
        setLocationChecking(false);
        return;
      }

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setStatusMessage('❌ Error: Location permission denied.');
        setLocationChecking(false);
        return;
      }

      const currentLocation = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const { latitude, longitude } = currentLocation.coords;

      let nearestWorksite = null;
      let minDistance = Infinity;

      worksites.forEach(site => {
        const dist = calculateDistance(latitude, longitude, site.latitude, site.longitude);
        if (dist < minDistance) {
          minDistance = dist;
          nearestWorksite = { ...site, distance: dist };
        }
      });

      if (!nearestWorksite || nearestWorksite.distance > nearestWorksite.radius_meters) {
        setOutOfRangeData({
          worksite: nearestWorksite,
          distance: Math.round(nearestWorksite?.distance || 0),
          latitude,
          longitude
        });
        setStatusMessage(`❌ Out of Range for ${nearestWorksite?.name || 'Office'}. Please submit an exception request.`);
        setLocationChecking(false);
        return;
      }

      const { data, error } = await supabase
        .from('time_logs')
        .insert([{
          user_id: session.user.id,
          clock_in: new Date().toISOString(),
          ai_anomaly_flag: 'Normal Shift',
          worksite_id: nearestWorksite.id
        }])
        .select()
        .single();

      if (error) {
        setStatusMessage('❌ Insert Error: ' + error.message);
      } else {
        setActiveSession(data);
        setStatusMessage(`Clocked in at ${nearestWorksite.name}!`);
        fetchTimeData(session.user.id);
      }
    } catch (err) {
      setStatusMessage('❌ GPS Error: ' + err.message);
    } finally {
      setLocationChecking(false);
    }
  };

  const handleStartBreak = async (breakType) => {
    if (!activeSession) return;
    if (activeBreak) {
      setStatusMessage('You are already on a break.');
      return;
    }
    setStatusMessage(`Starting ${breakType}...`);

    const { data, error } = await supabase
      .from('time_breaks')
      .insert([{
        time_log_id: activeSession.id,
        break_type: breakType,
        start_time: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) {
      setStatusMessage('❌ Error starting break: ' + error.message);
    } else {
      setActiveBreak(data);
      setStatusMessage(`☕ On ${breakType}`);
    }
  };

  const handleEndBreak = async () => {
    if (!activeBreak) return;
    setStatusMessage('Ending break...');

    const { error } = await supabase
      .from('time_breaks')
      .update({ end_time: new Date().toISOString() })
      .eq('id', activeBreak.id);

    if (error) {
      setStatusMessage('❌ Error ending break: ' + error.message);
    } else {
      setActiveBreak(null);
      setStatusMessage('🟢 Returned to active shift');
      fetchTimeData(session.user.id);
    }
  };

  const handleExceptionSubmit = async () => {
    if (!exceptionNote.trim()) {
      setStatusMessage('❌ Please provide a reason note.');
      return;
    }

    setSubmittingException(true);
    const { error } = await supabase.from('time_exceptions').insert([{
      user_id: session.user.id,
      worksite_id: outOfRangeData.worksite.id,
      latitude: outOfRangeData.latitude,
      longitude: outOfRangeData.longitude,
      distance_meters: outOfRangeData.distance,
      reason_note: exceptionNote,
      status: 'pending'
    }]);

    if (error) {
      setStatusMessage('❌ Error submitting exception: ' + error.message);
    } else {
      setStatusMessage('✅ Exception request submitted successfully for manager review!');
      setOutOfRangeData(null);
      setExceptionNote('');
    }
    setSubmittingException(false);
  };

  const handleClockOut = async () => {
    if (!activeSession) return;
    setStatusMessage('Analyzing shift & clocking out...');

    const clockInTime = new Date(activeSession.clock_in).getTime();
    const clockOutTime = new Date().getTime();
    const durationHours = (clockOutTime - clockInTime) / (1000 * 60 * 60);

    let anomalyFlag = 'Normal Shift';
    if (durationHours > 12) anomalyFlag = '⚠️ Flagged: Excessive Duration (> 12 Hours)';
    else if (durationHours < 0.05) anomalyFlag = '⚠️ Flagged: Unusually Short Shift (< 3 Mins)';

    const { error } = await supabase
      .from('time_logs')
      .update({ clock_out: new Date().toISOString(), ai_anomaly_flag: anomalyFlag })
      .eq('id', activeSession.id);

    if (error) {
      setStatusMessage('Error: ' + error.message);
    } else {
      setActiveSession(null);
      setActiveBreak(null);
      setStatusMessage(`Clocked out! Status: ${anomalyFlag}`);
      fetchTimeData(session.user.id);
    }
  };

  const formatTimeCounter = (totalSecs) => {
    const hrs = Math.floor(totalSecs / 3600);
  const formatClock = (d) =>
    d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  if (loading) {
    return (
      <View style={styles.authLoadingContainer}>
        <Text style={styles.authLogoMark}>✦</Text>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.authLoadingText}>Loading NorthShift...</Text>
      </View>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.authContainer}>
        <View style={styles.authCard}>
          <Text style={styles.authLogoMark}>✦</Text>
          <Text style={styles.authTitle}>NorthShift</Text>
          <Text style={styles.authSubtitle}>Welcome back. Sign in to continue.</Text>

          <Text style={styles.authLabel}>Email</Text>
          <TextInput
            style={styles.authInput}
            placeholder="you@company.com"
            placeholderTextColor={colors.inputPlaceholder}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />
          <Text style={styles.authLabel}>Password</Text>
          <TextInput
            style={styles.authInput}
            placeholder="Your password"
            placeholderTextColor={colors.inputPlaceholder}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />

          {authError ? <Text style={styles.authError}>{authError}</Text> : null}
          {statusMessage ? <Text style={styles.authMessage}>{statusMessage}</Text> : null}

          <TouchableOpacity style={styles.authPrimaryButton} onPress={handleLogin} disabled={authLoading}>
            {authLoading ? <ActivityIndicator color="#0A0E1A" /> : <Text style={styles.authPrimaryButtonText}>Sign In</Text>}
          </TouchableOpacity>

          <View style={styles.authDivider}>
            <View style={styles.authDividerLine} />
            <Text style={styles.authDividerText}>or</Text>
            <View style={styles.authDividerLine} />
          </View>

          <TouchableOpacity style={styles.authBiometricButton} onPress={handleBiometric}>
            <Text style={styles.authBiometricButtonText}>Sign in with Face ID</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.authSecondaryButton} onPress={handleSignUp} disabled={authLoading}>
            <Text style={styles.authSecondaryButtonText}>New here? Create account</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.empContainer}>
      <View style={styles.empHeader}>
        <View>
          <Text style={styles.empBrand}>✦ NorthShift</Text>
          <Text style={styles.empEmail}>{businessName || session.user.email}</Text>
          <Text style={styles.empClock}>{formatClock(now)}</Text>
        </View>
        <View style={styles.empHeaderRight}>
          <Link href="/EmployeeChatScreen" asChild>
            <TouchableOpacity style={styles.empAssistantButton}>
              <Text style={styles.empAssistantButtonText}>✦ Assistant</Text>
            </TouchableOpacity>
          </Link>
          <Link href="/manager" asChild>
            <TouchableOpacity style={styles.empNavButton}>
              <Text style={styles.empNavButtonText}>Manager →</Text>
            </TouchableOpacity>
          </Link>
          <Link href="/profile" asChild>
            <TouchableOpacity style={styles.empNavButton}>
              <Text style={styles.empNavButtonText}>Profile</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.empContent}>
        {outOfRangeData ? (
          <View style={styles.empExceptionBox}>
            <Text style={styles.empExceptionTitle}>Out of Range</Text>
            <Text style={styles.empExceptionText}>
              You are {outOfRangeData.distance}m away from {outOfRangeData.worksite.name}. Add a note for your manager:
            </Text>
            <TextInput
              style={styles.empTextArea}
              placeholder="e.g., Client visit, remote field work..."
              placeholderTextColor={colors.inputPlaceholder}
              value={exceptionNote}
              onChangeText={setExceptionNote}
              multiline
              numberOfLines={3}
            />
            <TouchableOpacity style={styles.empPrimaryButton} onPress={handleExceptionSubmit} disabled={submittingException}>
              {submittingException ? <ActivityIndicator color="#0A0E1A" /> : <Text style={styles.empPrimaryButtonText}>Submit Exception Request</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.empGhostButton} onPress={() => setOutOfRangeData(null)}>
              <Text style={styles.empGhostButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.empStatusCard}>
              <View style={[styles.empStatusPill, activeSession && !activeBreak ? styles.empStatusPillActive : null]}>
                <Text style={styles.empStatusPillText}>
                  {activeSession ? (activeBreak ? `ON BREAK · ${activeBreak.break_type}` : 'ACTIVE SHIFT') : 'OFFLINE'}
                </Text>
              </View>
              <Text style={styles.empTimer}>
                {activeBreak
                  ? formatTimeCounter(breakSeconds)
                  : (activeSession ? formatTimeCounter(activeSessionSeconds) : '--:--:--')}
              </Text>
              {activeBreak && activeSession ? (
                <Text style={styles.empShiftSub}>Shift: {formatTimeCounter(activeSessionSeconds)}</Text>
              ) : null}
              <View style={styles.empHoursRow}>
                <Text style={styles.empHoursLabel}>Today&apos;s hours</Text>
                <Text style={styles.empHoursValue}>{todayHours} / 8h</Text>
              </View>
              <View style={styles.empProgressTrack}>
                <View style={[styles.empProgressFill, { width: `${Math.min(100, (parseFloat(todayHours) || 0) / 8 * 100)}%` }]} />
              </View>
            </View>

            {activeSession ? (
              activeBreak ? (
                <TouchableOpacity style={styles.empCircleButton} onPress={handleEndBreak}>
                  <Text style={styles.empCircleButtonText}>END{'\n'}BREAK</Text>
                </TouchableOpacity>
              ) : (
                <>
                  <View style={styles.empBreakRow}>
                    <TouchableOpacity style={styles.empChip} onPress={() => handleStartBreak('Unpaid Lunch')}>
                      <Text style={styles.empChipText}>Unpaid Lunch</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.empChip} onPress={() => handleStartBreak('Paid Lunch')}>
                      <Text style={styles.empChipText}>Paid Lunch</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.empChip} onPress={() => handleStartBreak('Paid Rest Break')}>
                      <Text style={styles.empChipText}>Rest Break</Text>
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity style={styles.empCircleButton} onPress={handleClockOut}>
                    <Text style={styles.empCircleButtonText}>CLOCK{'\n'}OUT</Text>
                  </TouchableOpacity>
                </>
              )
            ) : (
              <TouchableOpacity
                style={[styles.empCircleButton, locationChecking && styles.empCircleButtonDisabled]}
                onPress={handleClockIn}
                disabled={locationChecking}
              >
                {locationChecking ? <ActivityIndicator color="#0A0E1A" size="large" /> : <Text style={styles.empCircleButtonText}>CLOCK{'\n'}IN</Text>}
              </TouchableOpacity>
            )}

            {statusMessage ? <Text style={styles.empMessage}>{statusMessage}</Text> : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f6fa' },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f5f6fa' },
  loadingText: { marginTop: 10, color: '#555' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 15, backgroundColor: '#ffffff', borderBottomWidth: 1, borderBottomColor: '#dcdde1' },
  headerTitle: { fontSize: 18, fontWeight: 'bold', color: '#2f3640' },
  headerSubtitle: { fontSize: 12, color: '#718093' },
  headerRight: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  navButton: { backgroundColor: '#2f3640', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  navButtonText: { color: '#ffffff', fontWeight: '600', fontSize: 12 },
  assistantButton: { backgroundColor: '#007AFF', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  logoutButton: { backgroundColor: '#e74c3c', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  logoutButtonText: { color: '#ffffff', fontWeight: '600', fontSize: 12 },
  content: { padding: 20, alignItems: 'center', justifyContent: 'center', flexGrow: 1 },
  card: { backgroundColor: '#ffffff', padding: 30, borderRadius: 12, width: '100%', maxWidth: 400, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 6, elevation: 4, alignItems: 'center' },
  title: { fontSize: 22, fontWeight: 'bold', color: '#2f3640' },
  subtitle: { fontSize: 13, color: '#718093', marginBottom: 20, textAlign: 'center' },
  input: { width: '100%', borderWidth: 1, borderColor: '#dcdde1', padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 14, backgroundColor: '#fafafa', color: '#2f3640' },
  textArea: { width: '100%', borderWidth: 1, borderColor: '#f5b7b1', padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 14, backgroundColor: '#fdfefe', color: '#2f3640', height: 80, textAlignVertical: 'top' },
  primaryButton: { backgroundColor: '#27ae60', width: '100%', padding: 14, borderRadius: 8, alignItems: 'center', marginTop: 5 },
  secondaryButton: { backgroundColor: '#f1f2f6', width: '100%', padding: 14, borderRadius: 8, alignItems: 'center', marginTop: 10, borderWidth: 1, borderColor: '#dcdde1' },
  secondaryButtonText: { color: '#2f3640', fontWeight: '600', fontSize: 14 },
  buttonText: { color: '#ffffff', fontSize: 15, fontWeight: 'bold' },
  errorText: { color: '#e74c3c', fontSize: 12, marginBottom: 10, textAlign: 'center' },
  statusBox: { marginVertical: 10, alignItems: 'center', width: '100%' },
  statusLabel: { fontSize: 14, color: '#718093' },
  statusValue: { fontSize: 16, fontWeight: 'bold', marginTop: 4 },
  activeText: { color: '#27ae60' },
  breakText: { color: '#f39c12' },
  offlineText: { color: '#e74c3c' },
  tickerBox: { marginVertical: 10, alignItems: 'center', backgroundColor: '#e8f8f5', padding: 10, borderRadius: 8, width: '100%', borderWidth: 1, borderColor: '#a3e4d7' },
  tickerLabel: { fontSize: 12, color: '#16a085', fontWeight: '600' },
  tickerValue: { fontSize: 22, fontWeight: 'bold', color: '#117a65', marginTop: 2, fontVariant: ['tabular-nums'] },
  hoursBox: { marginVertical: 10, alignItems: 'center', backgroundColor: '#f1f2f6', padding: 10, borderRadius: 8, width: '100%' },
  hoursLabel: { fontSize: 13, color: '#57606f' },
  hoursValue: { fontSize: 20, fontWeight: 'bold', color: '#2f3640', marginTop: 2 },
  clockInButton: { backgroundColor: '#27ae60', width: '100%', padding: 15, borderRadius: 8, alignItems: 'center', marginTop: 15 },
  disabledButton: { backgroundColor: '#95a5a6' },
  clockOutButton: { backgroundColor: '#d35400', width: '100%', padding: 15, borderRadius: 8, alignItems: 'center', marginTop: 15 },
  breakContainer: { width: '100%', marginTop: 15, gap: 8 },
  breakRow: { flexDirection: 'row', gap: 8, width: '100%' },
  lunchUnpaidButton: { flex: 1, backgroundColor: '#e67e22', padding: 12, borderRadius: 8, alignItems: 'center' },
  lunchPaidButton: { flex: 1, backgroundColor: '#d35400', padding: 12, borderRadius: 8, alignItems: 'center' },
  restButton: { flex: 1, backgroundColor: '#2980b9', padding: 12, borderRadius: 8, alignItems: 'center' },
  breakButtonText: { color: '#ffffff', fontWeight: 'bold', fontSize: 13 },
  endBreakButton: { backgroundColor: '#27ae60', width: '100%', padding: 15, borderRadius: 8, alignItems: 'center', marginTop: 15 },
  exceptionBox: { width: '100%', backgroundColor: '#fef9e7', borderColor: '#f9e79f', borderWidth: 1, padding: 15, borderRadius: 8, marginTop: 10, alignItems: 'center' },
  exceptionTitle: { fontSize: 15, fontWeight: 'bold', color: '#b7950b', marginBottom: 6 },
  exceptionText: { fontSize: 13, color: '#7d6608', textAlign: 'center', marginBottom: 12 },
  submitExceptionButton: { backgroundColor: '#d4ac0d', width: '100%', padding: 12, borderRadius: 6, alignItems: 'center' },
  cancelButton: { marginTop: 8, padding: 6 },
  cancelButtonText: { color: '#718093', fontSize: 13, fontWeight: '600' },
  message: { marginTop: 15, fontSize: 13, color: '#57606f', textAlign: 'center' },

  // --- NorthShift auth theme (login reskin; employee/manager screens keep legacy styles until their pass) ---
  authContainer: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', padding: spacing.lg },
  authLoadingContainer: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' },
  authLoadingText: { marginTop: spacing.md, color: colors.textSecondary, fontSize: 14 },
  authCard: { width: '100%', maxWidth: 400, alignSelf: 'center' },
  authLogoMark: { fontSize: 54, color: colors.accent, textAlign: 'center', marginBottom: spacing.sm },
  authTitle: { ...type.title, color: colors.textPrimary, textAlign: 'center' },
  authSubtitle: { ...type.body, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.xs, marginBottom: spacing.xl },
  authLabel: { ...type.label, color: colors.textSecondary, marginBottom: spacing.xs },
  authInput: { backgroundColor: colors.inputBackground, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: radius.md, padding: spacing.md, fontSize: 16, color: colors.textPrimary, marginBottom: spacing.md },
  authError: { color: colors.danger, fontSize: 13, textAlign: 'center', marginBottom: spacing.sm },
  authMessage: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginBottom: spacing.sm },
  authPrimaryButton: { backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: spacing.md + 2, alignItems: 'center', marginTop: spacing.sm, ...elevation.accentGlow },
  authPrimaryButtonText: { color: '#0A0E1A', fontSize: 16, fontWeight: '700' },
  authDivider: { flexDirection: 'row', alignItems: 'center', marginVertical: spacing.lg },
  authDividerLine: { flex: 1, height: 1, backgroundColor: colors.surfaceBorder },
  authDividerText: { color: colors.textMuted, marginHorizontal: spacing.md, fontSize: 13 },
  authBiometricButton: { borderWidth: 1, borderColor: colors.accentBorder, backgroundColor: colors.accentSoft, borderRadius: radius.md, paddingVertical: spacing.md, alignItems: 'center' },
  authBiometricButtonText: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  authSecondaryButton: { marginTop: spacing.lg, alignItems: 'center', padding: spacing.sm },
  authSecondaryButtonText: { color: colors.textSecondary, fontSize: 14 },

  // --- NorthShift employee theme (time tracker home) ---
  empContainer: { flex: 1, backgroundColor: colors.background },
  empHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  empBrand: { fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  empEmail: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  empHeaderRight: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  empAssistantButton: { backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder, paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.sm },
  empAssistantButtonText: { color: colors.accent, fontWeight: '600', fontSize: 12 },
  empNavButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.sm },
  empNavButtonText: { color: colors.textPrimary, fontWeight: '600', fontSize: 12 },
  empLogoutButton: { paddingVertical: 8, paddingHorizontal: 8 },
  empLogoutButtonText: { color: colors.textMuted, fontWeight: '600', fontSize: 12 },
  empContent: { padding: spacing.lg, alignItems: 'center', flexGrow: 1 },
  empStatusCard: { width: '100%', maxWidth: 400, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.lg, alignItems: 'center', ...elevation.card },
  empStatusPill: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.pill, paddingVertical: 6, paddingHorizontal: 14, marginBottom: spacing.md },
  empStatusPillActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  empStatusPillText: { ...type.label, color: colors.accent },
  empClock: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  empShiftSub: { fontSize: 12, color: colors.textSecondary, marginTop: 4 },
  empTimer: { ...type.timer, color: colors.textPrimary, marginBottom: spacing.sm },
  empHoursRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginBottom: spacing.sm },
  empHoursLabel: { fontSize: 13, color: colors.textSecondary },
  empHoursValue: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, fontVariant: ['tabular-nums'] },
  empProgressTrack: { width: '100%', height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' },
  empProgressFill: { height: '100%', backgroundColor: colors.accent, borderRadius: 4 },
  empCircleButton: { width: 168, height: 168, borderRadius: 84, backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center', marginTop: spacing.xl, ...elevation.accentGlow },
  empCircleButtonDisabled: { opacity: 0.6 },
  empCircleButtonText: { color: '#0A0E1A', fontSize: 20, fontWeight: '800', textAlign: 'center', letterSpacing: 1 },
  empBreakRow: { flexDirection: 'row', gap: 8, marginTop: spacing.xl, width: '100%', maxWidth: 400 },
  empChip: { flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' },
  empChipText: { color: colors.textPrimary, fontWeight: '600', fontSize: 13 },
  empMessage: { marginTop: spacing.lg, fontSize: 13, color: colors.textSecondary, textAlign: 'center', maxWidth: 400 },
  empExceptionBox: { width: '100%', maxWidth: 400, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.warning, borderRadius: radius.lg, padding: spacing.lg, ...elevation.card },
  empExceptionTitle: { fontSize: 17, fontWeight: '700', color: colors.warning, marginBottom: spacing.sm, textAlign: 'center' },
  empExceptionText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.md },
  empTextArea: { backgroundColor: colors.inputBackground, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: radius.md, padding: spacing.md, fontSize: 14, color: colors.textPrimary, height: 90, textAlignVertical: 'top', marginBottom: spacing.md },
  empPrimaryButton: { backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: spacing.md, alignItems: 'center' },
  empPrimaryButtonText: { color: '#0A0E1A', fontSize: 15, fontWeight: '700' },
  empGhostButton: { marginTop: spacing.sm, padding: spacing.sm, alignItems: 'center' },
  empGhostButtonText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
});
