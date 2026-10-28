import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Link } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, spacing, radius, type, elevation, buttons } from '../lib/theme';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

const PROFILE_FIELDS = [
  'full_name', 'first_name', 'last_name', 'role', 'business_id',
  'phone', 'date_of_birth', 'address_line', 'city', 'province', 'postal_code',
  'emergency_contact_1_name', 'emergency_contact_1_relationship', 'emergency_contact_1_phone',
  'emergency_contact_2_name', 'emergency_contact_2_relationship', 'emergency_contact_2_phone',
  'job_title', 'department', 'start_date', 'employment_type', 'primary_worksite_id', 'employee_number',
].join(', ');

function InfoRow({ label, value }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value || '—'}</Text>
    </View>
  );
}

function Field({ label, ...props }) {
  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={styles.input} placeholderTextColor={colors.inputPlaceholder} {...props} />
    </>
  );
}

export default function ProfileScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('employee');
  const [businessName, setBusinessName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');

  // Personal (employee-editable)
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [dob, setDob] = useState('');
  const [addressLine, setAddressLine] = useState('');
  const [city, setCity] = useState('');
  const [province, setProvince] = useState('');
  const [postalCode, setPostalCode] = useState('');

  // Emergency contacts (employee-editable)
  const [ec1Name, setEc1Name] = useState('');
  const [ec1Relationship, setEc1Relationship] = useState('');
  const [ec1Phone, setEc1Phone] = useState('');
  const [ec2Name, setEc2Name] = useState('');
  const [ec2Relationship, setEc2Relationship] = useState('');
  const [ec2Phone, setEc2Phone] = useState('');

  // Employment (manager-set, read-only here)
  const [jobTitle, setJobTitle] = useState('');
  const [department, setDepartment] = useState('');
  const [startDate, setStartDate] = useState('');
  const [employmentType, setEmploymentType] = useState('');
  const [employeeNumber, setEmployeeNumber] = useState('');
  const [worksiteName, setWorksiteName] = useState('');

  const [saving, setSaving] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMessage, setPwMessage] = useState('');
  const [message, setMessage] = useState('');
  const [setupMissing, setSetupMissing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => { loadProfile(); }, []);

  const loadProfile = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace('/'); return; }
    setEmail(session.user.email || '');
    const { data, error } = await supabase.from('profiles').select(PROFILE_FIELDS).eq('id', session.user.id).single();
    if (error) { setSetupMissing(true); setLoading(false); return; }
    if (data) {
      // Prefill first/last from full_name for accounts created before this update
      let fn = data.first_name || '';
      let ln = data.last_name || '';
      if (!fn && !ln && data.full_name) {
        const parts = data.full_name.trim().split(/\s+/);
        fn = parts[0] || '';
        ln = parts.slice(1).join(' ');
      }
      setFirstName(fn);
      setLastName(ln);
      setRole(data.role || 'employee');
      setPhone(data.phone || '');
      setDob(data.date_of_birth || '');
      setAddressLine(data.address_line || '');
      setCity(data.city || '');
      setProvince(data.province || '');
      setPostalCode(data.postal_code || '');
      setEc1Name(data.emergency_contact_1_name || '');
      setEc1Relationship(data.emergency_contact_1_relationship || '');
      setEc1Phone(data.emergency_contact_1_phone || '');
      setEc2Name(data.emergency_contact_2_name || '');
      setEc2Relationship(data.emergency_contact_2_relationship || '');
      setEc2Phone(data.emergency_contact_2_phone || '');
      setJobTitle(data.job_title || '');
      setDepartment(data.department || '');
      setStartDate(data.start_date || '');
      setEmploymentType(data.employment_type || '');
      setEmployeeNumber(data.employee_number || '');
      if (data.primary_worksite_id) {
        const { data: ws } = await supabase.from('worksites').select('name').eq('id', data.primary_worksite_id).maybeSingle();
        if (ws) setWorksiteName(ws.name || '');
      }
      if (data.business_id) {
        const { data: biz } = await supabase.from('businesses').select('business_name, account_number').eq('id', data.business_id).single();
        if (biz) { setBusinessName(biz.business_name || ''); setAccountNumber(biz.account_number || ''); }
      }
    }
    setLoading(false);
  };

  const handleSave = async () => {
    if (!firstName.trim() || !lastName.trim()) {
      setMessage('First and last name are required.');
      return;
    }
    if (dob.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(dob.trim())) {
      setMessage('Date of birth must be YYYY-MM-DD.');
      return;
    }
    setSaving(true);
    setMessage('');
    const { data: { session } } = await supabase.auth.getSession();
    const { error } = await supabase.from('profiles').update({
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      full_name: `${firstName.trim()} ${lastName.trim()}`,
      phone: phone.trim() || null,
      date_of_birth: dob.trim() || null,
      address_line: addressLine.trim() || null,
      city: city.trim() || null,
      province: province.trim() || null,
      postal_code: postalCode.trim() || null,
      emergency_contact_1_name: ec1Name.trim() || null,
      emergency_contact_1_relationship: ec1Relationship.trim() || null,
      emergency_contact_1_phone: ec1Phone.trim() || null,
      emergency_contact_2_name: ec2Name.trim() || null,
      emergency_contact_2_relationship: ec2Relationship.trim() || null,
      emergency_contact_2_phone: ec2Phone.trim() || null,
    }).eq('id', session.user.id);
    setMessage(error ? 'Could not save. Check your connection and try again.' : 'Profile updated.');
    setSaving(false);
  };

  // Change password for the signed-in account (e.g. after a business
  // handover). Supabase keeps this session signed in; on a handover,
  // also sign out on any device the previous owner used.
  const handleChangePassword = async () => {
    if (newPassword.length < 8) { setPwMessage('Use at least 8 characters for the new password.'); return; }
    if (newPassword !== confirmPassword) { setPwMessage('The two passwords do not match.'); return; }
    setPwSaving(true); setPwMessage('');
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      setPwMessage('Could not change the password. Please try again.');
    } else {
      setPwMessage('Password changed. Use the new password next time you sign in.');
      setNewPassword(''); setConfirmPassword('');
    }
    setPwSaving(false);
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

  const displayName = `${firstName} ${lastName}`.trim();

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
            <Text style={styles.avatarText}>{(displayName || email || '?').charAt(0).toUpperCase()}</Text>
          </View>
          <Text style={styles.email}>{email}</Text>
          <View style={styles.roleBadge}>
            <Text style={styles.roleBadgeText}>{role.toUpperCase()}</Text>
          </View>
          {businessName ? (
            <View style={styles.bizBox}>
              <Text style={styles.bizName}>{businessName}</Text>
              {accountNumber ? <Text style={styles.bizAcct}>Acct #{accountNumber}</Text> : null}
            </View>
          ) : null}
        </View>

        {setupMissing ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Profile fields not set up yet</Text>
            <Text style={styles.sectionNote}>The latest database update has not been applied to this workspace yet. Your manager can run it from the NorthShift setup files.</Text>
          </View>
        ) : (
          <>
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Personal</Text>
              <Field label="First name" value={firstName} onChangeText={setFirstName} placeholder="First name" autoCapitalize="words" />
              <Field label="Last name" value={lastName} onChangeText={setLastName} placeholder="Last name" autoCapitalize="words" />
              <Field label="Phone" value={phone} onChangeText={setPhone} placeholder="(416) 555-0100" keyboardType="phone-pad" />
              <Field label="Date of birth" value={dob} onChangeText={setDob} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" />
              <Field label="Street address" value={addressLine} onChangeText={setAddressLine} placeholder="123 Main St, Unit 4" autoCapitalize="words" />
              <Field label="City" value={city} onChangeText={setCity} placeholder="Toronto" autoCapitalize="words" />
              <Field label="Province" value={province} onChangeText={setProvince} placeholder="Ontario" autoCapitalize="words" />
              <Field label="Postal code" value={postalCode} onChangeText={setPostalCode} placeholder="M1B 2K3" autoCapitalize="characters" />
            </View>

            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Emergency Contacts</Text>
              <Text style={styles.sectionNote}>Who your manager should call in an emergency. Contact 1 is the primary contact.</Text>
              <Field label="Contact 1 — name" value={ec1Name} onChangeText={setEc1Name} placeholder="Full name" autoCapitalize="words" />
              <Field label="Contact 1 — relationship" value={ec1Relationship} onChangeText={setEc1Relationship} placeholder="Spouse, parent, sibling..." autoCapitalize="words" />
              <Field label="Contact 1 — phone" value={ec1Phone} onChangeText={setEc1Phone} placeholder="(416) 555-0100" keyboardType="phone-pad" />
              <Field label="Contact 2 — name (optional)" value={ec2Name} onChangeText={setEc2Name} placeholder="Full name" autoCapitalize="words" />
              <Field label="Contact 2 — relationship" value={ec2Relationship} onChangeText={setEc2Relationship} placeholder="Spouse, parent, sibling..." autoCapitalize="words" />
              <Field label="Contact 2 — phone" value={ec2Phone} onChangeText={setEc2Phone} placeholder="(416) 555-0100" keyboardType="phone-pad" />
            </View>

            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Employment</Text>
              <Text style={styles.sectionNote}>Set by your manager — contact them if anything here looks wrong.</Text>
              <InfoRow label="Job title" value={jobTitle} />
              <InfoRow label="Department" value={department} />
              <InfoRow label="Start date" value={startDate ? new Date(startDate + 'T12:00:00').toLocaleDateString() : ''} />
              <InfoRow label="Employment type" value={employmentType} />
              <InfoRow label="Primary worksite" value={worksiteName} />
              <InfoRow label="Employee #" value={employeeNumber} />
            </View>

            <View style={styles.sectionCard}>
              {message ? <Text style={styles.message}>{message}</Text> : null}
              <TouchableOpacity style={styles.primaryButton} onPress={handleSave} disabled={saving}>
                {saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Save Changes</Text>}
              </TouchableOpacity>
              <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
                <Text style={styles.signOutButtonText}>Sign Out</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Change password</Text>
          <Text style={styles.sectionNote}>Use this after a business handover so only the new owner can sign in. This session stays signed in — sign out on any device the previous owner used.</Text>
          {pwMessage ? <Text style={styles.message}>{pwMessage}</Text> : null}
          <Field label="New password" value={newPassword} onChangeText={setNewPassword} placeholder="At least 8 characters" secureTextEntry autoCapitalize="none" />
          <Field label="Confirm new password" value={confirmPassword} onChangeText={setConfirmPassword} placeholder="Repeat the new password" secureTextEntry autoCapitalize="none" />
          <TouchableOpacity style={styles.primaryButton} onPress={handleChangePassword} disabled={pwSaving}>
            {pwSaving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Change Password</Text>}
          </TouchableOpacity>
        </View>

        <View style={styles.sectionCard}>
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
                : <Text style={confirmingDelete ? styles.deleteButtonArmedText : styles.deleteButtonText}>{confirmingDelete ? 'Tap again to confirm delete' : 'Delete My Account'}</Text>}
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
  headerTitle: { fontSize: 17, fontFamily: fontFamily.bold, color: colors.textPrimary },
  navButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.sm },
  navButtonText: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 13 },
  content: { padding: spacing.lg, alignItems: 'center', gap: spacing.lg },
  card: { width: '100%', maxWidth: 400, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.xl, alignItems: 'center', ...elevation.card },
  sectionCard: { width: '100%', maxWidth: 400, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.xl, ...elevation.card },
  sectionTitle: { fontSize: 16, fontFamily: fontFamily.bold, color: colors.textPrimary, marginBottom: spacing.md },
  sectionNote: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary, marginBottom: spacing.md, marginTop: -spacing.sm },
  avatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentBorder, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  avatarText: { fontSize: 28, fontFamily: fontFamily.bold, color: colors.accent },
  email: { fontSize: 15, color: colors.textPrimary, fontFamily: fontFamily.semibold },
  roleBadge: { marginTop: spacing.sm, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.pill, paddingVertical: 4, paddingHorizontal: 12 },
  roleBadgeText: { ...type.label, color: colors.accent },
  bizBox: { alignItems: 'center', marginTop: spacing.lg },
  bizName: { fontSize: 15, fontFamily: fontFamily.semibold, color: colors.textPrimary },
  bizAcct: { fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  label: { ...type.label, color: colors.textSecondary, marginBottom: spacing.xs },
  input: { fontFamily: fontFamily.regular, width: '100%', backgroundColor: colors.inputBackground, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: radius.md, padding: spacing.md, fontSize: 16, color: colors.textPrimary, marginBottom: spacing.md },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  infoLabel: { ...type.label, color: colors.textSecondary },
  infoValue: { fontFamily: fontFamily.semibold, fontSize: 14, color: colors.textPrimary },
  message: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.sm },
  primaryButton: { ...buttons.primary },
  primaryButtonText: { ...buttons.primaryText },
  signOutButton: { marginTop: spacing.md, padding: spacing.sm, alignItems: 'center' },
  signOutButtonText: { color: colors.textSecondary, fontSize: 14, fontFamily: fontFamily.semibold },
  dangerZone: { alignItems: 'center' },
  dangerTitle: { fontSize: 14, fontFamily: fontFamily.bold, color: colors.danger, marginBottom: spacing.xs },
  dangerText: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.md },
  deleteButton: { ...buttons.danger },
  deleteButtonArmed: { backgroundColor: colors.danger },
  deleteButtonText: { ...buttons.dangerText },
  deleteButtonArmedText: { ...buttons.dangerArmedText },
});
