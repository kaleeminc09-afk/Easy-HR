import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, spacing, radius, buttons } from '../lib/theme';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;

// First-run onboarding: the user first picks which way they are joining.
// Owners pick "setting up a business" (business -> worksite -> done).
// Invited employees pick "I was invited" and are told to open the invite
// link from their email — they never create a business here. A signed-in
// user who already has a business never sees this screen (home redirects
// only when business_id is null, and this screen redirects back if one
// appears). Invited employees already carry a business_id from the
// invite, so they skip this too.
export default function OnboardingScreen() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [step, setStep] = useState('choose');
  const [businessName, setBusinessName] = useState('');
  const [businessId, setBusinessId] = useState(null);
  const [accountNumber, setAccountNumber] = useState('');
  const [siteName, setSiteName] = useState('');
  const [radius, setRadius] = useState('100');
  const [address, setAddress] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { router.replace('/'); return; }
      const { data } = await supabase.from('profiles').select('business_id').eq('id', session.user.id).single();
      if (data?.business_id) { router.replace('/'); return; }
      setChecking(false);
    })();
  }, []);

  const createBusiness = async () => {
    const name = businessName.trim();
    if (!name) { setMessage('Enter a business name.'); return; }
    setSaving(true);
    setMessage('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${SUPABASE_URL}/functions/v1/create-business`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_name: name }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage(out.error || 'Could not create the business. Try again.'); return; }
      setBusinessId(out.business_id);
      setAccountNumber(out.account_number || '');
      setStep('worksite');
    } catch {
      setMessage('Could not create the business. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const useCurrentLocation = async () => {
    setLocating(true);
    setMessage('');
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setMessage('Location permission was not granted — enter the coordinates manually below.');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({});
      setLat(String(pos.coords.latitude));
      setLng(String(pos.coords.longitude));
    } catch {
      setMessage('Could not read your location — enter the coordinates manually below.');
    } finally {
      setLocating(false);
    }
  };

  const saveWorksite = async () => {
    if (!siteName.trim()) { setMessage('Enter a location name.'); return; }
    const la = parseFloat(lat);
    const lo = parseFloat(lng);
    if (Number.isNaN(la) || Number.isNaN(lo)) {
      setMessage('A location needs coordinates — tap "Use my current location" or enter them below.');
      return;
    }
    const rad = radius.trim() === '' ? null : parseInt(radius.trim(), 10);
    if (rad !== null && (Number.isNaN(rad) || rad < 0)) { setMessage('Radius must be a whole number of metres, or blank for no limit.'); return; }
    setSaving(true);
    setMessage('');
    const { error } = await supabase.from('worksites').insert([{
      name: siteName.trim(),
      latitude: la,
      longitude: lo,
      radius_meters: rad,
      address: address.trim() || null,
      business_id: businessId,
    }]);
    setSaving(false);
    if (error) {
      setMessage('Could not save the location — the database update may not have run yet. ' + error.message);
      return;
    }
    setStep('done');
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    router.replace('/');
  };

  if (checking) {
    return (<SafeAreaView style={styles.container}><ActivityIndicator color={colors.primary} /></SafeAreaView>);
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        {step === 'choose' && (<>
          <Text style={styles.title}>Welcome to NorthShift</Text>
          <Text style={styles.body}>How are you joining?</Text>
          <TouchableOpacity style={buttons.primary} onPress={() => setStep('business')}>
            <Text style={buttons.primaryText}>I&apos;m setting up a business</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => setStep('invited')}>
            <Text style={styles.secondaryButtonText}>I was invited to join a business</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={signOut}><Text style={styles.auxLink}>Sign out</Text></TouchableOpacity>
        </>)}
        {step === 'invited' && (<>
          <Text style={styles.title}>You were invited</Text>
          <Text style={styles.body}>Your manager sent you an invite link by email. Open that link — it connects you to their business and lets you set your password. There is no business to set up here.</Text>
          <Text style={styles.body}>No link yet? Ask your manager to send it from Manage Users in their app. Once it arrives, open it on this device.</Text>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => setStep('choose')}>
            <Text style={styles.secondaryButtonText}>← Back</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={signOut}><Text style={styles.auxLink}>Sign out</Text></TouchableOpacity>
        </>)}
        {step === 'business' && (<>
          <Text style={styles.title}>Set up your business</Text>
          <Text style={styles.body}>This takes a minute. First, your company name — it shows on your team&apos;s screens and exports.</Text>
          <Text style={styles.label}>Business name</Text>
          <TextInput style={styles.input} placeholder="e.g. Maple Cleaning Co." placeholderTextColor={colors.inputPlaceholder} value={businessName} onChangeText={setBusinessName} autoCapitalize="words" />
          {message ? <Text style={styles.error}>{message}</Text> : null}
          <TouchableOpacity style={buttons.primary} onPress={createBusiness} disabled={saving}>
            {saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={buttons.primaryText}>Create business</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setStep('choose')}><Text style={styles.auxLink}>← I was invited instead</Text></TouchableOpacity>
          <TouchableOpacity onPress={signOut}><Text style={styles.auxLink}>Sign out</Text></TouchableOpacity>
        </>)}
        {step === 'worksite' && (<>
          <Text style={styles.title}>Add your first location</Text>
          <Text style={styles.body}>Staff scan this location&apos;s QR code to clock in. If you set a radius, they must be inside it.</Text>
          <Text style={styles.label}>Location name</Text>
          <TextInput style={styles.input} placeholder="e.g. Main Warehouse" placeholderTextColor={colors.inputPlaceholder} value={siteName} onChangeText={setSiteName} autoCapitalize="words" />
          <Text style={styles.label}>Address (optional)</Text>
          <TextInput style={styles.input} placeholder="Street address" placeholderTextColor={colors.inputPlaceholder} value={address} onChangeText={setAddress} />
          <Text style={styles.label}>Radius in metres (blank = no limit)</Text>
          <TextInput style={styles.input} placeholder="100" placeholderTextColor={colors.inputPlaceholder} value={radius} onChangeText={setRadius} keyboardType="numbers-and-punctuation" />
          <TouchableOpacity style={styles.secondaryButton} onPress={useCurrentLocation} disabled={locating}>
            {locating ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.secondaryButtonText}>Use my current location</Text>}
          </TouchableOpacity>
          <Text style={styles.label}>Latitude</Text>
          <TextInput style={styles.input} placeholder="43.6532" placeholderTextColor={colors.inputPlaceholder} value={lat} onChangeText={setLat} keyboardType="numbers-and-punctuation" />
          <Text style={styles.label}>Longitude</Text>
          <TextInput style={styles.input} placeholder="-79.3832" placeholderTextColor={colors.inputPlaceholder} value={lng} onChangeText={setLng} keyboardType="numbers-and-punctuation" />
          {message ? <Text style={styles.error}>{message}</Text> : null}
          <TouchableOpacity style={buttons.primary} onPress={saveWorksite} disabled={saving}>
            {saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={buttons.primaryText}>Save location</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => setStep('done')}>
            <Text style={styles.secondaryButtonText}>I&apos;ll add locations later</Text>
          </TouchableOpacity>
        </>)}
        {step === 'done' && (<>
          <Text style={styles.title}>You&apos;re set up</Text>
          <Text style={styles.body}>Your business is ready{accountNumber ? ` (account ${accountNumber})` : ''}. Invite your team and they&apos;ll appear on your board as they join.</Text>
          <TouchableOpacity style={buttons.primary} onPress={() => router.push('/users')}>
            <Text style={buttons.primaryText}>Invite your team</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => router.replace('/')}>
            <Text style={styles.secondaryButtonText}>Go to home</Text>
          </TouchableOpacity>
        </>)}
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
  error: { color: colors.danger, fontSize: 13, fontFamily: fontFamily.regular, textAlign: 'center', marginBottom: spacing.sm },
  note: { fontSize: 13, fontFamily: fontFamily.regular, color: colors.text, marginTop: spacing.md, textAlign: 'center' },
  auxLink: { color: colors.primary, fontSize: 13, fontFamily: fontFamily.medium, alignSelf: 'center', marginTop: spacing.md, minHeight: 44, textAlignVertical: 'center' },
  secondaryButton: { borderWidth: 1, borderColor: colors.primary, borderRadius: radius.md, padding: spacing.md, alignItems: 'center', marginTop: spacing.md, minHeight: 56, justifyContent: 'center' },
  secondaryButtonText: { color: colors.primary, fontSize: 16, fontFamily: fontFamily.semibold },
});
