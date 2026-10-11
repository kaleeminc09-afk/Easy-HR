import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, SafeAreaView, ActivityIndicator, ScrollView } from 'react-native';
import { Link } from 'expo-router';
import * as Location from 'expo-location';
import { supabase } from '../lib/supabase';

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  // Auth Form State
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');

  // Time Tracker State
  const [activeSession, setActiveSession] = useState(null);
  const [activeBreak, setActiveBreak] = useState(null);
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
    let timer = null;
    if (activeSession && !activeBreak) {
      const startTime = new Date(activeSession.clock_in).getTime();
      const updateTicker = () => {
        const now = new Date().getTime();
        const diffSeconds = Math.floor((now - startTime) / 1000);
        setActiveSessionSeconds(diffSeconds > 0 ? diffSeconds : 0);
      };
      updateTicker();
      timer = setInterval(updateTicker, 1000);
    } else {
      setActiveSession(null);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [activeSession, activeBreak]);

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
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading Easy HR...</Text>
      </View>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.card}>
          <Text style={styles.title}>Easy HR Login</Text>
          <Text style={styles.subtitle}>Sign in to your employee or manager account</Text>

          <TextInput
            style={styles.input}
            placeholder="Email address"
            placeholderTextColor="#95a5a6"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor="#95a5a6"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />

          {authError ? <Text style={styles.errorText}>{authError}</Text> : null}
          {statusMessage ? <Text style={styles.message}>{statusMessage}</Text> : null}

          <TouchableOpacity style={styles.primaryButton} onPress={handleLogin} disabled={authLoading}>
            {authLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign In</Text>}
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryButton} onPress={handleSignUp} disabled={authLoading}>
            <Text style={styles.secondaryButtonText}>Create New Account</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Easy HR</Text>
          <Text style={styles.headerSubtitle}>{session.user.email}</Text>
        </View>
        <View style={styles.headerRight}>
          <Link href="/EmployeeChatScreen" asChild>
            <TouchableOpacity style={styles.assistantButton}>
              <Text style={styles.navButtonText}>🤖 Assistant</Text>
            </TouchableOpacity>
          </Link>
          <Link href="/manager" asChild>
            <TouchableOpacity style={styles.navButton}>
              <Text style={styles.navButtonText}>Manager →</Text>
            </TouchableOpacity>
          </Link>
          <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
            <Text style={styles.logoutButtonText}>Logout</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.title}>Time Tracker</Text>
          <Text style={styles.subtitle}>Geo-fenced attendance & break controls</Text>

          {outOfRangeData ? (
            <View style={styles.exceptionBox}>
              <Text style={styles.exceptionTitle}>⚠️ Out of Range Exception</Text>
              <Text style={styles.exceptionText}>
                You are {outOfRangeData.distance}m away from {outOfRangeData.worksite.name}. Provide a note:
              </Text>
              <TextInput
                style={styles.textArea}
                placeholder="e.g., Client visit, remote field work..."
                placeholderTextColor="#95a5a6"
                value={exceptionNote}
                onChangeText={setExceptionNote}
                multiline
                numberOfLines={3}
              />
              <TouchableOpacity style={styles.submitExceptionButton} onPress={handleExceptionSubmit} disabled={submittingException}>
                {submittingException ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Submit Exception Request</Text>}
              </TouchableOpacity>
              <TouchableOpacity style={styles.cancelButton} onPress={() => setOutOfRangeData(null)}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View style={styles.statusBox}>
                <Text style={styles.statusLabel}>Current Status:</Text>
                <Text style={[styles.statusValue, activeSession ? (activeBreak ? styles.breakText : styles.activeText) : styles.offlineText]}>
                  {activeSession ? (activeBreak ? `☕ ON BREAK (${activeBreak.break_type})` : '🟢 ACTIVE (Clocked In)') : '⚪ OFFLINE'}
                </Text>
              </View>

              {activeSession && !activeBreak && (
                <View style={styles.tickerBox}>
                  <Text style={styles.tickerLabel}>Active Shift Duration:</Text>
                  <Text style={styles.tickerValue}>{formatTimeCounter(activeSessionSeconds)}</Text>
                </View>
              )}

              <View style={styles.hoursBox}>
                <Text style={styles.hoursLabel}>Today's Total Hours:</Text>
                <Text style={styles.hoursValue}>{todayHours} hrs</Text>
              </View>

              {activeSession ? (
                activeBreak ? (
                  <TouchableOpacity style={styles.endBreakButton} onPress={handleEndBreak}>
                    <Text style={styles.buttonText}>END BREAK (RETURN TO SHIFT)</Text>
                  </TouchableOpacity>
                ) : (
                  <>
                    <View style={styles.breakContainer}>
                      <View style={styles.breakRow}>
                        <TouchableOpacity style={styles.lunchUnpaidButton} onPress={() => handleStartBreak('Unpaid Lunch')}>
                          <Text style={styles.breakButtonText}>🍔 Unpaid Lunch</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.lunchPaidButton} onPress={() => handleStartBreak('Paid Lunch')}>
                          <Text style={styles.breakButtonText}>🥗 Paid Lunch</Text>
                        </TouchableOpacity>
                      </View>
                      <View style={styles.breakRow}>
                        <TouchableOpacity style={styles.restButton} onPress={() => handleStartBreak('Paid Rest Break')}>
                          <Text style={styles.breakButtonText}>☕ Rest Break</Text>
                        </TouchableOpacity>
                      </View>
                    </View>

                    <TouchableOpacity style={styles.clockOutButton} onPress={handleClockOut}>
                      <Text style={styles.buttonText}>CLOCK OUT & ANALYZE</Text>
                    </TouchableOpacity>
                  </>
                )
              ) : (
                <TouchableOpacity
                  style={[styles.clockInButton, locationChecking && styles.disabledButton]}
                  onPress={handleClockIn}
                  disabled={locationChecking}
                >
                  {locationChecking ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.buttonText}>CLOCK IN (AUTO-GPS)</Text>}
                </TouchableOpacity>
              )}
            </>
          )}

          {statusMessage ? <Text style={styles.message}>{statusMessage}</Text> : null}
        </View>
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
});
