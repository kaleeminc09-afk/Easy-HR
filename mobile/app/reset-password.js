import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Link } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, spacing, radius, type, buttons } from '../lib/theme';

// Reached from the Supabase password-recovery email, which redirects to
// northshift://reset-password. _layout.tsx signs the user in from the link
// tokens first, so by the time this screen renders there is a session and
// updateUser can set the new password. Opened any other way, there is no
// session and the screen says so instead of failing silently.
export default function ResetPasswordScreen() {
  const router = useRouter();
  const [hasSession, setHasSession] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setHasSession(!!session));
  }, []);

  const handleSave = async () => {
    if (newPassword.length < 8) { setMessage('Use at least 8 characters for the new password.'); return; }
    if (newPassword !== confirmPassword) { setMessage('The two passwords do not match.'); return; }
    setSaving(true);
    setMessage('');
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      setMessage('Could not change the password. The link may have expired — request a new one from the sign-in screen.');
    } else {
      setDone(true);
      setMessage('Password changed. You are signed in.');
    }
    setSaving(false);
  };

  if (hasSession === null) {
    return (<SafeAreaView style={styles.container}><ActivityIndicator color={colors.primary} /></SafeAreaView>);
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Choose a new password</Text>
        {hasSession === false ? (
          <>
            <Text style={styles.body}>This page opens from the reset link in your email. That link has expired, or this screen was opened directly.</Text>
            <Text style={styles.body}>Go back to the sign-in screen and tap “Forgot password?” to request a fresh link.</Text>
            <Link href="/" asChild><TouchableOpacity style={buttons.primary}><Text style={buttons.primaryText}>Back to sign in</Text></TouchableOpacity></Link>
          </>
        ) : done ? (
          <>
            <Text style={styles.body}>{message}</Text>
            <TouchableOpacity style={buttons.primary} onPress={() => router.replace('/')}><Text style={buttons.primaryText}>Continue to NorthShift</Text></TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.label}>New password</Text>
            <TextInput style={styles.input} placeholder="At least 8 characters" placeholderTextColor={colors.inputPlaceholder} value={newPassword} onChangeText={setNewPassword} secureTextEntry={!showPassword} autoCapitalize="none" />
            <Text style={styles.label}>Confirm new password</Text>
            <TextInput style={styles.input} placeholder="Repeat the new password" placeholderTextColor={colors.inputPlaceholder} value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry={!showPassword} autoCapitalize="none" />
            <TouchableOpacity onPress={() => setShowPassword(!showPassword)}><Text style={styles.auxLink}>{showPassword ? 'Hide passwords' : 'Show passwords'}</Text></TouchableOpacity>
            {message ? <Text style={styles.error}>{message}</Text> : null}
            <TouchableOpacity style={buttons.primary} onPress={handleSave} disabled={saving}>
              {saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={buttons.primaryText}>Set new password</Text>}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg },
  title: { fontSize: 24, fontFamily: fontFamily.bold, color: colors.text, marginBottom: spacing.md },
  body: { fontSize: 16, fontFamily: fontFamily.regular, color: colors.text, marginBottom: spacing.md },
  label: { fontSize: 13, fontFamily: fontFamily.medium, color: colors.text, marginBottom: spacing.xs },
  input: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, fontSize: 16, fontFamily: fontFamily.regular, color: colors.text, marginBottom: spacing.md },
  auxLink: { color: colors.primary, fontSize: 13, fontFamily: fontFamily.medium, alignSelf: 'flex-end', marginBottom: spacing.md },
  error: { color: colors.danger, fontSize: 13, fontFamily: fontFamily.regular, textAlign: 'center', marginBottom: spacing.sm },
});
