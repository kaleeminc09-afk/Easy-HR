import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import * as Location from 'expo-location';
import { colors, spacing, radius, fontFamily } from '../lib/theme';

export const qrPayload = (worksiteId) => `northshift-site:${worksiteId}`;

export default function WorksiteQrScreen() {
  const router = useRouter();

  // Back means back: return to the screen we came from, not a
  // role-based destination. A deep link with no history falls back
  // to the employee home.
  const handleBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [canAdd, setCanAdd] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [siteName, setSiteName] = useState('');
  const [radius, setRadius] = useState('100');
  const [address, setAddress] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formMessage, setFormMessage] = useState('');

  const [myBusinessId, setMyBusinessId] = useState(null);
  const loadSites = async () => {
    const { data, error } = await supabase.from('worksites').select('id, name, business_id').order('name');
    if (error) setError(error.message);
    else setSites(data || []);
    setLoading(false);
  };

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        const { data: prof } = await supabase.from('profiles').select('role, business_id').eq('id', session.user.id).single();
        setCanAdd(prof?.role === 'manager' || prof?.role === 'admin');
        setMyBusinessId(prof?.business_id || null);
      }
      await loadSites();
    })();
  }, []);

  const useCurrentLocation = async () => {
    setLocating(true);
    setFormMessage('');
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { setFormMessage('Location permission was not granted — enter the coordinates manually.'); return; }
      const pos = await Location.getCurrentPositionAsync({});
      setLat(String(pos.coords.latitude));
      setLng(String(pos.coords.longitude));
    } catch {
      setFormMessage('Could not read your location — enter the coordinates manually.');
    } finally {
      setLocating(false);
    }
  };

  const saveWorksite = async () => {
    if (!siteName.trim()) { setFormMessage('Enter a location name.'); return; }
    const la = parseFloat(lat);
    const lo = parseFloat(lng);
    if (Number.isNaN(la) || Number.isNaN(lo)) { setFormMessage('A location needs coordinates — use your current location or enter them.'); return; }
    const rad = radius.trim() === '' ? null : parseInt(radius.trim(), 10);
    if (rad !== null && (Number.isNaN(rad) || rad < 0)) { setFormMessage('Radius must be a whole number of metres, or blank for no limit.'); return; }
    setSaving(true);
    setFormMessage('');
    if (!myBusinessId) { setFormMessage('Your account has no business yet — complete onboarding first.'); return; }
    const { error } = await supabase.from('worksites').insert([{
      name: siteName.trim(), latitude: la, longitude: lo, radius_meters: rad, address: address.trim() || null, business_id: myBusinessId,
    }]);
    setSaving(false);
    if (error) { setFormMessage('Could not save the location — the database update may not have run yet. ' + error.message); return; }
    setSiteName(''); setRadius('100'); setAddress(''); setLat(''); setLng(''); setShowForm(false);
    await loadSites();
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={handleBack}>
          <Text style={styles.backButtonText}>&larr; Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Worksite QR Codes</Text>
        <View style={styles.headerSpacer} />
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.loadingText}>Loading worksites...</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.intro}>Print the code for each worksite and post it at the entrance. Staff scan it to clock in and out. If a worksite has a radius set, they must be inside it.</Text>
          {canAdd && !showForm && (
            <TouchableOpacity style={styles.addButton} onPress={() => setShowForm(true)}>
              <Text style={styles.addButtonText}>Add location</Text>
            </TouchableOpacity>
          )}
          {canAdd && showForm && (
            <View style={styles.formCard}>
              <Text style={styles.formLabel}>Location name</Text>
              <TextInput style={styles.formInput} placeholder="e.g. Main Warehouse" placeholderTextColor={colors.textSecondary} value={siteName} onChangeText={setSiteName} autoCapitalize="words" />
              <Text style={styles.formLabel}>Address (optional)</Text>
              <TextInput style={styles.formInput} placeholder="Street address" placeholderTextColor={colors.textSecondary} value={address} onChangeText={setAddress} />
              <Text style={styles.formLabel}>Radius in metres (blank = no limit)</Text>
              <TextInput style={styles.formInput} placeholder="100" placeholderTextColor={colors.textSecondary} value={radius} onChangeText={setRadius} keyboardType="numbers-and-punctuation" />
              <TouchableOpacity style={styles.formSecondary} onPress={useCurrentLocation} disabled={locating}>
                {locating ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.formSecondaryText}>Use my current location</Text>}
              </TouchableOpacity>
              <Text style={styles.formLabel}>Latitude</Text>
              <TextInput style={styles.formInput} placeholder="43.6532" placeholderTextColor={colors.textSecondary} value={lat} onChangeText={setLat} keyboardType="numbers-and-punctuation" />
              <Text style={styles.formLabel}>Longitude</Text>
              <TextInput style={styles.formInput} placeholder="-79.3832" placeholderTextColor={colors.textSecondary} value={lng} onChangeText={setLng} keyboardType="numbers-and-punctuation" />
              {formMessage ? <Text style={styles.errorText}>{formMessage}</Text> : null}
              <TouchableOpacity style={styles.addButton} onPress={saveWorksite} disabled={saving}>
                {saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.addButtonText}>Save location</Text>}
              </TouchableOpacity>
              <TouchableOpacity style={styles.formSecondary} onPress={() => setShowForm(false)}>
                <Text style={styles.formSecondaryText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}
          {sites.length === 0 && <Text style={styles.emptyText}>No worksites configured yet.</Text>}
          {sites.filter((site) => !site.business_id || site.business_id === myBusinessId).map((site) => (
            <View key={site.id} style={styles.card}>
              <View style={styles.qrWrap}>
                <QRCode value={qrPayload(site.id)} size={210} />
              </View>
              <Text style={styles.siteName}>{site.name}</Text>
              <Text style={styles.siteHint}>Scan with NorthShift to clock in / out</Text>
              {canAdd && !site.business_id && (
                <TouchableOpacity style={styles.claimButton} onPress={async () => {
                  const { error } = await supabase.from('worksites').update({ business_id: myBusinessId }).eq('id', site.id);
                  if (error) setError(error.message);
                  else await loadSites();
                }}>
                  <Text style={styles.claimButtonText}>Claim for my business</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.lg },
  loadingText: { marginTop: spacing.sm, color: colors.textSecondary, fontFamily: fontFamily.regular },
  errorText: { color: colors.danger, fontFamily: fontFamily.regular, fontSize: 14, textAlign: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  backButton: { paddingVertical: spacing.sm, paddingRight: spacing.md, minHeight: 44, justifyContent: 'center' },
  backButtonText: { color: colors.accent, fontFamily: fontFamily.semibold, fontSize: 15 },
  title: { color: colors.textPrimary, fontFamily: fontFamily.bold, fontSize: 17 },
  headerSpacer: { width: 60 },
  content: { padding: spacing.lg, flexGrow: 1 },
  intro: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 14, marginBottom: spacing.lg },
  emptyText: { color: colors.textSecondary, fontFamily: fontFamily.semibold, fontSize: 15, textAlign: 'center', marginTop: spacing.xl },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, padding: spacing.xl, alignItems: 'center', marginBottom: spacing.lg },
  qrWrap: { backgroundColor: '#FFFFFF', padding: spacing.md, borderRadius: radius.md, marginBottom: spacing.md },
  siteName: { color: colors.textPrimary, fontFamily: fontFamily.bold, fontSize: 19, textAlign: 'center' },
  siteHint: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 13, marginTop: spacing.xs, textAlign: 'center' },
  addButton: { backgroundColor: colors.accent, borderRadius: radius.md, padding: spacing.md, alignItems: 'center', marginBottom: spacing.lg, minHeight: 56, justifyContent: 'center' },
  addButtonText: { color: '#FFFFFF', fontFamily: fontFamily.semibold, fontSize: 16 },
  formCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, padding: spacing.lg, marginBottom: spacing.lg },
  formLabel: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 13, marginBottom: spacing.xs },
  formInput: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, padding: spacing.md, fontSize: 15, fontFamily: fontFamily.regular, color: colors.textPrimary, marginBottom: spacing.md },
  formSecondary: { borderWidth: 1, borderColor: colors.accent, borderRadius: radius.md, padding: spacing.md, alignItems: 'center', marginBottom: spacing.md, minHeight: 52, justifyContent: 'center' },
  formSecondaryText: { color: colors.accent, fontFamily: fontFamily.semibold, fontSize: 15 },
  claimButton: { borderWidth: 1, borderColor: colors.accent, borderRadius: radius.md, padding: spacing.md, alignItems: 'center', marginTop: spacing.md, minHeight: 52, justifyContent: 'center', alignSelf: 'stretch' },
  claimButtonText: { color: colors.accent, fontFamily: fontFamily.semibold, fontSize: 15 },
});
