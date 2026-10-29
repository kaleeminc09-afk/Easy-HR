import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, ScrollView, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Link } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, spacing, radius, type, elevation, buttons } from '../lib/theme';
import { buildStoragePath, formatFileSize } from '../supabase/functions/hr-ai-bot/logic';

const BUCKET = 'employee-documents';
const MAX_BYTES = 10 * 1024 * 1024;
// Hard format check: the picker type filter is only a hint to the OS,
// so a wrong type can still be picked (Android especially). Reject it
// here with a plain message instead of uploading it anyway.
const ALLOWED_EXTS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'doc', 'docx']);
const MIME_BY_EXT = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
function fileTypeOk(asset) {
  const mime = (asset.mimeType || '').toLowerCase();
  if (mime === 'application/pdf' || mime.startsWith('image/') || mime === 'application/msword' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return true;
  if (mime && mime !== 'application/octet-stream') return false;
  const ext = (asset.name || '').split('.').pop()?.toLowerCase();
  return ALLOWED_EXTS.has(ext);
}
function contentTypeFor(asset) {
  const mime = (asset.mimeType || '').toLowerCase();
  if (mime && mime !== 'application/octet-stream') return asset.mimeType;
  const ext = (asset.name || '').split('.').pop()?.toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}
const CATEGORIES = ['Contract', 'Certification', 'ID', 'Policy', 'Other'];

export default function DocumentsScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [setupMissing, setSetupMissing] = useState(false);
  const [myId, setMyId] = useState(null);
  const [myRole, setMyRole] = useState('employee');
  const [businessId, setBusinessId] = useState(null);
  const [people, setPeople] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [docs, setDocs] = useState([]);
  const [category, setCategory] = useState('Other');
  const [message, setMessage] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);

  const isManager = myRole === 'manager' || myRole === 'admin';

  useEffect(() => { init(); }, []);
  useEffect(() => { if (selectedUser) loadDocs(selectedUser); }, [selectedUser]);

  const init = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace('/'); return; }
    setMyId(session.user.id);
    const { data: me } = await supabase.from('profiles').select('role, business_id').eq('id', session.user.id).single();
    if (me) { setMyRole(me.role || 'employee'); setBusinessId(me.business_id || null); }
    const { data: ppl } = await supabase.from('profiles').select('id, full_name').order('full_name', { ascending: true });
    if (ppl) setPeople(ppl);
    setSelectedUser(session.user.id);
    setLoading(false);
  };

  const loadDocs = async (uid) => {
    const { data, error } = await supabase
      .from('documents')
      .select('id, user_id, uploaded_by, file_name, storage_path, content_type, size_bytes, category, created_at')
      .eq('user_id', uid)
      .order('created_at', { ascending: false });
    if (error) { setSetupMissing(true); setDocs([]); return; }
    setSetupMissing(false);
    setDocs(data || []);
  };

  const nameOf = (id) => {
    if (id === myId) return 'you';
    const p = people.find((x) => x.id === id);
    return (p && p.full_name) || 'a manager';
  };

  const pickAndUpload = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      if (!fileTypeOk(asset)) {
        setMessage('That file type is not accepted. Please pick a PDF, photo, or Word document.');
        return;
      }
      if (asset.size && asset.size > MAX_BYTES) {
        setMessage(`That file is ${formatFileSize(asset.size)} — over the 10 MB limit.`);
        return;
      }
      setUploading(true);
      setMessage('');
      // New expo-file-system API: the old readAsStringAsync throws a
      // deprecation error on this SDK. File.bytes() returns the raw
      // bytes directly, no base64 round-trip.
      const bytes = await new File(asset.uri).bytes();
      if (bytes.length > MAX_BYTES) {
        setMessage(`That file is ${formatFileSize(bytes.length)} — over the 10 MB limit.`);
        setUploading(false);
        return;
      }
      const path = buildStoragePath(selectedUser, asset.name || 'document', Date.now());
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, bytes, {
        contentType: contentTypeFor(asset),
        upsert: false,
      });
      if (upErr) {
        setMessage(upErr.message && upErr.message.toLowerCase().includes('bucket')
          ? 'Document storage is not set up yet — the storage update has not been applied to this workspace.'
          : 'Upload failed: ' + upErr.message);
        setUploading(false);
        return;
      }
      const { error: insErr } = await supabase.from('documents').insert([{
        business_id: businessId,
        user_id: selectedUser,
        uploaded_by: myId,
        file_name: asset.name || 'document',
        storage_path: path,
        content_type: contentTypeFor(asset),
        size_bytes: asset.size || bytes.length,
        category,
      }]);
      setMessage(insErr ? 'Uploaded but could not save the record: ' + insErr.message : 'Document uploaded.');
      await loadDocs(selectedUser);
      setUploading(false);
    } catch (e) {
      const msg = e?.message || '';
      setMessage(/deprecated|legacy|readAsStringAsync/i.test(msg)
        ? 'Upload failed because the file reader is out of date. Please reload the app and try again.'
        : 'Could not upload that file. Please try again.');
      setUploading(false);
    }
  };

  const viewDoc = async (doc) => {
    setBusyId(doc.id);
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(doc.storage_path, 300);
    if (error || !data?.signedUrl) {
      setMessage('Could not open: ' + (error?.message || 'no link returned'));
    } else {
      Linking.openURL(data.signedUrl);
    }
    setBusyId(null);
  };

  const deleteDoc = async (doc) => {
    if (confirmingDeleteId !== doc.id) { setConfirmingDeleteId(doc.id); return; }
    setBusyId(doc.id);
    await supabase.storage.from(BUCKET).remove([doc.storage_path]);
    const { error } = await supabase.from('documents').delete().eq('id', doc.id);
    setMessage(error ? 'Could not delete: ' + error.message : 'Document deleted.');
    setConfirmingDeleteId(null);
    await loadDocs(selectedUser);
    setBusyId(null);
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  const canDelete = (doc) => isManager || doc.uploaded_by === myId;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Link href={isManager ? '/manager' : '/'} asChild>
          <TouchableOpacity style={styles.navButton}>
            <Text style={styles.navButtonText}>← Back</Text>
          </TouchableOpacity>
        </Link>
        <Text style={styles.headerTitle}>Documents</Text>
        <View style={{ width: 80 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {message ? <Text style={styles.message}>{message}</Text> : null}

        {setupMissing ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Documents are not set up yet</Text>
            <Text style={styles.cardText}>The document storage update has not been applied to this workspace yet. Once it runs, contracts, certifications, and ID copies live here — private to each employee and their managers.</Text>
          </View>
        ) : (
          <>
            {isManager && (
              <View>
                <Text style={styles.label}>Whose documents</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRowH}>
                  {people.map((p) => (
                    <TouchableOpacity key={p.id} style={[styles.chip, selectedUser === p.id && styles.chipActive]} onPress={() => setSelectedUser(p.id)}>
                      <Text style={[styles.chipText, selectedUser === p.id && styles.chipTextActive]}>{p.id === myId ? 'Me' : (p.full_name || 'Unknown')}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Upload a document</Text>
              <Text style={styles.label}>Category</Text>
              <View style={styles.chipRow}>
                {CATEGORIES.map((c) => (
                  <TouchableOpacity key={c} style={[styles.chip, category === c && styles.chipActive]} onPress={() => setCategory(c)}>
                    <Text style={[styles.chipText, category === c && styles.chipTextActive]}>{c}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity style={styles.primaryButton} onPress={pickAndUpload} disabled={uploading}>
                {uploading ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Pick a File to Upload</Text>}
              </TouchableOpacity>
              <Text style={styles.cardText}>PDF, photo, or Word document, up to 10 MB. {selectedUser === myId ? 'Goes into your file.' : `Goes into ${nameOf(selectedUser)}'s file.`}</Text>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{selectedUser === myId ? 'My Documents' : `Documents · ${(people.find((p) => p.id === selectedUser)?.full_name || 'Team member')}`}</Text>
              {docs.length === 0 ? (
                <Text style={styles.emptyText}>No documents yet.</Text>
              ) : docs.map((d) => (
                <View key={d.id} style={styles.docCard}>
                  <View style={styles.docTop}>
                    <Text style={styles.docName} numberOfLines={1}>{d.file_name}</Text>
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{d.category}</Text>
                    </View>
                  </View>
                  <Text style={styles.docMeta}>
                    {formatFileSize(d.size_bytes)} · {new Date(d.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · uploaded by {nameOf(d.uploaded_by)}
                  </Text>
                  <View style={styles.docActions}>
                    <TouchableOpacity style={styles.smallPrimary} onPress={() => viewDoc(d)} disabled={busyId === d.id}>
                      <Text style={styles.smallPrimaryText}>View</Text>
                    </TouchableOpacity>
                    {canDelete(d) && (
                      <TouchableOpacity style={styles.smallOutline} onPress={() => deleteDoc(d)} disabled={busyId === d.id}>
                        <Text style={styles.smallOutlineText}>{confirmingDeleteId === d.id ? 'Tap again to delete' : 'Delete'}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              ))}
            </View>
          </>
        )}
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
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  message: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary, textAlign: 'center' },
  section: { gap: spacing.sm },
  sectionTitle: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary, marginBottom: spacing.xs },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.lg, ...elevation.card },
  cardTitle: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary, marginBottom: spacing.sm },
  cardText: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary, marginTop: spacing.sm },
  label: { ...type.label, color: colors.textSecondary, marginBottom: spacing.xs },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chipRowH: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.xs },
  chip: { borderWidth: 1, borderColor: colors.surfaceBorder, backgroundColor: colors.surface, borderRadius: radius.pill, paddingVertical: 8, paddingHorizontal: 14 },
  chipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  chipText: { fontFamily: fontFamily.semibold, fontSize: 13, color: colors.textSecondary },
  chipTextActive: { color: colors.accent },
  primaryButton: { ...buttons.primary },
  primaryButtonText: { ...buttons.primaryText },
  docCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.lg, ...elevation.card },
  docTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  docName: { flex: 1, fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary },
  docMeta: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary },
  docActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  badge: { borderRadius: radius.pill, paddingVertical: 3, paddingHorizontal: 9, borderWidth: 1, backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  badgeText: { ...type.label, color: colors.accent },
  smallPrimary: { ...buttons.compact },
  smallPrimaryText: { ...buttons.compactText },
  smallOutline: { ...buttons.compactOutline },
  smallOutlineText: { ...buttons.compactOutlineText },
  emptyText: { fontFamily: fontFamily.regular, color: colors.textSecondary, fontSize: 13 },
});
