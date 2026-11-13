import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ActivityIndicator, ScrollView, Linking, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, spacing, radius, type, elevation, buttons } from '../lib/theme';
import { buildReceiptPath, formatFileSize, mileageRateCents, mileageAmountCents, mileageTierSplit, mileageSplitByEntry, buildExpenseCsv } from '../supabase/functions/hr-ai-bot/logic';

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
// ISO date arithmetic on the YYYY-MM-DD strings the report stores.
// Noon anchor avoids DST edge cases; string comparison stays valid.
function addDaysIso(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  const p2 = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function mondayOf(iso) {
  const d = new Date(iso + 'T12:00:00');
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  const p2 = (x) => String(x).padStart(2, '0');
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
function fmtDate(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthName(m) {
  return MONTH_NAMES[m - 1] || '';
}
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const EXPENSE_COLUMNS = 'id, user_id, type, expense_date, category, amount_cents, merchant, note, receipt_path, mileage_km, mileage_rate_cents, origin, destination, status, reviewed_by, review_note, reimbursement_status, created_at';
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
  const [myRole, setMyRole] = useState('employee');
  const [people, setPeople] = useState([]);
  const [pendingQueue, setPendingQueue] = useState([]);
  const [yearExpenses, setYearExpenses] = useState([]);
  const [reviewNotes, setReviewNotes] = useState({});
  const [confirmMarkAllPaid, setConfirmMarkAllPaid] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
  const [reportYear, setReportYear] = useState(new Date().getFullYear());
  const [reportMonth, setReportMonth] = useState(new Date().getMonth() + 1);
  const [reportPeriod, setReportPeriod] = useState('month'); // 'day' | 'week' | 'month'
  const [reportDay, setReportDay] = useState(todayStr());
  const [reportWeekStart, setReportWeekStart] = useState(mondayOf(todayStr()));
  const [collapsedReport, setCollapsedReport] = useState({ breakdown: true, tier: true, filters: true });
  const [reportEmployee, setReportEmployee] = useState('all');
  const [reportCategory, setReportCategory] = useState('all');
  const [reportStatus, setReportStatus] = useState('all');
  const [reportType, setReportType] = useState('all');
  const [reportReimb, setReportReimb] = useState('all');
  const yearsLoadedRef = useRef(null); // comma-joined sorted years in yearExpenses

  const isManager = myRole === 'manager' || myRole === 'admin';

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
  useEffect(() => { if (isManager && businessId) { const years = periodYears(); if (yearsLoadedRef.current !== [...years].sort().join(',')) loadReportYears(businessId, years); } }, [reportPeriod, reportDay, reportWeekStart, reportYear]);

  const init = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.replace('/'); return; }
    setMyId(session.user.id);
    const { data: me } = await supabase.from('profiles').select('role, business_id').eq('id', session.user.id).single();
    const role = me?.role || 'employee';
    const bizId = me?.business_id || null;
    setMyRole(role);
    setBusinessId(bizId);
    await loadExpenses(session.user.id);
    if ((role === 'manager' || role === 'admin') && bizId) {
      await loadPeople();
      await loadTeamExpenses(bizId);
      await loadReportYears(bizId, [new Date().getFullYear()]);
    }
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

  const loadPeople = async () => {
    const { data } = await supabase.from('profiles').select('id, full_name').order('full_name', { ascending: true });
    if (data) setPeople(data);
  };

  const loadTeamExpenses = async (bizId) => {
    const { data } = await supabase
      .from('expenses')
      .select(EXPENSE_COLUMNS)
      .eq('business_id', bizId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    setPendingQueue(data || []);
  };

  const fetchYearExpenses = async (bizId, year) => {
    const { data } = await supabase
      .from('expenses')
      .select(EXPENSE_COLUMNS)
      .eq('business_id', bizId)
      .gte('expense_date', `${year}-01-01`)
      .lte('expense_date', `${year}-12-31`)
      .order('expense_date', { ascending: false });
    return data || [];
  };

  // Years the selected report period touches: one, except a week
  // spanning New Year, which needs both years loaded.
  const periodYears = () => {
    if (reportPeriod === 'day') return [Number(reportDay.slice(0, 4))];
    if (reportPeriod === 'week') {
      const y1 = Number(reportWeekStart.slice(0, 4));
      const y2 = Number(addDaysIso(reportWeekStart, 6).slice(0, 4));
      return y1 === y2 ? [y1] : [y1, y2];
    }
    return [reportYear];
  };

  const loadReportYears = async (bizId, years) => {
    const parts = [];
    for (const y of years) parts.push(...(await fetchYearExpenses(bizId, y)));
    setYearExpenses(parts);
    yearsLoadedRef.current = [...years].sort().join(',');
  };

  const reloadManagerData = async () => {
    if (!isManager || !businessId) return;
    await loadTeamExpenses(businessId);
    await loadReportYears(businessId, periodYears());
  };

  const nameOf = (id) => {
    if (id === myId) return 'you';
    const p = people.find((x) => x.id === id);
    return (p && p.full_name) || 'Team member';
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

  const reviewExpense = async (exp, status) => {
    setBusyId(exp.id);
    setMessage('');
    const { error } = await supabase.from('expenses')
      .update({ status, reviewed_by: myId, review_note: (reviewNotes[exp.id] || '').trim() || null })
      .eq('id', exp.id);
    setMessage(error ? 'Could not update: ' + error.message : `Expense ${status}.`);
    if (!error) setReviewNotes((prev) => { const n = { ...prev }; delete n[exp.id]; return n; });
    await loadExpenses(myId);
    await reloadManagerData();
    setBusyId(null);
  };

  const markPaid = async (exp) => {
    setBusyId(exp.id);
    setMessage('');
    const { error } = await supabase.from('expenses')
      .update({ reimbursement_status: 'paid' })
      .eq('id', exp.id)
      .eq('status', 'approved')
      .eq('reimbursement_status', 'unpaid');
    setMessage(error ? 'Could not update: ' + error.message : 'Marked as paid.');
    await loadExpenses(myId);
    await reloadManagerData();
    setBusyId(null);
  };

  const markAllShownPaid = async () => {
    if (!confirmMarkAllPaid) { setConfirmMarkAllPaid(true); return; }
    setConfirmMarkAllPaid(false);
    setBusyId('batch');
    setMessage('');
    const ids = dueShown.map((e) => e.id);
    const { error } = await supabase.from('expenses')
      .update({ reimbursement_status: 'paid' })
      .in('id', ids)
      .eq('status', 'approved')
      .eq('reimbursement_status', 'unpaid');
    setMessage(error ? 'Could not update: ' + error.message : `${ids.length} marked as paid.`);
    await loadExpenses(myId);
    await reloadManagerData();
    setBusyId(null);
  };

  const prevPeriod = () => {
    if (reportPeriod === 'day') setReportDay((d) => addDaysIso(d, -1));
    else if (reportPeriod === 'week') setReportWeekStart((w) => addDaysIso(w, -7));
    else if (reportMonth === 1) { setReportMonth(12); setReportYear(reportYear - 1); }
    else setReportMonth(reportMonth - 1);
  };
  const nextPeriod = () => {
    if (reportPeriod === 'day') setReportDay((d) => addDaysIso(d, 1));
    else if (reportPeriod === 'week') setReportWeekStart((w) => addDaysIso(w, 7));
    else if (reportMonth === 12) { setReportMonth(1); setReportYear(reportYear + 1); }
    else setReportMonth(reportMonth + 1);
  };
  // Switching period jumps to the current day / week / month — the
  // predictable anchor for generating a fresh report.
  const setPeriod = (p) => {
    setReportPeriod(p);
    if (p === 'day') setReportDay(todayStr());
    else if (p === 'week') setReportWeekStart(mondayOf(todayStr()));
    else { setReportYear(new Date().getFullYear()); setReportMonth(new Date().getMonth() + 1); }
  };

  const exportReportCsv = async () => {
    try {
      const rows = filteredRows.map((e) => ({
        expense_date: e.expense_date,
        employee_name: nameOf(e.user_id),
        type: e.type,
        category: e.category,
        merchant: e.merchant,
        amount_cents: splitAmount(e),
        status: e.status,
        reimbursement_status: e.reimbursement_status,
        receipt_path: e.receipt_path,
        user_id: e.user_id,
        reviewed_by: e.reviewed_by,
      }));
      if (rows.length === 0) { setExportMsg('Nothing to export for these filters.'); return; }
      const csv = buildExpenseCsv(rows);
      const filename = `northshift-expenses-${periodKey}.csv`;
      if (Platform.OS === 'web') {
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        setExportMsg(`Exported ${rows.length} expenses.`);
      } else {
        const { File, Paths } = require('expo-file-system');
        const Sharing = require('expo-sharing');
        const file = new File(Paths.cache, filename);
        file.write(csv);
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(file.uri, { mimeType: 'text/csv', dialogTitle: 'NorthShift expense report' });
          setExportMsg(`Exported ${rows.length} expenses.`);
        } else {
          setExportMsg('Sharing is not available on this device.');
        }
      }
    } catch (e) {
      setExportMsg('Export failed: ' + (e.message || 'unknown error'));
    }
  };

  const printReport = () => {
    if (typeof window === 'undefined') return;
    setExportMsg('');
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { setExportMsg('Pop-up blocked — allow pop-ups for this site, then try Print again.'); return; }
    const rowsHtml = filteredRows.map((e) => (
      '<tr><td>' + escHtml(e.expense_date) + '</td><td>' + escHtml(nameOf(e.user_id)) + '</td><td>' + escHtml(e.type) + '</td><td>' + escHtml(e.category) + '</td><td>' + escHtml(e.merchant || '') + '</td><td>' + (splitAmount(e) / 100).toFixed(2) + '</td><td>' + escHtml(e.status) + '</td><td>' + escHtml(e.reimbursement_status) + '</td><td>' + (e.status === 'approved' && e.reviewed_by === e.user_id ? 'self-approved' : '') + '</td></tr>'
    )).join('');
    win.document.write(
      '<!doctype html><html><head><title>NorthShift Expense Report &mdash; ' + escHtml(periodLabel) + '</title>' +
      '<style>body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#1c1917}' +
      '.sheet{max-width:900px;margin:32px auto;padding:24px}' +
      '.brand{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#0F766E;font-weight:700}' +
      'h1{font-size:24px;margin:8px 0 4px}.totals{font-size:14px;color:#57534e;margin:0 0 20px}' +
      'table{width:100%;border-collapse:collapse;font-size:13px}' +
      'th,td{border:1px solid #d6d3d1;padding:6px 8px;text-align:left}th{background:#f5f5f4}</style></head><body>' +
      '<div class="sheet"><div class="brand">NorthShift</div>' +
      '<h1>Expense Report &mdash; ' + escHtml(periodLabel) + '</h1>' +
      '<p class="totals">Approved ' + escHtml(fmtCents(totalApproved)) + ' &middot; Pending ' + escHtml(fmtCents(totalPending)) + ' &middot; Reimbursement due ' + escHtml(fmtCents(reimbDue)) + ' &middot; Mileage ' + periodMileageKm.toFixed(1) + ' km ' + escHtml(fmtCents(periodMileageAmt)) + ' &middot; Denied ' + escHtml(fmtCents(totalDenied)) + '</p>' +
      '<table><tr><th>Date</th><th>Employee</th><th>Type</th><th>Category</th><th>Merchant</th><th>Amount (CAD)</th><th>Status</th><th>Reimbursement</th><th>Flags</th></tr>' + rowsHtml + '</table>' +
      '<p class="totals">Mileage amounts use the year-to-date 5,000 km tier split.</p></div>' +
      '<script>window.onload = function () { window.focus(); window.print(); };' +
      'window.onafterprint = function () { window.close(); };</script>' +
      '</body></html>'
    );
    win.document.close();
    setExportMsg('Print view opened — use your browser\'s print dialog.');
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

  // ---- Manager report derivations (computed from loaded rows, no extra queries) ----
  const periodLabel = reportPeriod === 'day' ? fmtDate(reportDay) : reportPeriod === 'week' ? `${fmtDate(reportWeekStart)} – ${fmtDate(addDaysIso(reportWeekStart, 6))}` : `${monthName(reportMonth)} ${reportYear}`;
  const periodKey = reportPeriod === 'day' ? reportDay : reportPeriod === 'week' ? `${reportWeekStart}_week` : `${reportYear}-${String(reportMonth).padStart(2, '0')}`;
  const periodYear = reportPeriod === 'month' ? reportYear : Number((reportPeriod === 'day' ? reportDay : reportWeekStart).slice(0, 4));
  const periodRows = yearExpenses.filter((e) => {
    if (reportPeriod === 'day') return e.expense_date === reportDay;
    if (reportPeriod === 'week') return e.expense_date >= reportWeekStart && e.expense_date <= addDaysIso(reportWeekStart, 6);
    return e.expense_date.slice(0, 7) === `${reportYear}-${String(reportMonth).padStart(2, '0')}`;
  });
  const approvedMileageYear = yearExpenses.filter((e) => e.type === 'mileage' && e.status === 'approved');
  // Tier splits are per calendar year: compute one map per loaded year
  // and merge, so a New-Year-spanning week splits each entry in its
  // own year. mileageSplitByEntry filters by year internally.
  const splitByEntry = new Map();
  for (const y of [...new Set(yearExpenses.map((e) => Number(e.expense_date.slice(0, 4))))]) {
    for (const [k, v] of mileageSplitByEntry(approvedMileageYear, y)) splitByEntry.set(k, v);
  }
  // Report mileage amounts are tier-split exact; pending mileage falls back to
  // the stored estimate (it has no split until approved).
  const splitAmount = (e) => (e.type === 'mileage' ? (splitByEntry.get(e.id)?.amountCents ?? e.amount_cents) : e.amount_cents);
  const sumRows = (rows, fn) => rows.reduce((t, e) => t + fn(e), 0);
  const totalApproved = sumRows(periodRows.filter((e) => e.status === 'approved'), splitAmount);
  const totalPending = sumRows(periodRows.filter((e) => e.status === 'pending'), splitAmount);
  const totalDenied = sumRows(periodRows.filter((e) => e.status === 'denied'), splitAmount);
  const reimbDue = sumRows(periodRows.filter((e) => e.status === 'approved' && e.reimbursement_status === 'unpaid'), splitAmount);
  const periodMileageRows = periodRows.filter((e) => e.type === 'mileage' && e.status === 'approved');
  const periodMileageKm = sumRows(periodMileageRows, (e) => Number(e.mileage_km) || 0);
  const periodMileageAmt = sumRows(periodMileageRows, splitAmount);
  const tierRows = mileageTierSplit(approvedMileageYear, periodYear);
  const filteredRows = periodRows.filter((e) =>
    (reportEmployee === 'all' || e.user_id === reportEmployee) &&
    (reportCategory === 'all' || e.category === reportCategory) &&
    (reportStatus === 'all' || e.status === reportStatus) &&
    (reportType === 'all' || e.type === reportType) &&
    (reportReimb === 'all' || e.reimbursement_status === reportReimb)
  );
  const dueShown = filteredRows.filter((e) => e.status === 'approved' && e.reimbursement_status === 'unpaid');
  const activeFilters = [];
  if (reportEmployee !== 'all') activeFilters.push(nameOf(reportEmployee));
  if (reportCategory !== 'all') activeFilters.push(reportCategory);
  if (reportStatus !== 'all') activeFilters.push(reportStatus);
  if (reportType !== 'all') activeFilters.push(reportType);
  if (reportReimb !== 'all') activeFilters.push(reportReimb);
  const filterSummary = activeFilters.length === 0 ? 'All expenses' : activeFilters.join(' · ');
  const toggleReport = (key) => setCollapsedReport((prev) => ({ ...prev, [key]: !prev[key] }));
  const byCategory = {};
  for (const e of periodRows) { const c = byCategory[e.category] || { count: 0, total: 0 }; c.count += 1; c.total += splitAmount(e); byCategory[e.category] = c; }
  const byEmployee = {};
  for (const e of periodRows) {
    const b = byEmployee[e.user_id] || { money: 0, mileageKm: 0, mileageAmt: 0 };
    if (e.type === 'mileage') { b.mileageKm += Number(e.mileage_km) || 0; b.mileageAmt += splitAmount(e); }
    else { b.money += e.amount_cents; }
    byEmployee[e.user_id] = b;
  }

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
            {isManager && pendingQueue.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Waiting for your review ({pendingQueue.length})</Text>
                {pendingQueue.map((exp) => {
                  const badge = statusBadge(exp.status);
                  return (
                    <View key={exp.id} style={styles.docCard}>
                      <View style={styles.docTop}>
                        <Text style={styles.docName} numberOfLines={1}>
                          {nameOf(exp.user_id)} · {exp.type === 'mileage' ? `${exp.origin || ''} → ${exp.destination || ''}` : (exp.merchant || exp.category)}
                        </Text>
                        <View style={[styles.badge, { backgroundColor: badge.bg, borderColor: badge.fg }]}>
                          <Text style={[styles.badgeText, { color: badge.fg }]}>{badge.label}</Text>
                        </View>
                      </View>
                      <Text style={styles.docMeta}>
                        {fmtDate(exp.expense_date)} · {exp.type === 'mileage' ? `${exp.mileage_km} km × ${exp.mileage_rate_cents}¢` : exp.category} · {fmtCents(exp.amount_cents)}
                      </Text>
                      {exp.note ? <Text style={styles.docMeta}>{exp.note}</Text> : null}
                      {exp.receipt_path ? (
                        <View style={styles.docActions}>
                          <TouchableOpacity style={styles.smallPrimary} onPress={() => viewReceipt(exp)} disabled={busyId === exp.id}>
                            <Text style={styles.smallPrimaryText}>View Receipt</Text>
                          </TouchableOpacity>
                        </View>
                      ) : null}
                      <TextInput style={[styles.input, { marginTop: spacing.sm, marginBottom: spacing.sm }]} value={reviewNotes[exp.id] || ''} onChangeText={(v) => setReviewNotes((prev) => ({ ...prev, [exp.id]: v }))} placeholder="Review note (optional)" placeholderTextColor={colors.inputPlaceholder} />
                      <View style={styles.reviewRow}>
                        <TouchableOpacity style={styles.smallPrimary} onPress={() => reviewExpense(exp, 'approved')} disabled={busyId === exp.id}>
                          <Text style={styles.smallPrimaryText}>Approve</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.smallOutline} onPress={() => reviewExpense(exp, 'denied')} disabled={busyId === exp.id}>
                          <Text style={styles.smallOutlineText}>Deny</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
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
                      <Text style={styles.cardText}>Estimated {fmtCents(mileageAmountCents(kmPreview, datePreview.year, territory))} at {mileageRateCents(datePreview.year, territory)}¢/km. The expense report applies the 5,000 km yearly tier exactly.</Text>
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
            {isManager && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Expense Report</Text>
                <View style={styles.card}>
                  <View style={styles.chipRow}>
                    {[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([v, l]) => (
                      <TouchableOpacity key={v} style={[styles.chip, reportPeriod === v && styles.chipActive]} onPress={() => setPeriod(v)}>
                        <Text style={[styles.chipText, reportPeriod === v && styles.chipTextActive]}>{l}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <View style={styles.monthRow}>
                    <TouchableOpacity style={styles.smallOutline} onPress={prevPeriod}>
                      <Text style={styles.smallOutlineText}>← Prev</Text>
                    </TouchableOpacity>
                    <Text style={styles.monthLabel}>{periodLabel}</Text>
                    <TouchableOpacity style={styles.smallOutline} onPress={nextPeriod}>
                      <Text style={styles.smallOutlineText}>Next →</Text>
                    </TouchableOpacity>
                  </View>
                  <View style={styles.totalsStrip}>
                    <View style={styles.totalBox}><Text style={styles.totalValue}>{fmtCents(totalApproved)}</Text><Text style={styles.totalLabel}>Approved</Text></View>
                    <View style={styles.totalBox}><Text style={styles.totalValue}>{fmtCents(totalPending)}</Text><Text style={styles.totalLabel}>Pending</Text></View>
                    <View style={styles.totalBox}><Text style={styles.totalValue}>{fmtCents(reimbDue)}</Text><Text style={styles.totalLabel}>Reimbursement due</Text></View>
                    <View style={styles.totalBox}><Text style={styles.totalValue}>{periodMileageKm.toFixed(1)} km</Text><Text style={styles.totalLabel}>Mileage · {fmtCents(periodMileageAmt)}</Text></View>
                    <View style={styles.totalBox}><Text style={styles.totalValue}>{fmtCents(totalDenied)}</Text><Text style={styles.totalLabel}>Denied</Text></View>
                  </View>
                  <Text style={styles.cardText}>Mileage amounts use the year-to-date 5,000 km tier split — the payroll-exact number.</Text>
                </View>

                <View style={styles.card}>
                  <TouchableOpacity style={styles.cardHeaderRow} onPress={() => toggleReport('breakdown')}>
                    <Text style={[styles.cardTitle, { marginBottom: 0 }]}>Breakdown</Text>
                    <Text style={styles.chevron}>{collapsedReport.breakdown ? '▸' : '▾'}</Text>
                  </TouchableOpacity>
                  {!collapsedReport.breakdown && (
                    <>
                      <Text style={styles.subhead}>By category</Text>
                      {Object.keys(byCategory).length === 0 ? (
                        <Text style={styles.emptyText}>Nothing in this period.</Text>
                      ) : Object.entries(byCategory).sort((a, b) => b[1].total - a[1].total).map(([cat, v]) => (
                        <View key={cat} style={styles.reportRow}>
                          <Text style={styles.reportRowLabel}>{cat} · {v.count}</Text>
                          <Text style={styles.reportRowValue}>{fmtCents(v.total)}</Text>
                        </View>
                      ))}
                      <Text style={styles.subhead}>By employee</Text>
                      {Object.keys(byEmployee).length === 0 ? (
                        <Text style={styles.emptyText}>Nothing in this period.</Text>
                      ) : Object.entries(byEmployee).map(([uid, b]) => (
                        <View key={uid} style={styles.reportRow}>
                          <Text style={styles.reportRowLabel}>{nameOf(uid)}</Text>
                          <Text style={styles.reportRowValue}>{fmtCents(b.money)} money{b.mileageKm > 0 ? ` · ${b.mileageKm.toFixed(1)} km ${fmtCents(b.mileageAmt)}` : ''}</Text>
                        </View>
                      ))}
                    </>
                  )}
                </View>

                <View style={styles.card}>
                  <TouchableOpacity style={styles.cardHeaderRow} onPress={() => toggleReport('tier')}>
                    <Text style={[styles.cardTitle, { marginBottom: 0 }]}>Mileage tier split · {periodYear}</Text>
                    <Text style={styles.chevron}>{collapsedReport.tier ? '▸' : '▾'}</Text>
                  </TouchableOpacity>
                  {!collapsedReport.tier && (
                    <>
                      {tierRows.length === 0 ? (
                        <Text style={styles.emptyText}>No approved mileage this year.</Text>
                      ) : tierRows.map((t) => (
                        <View key={t.user_id} style={styles.reportRow}>
                          <Text style={styles.reportRowLabel}>{nameOf(t.user_id)}</Text>
                          <Text style={styles.reportRowValue}>{t.kmUnder.toFixed(1)} km @ tier 1 = {fmtCents(t.tier1Cents)}{t.kmOver > 0 ? ` · ${t.kmOver.toFixed(1)} km @ tier 2 = ${fmtCents(t.tier2Cents)}` : ''}</Text>
                        </View>
                      ))}
                    </>
                  )}
                </View>

                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Expenses · {periodLabel}</Text>
                  <Text style={styles.cardText}>Showing {filteredRows.length} of {periodRows.length} expenses.</Text>
                  <View style={styles.docActions}>
                    <TouchableOpacity style={styles.smallPrimary} onPress={exportReportCsv}>
                      <Text style={styles.smallPrimaryText}>Export CSV</Text>
                    </TouchableOpacity>
                    {Platform.OS === 'web' && (
                      <TouchableOpacity style={styles.smallOutline} onPress={printReport}>
                        <Text style={styles.smallOutlineText}>Print</Text>
                      </TouchableOpacity>
                    )}
                    {dueShown.length > 0 && (
                      <TouchableOpacity style={styles.smallOutline} onPress={markAllShownPaid} disabled={busyId === 'batch'}>
                        <Text style={styles.smallOutlineText}>{confirmMarkAllPaid ? `Tap again to mark ${dueShown.length} paid` : `Mark all shown paid (${dueShown.length})`}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  {exportMsg ? <Text style={styles.cardText}>{exportMsg}</Text> : null}
                </View>

                <View style={styles.card}>
                  <TouchableOpacity style={styles.cardHeaderRow} onPress={() => toggleReport('filters')}>
                    <Text style={[styles.cardTitle, { marginBottom: 0 }]}>Filters · {filterSummary}</Text>
                    <Text style={styles.chevron}>{collapsedReport.filters ? '▸' : '▾'}</Text>
                  </TouchableOpacity>
                  {!collapsedReport.filters && (
                    <>
                      <Text style={styles.label}>Employee</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRowH}>
                        <TouchableOpacity style={[styles.chip, reportEmployee === 'all' && styles.chipActive]} onPress={() => setReportEmployee('all')}>
                          <Text style={[styles.chipText, reportEmployee === 'all' && styles.chipTextActive]}>Everyone</Text>
                        </TouchableOpacity>
                        {people.map((p) => (
                          <TouchableOpacity key={p.id} style={[styles.chip, reportEmployee === p.id && styles.chipActive]} onPress={() => setReportEmployee(p.id)}>
                            <Text style={[styles.chipText, reportEmployee === p.id && styles.chipTextActive]}>{p.id === myId ? 'Me' : (p.full_name || 'Unknown')}</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                      <Text style={styles.label}>Category</Text>
                      <View style={styles.chipRow}>
                        <TouchableOpacity style={[styles.chip, reportCategory === 'all' && styles.chipActive]} onPress={() => setReportCategory('all')}>
                          <Text style={[styles.chipText, reportCategory === 'all' && styles.chipTextActive]}>All</Text>
                        </TouchableOpacity>
                        {[...CATEGORIES, MILEAGE_CATEGORY].map((c) => (
                          <TouchableOpacity key={c} style={[styles.chip, reportCategory === c && styles.chipActive]} onPress={() => setReportCategory(c)}>
                            <Text style={[styles.chipText, reportCategory === c && styles.chipTextActive]}>{c}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                      <Text style={styles.label}>Status</Text>
                      <View style={styles.chipRow}>
                        {[['all', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['denied', 'Denied']].map(([v, l]) => (
                          <TouchableOpacity key={v} style={[styles.chip, reportStatus === v && styles.chipActive]} onPress={() => setReportStatus(v)}>
                            <Text style={[styles.chipText, reportStatus === v && styles.chipTextActive]}>{l}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                      <Text style={styles.label}>Type</Text>
                      <View style={styles.chipRow}>
                        {[['all', 'All'], ['expense', 'Expense'], ['mileage', 'Mileage']].map(([v, l]) => (
                          <TouchableOpacity key={v} style={[styles.chip, reportType === v && styles.chipActive]} onPress={() => setReportType(v)}>
                            <Text style={[styles.chipText, reportType === v && styles.chipTextActive]}>{l}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                      <Text style={styles.label}>Reimbursement</Text>
                      <View style={styles.chipRow}>
                        {[['all', 'All'], ['unpaid', 'Unpaid'], ['paid', 'Paid']].map(([v, l]) => (
                          <TouchableOpacity key={v} style={[styles.chip, reportReimb === v && styles.chipActive]} onPress={() => setReportReimb(v)}>
                            <Text style={[styles.chipText, reportReimb === v && styles.chipTextActive]}>{l}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </>
                  )}
                </View>

                {filteredRows.length === 0 ? (
                  <Text style={styles.emptyText}>No expenses match these filters.</Text>
                ) : filteredRows.map((exp) => {
                  const badge = statusBadge(exp.status);
                  const selfApproved = exp.status === 'approved' && exp.reviewed_by === exp.user_id;
                  return (
                    <View key={exp.id} style={styles.docCard}>
                      <View style={styles.docTop}>
                        <Text style={styles.docName} numberOfLines={1}>
                          {nameOf(exp.user_id)} · {exp.type === 'mileage' ? `${exp.origin || ''} → ${exp.destination || ''}` : (exp.merchant || exp.category)}
                        </Text>
                        <View style={[styles.badge, { backgroundColor: badge.bg, borderColor: badge.fg }]}>
                          <Text style={[styles.badgeText, { color: badge.fg }]}>{badge.label}</Text>
                        </View>
                      </View>
                      <Text style={styles.docMeta}>
                        {fmtDate(exp.expense_date)} · {exp.type === 'mileage' ? `${exp.mileage_km} km × ${exp.mileage_rate_cents}¢` : exp.category} · {fmtCents(splitAmount(exp))}
                        {exp.status === 'approved' ? (exp.reimbursement_status === 'paid' ? ' · Reimbursed' : ' · Awaiting reimbursement') : ''}
                        {selfApproved ? ' · Self-approved' : ''}
                      </Text>
                      {exp.note ? <Text style={styles.docMeta}>{exp.note}</Text> : null}
                      {exp.review_note ? <Text style={styles.docMeta}>Manager note: {exp.review_note}</Text> : null}
                      <View style={styles.docActions}>
                        {exp.receipt_path ? (
                          <TouchableOpacity style={styles.smallPrimary} onPress={() => viewReceipt(exp)} disabled={busyId === exp.id}>
                            <Text style={styles.smallPrimaryText}>View Receipt</Text>
                          </TouchableOpacity>
                        ) : null}
                        {exp.status === 'approved' && exp.reimbursement_status === 'unpaid' && (
                          <TouchableOpacity style={styles.smallOutline} onPress={() => markPaid(exp)} disabled={busyId === exp.id}>
                            <Text style={styles.smallOutlineText}>Mark paid</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
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
  reviewRow: { flexDirection: 'row', gap: spacing.sm },
  chipRowH: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.xs, marginBottom: spacing.md },
  monthRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  monthLabel: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary },
  totalsStrip: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  totalBox: { flexGrow: 1, flexBasis: 100, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, padding: spacing.sm, alignItems: 'center' },
  totalValue: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary },
  totalLabel: { fontFamily: fontFamily.regular, fontSize: 12, color: colors.textSecondary, textAlign: 'center' },
  reportRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, paddingVertical: spacing.xs },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44 },
  chevron: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textSecondary },
  subhead: { fontSize: 14, fontFamily: fontFamily.semibold, color: colors.textPrimary, marginTop: spacing.md, marginBottom: spacing.xs },
  reportRowLabel: { flex: 1, fontFamily: fontFamily.regular, fontSize: 13, color: colors.textPrimary },
  reportRowValue: { fontFamily: fontFamily.semibold, fontSize: 13, color: colors.textPrimary, textAlign: 'right' },
});
