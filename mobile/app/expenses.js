import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ActivityIndicator, ScrollView, Linking, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, spacing, radius, type, elevation, buttons } from '../lib/theme';
import { buildReceiptPath, formatFileSize, mileageRateCents, mileageAmountCents } from '../supabase/functions/hr-ai-bot/logic';

const BUCKET = 'expense-receipts';
const MAX_BYTES = 10 * 1024 * 1024;
const CATEGORIES = ['Fuel', 'Meals', 'Travel', 'Supplies', 'Equipment', 'Parking/Tolls', 'Lodging', 'Phone/Internet', 'Training', 'Other'];
const MILEAGE_CATEGORY = 'Mileage';
// Receipts: photos + PDF only. HEIC/HEIF (iPhone default photo format) is NOT in
// the bucket allowlist, so it is rejected at pick time with a plain message
// instead of failing at upload. Camera shots come back JPEG, so taking the
// photo with the camera always works.
const HEIC_MIMES = new Set(['image/heic', 'image/heif']);
const HEIC_EXTS = new Set(['heic', 'heif']);
function receiptTypeOk(asset) {
  const mime = (asset.mimeType || '').toLowerCase();
  if (HEIC_MIMES.has(mime)) return false;
  if (mime === 'application/pdf' || mime.startsWith('image/')) return true;
  if (mime && mime !== 'application/octet-stream') return false;
  const ext = (asset.name || asset.fileName || '').split('.').pop()?.toLowerCase();
  if (HEIC_EXTS.has(ext)) return false;
  return ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
}
function isHeic(asset) {
  const mime = (asset.mimeType || '').toLowerCase();
  if (HEIC_MIMES.has(mime)) return true;
  const ext = (asset.name || asset.fileName || '').split('.').pop()?.toLowerCase();
  return HEIC_EXTS.has(ext);
}
function contentTypeForReceipt(asset) {
  const mime = (asset.mimeType || '').toLowerCase();
  if (mime && mime !== 'application/octet-stream') return asset.mimeType;
  const ext = (asset.name || asset.fileName || '').split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}
function todayStr() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
// Strict YYYY-MM-DD check: format AND a real calendar date. Never build a Date
// from unchecked text and call toISOString on it — an Invalid Date throws.
function parseDateStrict(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return { year: y, iso: s };
}
function parseMoneyCents(s) {
  const cleaned = (s || '').replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}
function fmtCents(c) {
  return '$' + (c / 100).toFixed(2);
}
function statusBadge(status) {
  if (status === 'approved') return { label: 'APPROVED', bg: colors.successSoft || colors.accentSoft, fg: colors.success };
  if (status === 'denied') return { label: 'DENIED', bg: colors.surface, fg: colors.danger };
  return { label: 'PENDING', bg: colors.warningSoft, fg: colors.warning };
}

export default function ExpensesScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [setupMissing, setSetupMissing] = useState(false);
  const [myId, setMyId] = useState(null);
  const [businessId, setBusinessId] = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);

  // Form state.
  const [kind, setKind] = useState('expense'); // 'expense' | 'mileage'
  const [dateStr, setDateStr] = useState(todayStr());
  const [category, setCategory] = useState('Other');
  const [amountStr, setAmountStr] = useState('');
  const [merchant, setMerchant] = useState('');
  const [note, setNote] = useState('');
  const [kmStr, setKmStr] = useState('');
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [territory, setTerritory] = useState(false);
  const [receipt, setReceipt] = useState(null); // { name, mimeType, size, bytes }

  // Back means back: return to the screen we came from, not a
  // role-based destination. A deep link with no history falls back
  // to the employee home.
  const handleBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  useEffect(() => { init(); }, []);

  const init = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace('/'); return; }
    setMyId(session.user.id);
    const { data: me } = await supabase.from('profiles').select('business_id').eq('id', session.user.id).single();
    if (me) setBusinessId(me.business_id || null);
    await loadExpenses(session.user.id);
    setLoading(false);
  };

  const loadExpenses = async (uid) => {
    const { data, error } = await supabase
      .from('expenses')
      .select('id, type, expense_date, category, amount_cents, merchant, note, receipt_path, mileage_km, mileage_rate_cents, origin, destination, status, review_note, reimbursement_status, created_at')
      .eq('user_id', uid)
      .order('expense_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) { setSetupMissing(true); setExpenses([]); return; }
    setSetupMissing(false);
    setExpenses(data || []);
  };

  // Normalize a picked asset (ImagePicker on phone, DocumentPicker on web)
  // into a receipt, validating type and size before any bytes move.
  const acceptReceipt = async (asset) => {
    if (isHeic(asset)) {
      setMessage('That photo is in HEIC format, which receipts do not accept yet. Please take the photo with the camera, or choose a JPG or PNG.');
      return;
    }
    if (!receiptTypeOk(asset)) {
      setMessage('That file type is not accepted. Please pick a photo or a PDF.');
      return;
    }
    if (asset.size && asset.size > MAX_BYTES) {
      setMessage(`That file is ${formatFileSize(asset.size)} — over the 10 MB limit.`);
      return;
    }
    if (asset.fileSize && asset.fileSize > MAX_BYTES) {
      setMessage(`That file is ${formatFileSize(asset.fileSize)} — over the 10 MB limit.`);
      return;
    }
    setPicking(true);
    try {
      const bytes = await new File(asset.uri).bytes();
      if (bytes.length > MAX_BYTES) {
        setMessage(`That file is ${formatFileSize(bytes.length)} — over the 10 MB limit.`);
        return;
      }
      setReceipt({
        name: asset.name || asset.fileName || `receipt-${Date.now()}.jpg`,
        mimeType: contentTypeForReceipt(asset),
        size: bytes.length,
        bytes,
      });
      setMessage('');
    } catch (e) {
      setMessage('Could not read that file. Please try again.');
    } finally {
      setPicking(false);
    }
  };

  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setMessage('Camera access was denied. Allow camera access in your phone settings to take receipt photos, or choose a photo from your library instead.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.85 });
    if (result.canceled || !result.assets?.length) return;
    await acceptReceipt(result.assets[0]);
  };

  const pickFromLibrary = async () => {
    if (Platform.OS === 'web') {
      // Web has no camera/library split — the document picker covers it,
      // same as the Documents screen.
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/*', 'application/pdf'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;
      await acceptReceipt(result.assets[0]);
      return;
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setMessage('Photo library access was denied. Allow photo access in your phone settings to attach receipt photos, or take the photo with the camera instead.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85 });
    if (result.canceled || !result.assets?.length) return;
    await acceptReceipt(result.assets[0]);
  };

  const submitExpense = async () => {
    // Validate everything BEFORE the spinner starts: a failed validation
    // must show a message, never a stuck spinner.
    if (!businessId) { setMessage('Set up your business first — expenses belong to a business.'); return; }
    const parsedDate = parseDateStrict(dateStr);
    if (!parsedDate) { setMessage('Enter a valid date (YYYY-MM-DD).'); return; }
    let amountCents = null;
    let km = null;
    let rateCents = null;
    if (kind === 'expense') {
      amountCents = parseMoneyCents(amountStr);
      if (amountCents == null) { setMessage('Enter an amount greater than $0.'); return; }
      if (!receipt) { setMessage('Attach a receipt photo first — receipts are required for expenses.'); return; }
    } else {
      km = Number((kmStr || '').replace(/,/g, ''));
      if (!Number.isFinite(km) || km <= 0) { setMessage('Enter the distance in kilometres (greater than 0).'); return; }
      km = Math.round(km * 100) / 100;
      if (!origin.trim()) { setMessage('Enter where the trip started (From).'); return; }
      if (!destination.trim()) { setMessage('Enter where the trip ended (To).'); return; }
      rateCents = mileageRateCents(parsedDate.year, territory);
      amountCents = mileageAmountCents(km, parsedDate.year, territory);
    }
    setSubmitting(true);
    setMessage('');
    try {
      let receiptPath = null;
      if (kind === 'expense') {
        receiptPath = buildReceiptPath(businessId, myId, receipt.name, Date.now());
        const { error: upErr } = await supabase.storage.from(BUCKET).upload(receiptPath, receipt.bytes, {
          contentType: receipt.mimeType,
          upsert: false,
        });
        if (upErr) throw new Error('Receipt upload failed: ' + upErr.message);
      }
      const { error: insErr } = await supabase.from('expenses').insert([{
        business_id: businessId,
        user_id: myId,
        type: kind,
        expense_date: parsedDate.iso,
        category: kind === 'mileage' ? MILEAGE_CATEGORY : category,
        amount_cents: amountCents,
        currency: 'CAD',
        merchant: kind === 'expense' ? (merchant.trim() || null) : null,
        note: note.trim() || null,
        receipt_path: receiptPath,
        mileage_km: kind === 'mileage' ? km : null,
        mileage_rate_cents: kind === 'mileage' ? rateCents : null,
        origin: kind === 'mileage' ? origin.trim() : null,
        destination: kind === 'mileage' ? destination.trim() : null,
      }]);
      if (insErr) throw new Error(insErr.message);
      setAmountStr('');
      setMerchant('');
      setNote('');
      setKmStr('');
      setOrigin('');
      setDestination('');
      setReceipt(null);
      setDateStr(todayStr());
      setMessage(kind === 'mileage' ? 'Mileage submitted for review.' : 'Expense submitted for review.');
      await loadExpenses(myId);
    } catch (e) {
      setMessage('Could not submit: ' + (e?.message || 'please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  const viewReceipt = async (exp) => {
    if (!exp.receipt_path) return;
    setBusyId(exp.id);
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(exp.receipt_path, 300);
    if (error || !data?.signedUrl) {
      setMessage('Could not open: ' + (error?.message || 'no link returned'));
    } else {
      Linking.openURL(data.signedUrl);
    }
    setBusyId(null);
  };

  const deleteExpense = async (exp) => {
    if (confirmingDeleteId !== exp.id) { setConfirmingDeleteId(exp.id); return; }
    setBusyId(exp.id);
    if (exp.receipt_path) await supabase.storage.from(BUCKET).remove([exp.receipt_path]);
    const { error } = await supabase.from('expenses').delete().eq('id', exp.id);
    setMessage(error ? 'Could not delete: ' + error.message : 'Expense deleted.');
    setConfirmingDeleteId(null);
    await loadExpenses(myId);
    setBusyId(null);
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  // Live mileage estimate: first-tier rate. The monthly report applies the
  // 5,000 km year-to-date tier split exactly.
  const kmPreview = Number((kmStr || '').replace(/,/g, ''));
  const datePreview = parseDateStrict(dateStr);
  const showEstimate = kind === 'mileage' && Number.isFinite(kmPreview) && kmPreview > 0 && datePreview;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.navButton} onPress={handleBack}>
          <Text style={styles.navButtonText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Expenses</Text>
        <View style={{ width: 80 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {message ? <Text style={styles.message}>{message}</Text> : null}

        {setupMissing ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Expenses are not set up yet</Text>
            <Text style={styles.cardText}>The expense update has not been applied to this workspace yet. Once it runs, receipts and mileage live here — private to each employee and their managers.</Text>
          </View>
        ) : (
          <>
            {!businessId ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>No business yet</Text>
                <Text style={styles.cardText}>Expenses belong to a business. Finish setting up your business first, then come back here.</Text>
              </View>
            ) : (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>New expense</Text>
                <View style={styles.chipRow}>
                  <TouchableOpacity style={[styles.chip, kind === 'expense' && styles.chipActive]} onPress={() => setKind('expense')}>
                    <Text style={[styles.chipText, kind === 'expense' && styles.chipTextActive]}>Expense</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.chip, kind === 'mileage' && styles.chipActive]} onPress={() => setKind('mileage')}>
                    <Text style={[styles.chipText, kind === 'mileage' && styles.chipTextActive]}>Mileage</Text>
                  </TouchableOpacity>
                </View>

                <Text style={styles.label}>Date (YYYY-MM-DD)</Text>
                <TextInput style={styles.input} value={dateStr} onChangeText={setDateStr} placeholder="YYYY-MM-DD" placeholderTextColor={colors.inputPlaceholder} keyboardType="numbers-and-punctuation" />

                {kind === 'expense' ? (
                  <>
                    <Text style={styles.label}>Category</Text>
                    <View style={styles.chipRow}>
                      {CATEGORIES.map((c) => (
                        <TouchableOpacity key={c} style={[styles.chip, category === c && styles.chipActive]} onPress={() => setCategory(c)}>
                          <Text style={[styles.chipText, category === c && styles.chipTextActive]}>{c}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                    <Text style={styles.label}>Amount (CAD)</Text>
                    <TextInput style={styles.input} value={amountStr} onChangeText={setAmountStr} placeholder="0.00" placeholderTextColor={colors.inputPlaceholder} keyboardType="decimal-pad" />
                    <Text style={styles.label}>Merchant / vendor (optional)</Text>
                    <TextInput style={styles.input} value={merchant} onChangeText={setMerchant} placeholder="e.g. Shell, Staples" placeholderTextColor={colors.inputPlaceholder} />
                    <Text style={styles.label}>Receipt photo (required)</Text>
                    {receipt ? (
                      <View style={styles.receiptRow}>
                        <Text style={styles.receiptName} numberOfLines={1}>{receipt.name} · {formatFileSize(receipt.size)}</Text>
                        <TouchableOpacity style={styles.smallOutline} onPress={() => setReceipt(null)}>
                          <Text style={styles.smallOutlineText}>Remove</Text>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <View style={styles.receiptButtons}>
                        {Platform.OS !== 'web' && (
                          <TouchableOpacity style={styles.secondaryButton} onPress={takePhoto} disabled={picking}>
                            <Text style={styles.secondaryButtonText}>Take Photo</Text>
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity style={styles.secondaryButton} onPress={pickFromLibrary} disabled={picking}>
                          {picking ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.secondaryButtonText}>{Platform.OS === 'web' ? 'Choose a File' : 'Choose from Library'}</Text>}
                        </TouchableOpacity>
                      </View>
                    )}
                    <Text style={styles.cardText}>Photo or PDF, up to 10 MB. An expense cannot be submitted without a receipt.</Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.label}>Distance (km)</Text>
                    <TextInput style={styles.input} value={kmStr} onChangeText={setKmStr} placeholder="e.g. 42.5" placeholderTextColor={colors.inputPlaceholder} keyboardType="decimal-pad" />
                    <Text style={styles.label}>From</Text>
                    <TextInput style={styles.input} value={origin} onChangeText={setOrigin} placeholder="Where the trip started" placeholderTextColor={colors.inputPlaceholder} />
                    <Text style={styles.label}>To</Text>
                    <TextInput style={styles.input} value={destination} onChangeText={setDestination} placeholder="Where the trip ended" placeholderTextColor={colors.inputPlaceholder} />
                    <TouchableOpacity style={[styles.chip, territory && styles.chipActive, { alignSelf: 'flex-start', marginBottom: spacing.md }]} onPress={() => setTerritory(!territory)}>
                      <Text style={[styles.chipText, territory && styles.chipTextActive]}>Driving in Yukon / NWT / Nunavut (+4¢/km)</Text>
                    </TouchableOpacity>
                    {showEstimate && (
                      <Text style={styles.cardText}>Estimated {fmtCents(mileageAmountCents(kmPreview, datePreview.year, territory))} at {mileageRateCents(datePreview.year, territory)}¢/km. The monthly report applies the 5,000 km yearly tier exactly.</Text>
                    )}
                  </>
                )}

                <Text style={styles.label}>Note (optional)</Text>
                <TextInput style={[styles.input, styles.textArea]} value={note} onChangeText={setNote} placeholder={kind === 'mileage' ? 'e.g. Client visit, supply run' : 'e.g. What this was for'} placeholderTextColor={colors.inputPlaceholder} multiline numberOfLines={3} />

                <TouchableOpacity style={styles.primaryButton} onPress={submitExpense} disabled={submitting}>
                  {submitting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>{kind === 'mileage' ? 'Submit Mileage' : 'Submit Expense'}</Text>}
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>My Expenses</Text>
              {expenses.length === 0 ? (
                <Text style={styles.emptyText}>No expenses yet.</Text>
              ) : expenses.map((exp) => {
                const badge = statusBadge(exp.status);
                return (
                  <View key={exp.id} style={styles.docCard}>
                    <View style={styles.docTop}>
                      <Text style={styles.docName} numberOfLines={1}>
                        {exp.type === 'mileage' ? `${exp.origin || ''} → ${exp.destination || ''}` : (exp.merchant || exp.category)}
                      </Text>
                      <View style={[styles.badge, { backgroundColor: badge.bg, borderColor: badge.fg }]}>
                        <Text style={[styles.badgeText, { color: badge.fg }]}>{badge.label}</Text>
                      </View>
                    </View>
                    <Text style={styles.docMeta}>
                      {new Date(exp.expense_date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · {exp.type === 'mileage' ? `${exp.mileage_km} km × ${exp.mileage_rate_cents}¢` : exp.category} · {fmtCents(exp.amount_cents)}
                      {exp.status === 'approved' ? (exp.reimbursement_status === 'paid' ? ' · Reimbursed' : ' · Awaiting reimbursement') : ''}
                    </Text>
                    {exp.note ? <Text style={styles.docMeta}>{exp.note}</Text> : null}
                    {exp.review_note ? <Text style={styles.docMeta}>Manager note: {exp.review_note}</Text> : null}
                    <View style={styles.docActions}>
                      {exp.receipt_path ? (
                        <TouchableOpacity style={styles.smallPrimary} onPress={() => viewReceipt(exp)} disabled={busyId === exp.id}>
                          <Text style={styles.smallPrimaryText}>View Receipt</Text>
                        </TouchableOpacity>
                      ) : null}
                      {exp.status === 'pending' && (
                        <TouchableOpacity style={styles.smallOutline} onPress={() => deleteExpense(exp)} disabled={busyId === exp.id}>
                          <Text style={styles.smallOutlineText}>{confirmingDeleteId === exp.id ? 'Tap again to delete' : 'Delete'}</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              })}
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
  input: { backgroundColor: colors.inputBackground, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: radius.sm, padding: spacing.sm, fontSize: 14, fontFamily: fontFamily.regular, color: colors.textPrimary, marginBottom: spacing.md, minHeight: 44 },
  textArea: { minHeight: 76, textAlignVertical: 'top' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: { borderWidth: 1, borderColor: colors.surfaceBorder, backgroundColor: colors.surface, borderRadius: radius.pill, paddingVertical: 8, paddingHorizontal: 14 },
  chipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  chipText: { fontFamily: fontFamily.semibold, fontSize: 13, color: colors.textSecondary },
  chipTextActive: { color: colors.accent },
  primaryButton: { ...buttons.primary, marginTop: spacing.sm },
  primaryButtonText: { ...buttons.primaryText },
  secondaryButton: { ...buttons.compactOutline, flex: 1 },
  secondaryButtonText: { ...buttons.compactOutlineText },
  receiptButtons: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xs },
  receiptRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  receiptName: { flex: 1, fontFamily: fontFamily.regular, fontSize: 13, color: colors.textPrimary },
  docCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.lg, ...elevation.card },
  docTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  docName: { flex: 1, fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary },
  docMeta: { fontFamily: fontFamily.regular, fontSize: 13, color: colors.textSecondary },
  docActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  badge: { borderRadius: radius.pill, paddingVertical: 3, paddingHorizontal: 9, borderWidth: 1 },
  badgeText: { ...type.label },
  smallPrimary: { ...buttons.compact },
  smallPrimaryText: { ...buttons.compactText },
  smallOutline: { ...buttons.compactOutline },
  smallOutlineText: { ...buttons.compactOutlineText },
  emptyText: { fontFamily: fontFamily.regular, color: colors.textSecondary, fontSize: 13 },
});
