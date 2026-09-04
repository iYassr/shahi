/**
 * The camera, pointed at a pairing code.
 *
 * `expo-camera`'s own barcode scanning (SDK 57 — the separate scanner package
 * is gone), asked for QR codes only so a barcode on a cereal box is never
 * offered to Connect. The camera fires the callback on every frame the code is
 * in, so a scan is handled once; a code that is not ours re-arms after saying
 * so, because the likeliest thing in front of the lens after a wrong QR is the
 * right one.
 *
 * Nothing here can be seen on a simulator: it has no camera, and Expo's docs
 * say barcode scanning needs a device. Verify on the phone.
 */
import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { theme } from "@/lib/theme";

export function Scanner({
  onScanned,
  onCancel,
}: {
  /** True if the code was ours and is being acted on; false to keep looking. */
  onScanned: (data: string) => boolean;
  onCancel: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [rejected, setRejected] = useState(false);
  const armed = useRef(true);
  const rearm = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  useEffect(
    () => () => {
      if (rearm.current) clearTimeout(rearm.current);
    },
    [],
  );

  const onBarcode = (result: BarcodeScanningResult) => {
    if (!armed.current) return;
    armed.current = false;
    if (onScanned(result.data)) return;
    setRejected(true);
    rearm.current = setTimeout(() => {
      setRejected(false);
      armed.current = true;
    }, 1_500);
  };

  // Still asking: draw nothing rather than flash the denied state.
  if (!permission) return <View style={styles.screen} />;

  if (!permission.granted) {
    return (
      <View style={[styles.screen, styles.centred]}>
        <Text style={styles.deniedTitle}>Shahi needs the camera to scan the code.</Text>
        <Text style={styles.deniedText}>
          {permission.canAskAgain
            ? "Allow camera access when asked."
            : "Camera access is off for Shahi. Turn it on in Settings, then come back."}
        </Text>
        {!permission.canAskAgain && (
          <Pressable accessibilityRole="button" style={styles.button} onPress={() => void Linking.openSettings()} testID="open-settings">
            <Text style={styles.buttonText}>Open Settings</Text>
          </Pressable>
        )}
        <Pressable accessibilityRole="button" onPress={onCancel} hitSlop={12} testID="scanner-cancel">
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={onBarcode}
      />
      <View style={styles.overlay} pointerEvents="box-none">
        <Text style={styles.hint}>
          {rejected ? "That isn't a Shahi pairing code." : "Point at the code your server printed."}
        </Text>
        <View style={styles.frame} />
        <Pressable accessibilityRole="button" style={styles.cancelButton} onPress={onCancel} hitSlop={12} testID="scanner-cancel">
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void },
  centred: { alignItems: "center", justifyContent: "center", padding: 28, gap: 14 },
  overlay: { flex: 1, alignItems: "center", justifyContent: "space-between", paddingVertical: 48 },
  hint: {
    color: theme.fg,
    fontSize: 15,
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    overflow: "hidden",
  },
  frame: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: theme.peach,
    borderRadius: 18,
    borderCurve: "continuous",
  },
  cancelButton: { minHeight: 44, justifyContent: "center" },
  cancel: { color: theme.fg, fontSize: 16, textDecorationLine: "underline" },
  deniedTitle: { color: theme.fg, fontSize: 18, fontWeight: "600", textAlign: "center" },
  deniedText: { color: theme.dim, fontSize: 15, lineHeight: 22, textAlign: "center" },
  button: {
    backgroundColor: theme.peach,
    borderRadius: 8,
    borderCurve: "continuous",
    minHeight: 48,
    paddingHorizontal: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { color: theme.void, fontWeight: "600", fontSize: 16 },
});
