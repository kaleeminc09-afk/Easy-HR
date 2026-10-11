import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, SafeAreaView, ActivityIndicator, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform, FlatList } from 'react-native';
import { Link } from 'expo-router';
import * as Location from 'expo-location';
import { supabase } from '../lib/supabase';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

type ChatMessage = { id: string; role: 'user' | 'bot'; content: string };

export default function EmployeeChatScreen() {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: '1', role: 'bot', content: "Hi! I'm your Easy HR assistant. Ask me about your shifts and hours, I'll help file an out-of-range exception, or I can log a blocker for your manager." },
  ]);
  const [inputText, setInputText] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setSession(session);
      setLoading(false);

      // Capture GPS once so the bot can file location-aware exceptions
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          setCoords({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        }
      } catch (e) {
        console.log('Location unavailable for chat:', e);
      }
    })();
  }, []);

  const sendMessage = async (text: string) => {
    if (!text.trim() || !session?.user) return;

    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInputText('');
    setIsChatLoading(true);

    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/hr-ai-bot`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: text,
          userId: session.user.id,
          role: 'employee',
          location: coords,
        }),
      });

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      const botMsg: ChatMessage = { id: (Date.now() + 1).toString(), role: 'bot', content: data.reply };
      setMessages((prev) => [...prev, botMsg]);
    } catch (error: any) {
      const errorMsg: ChatMessage = { id: (Date.now() + 1).toString(), role: 'bot', content: `Error: ${error.message}` };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsChatLoading(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading assistant...</Text>
      </View>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centerContainer}>
          <Text style={styles.deniedText}>Please sign in to use the assistant.</Text>
          <Link href="/" asChild>
            <TouchableOpacity style={styles.primaryButton}>
              <Text style={styles.buttonText}>← Back to Sign In</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>🤖 HR Assistant</Text>
          <Text style={styles.subtitle}>Shift questions, exceptions & blockers</Text>
        </View>
        <Link href="/" asChild>
          <TouchableOpacity style={styles.navButton}>
            <Text style={styles.navButtonText}>← Time Tracker</Text>
          </TouchableOpacity>
        </Link>
      </View>

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
            placeholder="e.g. How many hours did I work today?"
            value={inputText}
            onChangeText={setInputText}
            editable={!isChatLoading}
            onSubmitEditing={() => sendMessage(inputText)}
          />
          <TouchableOpacity style={styles.sendButton} onPress={() => sendMessage(inputText)} disabled={isChatLoading}>
            {isChatLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.sendButtonText}>Send</Text>}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f6fa' },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f5f6fa', padding: 20 },
  loadingText: { marginTop: 10, color: '#555' },
  deniedText: { fontSize: 14, color: '#718093', textAlign: 'center', marginBottom: 20 },
  primaryButton: { backgroundColor: '#2f3640', padding: 12, borderRadius: 8, alignItems: 'center', paddingHorizontal: 20 },
  buttonText: { color: '#ffffff', fontWeight: 'bold', fontSize: 13 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 15, backgroundColor: '#ffffff', borderBottomWidth: 1, borderBottomColor: '#dcdde1' },
  title: { fontSize: 18, fontWeight: 'bold', color: '#2f3640' },
  subtitle: { fontSize: 12, color: '#718093', marginTop: 2 },
  navButton: { backgroundColor: '#f1f2f6', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, borderWidth: 1, borderColor: '#dcdde1' },
  navButtonText: { color: '#2f3640', fontWeight: '600', fontSize: 12 },
  chatWrapper: { flex: 1, backgroundColor: '#ffffff', maxWidth: 800, width: '100%', alignSelf: 'center', marginTop: 10, borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: '#dcdde1' },
  chatList: { padding: 15 },
  messageBubble: { maxWidth: '80%', padding: 12, borderRadius: 10, marginBottom: 10 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: '#007AFF' },
  botBubble: { alignSelf: 'flex-start', backgroundColor: '#f1f2f6', borderWidth: 1, borderColor: '#dcdde1' },
  messageText: { fontSize: 15, lineHeight: 22 },
  userText: { color: '#ffffff' },
  botText: { color: '#2f3640' },
  inputContainer: { flexDirection: 'row', padding: 12, backgroundColor: '#f5f6fa', borderTopWidth: 1, borderColor: '#dcdde1' },
  chatInput: { flex: 1, borderWidth: 1, borderColor: '#dcdde1', backgroundColor: '#ffffff', borderRadius: 20, paddingHorizontal: 15, fontSize: 15, height: 42 },
  sendButton: { marginLeft: 10, backgroundColor: '#007AFF', borderRadius: 20, paddingHorizontal: 20, justifyContent: 'center', alignItems: 'center' },
  sendButtonText: { color: '#ffffff', fontWeight: 'bold' },
});
