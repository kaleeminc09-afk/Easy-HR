import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, ScrollView, SafeAreaView, ActivityIndicator, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform, FlatList } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { colors, spacing, radius, type, elevation } from '../lib/theme';

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
        id, clock_in, clock_out, ai_anomaly_flag,
        profiles ( full_name, email, first_name, last_name ),
        worksites ( name )
      `)
      .order('clock_in', { ascending: false });

    if (logsError) console.error('Logs Error:', logsError.message);
    if (logsData) setLogs(logsData);

    const { data: excData, error: excError } = await supabase
      .from('time_exceptions')
      .select(`
        id, attempted_at, distance_meters, reason_note, status, user_id, worksite_id,
        profiles ( full_name, email, first_name, last_name ), worksites ( name )
      `)
      .order('attempted_at', { ascending: false });

    if (excError) {
      console.error('Exceptions Error:', excError.message);
    } else if (excData) {
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
    const history = [...messages, userMsg].slice(-20).map((m) => ({
      role: m.role === 'bot' ? 'assistant' : 'user',
      content: m.content,
    }));

    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/hr-ai-bot`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: text,
          managerId: currentUser?.id || 'mgr_123',
          history,
        }),
      });

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      const botMsg = { id: (Date.now() + 1).toString(), role: 'bot', content: (data.reply || '').replace(/\*\*/g, '') };
      setMessages((prev) => [...prev, botMsg]);
    } catch (error) {
      const errorMsg = { id: (Date.now() + 1).toString(), role: 'bot', content: `Error: ${error.message}` };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsChatLoading(false);
    }
  };

  const pendingExceptionsCount = exceptions.filter(e => e.status === 'pending').length;

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
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
          <Text style={styles.title}>✦ NorthShift</Text>
          {businessName ? <Text style={styles.subtitle}>{businessName} · Manager Portal</Text> : <Text style={styles.subtitle}>Manager Portal · Time Audits & Exceptions</Text>}
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Link href="/profile" asChild>
            <TouchableOpacity style={styles.navButton}>
              <Text style={styles.navButtonText}>Profile</Text>
            </TouchableOpacity>
          </Link>
          <Link href="/" asChild>
            <TouchableOpacity style={styles.navButton}>
              <Text style={styles.navButtonText}>← Employee Portal</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </View>

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
        <TouchableOpacity style={[styles.filterTab, filter === 'AI' && styles.activeFilterTab, { backgroundColor: filter === 'AI' ? '#007AFF' : '#e8f0fe' }]} onPress={() => setFilter('AI')}>
          <Text style={[styles.filterText, filter === 'AI' && styles.activeFilterText, { color: filter === 'AI' ? '#fff' : '#007AFF' }]}>
            ✦ AI Assistant
          </Text>
        </TouchableOpacity>

        <View style={styles.exportSection}>
          {filter !== 'EXCEPTIONS' && filter !== 'AI' && (
            <>
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
            exceptions.length === 0 ? (
              <View style={styles.emptyCard}><Text style={styles.emptyText}>No out-of-range exception requests found.</Text></View>
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
              <View style={styles.emptyCard}><Text style={styles.emptyText}>No time logs found matching this filter.</Text></View>
            ) : (
              (filter === 'ANOMALIES' ? logs.filter(l => l.ai_anomaly_flag?.includes('⚠️')) : logs).map((log) => {
                const isAnomaly = log.ai_anomaly_flag && log.ai_anomaly_flag.includes('⚠️️');
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
                      <View style={styles.infoRow}><Text style={styles.label}>Total Duration:</Text><Text style={styles.valueBold}>{calculateDuration(log.clock_in, log.clock_out)}</Text></View>
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
  loadingText: { marginTop: spacing.md, color: colors.textSecondary, fontSize: 14 },
  deniedCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, padding: spacing.xl, borderRadius: radius.lg, alignItems: 'center', maxWidth: 400, width: '100%', ...elevation.card },
  deniedTitle: { fontSize: 20, fontWeight: 'bold', color: colors.danger, marginBottom: spacing.sm },
  deniedText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.lg },
  primaryButton: { backgroundColor: colors.accent, width: '100%', padding: spacing.md, borderRadius: radius.md, alignItems: 'center', ...elevation.accentGlow },
  primaryButtonText: { color: '#0A0E1A', fontWeight: '700', fontSize: 14 },
  buttonText: { color: '#ffffff', fontWeight: 'bold', fontSize: 13 },
  approveButtonText: { color: '#0A0E1A', fontWeight: '700', fontSize: 13 },
  rejectButtonText: { color: colors.danger, fontWeight: '700', fontSize: 13 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, backgroundColor: colors.background, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  title: { fontSize: 20, fontWeight: '700', color: colors.textPrimary },
  subtitle: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  navButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.sm },
  navButtonText: { color: colors.textPrimary, fontWeight: '600', fontSize: 13 },
  adminCard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.lg, padding: spacing.lg, marginHorizontal: spacing.lg, marginTop: spacing.md, ...elevation.card },
  adminCardTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  adminCardText: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  adminCardButton: { backgroundColor: colors.accent, borderRadius: radius.sm, paddingVertical: 12, paddingHorizontal: 16, minHeight: 44, justifyContent: 'center' },
  adminCardButtonText: { color: '#0A0E1A', fontWeight: '700', fontSize: 13 },
  filterBar: { flexDirection: 'row', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, backgroundColor: colors.background, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder, alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  filterTab: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder },
  activeFilterTab: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  filterText: { fontSize: 13, color: colors.textSecondary, fontWeight: '600' },
  activeFilterText: { color: colors.accent },
  exportSection: { flexDirection: 'row', alignItems: 'center', marginLeft: 'auto', gap: 10, flexWrap: 'wrap' },
  formatSelector: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.sm, padding: 2, borderWidth: 1, borderColor: colors.surfaceBorder },
  formatTab: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 4 },
  activeFormatTab: { backgroundColor: colors.accent },
  formatText: { fontSize: 11, color: colors.textSecondary, fontWeight: '600' },
  activeFormatText: { color: '#0A0E1A' },
  exportButton: { backgroundColor: colors.accent, paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.sm },
  exportButtonText: { fontSize: 13, color: '#0A0E1A', fontWeight: '700' },
  refreshButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.sm },
  refreshButtonText: { fontSize: 13, color: colors.textSecondary },
  scrollContent: { padding: spacing.lg, maxWidth: 800, width: '100%', alignSelf: 'center' },
  emptyCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, padding: spacing.xl, borderRadius: radius.md, alignItems: 'center', marginTop: spacing.lg },
  emptyText: { color: colors.textSecondary, fontSize: 14 },
  logCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md, ...elevation.card },
  anomalyCard: { borderColor: colors.warning, borderLeftWidth: 3 },
  pendingCard: { borderColor: colors.warning },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm, paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  employeeName: { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  statusBadge: { fontSize: 12, fontWeight: '600', paddingVertical: 4, paddingHorizontal: 10, borderRadius: radius.pill, overflow: 'hidden' },
  badgeNormal: { backgroundColor: 'rgba(52,211,153,0.14)', color: colors.success },
  badgeDanger: { backgroundColor: 'rgba(248,113,113,0.14)', color: colors.danger },
  badgeWarning: { backgroundColor: colors.warningSoft, color: colors.warning },
  cardBody: { gap: 6 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between' },
  label: { fontSize: 13, color: colors.textSecondary },
  value: { fontSize: 13, color: colors.textPrimary, fontWeight: '500' },
  worksiteValue: { fontSize: 13, color: colors.accent, fontWeight: '700' },
  valueBold: { fontSize: 13, color: colors.textPrimary, fontWeight: '700', fontVariant: ['tabular-nums'] },
  noteBox: { backgroundColor: colors.warningSoft, padding: spacing.md, borderRadius: radius.sm, marginTop: 4, borderWidth: 1, borderColor: colors.warning },
  noteLabel: { fontSize: 11, fontWeight: '700', color: colors.warning, marginBottom: 2 },
  noteText: { fontSize: 13, color: colors.textPrimary, fontStyle: 'italic' },
  approvalButtons: { flexDirection: 'row', gap: 10, marginTop: spacing.md },
  approveButton: { flex: 1, backgroundColor: colors.accent, padding: 12, borderRadius: radius.sm, alignItems: 'center' },
  rejectButton: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.danger, padding: 12, borderRadius: radius.sm, alignItems: 'center', paddingHorizontal: 16 },

  // --- AI chat ---
  chatWrapper: { flex: 1, backgroundColor: colors.background, maxWidth: 800, width: '100%', alignSelf: 'center', marginTop: spacing.md, borderRadius: radius.md, overflow: 'hidden', borderWidth: 1, borderColor: colors.surfaceBorder },
  chatList: { padding: spacing.md },
  messageBubble: { maxWidth: '80%', padding: 12, borderRadius: radius.md, marginBottom: 10 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: colors.accent },
  botBubble: { alignSelf: 'flex-start', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder },
  messageText: { fontSize: 15, lineHeight: 22 },
  userText: { color: '#0A0E1A' },
  botText: { color: colors.textPrimary },
  inputContainer: { flexDirection: 'row', padding: spacing.md, backgroundColor: colors.backgroundSecondary, borderTopWidth: 1, borderColor: colors.surfaceBorder },
  chatInput: { flex: 1, borderWidth: 1, borderColor: colors.inputBorder, backgroundColor: colors.inputBackground, color: colors.textPrimary, borderRadius: 20, paddingHorizontal: 15, fontSize: 15, height: 42 },
  sendButton: { marginLeft: 10, backgroundColor: colors.accent, borderRadius: 20, paddingHorizontal: 20, justifyContent: 'center', alignItems: 'center' },
  sendButtonText: { color: '#0A0E1A', fontWeight: '700' }
});
