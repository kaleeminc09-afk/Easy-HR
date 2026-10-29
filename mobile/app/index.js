import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ActivityIndicator, ScrollView, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { Link, useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { supabase } from '../lib/supabase';
import { colors, spacing, radius, type, elevation, fontFamily, buttons } from '../lib/theme';
import { chooseBreakType, maxMinutesForBreakType, DEFAULT_BREAK_POLICY, PROVINCE_BREAK_RULES } from '../supabase/functions/hr-ai-bot/logic';

export default function App() {
  const [session, setSession] = useState(null);
  const [businessName, setBusinessName] = useState('');
  const [myRole, setMyRole] = useState('employee');
  const [menuOpen, setMenuOpen] = useState(false);
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  // Auth Form State
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [profileIncomplete, setProfileIncomplete] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authMode, setAuthMode] = useState('signin'); // signin | create | forgot
  const [showPassword, setShowPassword] = useState(false);

  // Time Tracker State
  const [activeSession, setActiveSession] = useState(null);
  const [activeBreak, setActiveBreak] = useState(null);
  const [breakSeconds, setBreakSeconds] = useState(0);
  const [now, setNow] = useState(new Date());
  const [todayHours, setTodayHours] = useState(0);
  const [activeSessionSeconds, setActiveSessionSeconds] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [myBusinessId, setMyBusinessId] = useState(null);
  const [breakPolicy, setBreakPolicy] = useState({ ...DEFAULT_BREAK_POLICY, province: 'ON' });
  const [onCallBreak, setOnCallBreak] = useState(false);
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
      const { data } = await supabase.from('profiles').select('business_id, phone, role').eq('id', session.user.id).single();
      // Emergency contact 1 lives on profile_private now (owner-only);
      // a missing row/table just means the nudge shows until it is saved.
      const { data: priv } = await supabase.from('profile_private').select('emergency_contact_1_phone').eq('user_id', session.user.id).maybeSingle();
      if (data) { setProfileIncomplete(!data.phone || !priv?.emergency_contact_1_phone); setMyRole(data.role || 'employee'); setMyBusinessId(data.business_id || null); }
      if (data && data.business_id) {
        const { data: pol } = await supabase.from('break_policies').select('*').eq('business_id', data.business_id).maybeSingle();
        if (pol) {
          const rule = PROVINCE_BREAK_RULES[pol.province] || PROVINCE_BREAK_RULES.ON;
          const minMeal = rule.meal_minutes || 0;
          setBreakPolicy({
            province: pol.province || 'ON',
            meal_minutes: Math.max(pol.meal_minutes || 0, minMeal),
            rest_minutes: pol.rest_minutes || DEFAULT_BREAK_POLICY.rest_minutes,
            rest_max_per_shift: pol.rest_max_per_shift ?? DEFAULT_BREAK_POLICY.rest_max_per_shift,
            meal_paid_if_available: pol.meal_paid_if_available ?? DEFAULT_BREAK_POLICY.meal_paid_if_available,
          });
        }
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
    if (!email.includes('@') || password.length < 6) {
      setAuthError('Enter your email and password (at least 6 characters).');
      setAuthLoading(false);
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setAuthError(error.message);
    setAuthLoading(false);
  };

  const handleForgotPassword = async () => {
    setAuthLoading(true);
    setAuthError('');
    setStatusMessage('');
    if (!email.includes('@')) {
      setAuthError('Enter the email address on your account.');
      setAuthLoading(false);
      return;
    }
    // Supabase sends the link only if the account exists; the message
    // below stays neutral either way so it never confirms an address.
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: 'northshift://reset-password',
    });
    if (error) {
      setAuthError(error.message);
    } else {
      setStatusMessage('If an account exists for that email, a reset link is on its way. Check your inbox (and spam folder).');
    }
    setAuthLoading(false);
  };

  const handleSignUp = async () => {
    setAuthLoading(true);
    setAuthError('');
    if (!email.includes('@') || password.length < 6) {
      setAuthError('Enter an email and a password (at least 6 characters) to create an account.');
      setAuthLoading(false);
      return;
    }
    const fn = firstName.trim();
    const ln = lastName.trim();
    const composedName = `${fn} ${ln}`.trim();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: composedName || email.split('@')[0], first_name: fn, last_name: ln, role: 'employee' } }
    });
    if (error) {
      setAuthError(error.message);
    } else {
      // If a session came back immediately, write the names to the profile
      // row directly so they are correct even if metadata is not copied.
      if (data && data.session && data.user && (fn || ln)) {
        try {
          await supabase.from('profiles').update({
            first_name: fn || null,
            last_name: ln || null,
            full_name: composedName,
          }).eq('id', data.user.id);
        } catch (e) { /* profile name can be fixed on the Profile screen */ }
      }
      setStatusMessage('Account created! You can now sign in.');
    }
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

  // GPS exception submit: the Out of Range box references this handler
  // but it was never defined, so tapping Submit used to throw. It files
  // the same time_exceptions row the QR scan now files (see scan.js).
  const handleExceptionSubmit = async () => {
    if (!outOfRangeData || !session?.user) return;
    setSubmittingException(true);
    try {
      const { error } = await supabase.from('time_exceptions').insert([{
        user_id: session.user.id,
        worksite_id: outOfRangeData.worksite?.id || null,
        attempted_at: new Date().toISOString(),
        latitude: outOfRangeData.latitude,
        longitude: outOfRangeData.longitude,
        distance_meters: outOfRangeData.distance,
        reason_note: exceptionNote,
        status: 'pending',
      }]);
      if (error) throw new Error(error.message);
      setOutOfRangeData(null);
      setExceptionNote('');
      setStatusMessage('Exception request sent to your manager.');
    } catch (e) {
      setStatusMessage('❌ Could not send exception: ' + e.message);
    } finally {
      setSubmittingException(false);
    }
  };

  // Supervised breaks: the employee never picks paid vs unpaid.
  // One button; chooseBreakType (shared with logic.ts) picks the type
  // from the business policy and this shift's breaks so far.
  const handleStartBreak = async () => {
    if (!activeSession) return;
    if (activeBreak) {
      setStatusMessage('You are already on a break.');
      return;
    }
    setStatusMessage('Starting break...');
    const { data: taken } = await supabase
      .from('time_breaks')
      .select('break_type')
      .eq('time_log_id', activeSession.id);
    const chosen = chooseBreakType(breakPolicy, taken || [], { onCall: onCallBreak });
    if (!chosen.break_type) {
      setStatusMessage(chosen.reason);
      return;
    }
    const { data, error } = await supabase
      .from('time_breaks')
      .insert([{
        time_log_id: activeSession.id,
        break_type: chosen.break_type,
        start_time: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) {
      setStatusMessage('❌ Error starting break: ' + error.message);
    } else {
      setActiveBreak(data);
      setOnCallBreak(false);
      setStatusMessage(`☕ On ${chosen.break_type} · ${chosen.paid ? 'paid' : 'unpaid'} · up to ${chosen.max_minutes} min. ${chosen.reason}`);
    }
  };

  const handleEndBreak = async () => {
    if (!activeBreak) return;
    setStatusMessage('Ending break...');
    const endIso = new Date().toISOString();
    const { error } = await supabase
      .from('time_breaks')
      .update({ end_time: endIso })
      .eq('id', activeBreak.id);

    if (error) {
      setStatusMessage('❌ Error ending break: ' + error.message);
    } else {
      const maxMin = maxMinutesForBreakType(activeBreak.break_type, breakPolicy);
      const durMin = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(activeBreak.start_time).getTime()) / 60000));
      setActiveBreak(null);
      if (durMin > maxMin) {
        setStatusMessage(`🟢 Returned to active shift — break ran ${durMin} min vs ${maxMin} min allowed for ${activeBreak.break_type}; the overrun is flagged for the manager to review. Overrun pay is not changed automatically.`);
      } else if (activeBreak.break_type === 'On-call Meal') {
        setStatusMessage('🟢 Returned to active shift — on-call meal flagged for manager review.');
      } else {
        setStatusMessage('🟢 Returned to active shift');
      }
      fetchTimeData(session.user.id);
    }
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

  const formatClock = (d) =>
    d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  // --- Phase A0: hero clock, greeting, press animation ---
  const formatHeroTime = (d) =>
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const formatHeroDate = (d) =>
    d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const greeting = () => {
    const h = now.getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  };

  // Subtle press-in animation for the big clock button ("nothing crazy")
  const btnScale = useSharedValue(1);
  const animatedBtnStyle = useAnimatedStyle(() => ({
    transform: [{ scale: btnScale.value }],
  }));
  const pressIn = () => { btnScale.value = withSpring(0.94, { damping: 15, stiffness: 400 }); };
  const pressOut = () => { btnScale.value = withSpring(1, { damping: 15, stiffness: 400 }); };

  if (loading) {
    return (
      <View style={styles.authLoadingContainer}>
        <Image source={require('../assets/images/icon.png')} style={styles.authLogo} />
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.authLoadingText}>Loading NorthShift...</Text>
      </View>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.authContainer}>
        <View style={styles.authCard}>
          <Image source={require('../assets/images/icon.png')} style={styles.authLogo} />
          <Text style={styles.authTitle}>NorthShift</Text>
          <Text style={styles.authSubtitle}>{authMode === 'create' ? 'Create your NorthShift account.' : 'Welcome back. Sign in to continue.'}</Text>

          {authMode === 'create' && (<>
          <Text style={styles.authLabel}>First name</Text>
          <TextInput
            style={styles.authInput}
            placeholder="First name"
            placeholderTextColor={colors.inputPlaceholder}
            value={firstName}
            onChangeText={setFirstName}
            autoCapitalize="words"
          />
          <Text style={styles.authLabel}>Last name</Text>
          <TextInput
            style={styles.authInput}
            placeholder="Last name"
            placeholderTextColor={colors.inputPlaceholder}
            value={lastName}
            onChangeText={setLastName}
            autoCapitalize="words"
          />
          </>)}
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
          {authMode !== 'forgot' && (<>
          <Text style={styles.authLabel}>Password</Text>
          <TextInput
            style={styles.authInput}
            placeholder="Your password"
            placeholderTextColor={colors.inputPlaceholder}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
          />
          {authMode === 'signin' && (
            <View style={styles.authAuxRow}>
              <TouchableOpacity onPress={() => { setAuthMode('forgot'); setAuthError(''); setStatusMessage(''); }}>
                <Text style={styles.authAuxLink}>Forgot password?</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowPassword(!showPassword)}>
                <Text style={styles.authAuxLink}>{showPassword ? 'Hide' : 'Show'}</Text>
              </TouchableOpacity>
            </View>
          )}
          </>)}
          {authMode === 'forgot' && (
            <Text style={styles.authMessage}>Enter the email on your account and we will send you a link to choose a new password.</Text>
          )}

          {authError ? <Text style={styles.authError}>{authError}</Text> : null}
          {statusMessage ? <Text style={styles.authMessage}>{statusMessage}</Text> : null}

          <TouchableOpacity style={styles.authPrimaryButton} onPress={authMode === 'create' ? handleSignUp : authMode === 'forgot' ? handleForgotPassword : handleLogin} disabled={authLoading}>
            {authLoading ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.authPrimaryButtonText}>{authMode === 'create' ? 'Create Account' : authMode === 'forgot' ? 'Send reset link' : 'Sign In'}</Text>}
          </TouchableOpacity>

          {authMode === 'signin' && (<>
          <View style={styles.authDivider}>
            <View style={styles.authDividerLine} />
            <Text style={styles.authDividerText}>or</Text>
            <View style={styles.authDividerLine} />
          </View>

          <TouchableOpacity style={styles.authBiometricButton} onPress={handleBiometric}>
            <Text style={styles.authBiometricButtonText}>Sign in with biometrics</Text>
          </TouchableOpacity>
          </>)}

          <TouchableOpacity style={styles.authSecondaryButton} onPress={() => { setAuthMode(authMode === 'forgot' ? 'signin' : authMode === 'create' ? 'signin' : 'create'); setAuthError(''); setStatusMessage(''); }} disabled={authLoading}>
            <Text style={styles.authSecondaryButtonText}>{authMode === 'forgot' ? 'Back to sign in' : authMode === 'create' ? 'Already have an account? Sign in' : 'New here? Create account'}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.empContainer}>
      <View style={styles.empHeader}>
        <View>
          <View style={styles.empBrandRow}>
            <Image source={require('../assets/images/icon.png')} style={styles.empBrandLogo} />
            <Text style={styles.empBrand}>NorthShift</Text>
          </View>
          <Text style={styles.empEmail}>{businessName || session.user.email}</Text>
          {(myRole === 'manager' || myRole === 'admin') && (<Text style={styles.roleBadge}>Manager</Text>)}
        </View>
        <TouchableOpacity style={styles.empNavButton} onPress={() => setMenuOpen(!menuOpen)}>
          <Text style={styles.empNavButtonText}>☰ Menu</Text>
        </TouchableOpacity>
      </View>
      {menuOpen && (
        <View style={styles.menuPanel}>
          {[
            ['✦ Assistant', '/EmployeeChatScreen'],
            ['Team', '/team'],
            ['Schedule', '/schedule'],
            ['Time Off', '/timeoff'],
            ['Documents', '/documents'],
            ['Manager →', '/manager'],
            ['Profile', '/profile'],
          ].map(([label, href]) => (
            <TouchableOpacity key={href} style={styles.menuItem} onPress={() => { setMenuOpen(false); router.push(href); }}>
              <Text style={styles.menuItemText}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <ScrollView contentContainerStyle={styles.empContent}>
        {profileIncomplete && (
          <Link href="/profile" asChild>
            <TouchableOpacity style={styles.profileNudge}>
              <Text style={styles.profileNudgeTitle}>Complete your profile</Text>
              <Text style={styles.profileNudgeText}>Add your phone number and an emergency contact so your manager can reach the right person fast.</Text>
              <Text style={styles.profileNudgeLink}>Go to Profile →</Text>
            </TouchableOpacity>
          </Link>
        )}
        {/* Hero live clock — the heart of a time-clock app */}
        <View style={styles.heroClockWrap}>
          <Text style={styles.heroTime}>{formatHeroTime(now)}</Text>
          <Text style={styles.heroDate}>{formatHeroDate(now)}</Text>
        </View>
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
              {submittingException ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.empPrimaryButtonText}>Submit Exception Request</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.empGhostButton} onPress={() => setOutOfRangeData(null)}>
              <Text style={styles.empGhostButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.empStatusCard}>
              <View style={styles.empStatusRow}>
                <View style={[
                  styles.empStatusDot,
                  activeSession ? (activeBreak ? styles.empStatusDotBreak : styles.empStatusDotActive) : styles.empStatusDotOff,
                ]} />
                <Text style={styles.empStatusText}>
                  {activeSession ? (activeBreak ? `On break · ${activeBreak.break_type}` : 'On shift') : 'Off the clock'}
                </Text>
              </View>
              {activeSession ? (
                <>
                  <Text style={styles.empTimer}>
                    {activeBreak ? formatTimeCounter(breakSeconds) : formatTimeCounter(activeSessionSeconds)}
                  </Text>
                  <Text style={styles.empTimerLabel}>
                    {activeBreak ? 'break elapsed' : 'shift elapsed'}
                  </Text>
                  {activeBreak ? (
                    <Text style={styles.empShiftSub}>Shift: {formatTimeCounter(activeSessionSeconds)}</Text>
                  ) : null}
                </>
              ) : (
                <>
                  <Text style={styles.empGreeting}>{greeting()}.</Text>
                  <Text style={styles.empOfflineSub}>
                    {parseFloat(todayHours) > 0
                      ? `You've logged ${todayHours}h today — nice work.`
                      : 'No hours logged yet today. Tap below when your shift starts.'}
                  </Text>
                </>
              )}
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
                <Animated.View style={animatedBtnStyle}>
                  <TouchableOpacity
                    style={styles.empCircleButton}
                    onPress={handleEndBreak}
                    onPressIn={pressIn}
                    onPressOut={pressOut}
                    activeOpacity={0.9}
                  >
                    <Text style={styles.empCircleButtonText}>END{'\n'}BREAK</Text>
                  </TouchableOpacity>
                </Animated.View>
              ) : (
                <>
                  <TouchableOpacity style={styles.empOnCallRow} onPress={() => setOnCallBreak(!onCallBreak)}>
                    <Text style={styles.empOnCallBox}>{onCallBreak ? '☑' : '☐'}</Text>
                    <Text style={styles.empOnCallText}>I must stay available during this break</Text>
                  </TouchableOpacity>
                  <Text style={styles.empBreakPolicyText}>If ticked, this break is recorded as an on-call meal: paid only if your business policy allows it, and your manager reviews it.</Text>
                  <View style={styles.empBreakRow}>
                    <TouchableOpacity style={styles.empBreakButton} onPress={handleStartBreak}>
                      <Text style={styles.empBreakButtonText}>Start Break</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.empBreakPolicyText}>Meal {breakPolicy.meal_minutes} min unpaid · Rest {breakPolicy.rest_minutes} min paid, max {breakPolicy.rest_max_per_shift} per shift · {(PROVINCE_BREAK_RULES[breakPolicy.province] || PROVINCE_BREAK_RULES.ON).name}</Text>
                  <Animated.View style={animatedBtnStyle}>
                    <TouchableOpacity
                      style={styles.empCircleButton}
                      onPress={handleClockOut}
                      onPressIn={pressIn}
                      onPressOut={pressOut}
                      activeOpacity={0.9}
                    >
                      <Text style={styles.empCircleButtonText}>CLOCK{'\n'}OUT</Text>
                    </TouchableOpacity>
                  </Animated.View>
                </>
              )
            ) : (
              <Animated.View style={animatedBtnStyle}>
                <TouchableOpacity
                  style={[styles.empCircleButton, locationChecking && styles.empCircleButtonDisabled]}
                  onPress={handleClockIn}
                  onPressIn={pressIn}
                  onPressOut={pressOut}
                  activeOpacity={0.9}
                  disabled={locationChecking}
                >
                  {locationChecking ? <ActivityIndicator color="#FFFFFF" size="large" /> : <Text style={styles.empCircleButtonText}>CLOCK{'\n'}IN</Text>}
                </TouchableOpacity>
              </Animated.View>
            )}

            {statusMessage ? <Text style={styles.empMessage}>{statusMessage}</Text> : null}

            <Link href="/scan" asChild>
              <TouchableOpacity style={styles.empScanButton}>
                <Text style={styles.empScanButtonText}>Scan QR to Clock In / Out</Text>
              </TouchableOpacity>
            </Link>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({

  // --- NorthShift auth theme (login reskin; employee/manager screens keep legacy styles until their pass) ---
  authContainer: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', padding: spacing.lg },
  authLoadingContainer: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' },
  authLoadingText: { marginTop: spacing.md, color: colors.textSecondary, fontSize: 14, fontFamily: fontFamily.regular },
  authCard: { width: '100%', maxWidth: 400, alignSelf: 'center' },
  authLogo: { width: 76, height: 76, borderRadius: 20, alignSelf: 'center', marginBottom: spacing.sm },
  empScanButton: { ...buttons.secondary, marginTop: spacing.md },
  empScanButtonText: { ...buttons.secondaryText },
  empBrandRow: { flexDirection: 'row', alignItems: 'center' },
  empBrandLogo: { width: 30, height: 30, borderRadius: 9, marginRight: 8 },
  authTitle: { ...type.title, fontFamily: fontFamily.brand, color: colors.textPrimary, textAlign: 'center' },
  authSubtitle: { ...type.body, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.xs, marginBottom: spacing.xl },
  authLabel: { ...type.label, color: colors.textSecondary, marginBottom: spacing.xs },
  authInput: { backgroundColor: colors.inputBackground, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: radius.md, padding: spacing.md, fontSize: 16, fontFamily: fontFamily.regular, color: colors.textPrimary, marginBottom: spacing.md },
  authError: { color: colors.danger, fontSize: 13, fontFamily: fontFamily.regular, textAlign: 'center', marginBottom: spacing.sm },
  authAuxRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  authAuxLink: { color: colors.primary, fontSize: 13, fontFamily: fontFamily.medium },
  authMessage: { color: colors.textSecondary, fontSize: 13, fontFamily: fontFamily.regular, textAlign: 'center', marginBottom: spacing.sm },
  authPrimaryButton: { ...buttons.primary, marginTop: spacing.sm },
  authPrimaryButtonText: { ...buttons.primaryText },
  authDivider: { flexDirection: 'row', alignItems: 'center', marginVertical: spacing.lg },
  authDividerLine: { flex: 1, height: 1, backgroundColor: colors.surfaceBorder },
  authDividerText: { color: colors.textMuted, marginHorizontal: spacing.md, fontSize: 13, fontFamily: fontFamily.regular },
  authBiometricButton: { ...buttons.secondary },
  authBiometricButtonText: { ...buttons.secondaryText },
  authSecondaryButton: { marginTop: spacing.lg, alignItems: 'center', padding: spacing.sm },
  authSecondaryButtonText: { color: colors.textSecondary, fontSize: 14, fontFamily: fontFamily.regular },

  // --- NorthShift employee theme (time tracker home) ---
  empContainer: { flex: 1, backgroundColor: colors.background },
  empHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  empBrand: { fontSize: 18, fontFamily: fontFamily.brand, color: colors.textPrimary },
  empEmail: { fontSize: 13, fontFamily: fontFamily.regular, color: colors.textSecondary, marginTop: 2 },
  roleBadge: { alignSelf: 'flex-start', marginTop: 2, backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder, borderRadius: radius.pill, paddingVertical: 2, paddingHorizontal: 8, fontSize: 11, fontFamily: fontFamily.semibold, color: colors.accent, overflow: 'hidden' },
  empHeaderRight: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  menuPanel: { backgroundColor: colors.backgroundSecondary, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, marginHorizontal: spacing.lg, marginTop: spacing.sm, padding: spacing.sm, gap: 8 },
  menuItem: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.sm },
  menuItemText: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 15 },
  empAssistantButton: { backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder, paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.sm },
  empAssistantButtonText: { color: colors.accent, fontFamily: fontFamily.semibold, fontSize: 12 },
  empNavButton: { ...buttons.glass },
  empNavButtonText: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 12 },
  empContent: { padding: spacing.lg, paddingBottom: spacing.xxl, alignItems: 'center', flexGrow: 1 },
  profileNudge: { width: '100%', maxWidth: 420, backgroundColor: colors.warningSoft, borderWidth: 1, borderColor: colors.warning, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.lg },
  profileNudgeTitle: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.warning, marginBottom: spacing.xs },
  profileNudgeText: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textPrimary, marginBottom: spacing.sm },
  profileNudgeLink: { color: colors.accent, fontFamily: fontFamily.semibold, fontSize: 13 },
  // Hero live clock
  heroClockWrap: { alignItems: 'center', marginTop: spacing.md, marginBottom: spacing.lg },
  heroTime: { ...type.heroClock, color: colors.textPrimary },
  heroDate: { fontSize: 14, fontFamily: fontFamily.medium, color: colors.textSecondary, marginTop: 4 },
  empStatusCard: { width: '100%', maxWidth: 400, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.lg, alignItems: 'center', ...elevation.card },
  // Clean status dot + label (replaces textured pill)
  empStatusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md },
  empStatusDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  empStatusDotActive: { backgroundColor: colors.success },
  empStatusDotBreak: { backgroundColor: colors.warning },
  empStatusDotOff: { backgroundColor: colors.textMuted },
  empStatusText: { fontSize: 14, fontFamily: fontFamily.semibold, color: colors.textPrimary, letterSpacing: 0.3 },
  empTimer: { ...type.timer, color: colors.textPrimary },
  empTimerLabel: { fontSize: 12, fontFamily: fontFamily.medium, color: colors.textMuted, marginTop: 2, marginBottom: spacing.sm, textTransform: 'uppercase', letterSpacing: 1 },
  empGreeting: { fontSize: 26, fontFamily: fontFamily.bold, color: colors.textPrimary, marginBottom: spacing.xs },
  empOfflineSub: { fontSize: 14, fontFamily: fontFamily.regular, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.md, lineHeight: 20 },
  empShiftSub: { fontSize: 13, fontFamily: fontFamily.medium, color: colors.textSecondary, marginTop: 4, fontVariant: ['tabular-nums'] },
  empHoursRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginBottom: spacing.sm },
  empHoursLabel: { fontSize: 13, fontFamily: fontFamily.regular, color: colors.textSecondary },
  empHoursValue: { fontSize: 13, fontFamily: fontFamily.semibold, color: colors.textPrimary, fontVariant: ['tabular-nums'] },
  empProgressTrack: { width: '100%', height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' },
  empProgressFill: { height: '100%', backgroundColor: colors.accent, borderRadius: 4 },
  empCircleButton: { width: 168, height: 168, borderRadius: 84, backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center', marginTop: spacing.xl, ...elevation.accentGlow },
  empCircleButtonDisabled: { opacity: 0.6 },
  empCircleButtonText: { color: '#FFFFFF', fontSize: 20, fontFamily: fontFamily.extrabold, textAlign: 'center', letterSpacing: 1 },
  empBreakRow: { flexDirection: 'row', gap: 8, marginTop: spacing.xl, width: '100%', maxWidth: 400 },
  empOnCallRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: spacing.xl, width: '100%', maxWidth: 400 },
  empOnCallBox: { color: colors.textPrimary, fontSize: 18 },
  empOnCallText: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 13, flex: 1 },
  empBreakButton: { flex: 1, backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', minHeight: 56, justifyContent: 'center' },
  empBreakButtonText: { color: '#FFFFFF', fontFamily: fontFamily.semibold, fontSize: 15 },
  empBreakPolicyText: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 12, marginTop: spacing.sm, textAlign: 'center', width: '100%', maxWidth: 400 },
  empChip: { flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' },
  empChipText: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 13 },
  empMessage: { marginTop: spacing.lg, fontSize: 14, fontFamily: fontFamily.regular, color: colors.textSecondary, textAlign: 'center', maxWidth: 400, lineHeight: 20 },
  empExceptionBox: { width: '100%', maxWidth: 400, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.warning, borderRadius: radius.lg, padding: spacing.lg, ...elevation.card },
  empExceptionTitle: { fontSize: 17, fontFamily: fontFamily.bold, color: colors.warning, marginBottom: spacing.sm, textAlign: 'center' },
  empExceptionText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.md },
  empTextArea: { backgroundColor: colors.inputBackground, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: radius.md, padding: spacing.md, fontSize: 14, color: colors.textPrimary, height: 90, textAlignVertical: 'top', marginBottom: spacing.md },
  empPrimaryButton: { ...buttons.primary },
  empPrimaryButtonText: { ...buttons.primaryText },
  empGhostButton: { marginTop: spacing.sm, padding: spacing.sm, alignItems: 'center' },
  empGhostButtonText: { color: colors.textMuted, fontSize: 13, fontFamily: fontFamily.semibold },
});
