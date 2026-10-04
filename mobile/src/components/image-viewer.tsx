import { UiText } from "@/components/ui-text";
import { useI18n } from "@/lib/i18n";
/**
 * An image from a conversation, full screen, to pinch and pan. Tapping a
 * picture in Reader did nothing (device audit of build 28, October 2026): the
 * thumbnail was the only size it came in, and a contact sheet of video frames
 * was unreadable at the width of a message.
 *
 * Zoom is the scroll view's own (`maximumZoomScale`), which iOS implements
 * natively: no gesture library, and it pans the zoomed image for free.
 */
import { useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { initialWindowMetrics, SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { shareFile } from "@/components/pdf-view";
import { Text } from "@/components/text";
import { theme } from "@/lib/theme";

export type ImageSource = { uri: string; headers?: Record<string, string> };

/** The image's bytes as base64, for the share sheet: data URLs carry them, others are fetched with their headers. */
async function imageBase64(source: ImageSource): Promise<{ base64: string; type: string }> {
  const data = source.uri.match(/^data:([^;,]+);base64,(.*)$/s);
  if (data) return { type: data[1]!, base64: data[2]! };
  const res = await fetch(source.uri, { headers: source.headers });
  if (!res.ok) throw new Error("The image could not be saved.");
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { type: (res.headers.get("content-type") ?? "image/png").split(";")[0]!.trim(), base64: btoa(binary) };
}

const NO_INSETS = { frame: { x: 0, y: 0, width: 0, height: 0 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic" };

/** Pinch to zoom and pan, filling the space it is given. */
export function ZoomableImage({ source, label }: { source: ImageSource; label: string }) {
  useI18n();
  const { width, height } = useWindowDimensions();
  return (
    <ScrollView
      style={styles.zoom}
      contentContainerStyle={styles.zoomBody}
      maximumZoomScale={5}
      minimumZoomScale={1}
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
    >
      <Image testID="zoomable-image" accessibilityLabel={label} source={source} style={{ width, height: height * 0.8 }} resizeMode="contain" />
    </ScrollView>
  );
}

export function ImageViewer({ source, onClose }: { source: ImageSource; onClose: () => void }) {
  const { t: ui } = useI18n();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose}>
      {/* A modal is a native root of its own, and the app's provider does not
          reach it: without one here the insets were zero, and Done and
          Save / Share sat under the status bar, where a tap went to its
          "◀ TestFlight" link instead (build 29 on a phone, October 2026). */}
      {/* Seeded with the window's insets as the app started, so the viewer
          draws at once rather than after its first native measurement. */}
      <SafeAreaProvider initialMetrics={initialWindowMetrics ?? NO_INSETS}>
      <SafeAreaView style={styles.viewer}>
        <View style={styles.bar}>
          <Pressable accessibilityRole="button" accessibilityLabel={ui("Close image")} hitSlop={12} style={styles.barButton} onPress={onClose}>
            <UiText style={styles.barText}>Done</UiText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ui("Save or share image")}
            hitSlop={12}
            style={styles.barButton}
            disabled={saving}
            onPress={async () => {
              setSaving(true);
              setError(null);
              try {
                const { base64, type } = await imageBase64(source);
                await shareFile(base64, `image.${EXTENSIONS[type] ?? "png"}`);
              } catch (e) {
                setError(e instanceof Error ? e.message : "The image could not be saved.");
              } finally {
                setSaving(false);
              }
            }}
          >
            <UiText style={styles.barText}>{saving ? "Saving…" : "Save / Share"}</UiText>
          </Pressable>
        </View>
        {error && <UiText accessibilityRole="alert" style={styles.error}>{error}</UiText>}
        <ZoomableImage source={source} label={ui("Image from the conversation. Pinch to zoom.")} />
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  viewer: { flex: 1, backgroundColor: "#000" },
  bar: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16 },
  barButton: { minHeight: 44, justifyContent: "center" },
  barText: { color: theme.peach, fontSize: 16 },
  error: { color: theme.rose, fontSize: 13, paddingHorizontal: 16 },
  zoom: { flex: 1 },
  zoomBody: { flexGrow: 1, alignItems: "center", justifyContent: "center" },
});
