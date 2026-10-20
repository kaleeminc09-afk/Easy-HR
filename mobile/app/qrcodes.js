import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { Link } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, spacing, radius, fontFamily } from '../lib/theme';

export const qrPayload = (worksiteId) => `northshift-site:${worksiteId}`;

export default function WorksiteQrScreen() {
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from('worksites').select('id, name').order('name');
      if (error) setError(error.message);
      else setSites(data || []);
      setLoading(false);
    })();
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Link href="/" asChild>
          <TouchableOpacity style={styles.backButton}>
            <Text style={styles.backButtonText}>&larr; Back</Text>
          </TouchableOpacity>
        </Link>
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
          <Text style={styles.intro}>Print the code for each worksite and post it at the entrance. Staff scan it to clock in and out — no GPS needed.</Text>
          {sites.length === 0 && <Text style={styles.emptyText}>No worksites configured yet.</Text>}
          {sites.map((site) => (
            <View key={site.id} style={styles.card}>
              <View style={styles.qrWrap}>
                <QRCode value={qrPayload(site.id)} size={210} />
              </View>
              <Text style={styles.siteName}>{site.name}</Text>
              <Text style={styles.siteHint}>Scan with NorthShift to clock in / out</Text>
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
});
