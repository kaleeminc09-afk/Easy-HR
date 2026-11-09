// Web-only floating Assistant (rendered by app/_layout.tsx inside the
// web content area, when Platform.OS === 'web' AND a session exists).
// A 56px button, bottom-right of the content area, opens a popup chat
// panel that works on ANY screen because it lives in the shell, not in
// one screen. Native never sees it. If there is no session, the button
// does not render at all.
// The chat call mirrors EmployeeChatScreen.tsx verbatim in shape:
// POST to the hr-ai-bot function with the session Bearer token, the
// prompt, userId, the user's ACTUAL role, timeZone, and the last 10
// messages as history, with the same one-retry rule and the same
// friendly error messages. (Location is null here — the panel has no
// GPS capture; the bot treats a null location as "not provided".)
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { supabase } from '../lib/supabase';
import { buttons, colors, elevation, fontFamily, radius, spacing, type } from '../lib/theme';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;

type ChatMessage = { id: string; role: 'user' | 'bot'; content: string };

const WELCOME: ChatMessage = {
  id: '1',
  role: 'bot',
  content: "Hi! I'm your NorthShift assistant. Ask me about your shifts and hours, I'll help file an out-of-range exception, or I can log a blocker for your manager.",
};

export default function WebAssistant() {
  const [session, setSession] = useState<any>(null);
  const [role, setRole] = useState('employee');
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [inputText, setInputText] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setSession(session);
      if (session) {
        // Actual role, not the chat screen's hardcoded 'employee'.
        const { data } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
        if (data?.role) setRole(data.role);
      }
    })();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  const sendMessage = async (text: string) => {
    if (!text.trim() || !session?.user) return;

    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInputText('');
    setIsChatLoading(true);

    // Send recent conversation so the bot follows pronouns and short follow-ups.
    const history = [...messages, userMsg].slice(-10).map((m) => ({
      role: m.role === 'bot' ? 'assistant' : 'user',
      content: m.content,
    }));

    try {
      // One automatic retry for transient provider errors, so a single
      // blip does not surface as a failure in chat.
      let data: any = null;
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/hr-ai-bot`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt: text,
            userId: session.user.id,
            role,
            location: null,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            history,
          }),
        });
        data = await response.json();
        if (!data.error) break;
        if (attempt >= 1 || !/rate|provider|internal|network|fetch/i.test(data.error)) throw new Error(data.error);
        await new Promise((r) => setTimeout(r, 1000));
      }

      const botMsg: ChatMessage = { id: (Date.now() + 1).toString(), role: 'bot', content: (data.reply || '').replace(/\*\*/g, '') };
      setMessages((prev) => [...prev, botMsg]);
    } catch (error: any) {
      const friendly = /rate|provider|internal|network|fetch/i.test(error.message || '') ? 'The assistant is busy right now — please try again in a moment.' : 'Something went wrong with the assistant — please try again.';
      const errorMsg: ChatMessage = { id: (Date.now() + 1).toString(), role: 'bot', content: friendly };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsChatLoading(false);
    }
  };

  if (!session) return null;

  return (
    <>
      {open && (
        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <View>
              <Text style={styles.panelTitle}>Assistant</Text>
              <Text style={styles.panelSubtitle}>Shift questions, exceptions & blockers</Text>
            </View>
            <TouchableOpacity style={styles.closeButton} onPress={() => setOpen(false)} accessibilityLabel="Close assistant">
              <Text style={styles.closeButtonText}>✕</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            ref={listRef}
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
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          />
          <View style={styles.inputContainer}>
            <TextInput
              style={styles.chatInput}
              placeholder="Ask about shifts or hours…"
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
        </View>
      )}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => setOpen(!open)}
        accessibilityLabel={open ? 'Close assistant' : 'Open assistant'}
      >
        <Text style={styles.fabText}>{open ? '✕' : '✦'}</Text>
      </TouchableOpacity>
    </>
  );
}

const styles = StyleSheet.create({
  // Anchored to the web content area (the _layout webContent View),
  // so the button and panel sit over the content, clear of the
  // 220px toolbar on the right.
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...elevation.raised,
  },
  fabText: { color: colors.background, fontSize: 24, fontFamily: fontFamily.semibold },
  panel: {
    position: 'absolute',
    right: 16,
    bottom: 84,
    width: 380,
    height: 520,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
    overflow: 'hidden',
    ...elevation.raised,
  },
  panelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.backgroundSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceBorder,
  },
  panelTitle: { ...type.heading, color: colors.textPrimary },
  panelSubtitle: { ...type.caption, color: colors.textSecondary, marginTop: 2 },
  closeButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  closeButtonText: { color: colors.textPrimary, fontSize: 16, fontFamily: fontFamily.semibold },
  chatList: { padding: spacing.md },
  messageBubble: { maxWidth: '85%', padding: spacing.md, borderRadius: radius.md, marginBottom: spacing.sm },
  userBubble: { alignSelf: 'flex-end', backgroundColor: colors.accent },
  botBubble: { alignSelf: 'flex-start', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.surfaceBorder },
  messageText: { fontSize: 15, lineHeight: 22, fontFamily: fontFamily.regular },
  userText: { color: colors.background },
  botText: { color: colors.textPrimary },
  inputContainer: { flexDirection: 'row', padding: spacing.md, backgroundColor: colors.backgroundSecondary, borderTopWidth: 1, borderColor: colors.surfaceBorder },
  chatInput: { flex: 1, borderWidth: 1, borderColor: colors.inputBorder, backgroundColor: colors.inputBackground, color: colors.textPrimary, borderRadius: radius.pill, paddingHorizontal: spacing.md, fontSize: 15, fontFamily: fontFamily.regular, height: 44 },
  sendButton: { ...buttons.compact, marginLeft: spacing.sm },
  sendButtonText: { ...buttons.compactText },
});
