import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, ScrollView, ActivityIndicator, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform, FlatList, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Link, useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, spacing, radius, type, elevation, fontFamily, buttons } from '../lib/theme';
import { computeWeeklyOvertime, OT_THRESHOLD_HOURS, findMealBreakViolations, buildAuditCsv } from '../supabase/functions/hr-ai-bot/logic';
import { maxMinutesForBreakType, DEFAULT_BREAK_POLICY, PROVINCE_BREAK_RULES } from '../supabase/functions/hr-ai-bot/logic';

// Added Keys for the Edge Function connection
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export default function ManagerDashboard() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [userRole, setUserRole] = useState('manager');
  const [businessName, setBusinessName] = useState('');
  const [currentUser, setCurrentUser] = useState(null);
  
  const [logs, setLogs] = useState([]);
  const [exceptions, setExceptions] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [excErrorMsg, setExcErrorMsg] = useState('');
  const [breaks, setBreaks] = useState([]);
  const [myBusinessId, setMyBusinessId] = useState(null);
  const [breakPolicy, setBreakPolicy] = useState({ ...DEFAULT_BREAK_POLICY, province: 'ON' });
  const [exportDays, setExportDays] = useState(14);
  const [exportMsg, setExportMsg] = useState('');
  const [filter, setFilter] = useState('ALL'); // ALL, ANOMALIES, EXCEPTIONS, AI
  const [payrollFormat, setPayrollFormat] = useState('STANDARD'); 

  // --- NEW AI CHAT STATE ---
  const [messages, setMessages] = useState([{ id: '1', role: 'bot', content: 'Hello! I am your NorthShift assistant. How can I help you manage the team today?' }]);
  const [inputText, setInputText] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);

  useEffect(() => {
    checkManagerAccessAndFetchData();
  }, []);

  const checkManagerAccessAndFetchData = async () => {
    try {
      setLoading(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setIsAuthorized(false);
        setLoading(false);
        return;
      }

      setCurrentUser(session.user);
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', session.user.id)
        .single();

      if (profileError || !profile || (profile.role !== 'manager' && profile.role !== 'admin')) {
        setIsAuthorized(false);
        setLoading(false);
        return;
      }

      setIsAuthorized(true);
      setUserRole(profile.role);
      const { data: profBiz } = await supabase.from('profiles').select('business_id').eq('id', session.user.id).single();
      if (profBiz && profBiz.business_id) {
        const { data: biz } = await supabase.from('businesses').select('business_name').eq('id', profBiz.business_id).single();
        if (biz) setBusinessName(biz.business_name || '');
      }
      if (profBiz && profBiz.business_id) {
        setMyBusinessId(profBiz.business_id);
        const { data: pol } = await supabase.from('break_policies').select('*').eq('business_id', profBiz.business_id).maybeSingle();
        if (pol) {
          const rule = PROVINCE_BREAK_RULES[pol.province] || PROVINCE_BREAK_RULES.ON;
          setBreakPolicy({
            province: pol.province || 'ON',
            meal_minutes: Math.max(pol.meal_minutes || 0, rule.meal_minutes || 0),
            rest_minutes: pol.rest_minutes || DEFAULT_BREAK_POLICY.rest_minutes,
            rest_max_per_shift: pol.rest_max_per_shift ?? DEFAULT_BREAK_POLICY.rest_max_per_shift,
            meal_paid_if_available: pol.meal_paid_if_available ?? DEFAULT_BREAK_POLICY.meal_paid_if_available,
          });
        }
      }
      await fetchAllManagerData();
    } catch (err) {
      console.error('Authorization error:', err);
      setIsAuthorized(false);
    } finally {
      setLoading(false);
    }
  };

  const fetchAllManagerData = async () => {
    const { data: logsData, error: logsError } = await supabase
      .from('time_logs')
      .select(`
        id, user_id, clock_in, clock_out, ai_anomaly_flag,
        profiles ( full_name, email, first_name, last_name ),
        worksites ( name )
      `)
      .order('clock_in', { ascending: false });

    if (logsError) console.error('Logs Error:', logsError.message);
    if (logsData) setLogs(logsData);

    const { data: breaksData } = await supabase
      .from('time_breaks')
      .select('id, time_log_id, break_type, start_time, end_time');
    if (breaksData) setBreaks(breaksData);

    const { data: excData, error: excError } = await supabase
      .from('time_exceptions')
      .select(`
        id, attempted_at, distance_meters, reason_note, status, user_id, worksite_id,
        profiles!time_exceptions_user_id_fkey ( full_name, email, first_name, last_name ), worksites ( name )
      `)
      .order('attempted_at', { ascending: false });

    if (excError) {
      console.error('Exceptions Error:', excError.message);
      setExcErrorMsg(excError.message);
      setExceptions([]);
    } else if (excData) {
      setExcErrorMsg('');
      setExceptions(excData);
    }
  };

  const handleUpdateException = async (exceptionId, newStatus) => {
    const { error } = await supabase
      .from('time_exceptions')
      .update({ status: newStatus, reviewed_by: currentUser?.id })
      .eq('id', exceptionId);

    if (error) {
      console.error('Error updating exception:', error.message);
    } else {
      fetchAllManagerData();
    }
  };

  // Review an AI anomaly: approve keeps the shift, deny disputes it.
  // Either way the ⚠️ clears so it leaves the anomalies tab, and the
  // review decision (+ optional quick note) stays visible in the log history.
  const [reviewingAnomaly, setReviewingAnomaly] = useState(null); // { logId, decision }
  const [reviewNote, setReviewNote] = useState('');

  const handleReviewAnomaly = async (logId, decision, note) => {
    const log = logs.find((l) => l.id === logId);
    if (!log) return;
    const original = (log.ai_anomaly_flag || '').replace(/⚠️\s*/g, '').trim();
    const notePart = note && note.trim() ? ` — "${note.trim()}"` : '';
    const newFlag = decision === 'approved'
      ? `✓ Approved by manager — ${original}${notePart}`
      : `✕ Rejected by manager — ${original}${notePart}`;
    const { error } = await supabase
      .from('time_logs')
      .update({ ai_anomaly_flag: newFlag })
      .eq('id', logId);
    if (error) {
      console.error('Error reviewing anomaly:', error.message);
    } else {
      setReviewingAnomaly(null);
      setReviewNote('');
      fetchAllManagerData();
    }
  };

  const formatDateTime = (isoString) => {
    if (!isoString) return 'Active Shift';
    const date = new Date(isoString);
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const calculateDuration = (inTime, outTime) => {
    if (!outTime) {
      const diffMs = new Date().getTime() - new Date(inTime).getTime();
      return (diffMs / (1000 * 60 * 60)).toFixed(2) + ' hrs (Ongoing)';
    }
    const diffMs = new Date(outTime).getTime() - new Date(inTime).getTime();
    return (diffMs / (1000 * 60 * 60)).toFixed(2) + ' hrs';
  };

  const handlePayrollExport = () => {
    // Keeping your existing export logic exactly as it was
    if (logs.length === 0) return;
    let headers = [];
    let rows = [];
    let filename = '';

    if (payrollFormat === 'QUICKBOOKS') {
      headers = ['Employee', 'Email', 'Location', 'Date', 'Total Hours', 'Classification'];
      rows = logs.map(log => {
        const name = (log.profiles?.full_name || `${log.profiles?.first_name || ''} ${log.profiles?.last_name || ''}`).replace(/,/g, '');
        const email = log.profiles?.email || '';
        const worksite = (log.worksites?.name || 'Office').replace(/,/g, '');
        const date = log.clock_in ? new Date(log.clock_in).toISOString().split('T')[0] : '';
        let hours = '0.00';
        if (log.clock_in && log.clock_out) {
          const diffMs = new Date(log.clock_out).getTime() - new Date(log.clock_in).getTime();
          hours = (diffMs / (1000 * 60 * 60)).toFixed(2);
        }
        const payType = log.ai_anomaly_flag?.includes('⚠️') ? 'Review Needed' : 'Regular Time';
        return `"${name}","${email}","${worksite}","${date}","${hours}","${payType}"`;
      });
      filename = `quickbooks_payroll_${new Date().toISOString().split('T')[0]}.csv`;

    } else if (payrollFormat === 'ADP') {
      headers = ['Employee Name', 'Email', 'Worksite', 'Clock In', 'Clock Out', 'Status Code'];
      rows = logs.map(log => {
        const name = (log.profiles?.full_name || `${log.profiles?.first_name || ''} ${log.profiles?.last_name || ''}`).replace(/,/g, '');
        const email = log.profiles?.email || '';
        const worksite = (log.worksites?.name || 'Office').replace(/,/g, '');
        const clockIn = log.clock_in ? new Date(log.clock_in).toISOString() : '';
        const clockOut = log.clock_out ? new Date(log.clock_out).toISOString() : '';
        const statusCode = log.ai_anomaly_flag?.includes('⚠️') ? 'ERR-FLAG' : 'REG';
        return `"${name}","${email}","${worksite}","${clockIn}","${clockOut}","${statusCode}"`;
      });
      filename = `adp_workforce_export_${new Date().toISOString().split('T')[0]}.csv`;

    } else {
      headers = ['Employee Name', 'Email', 'Worksite', 'Clock In', 'Clock Out', 'Status'];
      rows = logs.map(log => {
        const name = (log.profiles?.full_name || `${log.profiles?.first_name || ''} ${log.profiles?.last_name || ''}`).replace(/,/g, '');
        const email = log.profiles?.email || '';
        const worksite = (log.worksites?.name || 'Unassigned').replace(/,/g, '');
        const clockIn = log.clock_in ? new Date(log.clock_in).toISOString() : '';
        const clockOut = log.clock_out ? new Date(log.clock_out).toISOString() : '';
        const status = (log.ai_anomaly_flag || 'Normal Shift').replace(/,/g, '');
        return `"${name}","${email}","${worksite}","${clockIn}","${clockOut}","${status}"`;
      });
      filename = `easy_hr_standard_export_${new Date().toISOString().split('T')[0]}.csv`;
    }

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // --- NEW AI CHAT SEND FUNCTION ---
  const sendMessage = async (text) => {
    if (!text.trim()) return;

    const userMsg = { id: Date.now().toString(), role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInputText('');
    setIsChatLoading(true);

    // Send recent conversation so the bot can resolve "them", bare names, etc.
    const history = [...messages, userMsg].slice(-10).map((m) => ({
      role: m.role === 'bot' ? 'assistant' : 'user',
      content: m.content,
    }));

    try {
      const { data: { session } } = await supabase.auth.getSession();
      // One automatic retry for transient provider errors, so a single
      // blip does not surface as a failure in chat.
      let data = null;
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/hr-ai-bot`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt: text,
            managerId: currentUser?.id || 'mgr_123',
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            history,
          }),
        });
        data = await response.json();
        if (!data.error) break;
        if (attempt >= 1 || !/rate|provider|internal|network|fetch/i.test(data.error)) throw new Error(data.error);
        await new Promise((r) => setTimeout(r, 1000));
      }

      const botMsg = { id: (Date.now() + 1).toString(), role: 'bot', content: (data.reply || '').replace(/\*\*/g, '') };
      setMessages((prev) => [...prev, botMsg]);
    } catch (error) {
      const friendly = /rate|provider|internal|network|fetch/i.test(error.message || '') ? 'The assistant is busy right now — please try again in a moment.' : 'Something went wrong with the assistant — please try again.';
      const errorMsg = { id: (Date.now() + 1).toString(), role: 'bot', content: friendly };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsChatLoading(false);
    }
  };

  const pendingExceptionsCount = exceptions.filter(e => e.status === 'pending').length;

  const overtimeRows = computeWeeklyOvertime(
    logs.filter(l => l.user_id).map(l => ({
      user_id: l.user_id,
      full_name: l.profiles?.full_name,
      clock_in: l.clock_in,
      clock_out: l.clock_out,
    })),
    Date.now()
  );
  const otWatch = overtimeRows.filter(r => r.status !== 'ok');

  const handleExport = async () => {
    try {
      setExportMsg('Building export...');
      const sinceMs = Date.now() - exportDays * 24 * 3600 * 1000;
      const rows = logs
        .filter(l => l.user_id && l.clock_out && new Date(l.clock_in).getTime() >= sinceMs)
        .map(l => ({
          log_id: l.id,
          user_id: l.user_id,
          full_name: l.profiles?.full_name,
          email: l.profiles?.email,
          worksite_name: l.worksites?.name,
          clock_in: l.clock_in,
          clock_out: l.clock_out,
          anomaly_flag: l.ai_anomaly_flag,
          breaks: breaks
            .filter(b => b.time_log_id === l.id)
            .map(b => ({ break_type: b.break_type, start_time: b.start_time, end_time: b.end_time })),
        }));
      if (rows.length === 0) {
        setExportMsg('No completed shifts in that range.');
        return;
      }
      const csv = buildAuditCsv(rows, Date.now());
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `northshift-audit-${stamp}.csv`;
      if (Platform.OS === 'web') {
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        setExportMsg(`Exported ${rows.length} shifts.`);
      } else {
        const { File, Paths } = require('expo-file-system');
        const Sharing = require('expo-sharing');
        const file = new File(Paths.cache, filename);
        file.write(csv);
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(file.uri, { mimeType: 'text/csv', dialogTitle: 'NorthShift audit export' });
          setExportMsg(`Exported ${rows.length} shifts.`);
        } else {
          setExportMsg('Sharing is not available on this device.');
        }
      }
    } catch (e) {
      setExportMsg('Export failed: ' + (e.message || 'unknown error'));
    }
  };

  const fourteenDaysAgo = Date.now() - 14 * 24 * 3600 * 1000;
  const complianceFlags = findMealBreakViolations(
    logs
      .filter(l => l.user_id && new Date(l.clock_in).getTime() >= fourteenDaysAgo)
      .map(l => ({
        log_id: l.id,
        user_id: l.user_id,
        full_name: l.profiles?.full_name,
        clock_in: l.clock_in,
        clock_out: l.clock_out,
        breaks: breaks
          .filter(b => b.time_log_id === l.id)
          .map(b => ({ start_time: b.start_time, end_time: b.end_time })),
      })),
    Date.now()
  );

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.loadingText}>Verifying Manager Permissions...</Text>
      </View>
    );
  }

  if (!isAuthorized) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centerContainer}>
          <View style={styles.deniedCard}>
            <Text style={styles.deniedTitle}>Access Denied</Text>
            <Text style={styles.deniedText}>You must be logged in with a Manager account to view this portal.</Text>
            <TouchableOpacity style={styles.primaryButton} onPress={() => router.push('/')}>
              <Text style={styles.primaryButtonText}>← Return to Employee Portal</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View>
          <View style={styles.brandRow}>
            <Image source={require('../assets/images/icon.png')} style={styles.brandLogo} />
            <Text style={styles.title}>NorthShift</Text>
          </View>
          {businessName ? <Text style={styles.subtitle}>{businessName} · Manager Portal</Text> : <Text style={styles.subtitle}>Manager Portal · Time Audits & Exceptions</Text>}
        </View>
        <TouchableOpacity style={styles.navButton} onPress={() => setMenuOpen(!menuOpen)}>
          <Text style={styles.navButtonText}>☰ Menu</Text>
        </TouchableOpacity>
      </View>
      {menuOpen && (
        <View style={styles.menuPanel}>
          {[
            ['Team', '/team'],
            ['Documents', '/documents'],
            ['Time Off', '/timeoff'],
            ['Reports', '/reports'],
            ['Break Policy', '/break-policy'],
            ['Schedule', '/schedule'],
            ['QR Codes', '/qrcodes'],
            ['Profile', '/profile'],
            ['← Employee Portal', '/'],
          ].map(([label, href]) => (
            <TouchableOpacity key={href} style={styles.menuItem} onPress={() => { setMenuOpen(false); router.push(href); }}>
              <Text style={styles.menuItemText}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {userRole === 'admin' && (
        <View style={styles.adminCard}>
          <View>
            <Text style={styles.adminCardTitle}>Administration</Text>
            <Text style={styles.adminCardText}>Add managers, manage roles and access.</Text>
          </View>
          <View style={{ gap: 8 }}>
            <Link href="/users" asChild>
              <TouchableOpacity style={styles.adminCardButton}>
                    <Text style={styles.adminCardButtonText}>Manage Users →</Text>
              </TouchableOpacity>
            </Link>
            <Link href="/subscription" asChild>
              <TouchableOpacity style={styles.adminCardButton}>
                <Text style={styles.adminCardButtonText}>Subscription →</Text>
              </TouchableOpacity>
            </Link>
          </View>
        </View>
      )}

      <View style={styles.otCard}>
        <Text style={styles.otTitle}>Overtime Watch · This Week</Text>
        {otWatch.length === 0 ? (
          <Text style={styles.otClear}>All clear — nobody is close to the {OT_THRESHOLD_HOURS}h overtime line this week.</Text>
        ) : otWatch.map(r => (
          <View key={r.user_id} style={styles.otRow}>
            <View style={styles.otRowTop}>
              <Text style={styles.otName}>{r.name}</Text>
              <Text style={styles.otHours}>{r.hours.toFixed(1)}h</Text>
            </View>
            <View style={styles.otBarTrack}>
              <View style={[styles.otBarFill, { width: `${Math.min(100, (r.hours / OT_THRESHOLD_HOURS) * 100)}%`, backgroundColor: r.status === 'overtime' ? colors.danger : colors.warning }]} />
            </View>
            <Text style={[styles.otNote, { color: r.status === 'overtime' ? colors.danger : colors.warning }]}>
              {r.status === 'overtime'
                ? `In overtime — ${r.overtime_hours.toFixed(1)}h past the ${OT_THRESHOLD_HOURS}h line`
                : `Approaching overtime — ${(OT_THRESHOLD_HOURS - r.hours).toFixed(1)}h to the ${OT_THRESHOLD_HOURS}h line`}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.otCard}>
        <Text style={styles.otTitle}>Break Compliance · Last 14 Days</Text>
        {complianceFlags.length === 0 ? (
          <Text style={styles.otClear}>All clear — every recent shift had its 30-minute meal break.</Text>
        ) : (
          <>
            {complianceFlags.slice(0, 5).map(f => (
              <View key={f.log_id} style={styles.bcRow}>
                <View style={styles.otRowTop}>
                  <Text style={styles.otName}>{f.name}</Text>
                  <Text style={styles.bcDate}>{new Date(f.clock_in).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</Text>
                </View>
                <Text style={styles.bcMsg}>{f.message}</Text>
              </View>
            ))}
            {complianceFlags.length > 5 && (
              <Text style={styles.bcMore}>+ {complianceFlags.length - 5} more flagged shifts</Text>
            )}
          </>
        )}
      </View>

      <View style={styles.otCard}>
        <Text style={styles.otTitle}>Audit Export</Text>
        <Text style={styles.otClear}>One CSV with every completed shift, break, overtime total and compliance flag — ready for payroll or an ESA audit.</Text>
        <View style={styles.exportChips}>
          {[7, 14, 30].map(d => (
            <TouchableOpacity key={d} style={[styles.filterTab, exportDays === d && styles.activeFilterTab]} onPress={() => setExportDays(d)}>
              <Text style={[styles.filterText, exportDays === d && styles.activeFilterText]}>{d} days</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity style={styles.exportBtn} onPress={handleExport}>
          <Text style={styles.exportBtnText}>Export Last {exportDays} Days</Text>
        </TouchableOpacity>
        {exportMsg ? <Text style={styles.exportMsg}>{exportMsg}</Text> : null}
      </View>

      <View style={styles.filterBar}>
        <TouchableOpacity style={[styles.filterTab, filter === 'ALL' && styles.activeFilterTab]} onPress={() => setFilter('ALL')}>
          <Text style={[styles.filterText, filter === 'ALL' && styles.activeFilterText]}>All Logs ({logs.length})</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.filterTab, filter === 'ANOMALIES' && styles.activeFilterTab]} onPress={() => setFilter('ANOMALIES')}>
          <Text style={[styles.filterText, filter === 'ANOMALIES' && styles.activeFilterText]}>
            AI Anomalies ({logs.filter(l => l.ai_anomaly_flag?.includes('⚠️')).length})
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.filterTab, filter === 'EXCEPTIONS' && styles.activeFilterTab]} onPress={() => setFilter('EXCEPTIONS')}>
          <Text style={[styles.filterText, filter === 'EXCEPTIONS' && styles.activeFilterText]}>
            Geo Exceptions ({pendingExceptionsCount} pending)
          </Text>
        </TouchableOpacity>

        {/* NEW AI TAB */}
        <TouchableOpacity style={[styles.filterTab, filter === 'AI' && styles.aiTabActive]} onPress={() => setFilter('AI')}>
          <Text style={[styles.filterText, filter === 'AI' ? styles.aiTabTextActive : styles.aiTabText]}>
            ✦ AI Assistant
          </Text>
        </TouchableOpacity>

        <View style={styles.exportSection}>
          {filter !== 'EXCEPTIONS' && filter !== 'AI' && (
            <>
              <Text style={styles.label}>Payroll export — all logs in this list (separate from the Audit Export above)</Text>
              <View style={styles.formatSelector}>
                <TouchableOpacity style={[styles.formatTab, payrollFormat === 'STANDARD' && styles.activeFormatTab]} onPress={() => setPayrollFormat('STANDARD')}>
                  <Text style={[styles.formatText, payrollFormat === 'STANDARD' && styles.activeFormatText]}>Standard</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.formatTab, payrollFormat === 'QUICKBOOKS' && styles.activeFormatTab]} onPress={() => setPayrollFormat('QUICKBOOKS')}>
                  <Text style={[styles.formatText, payrollFormat === 'QUICKBOOKS' && styles.activeFormatText]}>QuickBooks</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.formatTab, payrollFormat === 'ADP' && styles.activeFormatTab]} onPress={() => setPayrollFormat('ADP')}>
                  <Text style={[styles.formatText, payrollFormat === 'ADP' && styles.activeFormatText]}>ADP</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity style={styles.exportButton} onPress={handlePayrollExport}>
                <Text style={styles.exportButtonText}>Export {payrollFormat}</Text>
              </TouchableOpacity>
            </>
          )}
          <TouchableOpacity style={styles.refreshButton} onPress={fetchAllManagerData}>
            <Text style={styles.refreshButtonText}>↻</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* RENDER CHAT OR DASHBOARD CONTENT */}
      {filter === 'AI' ? (
        <KeyboardAvoidingView style={styles.chatWrapper} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <FlatList
            data={messages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.chatList}
            renderItem={({ item }) => (
              <View style={[styles.messageBubble, item.role === 'user' ? styles.userBubble : styles.botBubble]}>
                <Text style={[styles.messageText, item.role === 'user' ? styles.userText : styles.botText]}>
                  {item.content}
                </Text>
              </View>
            )}
          />
          <View style={styles.inputContainer}>
            <TextInput
              style={styles.chatInput}
              placeholder="Ask about geo-exceptions..."
              placeholderTextColor={colors.inputPlaceholder}
              value={inputText}
              onChangeText={setInputText}
              editable={!isChatLoading}
            />
            <TouchableOpacity style={styles.sendButton} onPress={() => sendMessage(inputText)} disabled={isChatLoading}>
              {isChatLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.sendButtonText}>Send</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      ) : (
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {filter === 'EXCEPTIONS' ? (
            excErrorMsg ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyTitle}>Could not load exceptions</Text>
                <Text style={styles.emptyText}>{excErrorMsg}</Text>
              </View>
            ) : exceptions.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyTitle}>All clear</Text>
                <Text style={styles.emptyText}>No out-of-range exception requests. When an employee clocks in outside a worksite, it'll land here for your review.</Text>
              </View>
            ) : (
              exceptions.map((exc) => {
                const employeeName = exc.profiles?.full_name || `${exc.profiles?.first_name || ''} ${exc.profiles?.last_name || ''}`.trim() || 'Unknown Employee';
                const worksiteName = exc.worksites?.name || 'Selected Office';
                const isPending = exc.status === 'pending';

                return (
                  <View key={exc.id} style={[styles.logCard, isPending && styles.pendingCard]}>
                    <View style={styles.cardHeader}>
                      <Text style={styles.employeeName}>{employeeName}</Text>
                      <Text style={[styles.statusBadge, exc.status === 'approved' ? styles.badgeNormal : exc.status === 'rejected' ? styles.badgeDanger : styles.badgeWarning]}>
                        {exc.status.toUpperCase()}
                      </Text>
                    </View>
                    <View style={styles.cardBody}>
                      <View style={styles.infoRow}><Text style={styles.label}>Attempted Worksite:</Text><Text style={styles.worksiteValue}>{worksiteName}</Text></View>
                      <View style={styles.infoRow}><Text style={styles.label}>Distance from Site:</Text><Text style={styles.value}>{exc.distance_meters} meters away</Text></View>
                      <View style={styles.infoRow}><Text style={styles.label}>Attempted At:</Text><Text style={styles.value}>{formatDateTime(exc.attempted_at)}</Text></View>
                      <View style={styles.noteBox}><Text style={styles.noteLabel}>Employee Reason Note:</Text><Text style={styles.noteText}>"{exc.reason_note}"</Text></View>
                      {isPending && (
                        <View style={styles.approvalButtons}>
                          <TouchableOpacity style={styles.approveButton} onPress={() => handleUpdateException(exc.id, 'approved')}>
                            <Text style={styles.approveButtonText}>✓ Approve Exception</Text>
                          </TouchableOpacity>
                          <TouchableOpacity style={styles.rejectButton} onPress={() => handleUpdateException(exc.id, 'rejected')}>
                            <Text style={styles.rejectButtonText}>✕ Reject</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                    </View>
                  </View>
                );
              })
            )
          ) : (
            (filter === 'ANOMALIES' ? logs.filter(l => l.ai_anomaly_flag?.includes('⚠️')) : logs).length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyTitle}>{filter === 'ANOMALIES' ? 'No anomalies' : 'No time logs yet'}</Text>
                <Text style={styles.emptyText}>
                  {filter === 'ANOMALIES'
                    ? 'Nothing flagged by the AI. Shifts that look unusual will show up here automatically.'
                    : 'Once your team starts clocking in, their shifts will appear here.'}
                </Text>
              </View>
            ) : (
              (filter === 'ANOMALIES' ? logs.filter(l => l.ai_anomaly_flag?.includes('⚠️')) : logs).map((log) => {
                const isAnomaly = log.ai_anomaly_flag?.includes('⚠️');
                const employeeName = log.profiles?.full_name || `${log.profiles?.first_name || ''} ${log.profiles?.last_name || ''}`.trim() || 'Unknown Employee';
                const worksiteName = log.worksites?.name || 'Unassigned / Remote';
                
                return (
                  <View key={log.id} style={[styles.logCard, isAnomaly && styles.anomalyCard]}>
                    <View style={styles.cardHeader}>
                      <Text style={styles.employeeName}>{employeeName}</Text>
                      <Text style={[styles.statusBadge, isAnomaly ? styles.badgeDanger : styles.badgeNormal]}>{log.ai_anomaly_flag || 'Normal Shift'}</Text>
                    </View>
                    <View style={styles.cardBody}>
                      <View style={styles.infoRow}><Text style={styles.label}>Worksite Location:</Text><Text style={styles.worksiteValue}>{worksiteName}</Text></View>
                      <View style={styles.infoRow}><Text style={styles.label}>Clock In:</Text><Text style={styles.value}>{formatDateTime(log.clock_in)}</Text></View>
                      <View style={styles.infoRow}><Text style={styles.label}>Clock Out:</Text><Text style={styles.value}>{formatDateTime(log.clock_out)}</Text></View>
                      <View style={styles.infoRow}><Text style={styles.label}>Total Duration:</Text><Text style={styles.valueBold}>{calculateDuration(log.clock_in, log.clock_out)}</Text></View>                      <View style={styles.infoRow}><Text style={styles.label}>Total Duration:</Text><Text style={styles.valueBold}>{calculateDuration(log.clock_in, log.clock_out)}</Text></View>
                      {(() => {
                        const logBreaks = breaks.filter(b => b.time_log_id === log.id);
                        const notes = [];
                        for (const b of logBreaks) {
                          if (b.break_type === 'On-call Meal') notes.push('On-call Meal — review pay treatment');
                          if (b.start_time && b.end_time) {
                            const dur = Math.max(0, Math.round((new Date(b.end_time).getTime() - new Date(b.start_time).getTime()) / 60000));
                            const max = maxMinutesForBreakType(b.break_type, breakPolicy);
                            if (dur > max) notes.push(`Break overrun: ${b.break_type} ran ${dur} min vs ${max} min allowed`);
                          }
                        }
                        return notes.length ? (
                          <View style={styles.noteBox}>{notes.map((n, i) => (<Text key={i} style={styles.noteText}>⚠️ {n}</Text>))}</View>
                        ) : null;
                      })()}
                      {isAnomaly && (
                        reviewingAnomaly?.logId === log.id ? (
                          <View style={styles.reviewNoteWrap}>
                            <TextInput
                              style={styles.reviewNoteInput}
                              placeholder={reviewingAnomaly.decision === 'approved' ? 'Quick note (optional) — e.g. overtime authorized' : 'Quick note (optional) — e.g. buddy punching suspected'}
                              placeholderTextColor={colors.inputPlaceholder}
                              value={reviewNote}
                              onChangeText={setReviewNote}
                            />
                            <View style={styles.approvalButtons}>
                              <TouchableOpacity style={styles.approveButton} onPress={() => handleReviewAnomaly(log.id, reviewingAnomaly.decision, reviewNote)}>
                                <Text style={styles.approveButtonText}>Confirm {reviewingAnomaly.decision === 'approved' ? '✓' : '✕'}</Text>
                              </TouchableOpacity>
                              <TouchableOpacity style={styles.rejectButton} onPress={() => { setReviewingAnomaly(null); setReviewNote(''); }}>
                                <Text style={styles.rejectButtonText}>Cancel</Text>
                              </TouchableOpacity>
                            </View>
                          </View>
                        ) : (
                          <View style={styles.approvalButtons}>
                            <TouchableOpacity style={styles.approveButton} onPress={() => setReviewingAnomaly({ logId: log.id, decision: 'approved' })}>
                              <Text style={styles.approveButtonText}>✓ Approve</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.rejectButton} onPress={() => setReviewingAnomaly({ logId: log.id, decision: 'rejected' })}>
                              <Text style={styles.rejectButtonText}>✕ Deny</Text>
                            </TouchableOpacity>
                          </View>
                        )
                      )}
                    </View>
                  </View>
                );
              })
            )
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background, padding: spacing.lg },
  loadingText: { marginTop: spacing.md, color: colors.textSecondary, fontSize: 14, fontFamily: fontFamily.regular },
  deniedCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, padding: spacing.xl, borderRadius: radius.lg, alignItems: 'center', maxWidth: 400, width: '100%', ...elevation.card },
  deniedTitle: { fontSize: 20, fontFamily: fontFamily.bold, color: colors.danger, marginBottom: spacing.sm },
  deniedText: { fontSize: 14, fontFamily: fontFamily.regular, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.lg },
  primaryButton: { ...buttons.primary },
  primaryButtonText: { ...buttons.primaryText },
  approveButtonText: { ...buttons.compactText },
  rejectButtonText: { ...buttons.compactText, color: colors.danger },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, backgroundColor: colors.background, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  title: { fontSize: 20, fontFamily: fontFamily.bold, color: colors.textPrimary },
  brandRow: { flexDirection: 'row', alignItems: 'center' },
  otCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, padding: spacing.md, marginHorizontal: spacing.lg, marginBottom: spacing.md },
  otTitle: { color: colors.textPrimary, fontFamily: fontFamily.bold, fontSize: 15, marginBottom: spacing.sm },
  otClear: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 13 },
  otRow: { marginBottom: spacing.md },
  otRowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  otName: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 14 },
  otHours: { color: colors.textPrimary, fontFamily: fontFamily.bold, fontSize: 14 },
  otBarTrack: { height: 8, borderRadius: 4, backgroundColor: colors.surfaceBorder, overflow: 'hidden', marginBottom: spacing.xs },
  otBarFill: { height: 8, borderRadius: 4 },
  otNote: { fontFamily: fontFamily.semibold, fontSize: 12 },
  bcRow: { marginBottom: spacing.md },
  bcDate: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 13 },
  bcMsg: { color: colors.danger, fontFamily: fontFamily.regular, fontSize: 13 },
  bcMore: { color: colors.textSecondary, fontFamily: fontFamily.semibold, fontSize: 12 },
  exportChips: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  exportBtn: { ...buttons.primary, marginTop: spacing.md },
  exportBtnText: { ...buttons.primaryText },
  exportMsg: { color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 13, marginTop: spacing.sm },
  brandLogo: { width: 30, height: 30, borderRadius: 9, marginRight: 8 },
  subtitle: { fontSize: 13, fontFamily: fontFamily.regular, color: colors.textSecondary, marginTop: 2 },
  navButton: { ...buttons.glass },
  navButtonText: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 13 },
  adminCard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.lg, marginHorizontal: spacing.lg, marginTop: spacing.md, ...elevation.card },
  adminCardTitle: { fontSize: 15, fontFamily: fontFamily.bold, color: colors.textPrimary },
  adminCardText: { fontSize: 13, fontFamily: fontFamily.regular, color: colors.textSecondary, marginTop: 2 },
  adminCardButton: { ...buttons.compact },
  adminCardButtonText: { ...buttons.compactText },
  filterBar: { flexDirection: 'row', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, backgroundColor: colors.background, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder, alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  filterTab: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder },
  activeFilterTab: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  aiTabActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  aiTabText: { color: colors.accent },
  aiTabTextActive: { color: '#0A0E1A' },
  filterText: { fontSize: 13, color: colors.textSecondary, fontFamily: fontFamily.semibold },
  activeFilterText: { color: colors.accent },
  exportSection: { flexDirection: 'row', alignItems: 'center', marginLeft: 'auto', gap: 10, flexWrap: 'wrap' },
  formatSelector: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.sm, padding: 2, borderWidth: 1, borderColor: colors.surfaceBorder },
  formatTab: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 4 },
  activeFormatTab: { backgroundColor: colors.accent },
  formatText: { fontSize: 12, color: colors.textSecondary, fontFamily: fontFamily.semibold },
  activeFormatText: { color: '#0A0E1A' },
  exportButton: { backgroundColor: colors.accent, paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.sm },
  exportButtonText: { fontSize: 13, color: '#0A0E1A', fontFamily: fontFamily.bold },
  refreshButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.sm },
  refreshButtonText: { fontSize: 13, color: colors.textSecondary },
  scrollContent: { padding: spacing.lg, paddingBottom: spacing.xxl, maxWidth: 800, width: '100%', alignSelf: 'center' },
  menuPanel: { backgroundColor: colors.backgroundSecondary, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, marginHorizontal: spacing.lg, marginTop: spacing.sm, padding: spacing.sm, gap: 8 },
  menuItem: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.sm },
  menuItemText: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 15 },
  emptyCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, padding: spacing.xl, borderRadius: radius.md, alignItems: 'center', marginTop: spacing.lg },
  emptyTitle: { fontSize: 17, fontFamily: fontFamily.bold, color: colors.textPrimary, marginBottom: spacing.xs },
  emptyText: { color: colors.textSecondary, fontSize: 14, fontFamily: fontFamily.regular, textAlign: 'center', lineHeight: 20 },
  logCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md, ...elevation.card },
  anomalyCard: { borderColor: colors.warning, borderLeftWidth: 3 },
  pendingCard: { borderColor: colors.warning },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm, paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  employeeName: { fontSize: 16, fontFamily: fontFamily.bold, color: colors.textPrimary },
  statusBadge: { fontSize: 12, fontFamily: fontFamily.semibold, paddingVertical: 4, paddingHorizontal: 10, borderRadius: radius.pill, overflow: 'hidden' },
  badgeNormal: { backgroundColor: 'rgba(52,211,153,0.14)', color: colors.success },
  badgeDanger: { backgroundColor: 'rgba(248,113,113,0.14)', color: colors.danger },
  badgeWarning: { backgroundColor: colors.warningSoft, color: colors.warning },
  cardBody: { gap: 6 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between' },
  label: { fontSize: 13, fontFamily: fontFamily.regular, color: colors.textSecondary },
  value: { fontSize: 13, fontFamily: fontFamily.medium, color: colors.textPrimary },
  worksiteValue: { fontSize: 13, fontFamily: fontFamily.bold, color: colors.accent },
  valueBold: { fontSize: 13, fontFamily: fontFamily.bold, color: colors.textPrimary, fontVariant: ['tabular-nums'] },
  noteBox: { backgroundColor: colors.warningSoft, padding: spacing.md, borderRadius: radius.sm, marginTop: 4, borderWidth: 1, borderColor: colors.warning },
  noteLabel: { fontSize: 12, fontFamily: fontFamily.bold, color: colors.warning, marginBottom: 2 },
  noteText: { fontSize: 13, fontFamily: fontFamily.regular, color: colors.textPrimary, fontStyle: 'italic' },
  approvalButtons: { flexDirection: 'row', gap: 10, marginTop: spacing.md },
  approveButton: { ...buttons.compact, flex: 1 },
  rejectButton: { ...buttons.compact, flex: 1, backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.danger },
  reviewNoteWrap: { marginTop: spacing.md, gap: 8 },
  reviewNoteInput: { backgroundColor: colors.inputBackground, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: radius.sm, padding: spacing.sm, fontSize: 14, fontFamily: fontFamily.regular, color: colors.textPrimary },

  // --- AI chat ---
  chatWrapper: { flex: 1, backgroundColor: colors.background, maxWidth: 800, width: '100%', alignSelf: 'center', marginTop: spacing.md, borderRadius: radius.md, overflow: 'hidden', borderWidth: 1, borderColor: colors.surfaceBorder },
  chatList: { padding: spacing.md },
  messageBubble: { maxWidth: '80%', padding: 12, borderRadius: radius.md, marginBottom: 10 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: colors.accent },
  botBubble: { alignSelf: 'flex-start', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder },
  messageText: { fontSize: 15, fontFamily: fontFamily.regular, lineHeight: 22 },
  userText: { color: '#0A0E1A' },
  botText: { color: colors.textPrimary },
  inputContainer: { flexDirection: 'row', padding: spacing.md, backgroundColor: colors.backgroundSecondary, borderTopWidth: 1, borderColor: colors.surfaceBorder },
  chatInput: { flex: 1, borderWidth: 1, borderColor: colors.inputBorder, backgroundColor: colors.inputBackground, color: colors.textPrimary, borderRadius: 20, paddingHorizontal: 15, fontSize: 15, fontFamily: fontFamily.regular, height: 42 },
  sendButton: { marginLeft: 10, backgroundColor: colors.accent, borderRadius: 20, paddingHorizontal: 20, justifyContent: 'center', alignItems: 'center' },
  sendButtonText: { color: '#0A0E1A', fontFamily: fontFamily.bold }
});
