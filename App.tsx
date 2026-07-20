import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  UIManager,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { analyzeNote, transcribeAudio } from './src/api';
import {
  addNotificationResponseListener,
  cancelReminder,
  requestPermissions,
  scheduleReminder,
} from './src/notifications';
import type { AnalyzeResponse, Note, Reminder } from './src/types';
import { GestureHandlerRootView, Swipeable } from 'react-native-gesture-handler';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const BLACK = '#000000';
const WHITE = '#FFFFFF';
const DIM = '#777777';

const IS_WEB = Platform.OS === 'web';

const NOTES_KEY = 'monolog.notes';
const REMINDERS_KEY = 'monolog.reminders';

// ─── Write Pad ──────────────────────────────────────────────────

function WritePad({
  onReminderCreated,
  onNoteCreated,
}: {
  onReminderCreated: () => void;
  onNoteCreated: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const processingRef = useRef(false);
  const buttonOpacity = useRef(new Animated.Value(1)).current;
  const waveOpacity = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(0.8)).current;
  const pulseLoopRef = useRef<Animated.CompositeAnimation | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingOpacity = useRef(new Animated.Value(0)).current;
  const savingPulse = useRef<Animated.CompositeAnimation | null>(null);
  const draftFade = useRef(new Animated.Value(1)).current;
  const savingFade = useRef(new Animated.Value(0)).current;
  const recordingRef = useRef(false);
  const thinkingAnim = useRef(new Animated.Value(0)).current;
  const [dotCount, setDotCount] = useState(0);

  // ── Simple pulsing dot ────────────────────────────────────────
  const startPulse = () => {
    Animated.parallel([
      Animated.timing(buttonOpacity, { toValue: 0, duration: 250, useNativeDriver: true }),
      Animated.timing(waveOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
    ]).start();

    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.3, duration: 500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0.8, duration: 500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    pulse.start();
    pulseLoopRef.current = pulse;
  };

  const stopPulse = () => {
    pulseLoopRef.current?.stop();
    pulseAnim.setValue(0.8);
    Animated.parallel([
      Animated.timing(buttonOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(waveOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start();
  };

  // ── Silence detection via timeout ───
  const startAutoStop = () => {
    // Auto-stop after 60 seconds max
    silenceTimerRef.current = setTimeout(() => {
      if (!processingRef.current && recorder.isRecording) {
        recordingRef.current = false;
        stopPulse();
        setListening(false);
        setProcessing(true);
        processingRef.current = true;
        (async () => {
          try {
            await recorder.stop();
            if (recorder.uri) {
              await processAudioData(recorder.uri, 'audio/mp4');
            } else {
              setProcessing(false);
              processingRef.current = false;
            }
          } catch (e: any) {
            Alert.alert('Recording failed', e?.message ?? 'Unknown error');
            setProcessing(false);
            processingRef.current = false;
          }
        })();
      }
    }, 60000);
  };

  const stopAutoStop = () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  // ── Process recorded audio file ──────────────────────────────
  const processAudioData = async (uri: string, mimeType: string) => {
    try {
      const text = await transcribeAudio(uri, mimeType);
      // Skip empty/silent transcriptions (just punctuation or whitespace)
      if (text && text.trim().replace(/[.\s]/g, '').length > 0) {
        setDraft((prev) => (prev ? prev + ' ' + text : text));
      }
    } catch (e: any) {
      Alert.alert('Transcription failed', e?.message ?? 'Unknown error');
    } finally {
      await new Promise((r) => setTimeout(r, 300));
      setProcessing(false);
      processingRef.current = false;
    }
  };

  // ── Start recording ──────────────────────────────────────────
  const startRecording = async () => {
    if (processingRef.current || recordingRef.current) return;
    recordingRef.current = true;
    setProcessing(true);
    processingRef.current = true;
    try {
      await recorder.prepareToRecordAsync();
      // User already released? Don't start.
      if (!processingRef.current) return;
      recorder.record();
      setListening(true);
      setProcessing(false);
      processingRef.current = false;
      startPulse();
      startAutoStop();
    } catch (e: any) {
      setProcessing(false);
      processingRef.current = false;
      Alert.alert('Recording failed', e?.message ?? 'Could not access microphone');
    }
  };

  // ── Stop recording ───────────────────────────────────────────
  const stopRecording = async () => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    // If recording hasn't fully started yet, signal abort.
    if (processingRef.current && !listening) {
      processingRef.current = false;
      return;
    }
    stopAutoStop();
    stopPulse();
    setListening(false);
    setProcessing(true);
    processingRef.current = true;
    try {
      await recorder.stop();
      if (recorder.uri) {
        await processAudioData(recorder.uri, 'audio/mp4');
      } else {
        setProcessing(false);
        processingRef.current = false;
      }
    } catch (e: any) {
      Alert.alert('Recording failed', e?.message ?? 'Unknown error');
      setProcessing(false);
      processingRef.current = false;
    }
  };

  // ── Hold to record ───────────────────────────────────────────
  const handleMicPressIn = async () => {
    await startRecording();
  };

  const handleMicPressOut = async () => {
    if (recordingRef.current) {
      await stopRecording();
    }
  };

  // Persist draft.
  useEffect(() => {
    AsyncStorage.setItem('monolog.draft', draft);
  }, [draft]);

  // Restore draft.
  useEffect(() => {
    (async () => {
      try {
        const d = await AsyncStorage.getItem('monolog.draft');
        if (d) setDraft(d);
      } catch {}
    })();
  }, []);

  // Request mic permission + configure audio mode on mount.
  // Skip on web — mic recording is disabled in the web build.
  useEffect(() => {
    if (IS_WEB) return;
    (async () => {
      try {
        const { granted } = await AudioModule.requestRecordingPermissionsAsync();
        if (granted) {
          await setAudioModeAsync({
            playsInSilentMode: true,
            allowsRecording: true,
          });
        }
      } catch {}
    })();
  }, []);

  // Cleanup timers/recorder on unmount.
  useEffect(() => {
    return () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, []);

  // ── Pulsing "Saving…" text during transcription ──────────────
  useEffect(() => {
    if (processing && !listening) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(savingOpacity, { toValue: 1, duration: 600, useNativeDriver: true }),
          Animated.timing(savingOpacity, { toValue: 0.3, duration: 600, useNativeDriver: true }),
        ]),
      );
      pulse.start();
      savingPulse.current = pulse;
    } else {
      savingPulse.current?.stop();
      savingOpacity.setValue(0);
    }
    return () => savingPulse.current?.stop();
  }, [processing, listening, savingOpacity]);


  // ── AI thinking animation (color cycling + dots) on "Saving.." ──
  useEffect(() => {
    if (saving) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(thinkingAnim, { toValue: 1, duration: 500, useNativeDriver: false }),
          Animated.timing(thinkingAnim, { toValue: 0, duration: 500, useNativeDriver: false }),
        ]),
      );
      loop.start();

      let dotI = 0;
      const dotInterval = setInterval(() => {
        dotI = (dotI + 1) % 4;
        setDotCount(dotI);
      }, 400);

      return () => {
        loop.stop();
        clearInterval(dotInterval);
        thinkingAnim.setValue(0);
      };
    } else {
      setDotCount(0);
      thinkingAnim.setValue(0);
    }
  }, [saving, thinkingAnim]);


  const send = async () => {
    const text = draft.trim();
    if (!text || saving) return;

    // ── Start save animation ──────────────────────────────────
    setSaving(true);
    const saveStart = Date.now();
    Animated.parallel([
      Animated.timing(draftFade, {
        toValue: 0,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
      Animated.timing(savingFade, {
        toValue: 1,
        duration: 350,
        delay: 80,
        easing: Easing.out(Easing.back(1.3)),
        useNativeDriver: false,
      }),
    ]).start();

    // ── Load existing reminders for context ─────────────────────
    let existingReminders: Reminder[] = [];
    try {
      const raw = await AsyncStorage.getItem(REMINDERS_KEY);
      if (raw) existingReminders = JSON.parse(raw);
    } catch {}

    // ── Save logic (API + storage) ──────────────────────────────
    let result: AnalyzeResponse | null = null;
    try {
      result = await analyzeNote(
        text,
        new Date().getTimezoneOffset(),
        undefined,
        existingReminders.map((r) => ({ id: r.id, title: r.title })),
      );
    } catch {
      // ── AI backend unavailable — fall back to a plain note ─────
      const note: Note = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        raw: text,
        title: text.length > 60 ? text.slice(0, 60) + '…' : text,
        createdAt: new Date().toISOString(),
      };
      const existingNotes = await AsyncStorage.getItem(NOTES_KEY);
      const savedNotes: Note[] = existingNotes ? JSON.parse(existingNotes) : [];
      savedNotes.unshift(note);
      await AsyncStorage.setItem(NOTES_KEY, JSON.stringify(savedNotes));
      onNoteCreated();
      return finishSaving(saveStart);
    }

    // ── AI analysis succeeded — dispatch by action ──────────────
    const KNOWN = ['create', 'modify', 'skip', 'delete'];
    let action = KNOWN.includes(result.action)
      ? result.action
      : (result.needsReminder && result.reminder ? 'create' : 'none');
    // Safety: if action needs reminder data but it's missing, fall back to note
    if (action === 'create' && !result.reminder) action = 'none';

    try {
      switch (action) {
        case 'create': {
          // ── New reminder ───────────────────────────────────────────
          const fireAt = new Date(result.reminder!.datetime);
          const fireDate =
            fireAt.getTime() <= Date.now()
              ? new Date(Date.now() + 60_000)
              : fireAt;
          let notificationId: string | undefined;
          try {
            const granted = await requestPermissions();
            if (granted) {
              notificationId = await scheduleReminder({
                title: result.title,
                fireAt: fireDate,
                recurring: result.reminder!.recurring,
                daysOfWeek: result.reminder!.daysOfWeek ?? undefined,
                remindBeforeMinutes: result.reminder!.remindBeforeMinutes,
              });
            }
          } catch {}
          const reminder: Reminder = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            title: result.title,
            fireAt: fireDate.toISOString(),
            recurring: result.reminder!.recurring,
            notificationId: notificationId ?? '',
            daysOfWeek: result.reminder!.daysOfWeek ?? undefined,
            remindBeforeMinutes: result.reminder!.remindBeforeMinutes,
          };
          const existing = await AsyncStorage.getItem(REMINDERS_KEY);
          const reminders: Reminder[] = existing ? JSON.parse(existing) : [];
          reminders.unshift(reminder);
          await AsyncStorage.setItem(REMINDERS_KEY, JSON.stringify(reminders));
          onReminderCreated();
          break;
        }

        case 'modify': {
          // ── Modify an existing reminder ────────────────────────────
          const targetTitle = result.targetReminderTitle?.toLowerCase() || result.title.toLowerCase();
          const target = existingReminders.find((r) => r.title.toLowerCase().includes(targetTitle) || targetTitle.includes(r.title.toLowerCase()));
          if (!target) {
            // Fall back to create if no match
            const fireAt = new Date(result.reminder?.datetime || result.modify?.datetime || new Date().toISOString());
            const fireDate = fireAt.getTime() <= Date.now() ? new Date(Date.now() + 60_000) : fireAt;
            let notificationId: string | undefined;
            try {
              if (await requestPermissions()) {
                notificationId = await scheduleReminder({
                  title: result.modify?.title || result.title,
                  fireAt: fireDate,
                  recurring: result.modify?.recurring || result.reminder?.recurring || 'none',
                  daysOfWeek: result.modify?.daysOfWeek ?? undefined,
                  remindBeforeMinutes: result.modify?.remindBeforeMinutes ?? result.reminder?.remindBeforeMinutes,
                });
              }
            } catch {}
            const reminder: Reminder = {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              title: result.modify?.title || result.title,
              fireAt: fireDate.toISOString(),
              recurring: result.modify?.recurring || result.reminder?.recurring || 'none',
              notificationId: notificationId ?? '',
              daysOfWeek: result.modify?.daysOfWeek ?? undefined,
              remindBeforeMinutes: result.modify?.remindBeforeMinutes ?? result.reminder?.remindBeforeMinutes,
            };
            const existing = await AsyncStorage.getItem(REMINDERS_KEY);
            const reminders: Reminder[] = existing ? JSON.parse(existing) : [];
            reminders.unshift(reminder);
            await AsyncStorage.setItem(REMINDERS_KEY, JSON.stringify(reminders));
            onReminderCreated();
          } else {
            // Cancel old notifications
            try { await cancelReminder(target.notificationId); } catch {}
            // Apply modify fields
            const mod = result.modify || {};
            const newFireAt = mod.datetime ? new Date(mod.datetime) : new Date(target.fireAt);
            const newRecurring = mod.recurring || target.recurring;
            const newDaysOfWeek = mod.daysOfWeek !== undefined ? mod.daysOfWeek : target.daysOfWeek;
            const newRemindBefore = mod.remindBeforeMinutes ?? target.remindBeforeMinutes;
            const fireDate = newFireAt.getTime() <= Date.now() ? new Date(Date.now() + 60_000) : newFireAt;
            let notificationId: string | undefined;
            try {
              if (await requestPermissions()) {
                notificationId = await scheduleReminder({
                  title: mod.title || target.title,
                  fireAt: fireDate,
                  recurring: newRecurring,
                  daysOfWeek: newDaysOfWeek ?? undefined,
                  remindBeforeMinutes: newRemindBefore,
                });
              }
            } catch {}
            await updateReminder(target.id, {
              title: mod.title || target.title,
              fireAt: fireDate.toISOString(),
              recurring: newRecurring,
              daysOfWeek: newDaysOfWeek,
              remindBeforeMinutes: newRemindBefore,
              notificationId: notificationId ?? target.notificationId,
            });
          }
          break;
        }

        case 'skip': {
          // ── Skip one occurrence (today) of a recurring reminder ───
          const skipTargetTitle = result.targetReminderTitle?.toLowerCase() || result.title.toLowerCase();
          const skipTarget = existingReminders.find(
            (r) => r.title.toLowerCase().includes(skipTargetTitle) || skipTargetTitle.includes(r.title.toLowerCase()),
          );
          if (skipTarget) {
            const todayStr = new Date().toISOString().split('T')[0];
            const skipDates = [...(skipTarget.skipDates || []), todayStr];
            try { await cancelReminder(skipTarget.notificationId); } catch {}
            let notificationId = '';
            try {
              if (await requestPermissions()) {
                notificationId = await scheduleReminder({
                  title: skipTarget.title,
                  fireAt: new Date(skipTarget.fireAt),
                  recurring: skipTarget.recurring,
                  daysOfWeek: skipTarget.daysOfWeek,
                  remindBeforeMinutes: skipTarget.remindBeforeMinutes,
                });
              }
            } catch {}
            await updateReminder(skipTarget.id, { skipDates, notificationId: notificationId || skipTarget.notificationId });
          }
          break;
        }

        case 'delete': {
          // ── Delete an existing reminder ────────────────────────────
          const delTargetTitle = result.targetReminderTitle?.toLowerCase() || result.title.toLowerCase();
          const delTarget = existingReminders.find(
            (r) => r.title.toLowerCase().includes(delTargetTitle) || delTargetTitle.includes(r.title.toLowerCase()),
          );
          if (delTarget) {
            try { await cancelReminder(delTarget.notificationId); } catch {}
            await deleteReminder(delTarget.id);
          }
          break;
        }

        default: {
          // ── Not a reminder action — save as note ────────────────
          const note: Note = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            raw: text,
            title: result.title,
            createdAt: new Date().toISOString(),
          };
          const existingNotes = await AsyncStorage.getItem(NOTES_KEY);
          const savedNotes: Note[] = existingNotes ? JSON.parse(existingNotes) : [];
          savedNotes.unshift(note);
          await AsyncStorage.setItem(NOTES_KEY, JSON.stringify(savedNotes));
          onNoteCreated();
          break;
        }
      }
    } catch {
      // If anything goes wrong (e.g. storage failure), still finish saving
    }

    await finishSaving(saveStart);
  };

  // ── Finish saving animation ─────────────────────────────────
  const finishSaving = async (startTime: number) => {
    // Show "Saving.." for at least 1s total
    const elapsed = Date.now() - startTime;
    if (elapsed < 1000) {
      await new Promise((r) => setTimeout(r, 1000 - elapsed));
    }
    // Saving text fades out
    await new Promise<void>((resolve) => {
      Animated.timing(savingFade, {
        toValue: 0,
        duration: 180,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: false,
      }).start(resolve);
    });
    // Clear draft so placeholder shows, then animate area back in
    setDraft('');
    setSaving(false);
    Animated.timing(draftFade, {
      toValue: 1,
      duration: 300,
      easing: Easing.out(Easing.back(1.2)),
      useNativeDriver: false,
    }).start();
  };

  // ── Animated color for the "Saving.." thinking effect ────
  const savingTextColor = thinkingAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [DIM, '#FFFFFF', DIM],
  });

  // ── Slide / scale for the send animation ──────────────────
  const draftSlideY = draftFade.interpolate({
    inputRange: [0, 1],
    outputRange: [-24, 0],
  });
  const draftScale = draftFade.interpolate({
    inputRange: [0, 1],
    outputRange: [0.96, 1],
  });
  const savingSlideY = savingFade.interpolate({
    inputRange: [0, 1],
    outputRange: [16, 0],
  });

  // On native, wrap in TouchableWithoutFeedback so tapping outside the input
  // dismisses the keyboard. On web this wrapper intercepts clicks and makes
  // focusing the input require a long-press — so we skip it entirely.
  const RootWrapper = IS_WEB ? View : TouchableWithoutFeedback;
  const rootWrapperProps = IS_WEB ? { style: { flex: 1 } } : { onPress: Keyboard.dismiss };

  return (
    <RootWrapper {...rootWrapperProps}>
      <View style={{ flex: 1 }}>
        {/* Header */}
      <View style={[styles.header, { paddingTop: 54 }]}>
          <Text style={styles.headerTitle}>write</Text>
          <Pressable
            onPress={send}
            disabled={loading || saving || draft.trim().length === 0}
            hitSlop={14}
            style={({ pressed }) => [
              styles.sendBtn,
              pressed && styles.sendBtnPressed,
              (loading || saving || draft.trim().length === 0) && styles.sendBtnDisabled,
            ]}
          >
            {loading ? (
              <ActivityIndicator color={BLACK} size="small" />
            ) : (
              <Ionicons name="arrow-up" size={24} color={BLACK} />
            )}
          </Pressable>
        </View>

        <KeyboardAvoidingView
          className="tab-content"
          style={styles.pad}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={{ position: 'relative', flex: 1 }}>
            <Animated.View style={{ flex: 1, opacity: draftFade, transform: [{ translateY: draftSlideY }, { scale: draftScale }] }} pointerEvents={saving ? 'none' : 'auto'}>
              {!draft && (
                <Text
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    color: DIM,
                    fontSize: 22,
                    lineHeight: 34,
                    fontWeight: '300',
                  }}
                >
                  type your thought…
                </Text>
              )}
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder=""
                placeholderTextColor={DIM}
                multiline
                autoCorrect
                autoFocus={false}
              keyboardAppearance="dark"
              selectionColor="#FFFFFF"
              cursorColor="#FFFFFF"
              style={[styles.input, { marginLeft: -3 }]}
            />
            </Animated.View>

            {/* Saving.. overlay */}
            <Animated.Text
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                color: savingTextColor,
                fontSize: 22,
                lineHeight: 34,
                fontWeight: '300',
                opacity: savingFade,
                transform: [{ translateY: savingSlideY }],
              }}
            >
              Saving{'.'.repeat(dotCount)}
            </Animated.Text>
          </View>
        </KeyboardAvoidingView>

        {/* Mic area — bottom center (hidden on web; mic recording is native-only) */}
        {!IS_WEB && (
          <View style={styles.micArea}>
            {/* Pulsing dot */}
            <Animated.View
              pointerEvents="none"
              style={[
                styles.pulseDot,
                { opacity: waveOpacity, transform: [{ scale: pulseAnim }] },
              ]}
            />

            {/* Mic button */}
            <Animated.View style={{ opacity: buttonOpacity }}>
              <Pressable onPressIn={handleMicPressIn} onPressOut={handleMicPressOut} hitSlop={12} style={styles.micBtn}>
                {processing ? (
                  <ActivityIndicator color={BLACK} size="small" />
                ) : (
                  <Ionicons name="mic-outline" size={32} color={WHITE} />
                )}
              </Pressable>
            </Animated.View>

            {/* Saving text — fades in during transcription */}
            <Animated.Text style={[styles.savingText, { opacity: savingOpacity }]}>
              Saving…
            </Animated.Text>
          </View>
        )}
      </View>
    </RootWrapper>
  );
}

// ─── Reminders Tab ──────────────────────────────────────────────

function RemindersPad({
  reminders,
  notes,
  onDelete,
  onUpdate,
  onDeleteNote,
  onUpdateNote,
}: {
  reminders: Reminder[];
  notes: Note[];
  onDelete: (id: string) => void;
  onUpdate: (id: string, updates: Partial<Reminder>) => void;
  onDeleteNote: (id: string) => void;
  onUpdateNote: (id: string, updates: Partial<Note>) => void;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDate, setEditDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);

  const [noteEditingId, setNoteEditingId] = useState<string | null>(null);
  const [noteEditTitle, setNoteEditTitle] = useState('');
  const [noteEditRaw, setNoteEditRaw] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  // ── Reminder delete ──────────────────────────────────────────
  const del = async (r: Reminder) => {
    setDeleting(r.id);
    try {
      await cancelReminder(r.notificationId);
    } catch {}
    onDelete(r.id);
    setDeleting(null);
  };

  // ── Note delete ──────────────────────────────────────────────
  const delNote = async (n: Note) => {
    setDeleting(n.id);
    onDeleteNote(n.id);
    setDeleting(null);
  };

  const startEdit = (r: Reminder) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setEditingId(r.id);
    setEditTitle(r.title);
    setEditDate(new Date(r.fireAt));
  };

  const saveEdit = async (r: Reminder) => {
    if (!editTitle.trim()) {
      Alert.alert('Missing title', 'Enter a title for the reminder.');
      return;
    }
    let notificationId: string | undefined;
    try {
      await cancelReminder(r.notificationId);
    } catch {}
    try {
      notificationId = await scheduleReminder({
        title: editTitle.trim(),
        fireAt: editDate,
        recurring: r.recurring,
        daysOfWeek: r.daysOfWeek,
        remindBeforeMinutes: r.remindBeforeMinutes,
      });
    } catch {}
    await onUpdate(r.id, {
      title: editTitle.trim(),
      fireAt: editDate.toISOString(),
      ...(notificationId ? { notificationId } : {}),
    });
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setEditingId(null);
  };

  const startNoteEdit = (n: Note) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setNoteEditingId(n.id);
    setNoteEditTitle(n.title);
    setNoteEditRaw(n.raw);
  };

  const saveNoteEdit = async (n: Note) => {
    if (!noteEditTitle.trim()) {
      Alert.alert('Missing title', 'Enter a title for the note.');
      return;
    }
    await onUpdateNote(n.id, { title: noteEditTitle.trim(), raw: noteEditRaw });
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setNoteEditingId(null);
  };

  // ── Date helpers for inline picker ────────────────────────────
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const addDays = (d: Date, n: number) => {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  };

  const nextWeekday = (d: Date, target: number) => {
    const r = new Date(d);
    while (r.getDay() !== target) r.setDate(r.getDate() + 1);
    return r;
  };

  const datePresets = [
    { label: 'Today', getValue: () => new Date() },
    { label: 'Tomorrow', getValue: () => addDays(new Date(), 1) },
    { label: 'Sun', getValue: () => nextWeekday(new Date(), 0) },
    { label: 'Mon', getValue: () => nextWeekday(new Date(), 1) },
    { label: '+1 Week', getValue: () => addDays(new Date(), 7) },
  ];

  const timePresets = [
    { label: '9 AM', h: 9, m: 0 },
    { label: '12 PM', h: 12, m: 0 },
    { label: '3 PM', h: 15, m: 0 },
    { label: '6 PM', h: 18, m: 0 },
    { label: '9 PM', h: 21, m: 0 },
  ];

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    const opts: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    };
    return d.toLocaleDateString('en-US', opts);
  };

  const formatNoteDate = (iso: string) => {
    const d = new Date(iso);
    const opts: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
    };
    return d.toLocaleDateString('en-US', opts);
  };

  const fmtEditDate = (d: Date) =>
    `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;

  // ── All reminders sorted ───────────────────────────────────────
  const now = Date.now();
  const sorted = [...reminders].sort((a, b) => {
    const aPast = a.recurring === 'none' && new Date(a.fireAt).getTime() < now;
    const bPast = b.recurring === 'none' && new Date(b.fireAt).getTime() < now;
    if (aPast && !bPast) return 1;
    if (!aPast && bPast) return -1;
    return new Date(a.fireAt).getTime() - new Date(b.fireAt).getTime();
  });

  // ── Render ───────────────────────────────────────────────────
  return (
    <View style={{ flex: 1 }}>
        <ScrollView
            ref={scrollRef}
            className="tab-content"
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 220 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            stickyHeaderIndices={[0, 2]}
          >
            {/* Reminders header — sticky */}
            <View style={[styles.stickyHeader, { marginTop: 69 }]}>
              <Text style={styles.sectionTitle}>reminders</Text>
            </View>
            {/* Reminders content */}
            <View style={styles.section}>
              {sorted.length === 0 ? (
                <Text style={styles.emptyText}>no reminders</Text>
              ) : (
                sorted.map((r) => (
                  <View key={r.id}>
                    {editingId === r.id ? (
                      <View style={styles.editCard}>
                        <TextInput
                          value={editTitle}
                          onChangeText={setEditTitle}
                          style={styles.editInput}
                          placeholder="Reminder title"
                          placeholderTextColor={DIM}
                          keyboardAppearance="dark"
                          selectionColor="#FFFFFF"
                          cursorColor="#FFFFFF"
                        />
                        <Pressable
                          onPress={() => setShowDatePicker(!showDatePicker)}
                          style={styles.editDatePick}
                        >
                          <Text style={{ color: DIM, fontSize: 12 }}>When</Text>
                          <Text style={{ color: WHITE, fontSize: 14 }}>{fmtEditDate(editDate)}</Text>
                        </Pressable>
                        {showDatePicker && (
                          <View style={{ marginTop: 12, gap: 8 }}>
                            <Text style={{ color: DIM, fontSize: 11 }}>DATE</Text>
                            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                              {datePresets.map((p) => {
                                const d = p.getValue();
                                return (
                                  <PresetButton
                                    key={p.label}
                                    label={p.label}
                                    active={isSameDay(d, editDate)}
                                    onPress={() => {
                                      const next = new Date(d);
                                      next.setHours(editDate.getHours(), editDate.getMinutes());
                                      setEditDate(next);
                                    }}
                                  />
                                );
                              })}
                            </View>
                            <Text style={{ color: DIM, fontSize: 11, marginTop: 4 }}>TIME</Text>
                            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                              {timePresets.map((p) => (
                                <PresetButton
                                  key={p.label}
                                  label={p.label}
                                  active={editDate.getHours() === p.h && editDate.getMinutes() === p.m}
                                  onPress={() => {
                                    const next = new Date(editDate);
                                    next.setHours(p.h, p.m, 0, 0);
                                    setEditDate(next);
                                  }}
                                />
                              ))}
                            </View>
                          </View>
                        )}
                        <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
                          <Pressable onPress={() => saveEdit(r)} style={styles.editSaveBtn}>
                            <Text style={styles.editSaveText}>Save</Text>
                          </Pressable>
                          <Pressable onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setEditingId(null); }} style={styles.editCancelBtn}>
                            <Text style={styles.editCancelText}>Cancel</Text>
                          </Pressable>
                        </View>
                      </View>
                    ) : (
                      <Swipeable
                        overshootRight={false}
                        friction={2}
                        renderRightActions={(progress) => {
                          const tx = progress.interpolate({
                            inputRange: [0, 1],
                            outputRange: [100, 0],
                          });
                          return (
                            <Animated.View style={{ transform: [{ translateX: tx }], justifyContent: 'center', alignItems: 'flex-end', width: 80, paddingRight: 10 }}>
                              <Pressable
                                onPress={() => del(r)}
                                style={styles.swipeAction}
                              >
                                {deleting === r.id ? (
                                  <ActivityIndicator color={WHITE} size="small" />
                                ) : (
                                  <Ionicons name="trash-outline" size={20} color={WHITE} />
                                )}
                              </Pressable>
                            </Animated.View>
                          );
                        }}
                      >
                        <View style={styles.reminderRow}>
                          <Pressable
                            onPress={() => startEdit(r)}
                            style={{ flex: 1 }}
                          >
                            <Text style={styles.reminderTitle}>{r.title}</Text>
                            <Text style={styles.reminderMeta}>
                              {formatDate(r.fireAt)}
                              {r.skipDates?.includes(new Date().toISOString().split('T')[0])
                                ? ' · skipped today'
                                : r.recurring !== 'none' && (
                                  r.daysOfWeek && r.daysOfWeek.length > 0
                                    ? ` · ${r.daysOfWeek.map((d: number) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ')}`
                                    : ` · ${r.recurring}`
                                )}
                            </Text>
                          </Pressable>
                        </View>
                      </Swipeable>
                    )}
                  </View>
                )))}
            </View>
            {/* Notes header — sticky */}
            <View style={styles.stickyHeader}>
              <Text style={styles.sectionTitle}>notes</Text>
            </View>
            {/* Notes content */}
            <View style={styles.section}>
            {notes.length === 0 ? (
              <Text style={styles.emptyText}>no notes</Text>
            ) : (
              notes.map((n) => (
                <View key={n.id}>
                  {noteEditingId === n.id ? (
                    <View style={styles.editCard}>
                      <TextInput
                        value={noteEditTitle}
                        onChangeText={setNoteEditTitle}
                        style={styles.editInput}
                        placeholder="Note title"
                        placeholderTextColor={DIM}
                        autoFocus
                        keyboardAppearance="dark"
                        selectionColor="#FFFFFF"
                        cursorColor="#FFFFFF"
                      />
                      <TextInput
                        value={noteEditRaw}
                        onChangeText={setNoteEditRaw}
                        style={[styles.editInput, styles.editInputMultiline]}
                        placeholder="Content"
                        placeholderTextColor={DIM}
                        multiline
                        keyboardAppearance="dark"
                        selectionColor="#FFFFFF"
                        cursorColor="#FFFFFF"
                      />
                      <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
                        <Pressable onPress={() => saveNoteEdit(n)} style={styles.editSaveBtn}>
                          <Text style={styles.editSaveText}>Save</Text>
                        </Pressable>
                        <Pressable onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setNoteEditingId(null); }} style={styles.editCancelBtn}>
                          <Text style={styles.editCancelText}>Cancel</Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : (
                    <Swipeable
                      overshootRight={false}
                      friction={2}
                      renderRightActions={(progress) => {
                        const tx = progress.interpolate({
                          inputRange: [0, 1],
                          outputRange: [100, 0],
                        });
                        return (
                          <Animated.View style={{ transform: [{ translateX: tx }], justifyContent: 'center', alignItems: 'flex-end', width: 80, paddingRight: 10 }}>
                            <Pressable
                              onPress={() => delNote(n)}
                              style={styles.swipeAction}
                            >
                              {deleting === n.id ? (
                                <ActivityIndicator color={WHITE} size="small" />
                              ) : (
                                <Ionicons name="trash-outline" size={20} color={WHITE} />
                              )}
                            </Pressable>
                          </Animated.View>
                        );
                      }}
                    >
                      <Pressable onPress={() => startNoteEdit(n)} style={styles.noteItem}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.noteTitle}>{n.title}</Text>
                          <Text style={styles.noteRaw} numberOfLines={2}>
                            {n.raw}
                          </Text>
                        </View>
                        <Text style={styles.noteDate}>{formatNoteDate(n.createdAt)}</Text>
                      </Pressable>
                    </Swipeable>
                  )}
                </View>
              )))}
            </View>
        </ScrollView>

    </View>
  );
}

// ─── Preset chip for inline date/time picker ────────────────────

function PresetButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 20,
        backgroundColor: active ? '#444' : '#1a1a1a',
        borderWidth: 1,
        borderColor: active ? '#fff' : '#333',
      }}
    >
      <Text style={{ color: active ? '#fff' : '#888', fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

// ─── Month View ─────────────────────────────────────────────────

function MonthView({
  reminders,
  notes,
  onDeleteNote,
}: {
  reminders: Reminder[];
  notes: Note[];
  onDeleteNote: (id: string) => void;
}) {
  const today = useMemo(() => new Date(), []);
  const todayStr = today.toISOString().split('T')[0];
  const [cursor, setCursor] = useState(() => new Date());
  const [selected, setSelected] = useState<string | null>(todayStr);
  const [calRemindersOpen, setCalRemindersOpen] = useState(true);
  const [calNotesOpen, setCalNotesOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const slideAnim = useRef(new Animated.Value(0)).current;

  const delNote = (n: Note) => {
    setDeleting(n.id);
    onDeleteNote(n.id);
    setDeleting(null);
  };

  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startPad = firstDay.getDay();

  const days: (number | null)[] = [];
  for (let i = 0; i < startPad; i++) days.push(null);
  for (let d = 1; d <= lastDay.getDate(); d++) days.push(d);

  const monthLabel = cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const animateToMonth = (dir: 'left' | 'right', newCursor: Date) => {
    const offset = dir === 'left' ? 300 : -300;
    slideAnim.setValue(offset);
    setCursor(newCursor);
    // Keep selected day in the new month (clamp to last day if overflow)
    if (selected) {
      const dayNum = Math.min(
        parseInt(selected.split('-')[2], 10),
        new Date(newCursor.getFullYear(), newCursor.getMonth() + 1, 0).getDate(),
      );
      setSelected(
        `${newCursor.getFullYear()}-${String(newCursor.getMonth() + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`,
      );
    }
    Animated.timing(slideAnim, {
      toValue: 0,
      duration: 250,
      useNativeDriver: true,
    }).start();
  };

  const prevMonth = () => animateToMonth('right', new Date(year, month - 1, 1));
  const nextMonth = () => animateToMonth('left', new Date(year, month + 1, 1));

  const prevDay = () => {
    if (!selected) return;
    const d = new Date(`${selected}T12:00:00`);
    d.setDate(d.getDate() - 1);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    setSelected(ds);
    // If we went into the previous month, follow
    if (d.getMonth() !== cursor.getMonth() || d.getFullYear() !== cursor.getFullYear()) {
      animateToMonth('right', new Date(d.getFullYear(), d.getMonth(), 1));
    }
  };
  const nextDay = () => {
    if (!selected) return;
    const d = new Date(`${selected}T12:00:00`);
    d.setDate(d.getDate() + 1);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    setSelected(ds);
    if (d.getMonth() !== cursor.getMonth() || d.getFullYear() !== cursor.getFullYear()) {
      animateToMonth('left', new Date(d.getFullYear(), d.getMonth(), 1));
    }
  };

  const dayLabel = selected
    ? new Date(`${selected}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    : '';

  const dateStr = (day: number) =>
    `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const localDateStr = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const isSkipped = (r: Reminder, dateStr: string) => r.skipDates?.includes(dateStr) ?? false;

  const hasEvent = (day: number): boolean => {
    const ds = dateStr(day);
    const d = new Date(year, month, day);
    return (
      reminders.some((r) => {
        if (isSkipped(r, ds)) return false;
        if (r.recurring === 'daily') return true;
        const rd = new Date(r.fireAt);
        if (r.recurring === 'none') return localDateStr(rd) === ds;
        if (r.recurring === 'weekly') {
          if (r.daysOfWeek && r.daysOfWeek.length > 0) return r.daysOfWeek.includes(d.getDay());
          return rd.getDay() === d.getDay();
        }
        if (r.recurring === 'monthly') return rd.getDate() === d.getDate();
        if (r.recurring === 'yearly') return rd.getMonth() === d.getMonth() && rd.getDate() === d.getDate();
        return false;
      }) ||
      notes.some((n) => localDateStr(new Date(n.createdAt)) === ds)
    );
  };

  const selectedEvents = (() => {
    if (!selected) return null;
    const d = new Date(`${selected}T00:00:00`);
    const items: { id: string; title: string; meta: string }[] = [];

    reminders.forEach((r) => {
      if (isSkipped(r, selected)) return;
      if (r.recurring === 'daily') {
        items.push({ id: r.id, title: r.title, meta: 'daily' });
      } else {
        const rd = new Date(r.fireAt);
        const rds = localDateStr(rd);
        if (r.recurring === 'none' && rds === selected) {
          const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
          items.push({ id: r.id, title: r.title, meta: rd.toLocaleTimeString('en-US', opts) });
        } else if (r.recurring === 'weekly') {
          if (r.daysOfWeek && r.daysOfWeek.length > 0) {
            if (r.daysOfWeek.includes(d.getDay())) {
              const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
              const label = r.daysOfWeek.map(dd => dayNames[dd]).join(', ');
              items.push({ id: r.id, title: r.title, meta: label });
            }
          } else if (rd.getDay() === d.getDay()) {
            items.push({ id: r.id, title: r.title, meta: 'weekly' });
          }
        } else if (r.recurring === 'monthly' && rd.getDate() === d.getDate()) {
          items.push({ id: r.id, title: r.title, meta: 'monthly' });
        } else if (r.recurring === 'yearly' && rd.getMonth() === d.getMonth() && rd.getDate() === d.getDate()) {
          items.push({ id: r.id, title: r.title, meta: 'yearly' });
        }
      }
    });

    return items;
  })();

  // Notes that belong to the selected calendar day.
  // Uses the same localDateStr helper as the grid (YYYY-MM-DD).
  const notesForSelectedDay = selected
    ? notes.filter((n) => localDateStr(new Date(n.createdAt)) === selected)
    : [];

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>calendar</Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20, paddingTop: 5 }}>
        {/* On web, cap the calendar content width so cells don't balloon on
            wide desktop/tablet viewports. On native, full width is correct. */}
        <View style={IS_WEB ? styles.calWebWrap : undefined}>
        {/* cal-split: stack on mobile, side-by-side on desktop (via CSS class). */}
        <View className="cal-split">
          {/* ── LEFT SIDE: month nav + day headers + grid ── */}
          <View className="cal-grid-side">
          {/* Month nav */}
          <View style={styles.monthNav}>
            <Pressable onPress={prevMonth} hitSlop={10}>
              <Ionicons name="chevron-back" size={20} color={WHITE} />
            </Pressable>
            <Text style={styles.monthLabel}>{monthLabel}</Text>
            <Pressable onPress={nextMonth} hitSlop={10}>
              <Ionicons name="chevron-forward" size={20} color={WHITE} />
            </Pressable>
          </View>

          <Animated.View style={{ transform: [{ translateX: slideAnim }] }}>
            {/* Day-of-week headers */}
            <View style={styles.calRow}>
              {[{ l: 'Su' }, { l: 'M' }, { l: 'T' }, { l: 'W' }, { l: 'Th' }, { l: 'F' }, { l: 'Sa' }].map(({ l }) => (
                <View key={l} style={styles.calDayHead}>
                  <Text style={styles.calDayHeadText}>{l}</Text>
                </View>
              ))}
            </View>

            {/* Grid */}
            <View style={styles.calGrid}>
              {days.map((day, i) => (
                <View key={day !== null ? `day-${day}` : `pad-${i}`} style={styles.calDay}>
                  {day !== null ? (
                    <Pressable
                      onPress={() => setSelected(dateStr(day))}
                      style={[
                        styles.calDayBtn,
                        selected === dateStr(day) && styles.calDaySelected,
                        dateStr(day) === todayStr && styles.calDayTodayBox,
                      ]}
                    >
                      <Text
                        style={[
                          styles.calDayNum,
                          selected === dateStr(day) && styles.calDayNumSelected,
                          dateStr(day) === todayStr && styles.calDayToday,
                        ]}
                      >
                        {day}
                      </Text>
                      {hasEvent(day) && <View style={styles.calDot} />}
                    </Pressable>
                  ) : (
                    <View style={styles.calDayEmpty} />
                  )}
                </View>
              ))}
            </View>
          </Animated.View>
          </View>

          {/* ── RIGHT SIDE: selected day detail (reminders + notes) ── */}
          <View className="cal-detail-side">
            {/* Day label heading — only show when a day is selected */}
            {selected && dayLabel && (
              <Text style={styles.calDayHeading}>{dayLabel}</Text>
            )}

            {/* Reminders for selected day — dropdown, open by default */}
            {selectedEvents && selectedEvents.length > 0 && (
              <View style={[styles.section, { paddingHorizontal: 22 }]}>
                <Pressable
                  onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setCalRemindersOpen(!calRemindersOpen); }}
                  style={styles.dropdownToggle}
                >
                  <Text style={styles.sectionLabel}>reminders · {selectedEvents.length}</Text>
                  <Ionicons
                    name={calRemindersOpen ? 'chevron-up' : 'chevron-down'}
                    size={14}
                    color={DIM}
                  />
                </Pressable>
                {calRemindersOpen && (
                  <View>
                    {selectedEvents.map((e) => (
                      <View key={e.id} style={styles.calEventItem}>
                        <Ionicons
                          name="notifications-outline"
                          size={14}
                          color={DIM}
                        />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.calEventTitle}>{e.title}</Text>
                          <Text style={styles.calEventMeta} numberOfLines={1}>
                            {e.meta}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )}

            {/* Empty day — only if nothing at all */}
            {(!selectedEvents || selectedEvents.length === 0) && notesForSelectedDay.length === 0 && (
              <View style={styles.calEmptyWrap}>
                <Text style={styles.calEmpty}>{selected ? 'nothing this day' : 'pick a day'}</Text>
              </View>
            )}

            {/* Notes for the selected day — collapsible */}
            {notesForSelectedDay.length > 0 && (
              <View style={[styles.section, { paddingHorizontal: 22 }]}>
                <Pressable
                  onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setCalNotesOpen(!calNotesOpen); }}
                  style={styles.dropdownToggle}
                >
                  <Text style={styles.sectionLabel}>notes · {notesForSelectedDay.length}</Text>
                  <Ionicons
                    name={calNotesOpen ? 'chevron-up' : 'chevron-down'}
                    size={14}
                    color={DIM}
                  />
                </Pressable>
                {calNotesOpen && (
                  <View>
                    {notesForSelectedDay.map((n) => (
                      <Swipeable
                        key={n.id}
                        overshootRight={false}
                        friction={2}
                        renderRightActions={(progress) => {
                          const tx = progress.interpolate({
                            inputRange: [0, 1],
                            outputRange: [100, 0],
                          });
                          return (
                            <Animated.View style={{ transform: [{ translateX: tx }], justifyContent: 'center', alignItems: 'flex-end', width: 80, paddingRight: 10 }}>
                              <Pressable
                                onPress={() => delNote(n)}
                                style={styles.swipeAction}
                              >
                                {deleting === n.id ? (
                                  <ActivityIndicator color={WHITE} size="small" />
                                ) : (
                                  <Ionicons name="trash-outline" size={20} color={WHITE} />
                                )}
                              </Pressable>
                            </Animated.View>
                          );
                        }}
                      >
                        <View style={styles.noteItem}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.noteTitle}>{n.title}</Text>
                            <Text style={styles.noteRaw} numberOfLines={2}>
                              {n.raw}
                            </Text>
                          </View>
                          <Text style={styles.noteDate}>
                            {new Date(n.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </Text>
                        </View>
                      </Swipeable>
                    ))}
                  </View>
                )}
              </View>
            )}
          </View>
        </View>
        </View>
      </ScrollView>
    </View>
  );
}

// ─── App ────────────────────────────────────────────────────────

export default function App() {
  return (
    <View style={styles.outerShell}>
      <View style={styles.appShell} className="app-shell">
        <AppInner />
      </View>
    </View>
  );
}

function AppInner() {
  const [tab, setTab] = useState<'write' | 'reminders' | 'calendar'>('write');
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const switchTab = (t: typeof tab) => {
    if (t === tab) return;
    fadeAnim.setValue(0);
    setTab(t);
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
  };

  // Load reminders on mount and after new ones are created.
  const loadReminders = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(REMINDERS_KEY);
      if (raw) setReminders(JSON.parse(raw));
    } catch {}
  }, []);

  // Load notes on mount and after new ones are created.
  const loadNotes = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(NOTES_KEY);
      if (raw) setNotes(JSON.parse(raw));
    } catch {}
  }, []);

  useEffect(() => {
    loadReminders();
    loadNotes();
  }, [loadReminders, loadNotes]);

  // Request notification permissions on startup so they're ready.
  useEffect(() => {
    requestPermissions();
  }, []);

  // Listen for notification taps — switch to reminders tab.
  useEffect(() => {
    const sub = addNotificationResponseListener(() => {
      setTab('reminders');
      loadReminders();
    });
    return () => sub.remove();
  }, [loadReminders]);

  const deleteReminder = useCallback(
    async (id: string) => {
      const reminder = reminders.find((r) => r.id === id);
      if (reminder) {
        try { await cancelReminder(reminder.notificationId); } catch {}
      }
      const next = reminders.filter((r) => r.id !== id);
      setReminders(next);
      await AsyncStorage.setItem(REMINDERS_KEY, JSON.stringify(next));
    },
    [reminders],
  );

  const updateReminder = useCallback(
    async (id: string, updates: Partial<Reminder>) => {
      const next = reminders.map((r) => (r.id === id ? { ...r, ...updates } : r));
      setReminders(next);
      await AsyncStorage.setItem(REMINDERS_KEY, JSON.stringify(next));
    },
    [reminders],
  );

  const deleteNote = useCallback(
    async (id: string) => {
      const next = notes.filter((n) => n.id !== id);
      setNotes(next);
      await AsyncStorage.setItem(NOTES_KEY, JSON.stringify(next));
    },
    [notes],
  );

  const updateNote = useCallback(
    async (id: string, updates: Partial<Note>) => {
      const next = notes.map((n) => (n.id === id ? { ...n, ...updates } : n));
      setNotes(next);
      await AsyncStorage.setItem(NOTES_KEY, JSON.stringify(next));
    },
    [notes],
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={styles.container}>
      <StatusBar style="light" />

      {/* Close button — top-right corner, web only.
          Returns to the landing page. Hidden on native (no concept of "back to website"). */}
      {IS_WEB && (
        <Pressable
          onPress={() => { try { window.location.href = '/'; } catch {} }}
          style={styles.closeBtn}
          hitSlop={12}
          accessibilityLabel="Back to website"
        >
          <Ionicons name="close" size={16} color={DIM} />
        </Pressable>
      )}

      <Animated.View
        style={[
          { flex: 1, opacity: fadeAnim, transform: [{ translateY: fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] },
        ]}
      >
        {tab === 'write' ? (
          <WritePad onReminderCreated={loadReminders} onNoteCreated={loadNotes} />
        ) : tab === 'reminders' ? (
          <RemindersPad
            reminders={reminders}
            notes={notes}
            onDelete={deleteReminder}
            onUpdate={updateReminder}
            onDeleteNote={deleteNote}
            onUpdateNote={updateNote}
          />
        ) : (
          <MonthView
            reminders={reminders}
            notes={notes}
            onDeleteNote={deleteNote}
          />
        )}
      </Animated.View>

      {/* Bottom nav */}
      <View style={styles.nav}>
        <Pressable style={styles.navBtn} onPress={() => switchTab('calendar')}>
          <View style={styles.navIconWrap}>
            <Ionicons
              name={tab === 'calendar' ? 'calendar' : 'calendar-outline'}
              size={22}
              color={tab === 'calendar' ? WHITE : DIM}
            />
            {tab === 'calendar' && <View style={styles.navDot} />}
          </View>
        </Pressable>
        <Pressable style={styles.navBtn} onPress={() => switchTab('write')}>
          <View style={styles.navIconWrap}>
            <Ionicons
              name={tab === 'write' ? 'create' : 'create-outline'}
              size={22}
              color={tab === 'write' ? WHITE : DIM}
            />
            {tab === 'write' && <View style={styles.navDot} />}
          </View>
        </Pressable>
        <Pressable style={styles.navBtn} onPress={() => switchTab('reminders')}>
          <View style={styles.navIconWrap}>
            <Ionicons
              name={tab === 'reminders' ? 'notifications' : 'notifications-outline'}
              size={22}
              color={tab === 'reminders' ? WHITE : DIM}
            />
            {tab === 'reminders' && <View style={styles.navDot} />}
          </View>
        </Pressable>
      </View>
    </View>
    </GestureHandlerRootView>
  );
}

// ─── Styles ─────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // outerShell centers the app on large screens (desktop/tablet) on web.
  // On native (phone), it just fills the screen.
  outerShell: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // appShell is the "phone-shaped" column on small screens, but expands
  // to use more of the available space on tablets and laptops.
  // On native it always fills the whole screen.
  appShell: {
    flex: 1,
    width: '100%',
    backgroundColor: BLACK,
    ...(Platform.OS === 'web'
      ? {
          // Phones (< 600px): full width, phone-like feel.
          // Small tablets / large phones (600-900px): cap at 540px, centered.
          // Tablets / laptops (>= 900px): cap at 720px, centered with shadow.
          // The media queries below adjust maxWidth + padding.
          maxWidth: '100%',
          marginHorizontal: 'auto',
          boxShadow: '0 0 60px rgba(0,0,0,0.5)',
          minHeight: '100vh',
        }
      : {}),
  },
  container: { flex: 1, backgroundColor: BLACK },

  // Web-only wrapper for calendar content — caps width + centers horizontally
  // so day cells don't balloon out on wide desktop/tablet viewports.
  // aspectRatio: 1 on a 14.2857%-wide cell means cells scale with the column;
  // capping the column to ~480px keeps cells at a phone-like ~60px square.
  calWebWrap: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
  },

  // Heading for the selected day on the right side of the split view.
  calDayHeading: {
    color: WHITE,
    fontSize: 14,
    fontWeight: '500',
    letterSpacing: 0.5,
    paddingHorizontal: 22,
    paddingTop: 8,
    paddingBottom: 14,
    textTransform: 'uppercase',
  },

  // Close button — small X in the top-right corner of the web app.
  // Returns user to the landing page. Web only.
  closeBtn: {
    position: 'absolute',
    top: 14,
    right: 14,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingTop: 64,
    paddingBottom: 12,
  },
  headerTitle: {
    color: WHITE,
    fontSize: 14,
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontWeight: '400',
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: WHITE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnPressed: { opacity: 0.7 },
  sendBtnDisabled: { opacity: 0.3 },

  // Writing pad
  pad: { flex: 1, paddingHorizontal: 22 },
  input: {
    color: WHITE,
    fontSize: 22,
    lineHeight: 34,
    fontWeight: '300',
    minHeight: 260,
    textAlignVertical: 'top',
    padding: 0,
  },
  micArea: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 20,
    height: 80,
  },
  pulseDot: {
    position: 'absolute',
    top: 2,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: WHITE,
  },
  micBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: '#2a2a2a',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  savingText: {
    color: DIM,
    fontSize: 12,
    letterSpacing: 1,
    marginTop: 10,
    textTransform: 'uppercase',
  },

  // Reminders
  section: {
    marginBottom: 28,
  },
  sectionLabel: {
    color: DIM,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  stickyHeader: {
    backgroundColor: '#000',
    paddingBottom: 12,
  },
  sectionTitle: {
    color: WHITE,
    fontSize: 14,
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontWeight: '400',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: DIM,
    fontSize: 13,
    letterSpacing: 1,
  },
  reminderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  reminderTitle: {
    color: WHITE,
    fontSize: 16,
    fontWeight: '400',
  },
  reminderMeta: {
    color: DIM,
    fontSize: 12,
    marginTop: 2,
  },

  // Notes
  noteItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  noteTitle: {
    color: WHITE,
    fontSize: 14,
    fontWeight: '400',
  },
  noteRaw: {
    color: DIM,
    fontSize: 12,
    marginTop: 2,
  },
  noteDate: {
    color: DIM,
    fontSize: 11,
    marginLeft: 12,
  },

  // Dropdown
  dropdownToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },

  // Edit reminder time
  editCard: {
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
    gap: 8,
  },
  editInput: {
    color: WHITE,
    fontSize: 14,
    backgroundColor: '#111',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  editInputMultiline: {
    minHeight: 60,
    textAlignVertical: 'top',
  },
  editDatePick: {
    backgroundColor: '#111',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 2,
  },
  editSaveBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: WHITE,
    borderRadius: 6,
  },
  editSaveText: {
    color: BLACK,
    fontSize: 13,
    fontWeight: '600',
  },
  editCancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  editCancelText: {
    color: DIM,
    fontSize: 13,
    fontWeight: '400',
  },

  // Swipe action — circle
  swipeAction: {
    backgroundColor: '#FF3B30',
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Calendar
  monthNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingVertical: 12,
  },
  monthLabel: {
    color: WHITE,
    fontSize: 16,
    fontWeight: '400',
  },
  calRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
  },
  calDayHead: {
    width: '14.2857%',
    alignItems: 'center',
    paddingVertical: 6,
  },
  calDayHeadText: {
    color: DIM,
    fontSize: 11,
    letterSpacing: 1,
  },
  calGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
  },
  // Each day cell takes exactly 1/7 of the row width via aspectRatio-based
  // sizing. We avoid `width: '14.28%'` + nested `flex: 1` because react-native-web
  // computes percentages against the wrong reference inside flexWrap containers,
  // which collapses the grid on desktop/tablet. aspectRatio on a width-bound
  // child resolves consistently across platforms.
  calDay: {
    width: '14.2857%',
    aspectRatio: 1,
    padding: 2,
  },
  calDayEmpty: {
    width: '100%',
    height: '100%',
  },
  calDayBtn: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  calDaySelected: {
    backgroundColor: '#222',
  },
  calDayTodayBox: {
    borderWidth: 1,
    borderColor: WHITE,
  },
  calDayNum: {
    color: WHITE,
    fontSize: 14,
    fontWeight: '300',
  },
  calDayNumSelected: {
    fontWeight: '600',
  },
  calDayToday: {
    color: WHITE,
    fontWeight: '700',
    fontSize: 15,
  },
  calDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#FFFFFF',
    marginTop: 3,
  },
  calEmptyWrap: {
    paddingHorizontal: 22,
    paddingTop: 12,
  },
  calEventItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  calEventTitle: {
    color: WHITE,
    fontSize: 13,
    fontWeight: '400',
  },
  calEventMeta: {
    color: DIM,
    fontSize: 11,
    marginTop: 1,
  },
  calEmpty: {
    color: DIM,
    fontSize: 12,
    fontStyle: 'italic',
  },

  // Nav
  nav: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
    paddingTop: 10,
    paddingBottom: 28,
  },
  navBtn: { flex: 1, alignItems: 'center', paddingVertical: 4 },
  navIconWrap: {
    alignItems: 'center',
    gap: 4,
  },
  navDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: WHITE,
  },
});
