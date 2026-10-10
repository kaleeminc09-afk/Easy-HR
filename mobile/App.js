import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, SafeAreaView, ActivityIndicator } from 'react-native';
import { supabase } from '../shared/lib/supabase';

// Hardcoded test user ID for development
const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';

export default function App() {
  const [loading, setLoading] = useState(true);
  const [activeSession, setActiveSession] = useState(null);
  const [todayHours, setTodayHours] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');

  // Check active session and today's logs on load
  useEffect(() => {
    fetchTimeData();
  }, []);

  const fetchTimeData = async () => {
    try {
      setLoading(true);
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      // 1. Check for active session (clocked in)
      const { data: activeData, error: activeError } = await supabase
        .from('time_logs')
        .select('*')
        .eq('user_id', TEST_USER_ID)
        .is('clock_out', null)
        .single();

      if (activeError && activeError.code !== 'PGRST116') {
        console.error('Error fetching active session:', activeError.message);
      } else {
        setActiveSession(activeData || null);
      }

      // 2. Fetch all logs for today to calculate total hours
      const { data: logsData, error: logsError } = await supabase
        .from('time_logs')
        .select('*')
        .eq('user_id', TEST_USER_ID)
        .gte('clock_in', todayStart.toISOString());

      if (logsError) {
        console.error('Error fetching today logs:', logsError.message);
      } else if (logsData) {
        let totalMs = 0;
        logsData.forEach(log => {
          const start = new Date(log.clock_in).getTime();
          const end = log.clock_out ? new Date(log.clock_out).getTime() : new Date().getTime();
          if (end > start) {
            totalMs += (end - start);
          }
        });
        setTodayHours((totalMs / (1000 * 60 * 60)).toFixed(2));
      }
    } catch (err) {
      console.error('Unexpected error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleClockIn = async () => {
    setStatusMessage('Clocking in...');
    const { data, error } = await supabase
      .from('time_logs')
      .insert([{ user_id: TEST_USER_ID, clock_in: new Date().toISOString() }])
      .select()
      .single();

    if (error) {
      setStatusMessage('Error: ' + error.message);
    } else {
      setActiveSession(data);
      setStatusMessage('Successfully clocked in!');
      fetchTimeData();
    }
  };

  const handleClockOut = async () => {
    if (!activeSession) return;
    setStatusMessage('Clocking out...');
    
    const { error } = await supabase
      .from('time_logs')
      .update({ clock_out: new Date().toISOString() })
      .eq('id', activeSession.id);

    if (error) {
      setStatusMessage('Error: ' + error.message);
    } else {
      setActiveSession(null);
      setStatusMessage('Successfully clocked out!');
      fetchTimeData();
    }
  };

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading Time Tracker...</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Easy HR Time Tracker</Text>
        <Text style={styles.subtitle}>Employee Portal</Text>

        <View style={styles.statusBox}>
          <Text style={styles.statusLabel}>Current Status:</Text>
          <Text style={[styles.statusValue, activeSession ? styles.activeText : styles.offlineText]}>
            {activeSession ? '🟢 ACTIVE (Clocked In)' : '⚪ OFFLINE'}
          </Text>
        </View>

        <View style={styles.hoursBox}>
          <Text style={styles.hoursLabel}>Today's Accumulated Hours:</Text>
          <Text style={styles.hoursValue}>{todayHours} hrs</Text>
        </View>

        {activeSession ? (
          <TouchableOpacity style={styles.clockOutButton} onPress={handleClockOut}>
            <Text style={styles.buttonText}>CLOCK OUT</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.clockInButton} onPress={handleClockIn}>
            <Text style={styles.buttonText}>CLOCK IN</Text>
          </TouchableOpacity>
        )}

        {statusMessage ? <Text style={styles.message}>{statusMessage}</Text> : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f6fa',
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f6fa',
  },
  loadingText: {
    marginTop: 10,
    color: '#555',
  },
  card: {
    backgroundColor: '#ffffff',
    padding: 30,
    borderRadius: 12,
    width: '90%',
    maxWidth: 400,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 4,
    alignItems: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#2f3640',
  },
  subtitle: {
    fontSize: 14,
    color: '#718093',
    marginBottom: 20,
  },
  statusBox: {
    marginVertical: 15,
    alignItems: 'center',
  },
  statusLabel: {
    fontSize: 14,
    color: '#718093',
  },
  statusValue: {
    fontSize: 16,
    fontWeight: 'bold',
    marginTop: 4,
  },
  activeText: {
    color: '#27ae60',
  },
  offlineText: {
    color: '#e74c3c',
  },
  hoursBox: {
    marginVertical: 15,
    alignItems: 'center',
    backgroundColor: '#f1f2f6',
    padding: 12,
    borderRadius: 8,
    width: '100%',
  },
  hoursLabel: {
    fontSize: 13,
    color: '#57606f',
  },
  hoursValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#2f3640',
    marginTop: 4,
  },
  clockInButton: {
    backgroundColor: '#27ae60',
    width: '100%',
    padding: 15,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 10,
  },
  clockOutButton: {
    backgroundColor: '#e74c3c',
    width: '100%',
    padding: 15,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 10,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  message: {
    marginTop: 15,
    fontSize: 13,
    color: '#57606f',
    textAlign: 'center',
  },
});
