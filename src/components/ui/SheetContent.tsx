// Centered content container for the form sheets. Sheets render full-width
// glass; on iPad (or any wide window) the inner content is capped at a
// readable column width and centered — pure flexbox, no Platform checks.
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

/** Max readable width for sheet content on wide screens (iPad). */
export const SHEET_CONTENT_MAX_WIDTH = 640;

export interface SheetContentProps {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function SheetContent({ children, style }: SheetContentProps) {
  return <View style={[styles.content, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  content: {
    alignSelf: 'center',
    maxWidth: SHEET_CONTENT_MAX_WIDTH,
    width: '100%',
  },
});
