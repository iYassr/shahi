import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ViewStyle, StyleProp } from "react-native";
import { Text } from "./text";
const documents = requireOptionalNativeModule<{ share(base64: string, name: string): Promise<void> }>("ShahiDocuments");
const NativePDF = documents ? requireNativeView<{ base64: string; style?: StyleProp<ViewStyle>; onLoadError?: () => void }>("ShahiDocuments") : null;
export function PDFView({ base64, onError }: { base64: string; onError: () => void }) {
  return NativePDF ? <NativePDF base64={base64} style={{ flex: 1 }} onLoadError={onError} /> : <Text>Update Shahi to preview PDFs and save files.</Text>;
}
export async function shareFile(base64: string, name: string) {
  if (!documents) throw new Error("Update Shahi to save files.");
  await documents.share(base64, name);
}
