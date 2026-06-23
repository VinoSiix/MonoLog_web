import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
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
  cancelReminder,
  requestPermissions,
  scheduleReminder,
} from './src/notifications';
import type { AnalyzeResponse, Note, Reminder } from './src/types';
import { GestureHandlerRootView, Swipeable } from 'react-native-gesture-handler';
import { Audio } from 'expo-av';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const BLACK = '#000000';
const WHITE = '#FFFFFF';
const DIM = '#555555';

const NOTES_KEY = 'minnotes.notes';
const REMINDERS_KEY = 'minnotes.reminders';

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
  const recordingRef = useRef<Audio.Recording | null>(null);
  const finishingRef = useRef(false);
  const audioReadyRef = useRef(true);
  const buttonOpacity = useRef(new Animated.Value(1)).current;
  const waveOpacity = useRef(new Animated.Value(0)).current;
  const barAnims = useRef(Array.from({ length: 4 }, () => new Animated.Value(0.5))).current;
  const waveLoopRef = useRef<Animated.CompositeAnimation | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSoundRef = useRef<number>(Date.now());

  // ── Smooth wave with 10-step sine-like cycle ──────────────────
  const startWave = () => {
    Animated.parallel([
      Animated.timing(buttonOpacity, { toValue: 0, duration: 250, useNativeDriver: true }),
      Animated.timing(waveOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
    ]).start();

    const ranges: [number, number][] = [
      [0.3, 1.9],
      [0.5, 1.5],
      [0.2, 1.7],
      [0.4, 1.4],
    ];

    const loops = barAnims.map((anim, i) => {
      const [low, high] = ranges[i];
      const speed = 320 + i * 40;

      // Build a smooth sine-like cycle from low→high→low with 6 intermediate points
      const pts = [low, low + (high - low) * 0.3, high, high - (high - low) * 0.3, low];
      const seq = pts.map((v) =>
        Animated.timing(anim, {
          toValue: v,
          duration: speed / pts.length,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      );
      return Animated.loop(Animated.sequence(seq));
    });

    const composite = Animated.parallel(loops);
    composite.start();
    waveLoopRef.current = composite;
  };

  const stopWave = () => {
    waveLoopRef.current?.stop();
    barAnims.forEach((a) => { a.setValue(0.5); });
    Animated.parallel([
      Animated.timing(buttonOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(waveOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start();
  };

  // ── Silence detection ──────────────────────────────────────────
  const startSilenceDetector = async () => {
    lastSoundRef.current = Date.now();
    silenceTimerRef.current = setInterval(async () => {
      try {
        const rec = recordingRef.current;
        if (!rec) return;
        const status = await rec.getStatusAsync();
        if (!status.isRecording) return;
        const metering = (status as any).metering ?? -160;
        // dB: -160 (silent) to 0 (loud). Threshold at -45 dB.
        if (metering > -45) {
          lastSoundRef.current = Date.now();
        } else if (Date.now() - lastSoundRef.current > 2000) {
          // 2 seconds of silence — auto-stop
          if (finishingRef.current) return;
          finishingRef.current = true;
          clearInterval(silenceTimerRef.current!);
          silenceTimerRef.current = null;
          await finishRecording();
        }
      } catch {}
    }, 200);
  };

  const stopSilenceDetector = () => {
    if (silenceTimerRef.current) {
      clearInterval(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  // ── Finish recording (shared between manual stop and auto-stop) ─
  const finishRecording = async (): Promise<void> => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    audioReadyRef.current = false;
    stopWave();
    stopSilenceDetector();
    setListening(false);
    setProcessing(true);
    try {
      const rec = recordingRef.current;
      recordingRef.current = null;
      if (!rec) return;
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      if (!uri) {
        Alert.alert('Error', 'No recording data.');
        return;
      }
      const text = await transcribeAudio(uri);
      if (text) setDraft((prev) => (prev ? prev + ' ' + text : text));
    } catch (e: any) {
      Alert.alert('Transcription failed', e?.message ?? 'Unknown error');
    } finally {
      await new Promise((r) => setTimeout(r, 300));
      setProcessing(false);
      finishingRef.current = false;
      audioReadyRef.current = true;
    }
  };

  const toggleMic = async () => {
    if (processing || !audioReadyRef.current) return;

    if (listening) {
      await finishRecording();
      return;
    }

    // Request mic permission
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Microphone access is required for voice input.');
      return;
    }

    // Start recording
    try {
      // Configure audio session right before recording (expo-av style)
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });
      const { recording } = await Audio.Recording.createAsync({
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      } as any);
      recordingRef.current = recording;
      setListening(true);
      startWave();
      startSilenceDetector();
    } catch (e: any) {
      audioReadyRef.current = true;
      Alert.alert('Recording failed', e?.message ?? 'Could not start mic');
    }
  };

  // Persist draft.
  useEffect(() => {
    AsyncStorage.setItem('minnotes.draft', draft);
  }, [draft]);

  // Restore draft.
  useEffect(() => {
    (async () => {
      try {
        const d = await AsyncStorage.getItem('minnotes.draft');
        if (d) setDraft(d);
      } catch {}
    })();
  }, []);


  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setLoading(true);

    let result: AnalyzeResponse | null = null;
    try {
      result = await analyzeNote(text, new Date().getTimezoneOffset());
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
      setDraft('');
      setLoading(false);
      return;
    }

    // ── AI analysis succeeded — parse result ────────────────────
    if (result.needsReminder && result.reminder) {
      // ── Reminder ───────────────────────────────────────────────
      const fireAt = new Date(result.reminder.datetime);
      // Don't schedule in the past — clamp to now + 1min.
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
            recurring: result.reminder.recurring,
          });
        }
      } catch {}

      const reminder: Reminder = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: result.title,
        fireAt: fireDate.toISOString(),
        recurring: result.reminder.recurring,
        notificationId: notificationId ?? '',
      };

      const existing = await AsyncStorage.getItem(REMINDERS_KEY);
      const reminders: Reminder[] = existing ? JSON.parse(existing) : [];
      reminders.unshift(reminder);
      await AsyncStorage.setItem(REMINDERS_KEY, JSON.stringify(reminders));
      onReminderCreated();
    } else {
      // ── Not a reminder — save as note ────────────────────────
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
    }

    setDraft('');
    setLoading(false);
  };

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <View style={{ flex: 1 }}>
        {/* Header */}
      <View style={[styles.header, { paddingTop: 54 }]}>
          <Text style={styles.headerTitle}>write</Text>
          <Pressable
            onPress={send}
            disabled={loading || draft.trim().length === 0}
            hitSlop={14}
            style={({ pressed }) => [
              styles.sendBtn,
              pressed && styles.sendBtnPressed,
              (loading || draft.trim().length === 0) && styles.sendBtnDisabled,
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
          style={styles.pad}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={{ position: 'relative', flex: 1 }}>
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
          </View>
        </KeyboardAvoidingView>

        {/* Mic area — bottom center */}
        <View style={styles.micArea}>
          {/* Soundwave bars */}
          <Animated.View style={[styles.waveRow, { opacity: waveOpacity }]}>
              <Animated.View style={[styles.waveBar, { transform: [{ scaleY: barAnims[0] }] }]} />
              <Animated.View style={[styles.waveBar, { transform: [{ scaleY: barAnims[1] }] }]} />
              <Animated.View style={[styles.waveBar, { transform: [{ scaleY: barAnims[2] }] }]} />
              <Animated.View style={[styles.waveBar, { transform: [{ scaleY: barAnims[3] }] }]} />
          </Animated.View>

          {/* Mic button */}
          <Animated.View style={{ opacity: buttonOpacity }}>
            <Pressable onPress={toggleMic} hitSlop={12} style={styles.micBtn}>
              {processing ? (
                <ActivityIndicator color={BLACK} size="small" />
              ) : (
                <Ionicons name="mic-outline" size={28} color={DIM} />
              )}
            </Pressable>
          </Animated.View>
        </View>
      </View>
    </TouchableWithoutFeedback>
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
                              {r.recurring !== 'none' && ` · ${r.recurring}`}
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

  const hasEvent = (day: number): boolean => {
    const ds = dateStr(day);
    const d = new Date(year, month, day);
    return (
      reminders.some((r) => {
        if (r.recurring === 'daily') return true;
        const rd = new Date(r.fireAt);
        if (r.recurring === 'none') return rd.toISOString().split('T')[0] === ds;
        if (r.recurring === 'weekly') return rd.getDay() === d.getDay();
        if (r.recurring === 'monthly') return rd.getDate() === d.getDate();
        return false;
      }) ||
      notes.some((n) => new Date(n.createdAt).toISOString().split('T')[0] === ds)
    );
  };

  const selectedEvents = (() => {
    if (!selected) return null;
    const d = new Date(`${selected}T00:00:00`);
    const items: { id: string; title: string; meta: string }[] = [];

    reminders.forEach((r) => {
      if (r.recurring === 'daily') {
        items.push({ id: r.id, title: r.title, meta: 'daily' });
      } else {
        const rd = new Date(r.fireAt);
        const rds = rd.toISOString().split('T')[0];
        if (r.recurring === 'none' && rds === selected) {
          const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
          items.push({ id: r.id, title: r.title, meta: rd.toLocaleTimeString('en-US', opts) });
        } else if (r.recurring === 'weekly' && rd.getDay() === d.getDay()) {
          items.push({ id: r.id, title: r.title, meta: 'weekly' });
        } else if (r.recurring === 'monthly' && rd.getDate() === d.getDate()) {
          items.push({ id: r.id, title: r.title, meta: 'monthly' });
        }
      }
    });

    return items;
  })();

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>calendar</Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20, paddingTop: 5 }}>
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
        {(!selectedEvents || selectedEvents.length === 0) && notes.length === 0 && (
          <View style={styles.calEmptyWrap}>
            <Text style={styles.calEmpty}>nothing this day</Text>
          </View>
        )}

        {/* All notes — collapsible */}
        {notes.length > 0 && (
          <View style={[styles.section, { paddingHorizontal: 22 }]}>
            <Pressable
              onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setCalNotesOpen(!calNotesOpen); }}
              style={styles.dropdownToggle}
            >
              <Text style={styles.sectionLabel}>notes · {notes.length}</Text>
              <Ionicons
                name={calNotesOpen ? 'chevron-up' : 'chevron-down'}
                size={14}
                color={DIM}
              />
            </Pressable>
            {calNotesOpen && (
              <View>
                {notes.map((n) => (
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
        </Animated.View>
      </ScrollView>
    </View>
  );
}

// ─── App ────────────────────────────────────────────────────────

export default function App() {
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
    (async () => {
      const { status } = await Notifications.getPermissionsAsync();
      if (status !== 'granted') {
        await Notifications.requestPermissionsAsync();
      }
    })();
  }, []);

  // Listen for notification taps — switch to reminders tab.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(
      (_response) => {
        setTab('reminders');
        loadReminders();
      },
    );
    return () => sub.remove();
  }, [loadReminders]);

  const deleteReminder = useCallback(
    async (id: string) => {
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
  container: { flex: 1, backgroundColor: BLACK },

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
    minHeight: 140,
    textAlignVertical: 'top',
    padding: 0,
  },
  micArea: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 20,
    height: 80,
  },
  waveRow: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 50,
  },
  waveBar: {
    width: 6,
    height: 28,
    borderRadius: 3,
    backgroundColor: WHITE,
  },
  micBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
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
    flex: 1,
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
  calDay: {
    width: '14.28%',
    aspectRatio: 1,
    padding: 2,
  },
  calDayEmpty: {
    flex: 1,
  },
  calDayBtn: {
    flex: 1,
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
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: WHITE,
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
