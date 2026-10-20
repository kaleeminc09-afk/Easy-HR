import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Link } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, spacing, radius, fontFamily, buttons } from '../lib/theme';

const QR_PREFIX = 'northshift-site:';

export function parseWorksiteQr(data) {
  if (typeof data !== 'string' || !data.startsWith(QR_PREFIX)) return null;
  const id = data.slice(QR_PREFIX.length).trim();
  return id.length > 0 ? id : null;
}

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const handledRef = useRef(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
      setAuthChecked(true);
    })();
  }, []);

  const reset = () => { handledRef.current = false; setResult(null); setBusy(false); };

  const handleScan = async ({ data }) => {
    if (handledRef.current) return;
    handledRef.current = true;
    const worksiteId = parseWorksiteQr(data);
    if (!worksiteId) {
      setResult({ ok: false, title: 'Not a NorthShift code', message: 'That QR code is not a worksite code. Point the camera at the code posted at your worksite.' });
      return;
    }
    setBusy(true);
    try {
      const { data: site, error: siteErr } = await supabase
        .from('worksites').select('id, name').eq('id', worksiteId).maybeSingle();
      if (siteErr || !site) throw new Error('That worksite could not be found. Ask your manager to reprint the code.');

      const { data: open } = await supabase
        .from('time_logs')
        .select('id, clock_in')
        .eq('user_id', session.user.id)
        .is('clock_out', null)
        .order('clock_in', { ascending: false })
        .limit(1);
      const openShift = open && open.length > 0 ? open[0] : null;

      if (openShift) {
        const now = new Date();
        const durationHours = (now.getTime() - new Date(openShift.clock_in).getTime()) / 3600000;
        let flag = 'Normal Shift';
        if (durationHours > 12) flag = '⚠️ Flagged: Excessive Duration (> 12 Hours)';
        else if (durationHours < 0.05) flag = '⚠️ Flagged: Unusually Short Shift (< 3 Mins)';
        await supabase.from('time_breaks')
          .update({ end_time: now.toISOString() })
          .eq('time_log_id', openShift.id)
          .is('end_time', null);
        const { error: outErr } = await supabase
          .from('time_logs')
          .update({ clock_out: now.toISOString(), ai_anomaly_flag: flag })
          .eq('id', openShift.id);
        if (outErr) throw new Error(outErr.message);
        setResult({ ok: true, title: 'Clocked out', message: `Shift ended at ${site.name}. ${flag === 'Normal Shift' ? 'See you next shift.' : flag}` });
      } else {
        const { error: inErr } = await supabase.from('time_logs').insert([{
          user_id: session.user.id,
          clock_in: new Date().toISOString(),
          ai_anomaly_flag: 'Normal Shift',
          worksite_id: site.id,
        }]);
        if (inErr) throw new Error(inErr.message);
        setResult({ ok: true, title: 'Clocked in', message: `You are on the clock at ${site.name}.` });
      }
    } catch (e) {
      setResult({ ok: false, title: 'Something went wrong', message: e.message || 'Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  if (!authChecked || !permission) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.loadingText}>Preparing camera...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.deniedTitle}>Sign in first</Text>
          <Text style={styles.deniedText}>You need to be signed in to clock in with a QR code.</Text>
          <Link href="/" asChild>
            <TouchableOpacity style={buttons.primary}>
              <Text style={buttons.primaryText}>Back to Sign In</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.deniedTitle}>Camera access needed</Text>
          <Text style={styles.deniedText}>NorthShift uses your camera only to scan the worksite QR code when you clock in or out.</Text>
          <TouchableOpacity style={buttons.primary} onPress={requestPermission}>
            <Text style={buttons.primaryText}>Allow Camera Access</Text>
          </TouchableOpacity>
          <Link href="/" asChild>
            <TouchableOpacity style={styles.backLink}>
              <Text style={styles.backLinkText}>Back</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </SafeAreaView>
    );
  }

  if (result) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <View style={[styles.resultCard, result.ok ? styles.resultOk : styles.resultBad]}>
            <Text style={styles.resultTitle}>{result.title}</Text>
            <Text style={styles.resultMessage}>{result.message}</Text>
          </View>
          <TouchableOpacity style={buttons.primary} onPress={reset}>
            <Text style={buttons.primaryText}>Scan Again</Text>
          </TouchableOpacity>
          <Link href="/" asChild>
            <TouchableOpacity style={styles.backLink}>
              <Text style={styles.backLinkText}>Back to Home</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Link href="/" asChild>
          <TouchableOpacity style={styles.backButton}>
            <Text style={styles.backButtonText}>&larr; Back</Text>
          </TouchableOpacity>
        </Link>
        <Text style={styles.title}>Scan to Clock In / Out</Text>
        <View style={styles.headerSpacer} />
      </View>
      <View style={styles.cameraWrap}>
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={busy ? undefined : handleScan}
        />
        <View style={styles.frame} pointerEvents="none" />
        {busy && (
          <View style={styles.busyOverlay}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={styles.busyText}>Recording your punch...</Text>
          </View>
        )}
      </View>
      <Text style={styles.hint}>Point at the worksite QR code. Scanning once clocks you in; scanning again clocks you out.</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.lg },
  loadingText: { marginTop: spacing.sm, color: colors.textSecondary, fontFamily: fontFamily.regular },
  deniedTitle: { color: colors.textPrimary, fontFamily: fontFamily.bold, fontSize: 20, marginBottom: spacing.sm, textAlign: 'center' },
  deniedText: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 15, marginBottom: spacing.lg, textAlign: 'center' },
  backLink: { marginTop: spacing.md, minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md },
  backLinkText: { color: colors.accent, fontFamily: fontFamily.semibold, fontSize: 15 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  backButton: { paddingVertical: spacing.sm, paddingRight: spacing.md, minHeight: 44, justifyContent: 'center' },
  backButtonText: { color: colors.accent, fontFamily: fontFamily.semibold, fontSize: 15 },
  title: { color: colors.textPrimary, fontFamily: fontFamily.bold, fontSize: 17 },
  headerSpacer: { width: 60 },
  cameraWrap: { flex: 1, position: 'relative', overflow: 'hidden' },
  frame: { position: 'absolute', top: '22%', left: '15%', right: '15%', aspectRatio: 1, borderWidth: 2, borderColor: colors.accent, borderRadius: radius.lg, backgroundColor: 'transparent' },
  busyOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(10, 14, 26, 0.75)', justifyContent: 'center', alignItems: 'center' },
  busyText: { marginTop: spacing.sm, color: colors.textPrimary, fontFamily: fontFamily.semibold },
  hint: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 14, textAlign: 'center', padding: spacing.lg },
  resultCard: { width: '100%', borderWidth: 1, borderRadius: radius.md, padding: spacing.xl, alignItems: 'center', marginBottom: spacing.lg, backgroundColor: colors.surface },
  resultOk: { borderColor: colors.success },
  resultBad: { borderColor: colors.danger },
  resultTitle: { color: colors.textPrimary, fontFamily: fontFamily.bold, fontSize: 22, marginBottom: spacing.sm },
  resultMessage: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 15, textAlign: 'center' },
});
