import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ActivityIndicator, ScrollView, Platform } from 'react-native';
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
  const [notice, setNotice] = useState('');

  // Web-only: refs to each rendered QR (react-native-svg Svg instance).
  // On web, Svg.toDataURL(cb, { width, height }) returns the QR as a
  // base64 PNG (no data: prefix). Phone never touches these refs.
  const qrRefs = useRef({});
  const isWeb = Platform.OS === 'web';

  const [myBusinessId, setMyBusinessId] = useState(null);
  const loadSites = async () => {
    const { data, error } = await supabase.from('worksites').select('id, name, business_id, address').order('name');
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

  const escHtml = (text) => String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fileSlug = (site) => (site.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || String(site.id).slice(0, 8);

  // Resolve a site's QR to a base64 PNG via the rendered Svg ref.
  // Returns false (with a notice) when the export is unavailable.
  const qrPngBase64 = (site, cb) => {
    const svg = qrRefs.current[site.id];
    if (!svg || typeof svg.toDataURL !== 'function') {
      setNotice('This browser could not export the QR code — take a screenshot of the code instead.');
      return false;
    }
    svg.toDataURL((base64) => cb(base64), { width: 600, height: 600 });
    return true;
  };

  // Web-only: download the QR as a PNG the manager can send on
  // WhatsApp or email. Staff scan the picture with the NorthShift app.
  const downloadQr = (site) => {
    if (typeof document === 'undefined') return;
    setNotice('');
    qrPngBase64(site, (base64) => {
      const link = document.createElement('a');
      link.href = `data:image/png;base64,${base64}`;
      link.download = `northshift-qr-${fileSlug(site)}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setNotice(`QR code for ${site.name} downloaded — send it to staff on WhatsApp or email.`);
    });
  };

  // Web-only: print a clean sheet for ONE worksite — big QR, name,
  // address, and the scan instruction. The print window holds only
  // that sheet, never the app screen.
  const printQr = (site) => {
    if (typeof window === 'undefined') return;
    setNotice('');
    qrPngBase64(site, (base64) => {
      const win = window.open('', '_blank', 'width=700,height=850');
      if (!win) {
        setNotice('Pop-up blocked — allow pop-ups for this site, then try Print again.');
        return;
      }
      const addressLine = site.address
        ? `<p class="addr">${escHtml(site.address)}</p>`
        : '';
      win.document.write(
        '<!doctype html><html><head><title>NorthShift QR &mdash; ' + escHtml(site.name) + '</title>' +
        '<style>body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#1c1917}' +
        '.sheet{max-width:560px;margin:48px auto;padding:32px;text-align:center}' +
        '.brand{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#0F766E;font-weight:700}' +
        'img{width:440px;height:440px;margin:28px 0 8px}' +
        'h1{font-size:30px;margin:8px 0}' +
        '.addr{font-size:17px;color:#57534e;margin:4px 0}' +
        '.hint{font-size:17px;margin-top:20px}</style></head><body>' +
        '<div class="sheet"><div class="brand">NorthShift</div>' +
        '<img src="data:image/png;base64,' + base64 + '" alt="Worksite QR code" />' +
        '<h1>' + escHtml(site.name) + '</h1>' + addressLine +
        '<p class="hint">Scan with the NorthShift app to clock in / out</p></div>' +
        '<script>window.onload = function () { window.focus(); window.print(); };' +
        'window.onafterprint = function () { window.close(); };</script>' +
        '</body></html>'
      );
      win.document.close();
      setNotice(`Print sheet opened for ${site.name} — use your browser's print dialog.`);
    });
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
          {notice ? <Text style={styles.noticeText}>{notice}</Text> : null}
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
                <QRCode value={qrPayload(site.id)} size={210} getRef={(c) => { if (c) qrRefs.current[site.id] = c; }} />
              </View>
              <Text style={styles.siteName}>{site.name}</Text>
              <Text style={styles.siteHint}>Scan with NorthShift to clock in / out</Text>
              {isWeb && (
                <View style={styles.webActions}>
                  <TouchableOpacity style={styles.webActionButton} onPress={() => printQr(site)}>
                    <Text style={styles.webActionButtonText}>Print</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.webActionButton, styles.webActionButtonSecond]} onPress={() => downloadQr(site)}>
                    <Text style={styles.webActionButtonText}>Download</Text>
                  </TouchableOpacity>
                </View>
              )}
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
  noticeText: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 14, textAlign: 'center', marginBottom: spacing.md },
  webActions: { flexDirection: 'row', marginTop: spacing.md, alignSelf: 'stretch' },
  webActionButton: { flex: 1, borderWidth: 1, borderColor: colors.accent, borderRadius: radius.md, padding: spacing.md, alignItems: 'center', minHeight: 52, justifyContent: 'center' },
  webActionButtonSecond: { marginLeft: spacing.sm },
  webActionButtonText: { color: colors.accent, fontFamily: fontFamily.semibold, fontSize: 15 },
  claimButtonText: { color: colors.accent, fontFamily: fontFamily.semibold, fontSize: 15 },
});
