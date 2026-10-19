import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, SafeAreaView, ActivityIndicator, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform, FlatList } from 'react-native';
import { Link } from 'expo-router';
import * as Location from 'expo-location';
import { supabase } from '../lib/supabase';
import { colors, fontFamily, radius, spacing, type } from '../lib/theme';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

type ChatMessage = { id: string; role: 'user' | 'bot'; content: string };

export default function EmployeeChatScreen() {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: '1', role: 'bot', content: "Hi! I'm your NorthShift assistant. Ask me about your shifts and hours, I'll help file an out-of-range exception, or I can log a blocker for your manager." },
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
          const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Balanced });
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

    // Send recent conversation so the bot follows pronouns and short follow-ups.
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
          userId: session.user.id,
          role: 'employee',
          location: coords,
          history,
        }),
      });

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      const botMsg: ChatMessage = { id: (Date.now() + 1).toString(), role: 'bot', content: (data.reply || '').replace(/\*\*/g, '') };
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
        <ActivityIndicator size="large" color={colors.accent} />
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
          <Text style={styles.title}>Assistant</Text>
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
            placeholderTextColor={colors.inputPlaceholder}
            value={inputText}
            onChangeText={setInputText}
            editable={!isChatLoading}
            onSubmitEditing={() => sendMessage(inputText)}
          />
          <TouchableOpacity style={styles.sendButton} onPress={() => sendMessage(inputText)} disabled={isChatLoading}>
            {isChatLoading ? <ActivityIndicator color={colors.background} /> : <Text style={styles.sendButtonText}>Send</Text>}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background, padding: spacing.lg },
  loadingText: { marginTop: spacing.sm, color: colors.textSecondary, fontFamily: fontFamily.regular, fontSize: 14 },
  deniedText: { fontSize: 14, color: colors.textSecondary, fontFamily: fontFamily.regular, textAlign: 'center', marginBottom: spacing.lg },
  primaryButton: { backgroundColor: colors.accent, padding: spacing.md, borderRadius: radius.md, alignItems: 'center', paddingHorizontal: spacing.lg },
  buttonText: { color: colors.background, fontFamily: fontFamily.semibold, fontSize: 13 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, backgroundColor: colors.backgroundSecondary, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder },
  title: { ...type.heading, color: colors.textPrimary },
  subtitle: { ...type.caption, color: colors.textSecondary, marginTop: 2 },
  navButton: { backgroundColor: colors.surface, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.surfaceBorder },
  navButtonText: { color: colors.textPrimary, fontFamily: fontFamily.semibold, fontSize: 12 },
  chatWrapper: { flex: 1, backgroundColor: colors.backgroundSecondary, maxWidth: 800, width: '100%', alignSelf: 'center', marginTop: spacing.sm, borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: colors.surfaceBorder },
  chatList: { padding: spacing.md },
  messageBubble: { maxWidth: '80%', padding: spacing.md, borderRadius: radius.md, marginBottom: spacing.sm },
  userBubble: { alignSelf: 'flex-end', backgroundColor: colors.accent },
  botBubble: { alignSelf: 'flex-start', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder },
  messageText: { fontSize: 15, lineHeight: 22, fontFamily: fontFamily.regular },
  userText: { color: colors.background },
  botText: { color: colors.textPrimary },
  inputContainer: { flexDirection: 'row', padding: spacing.md, backgroundColor: colors.backgroundSecondary, borderTopWidth: 1, borderColor: colors.surfaceBorder },
  chatInput: { flex: 1, borderWidth: 1, borderColor: colors.inputBorder, backgroundColor: colors.inputBackground, color: colors.textPrimary, borderRadius: radius.pill, paddingHorizontal: spacing.md, fontSize: 15, fontFamily: fontFamily.regular, height: 44 },
  sendButton: { marginLeft: spacing.sm, backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: spacing.lg, justifyContent: 'center', alignItems: 'center' },
  sendButtonText: { color: colors.background, fontFamily: fontFamily.semibold, fontSize: 15 },
});
