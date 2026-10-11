import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, SafeAreaView, ActivityIndicator, ScrollView } from 'react-native';
import { useRouter, Link } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, spacing, radius, type, elevation } from '../lib/theme';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export default function ProfileScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('employee');
  const [fullName, setFullName] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => { loadProfile(); }, []);

  const loadProfile = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace('/'); return; }
    setEmail(session.user.email || '');
    const { data } = await supabase.from('profiles').select('full_name, role').eq('id', session.user.id).single();
    if (data) {
      setFullName(data.full_name || '');
      setRole(data.role || 'employee');
    }
    setLoading(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    const { data: { session } } = await supabase.auth.getSession();
    const { error } = await supabase.from('profiles').update({ full_name: fullName.trim() }).eq('id', session.user.id);
    setMessage(error ? 'Could not save. Check your connection and try again.' : 'Profile updated.');
    setSaving(false);
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace('/');
  };

  const handleDelete = async () => {
    if (!confirmingDelete) { setConfirmingDelete(true); return; }
    setDeleting(true);
    setMessage('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${SUPABASE_URL}/functions/v1/delete-my-account`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Delete failed');
      await supabase.auth.signOut();
      router.replace('/');
    } catch (e) {
      setMessage('Could not delete your account: ' + e.message);
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Link href="/" asChild>
          <TouchableOpacity style={styles.navButton}>
            <Text style={styles.navButtonText}>← Back</Text>
          </TouchableOpacity>
        </Link>
        <Text style={styles.headerTitle}>Profile</Text>
        <View style={{ width: 80 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{(fullName || email || '?').charAt(0).toUpperCase()}</Text>
          </View>
          <Text style={styles.email}>{email}</Text>
          <View style={styles.roleBadge}>
            <Text style={styles.roleBadgeText}>{role.toUpperCase()}</Text>
          </View>

          <Text style={styles.label}>Full name</Text>
          <TextInput
            style={styles.input}
            value={fullName}
            onChangeText={setFullName}
            placeholder="Your name"
            placeholderTextColor={colors.inputPlaceholder}
          />

          {message ? <Text style={styles.message}>{message}</Text> : null}

          <TouchableOpacity style={styles.primaryButton} onPress={handleSave} disabled={saving}>
            {saving ? <ActivityIndicator color="#0A0E1A" /> : <Text style={styles.primaryButtonText}>Save Changes</Text>}
          </TouchableOpacity>

          <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
            <Text style={styles.signOutButtonText}>Sign Out</Text>
          </TouchableOpacity>

          <View style={styles.dangerZone}>
            <Text style={styles.dangerTitle}>Danger zone</Text>
            <Text style={styles.dangerText}>
              {confirmingDelete
                ? 'This permanently deletes your account and profile data. Tap again to confirm.'
                : 'Delete your NorthShift account and all profile data.'}
            </Text>
            <TouchableOpacity
              style={[styles.deleteButton, confirmingDelete && styles.deleteButtonArmed]}
              onPress={handleDelete}
              disabled={deleting}
            >
              {deleting
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.deleteButtonText}>{confirmingDelete ? 'Tap again to confirm delete' : 'Delete My Account'}</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingContainer: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  headerTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  navButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.sm },
  navButtonText: { color: colors.textPrimary, fontWeight: '600', fontSize: 13 },
  content: { padding: spacing.lg, alignItems: 'center' },
  card: { width: '100%', maxWidth: 400, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.xl, alignItems: 'center', ...elevation.card },
  avatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  avatarText: { fontSize: 28, fontWeight: '700', color: colors.accent },
  email: { fontSize: 15, color: colors.textPrimary, fontWeight: '600' },
  roleBadge: { marginTop: spacing.sm, marginBottom: spacing.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.pill, paddingVertical: 4, paddingHorizontal: 12 },
  roleBadgeText: { ...type.label, color: colors.accent },
  label: { ...type.label, color: colors.textSecondary, marginBottom: spacing.xs, alignSelf: 'flex-start' },
  input: { width: '100%', backgroundColor: colors.inputBackground, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: radius.md, padding: spacing.md, fontSize: 16, color: colors.textPrimary, marginBottom: spacing.md },
  message: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.sm },
  primaryButton: { width: '100%', backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: spacing.md, alignItems: 'center', marginTop: spacing.sm },
  primaryButtonText: { color: '#0A0E1A', fontSize: 15, fontWeight: '700' },
  signOutButton: { marginTop: spacing.md, padding: spacing.sm, alignItems: 'center' },
  signOutButtonText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  dangerZone: { width: '100%', marginTop: spacing.xl, paddingTop: spacing.lg, borderTopWidth: 1, borderTopColor: colors.surfaceBorder, alignItems: 'center' },
  dangerTitle: { fontSize: 14, fontWeight: '700', color: colors.danger, marginBottom: spacing.xs },
  dangerText: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.md },
  deleteButton: { width: '100%', borderWidth: 1, borderColor: colors.danger, borderRadius: radius.md, paddingVertical: spacing.md, alignItems: 'center' },
  deleteButtonArmed: { backgroundColor: colors.danger },
  deleteButtonText: { color: colors.danger, fontSize: 14, fontWeight: '700' },
});
