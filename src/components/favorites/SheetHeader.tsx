// Shared sheet header for the favorites + settings form sheets: large title on
// the left, iOS-style circular dismiss button on the right. Sits directly on
// the sheet's GlassPanel (no background of its own).
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { Colors } from '@/constants/theme';

export function SheetHeader({ title }: { title: string }) {
  const router = useRouter();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  return (
    <View style={styles.row}>
      <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>
        {title}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        hitSlop={8}
        onPress={() => router.back()}
        style={({ pressed }) => [
          styles.close,
          {
            backgroundColor:
              scheme === 'dark' ? 'rgba(118,118,128,0.24)' : 'rgba(118,118,128,0.16)',
            opacity: pressed ? 0.55 : 1,
          },
        ]}
      >
        <SymbolView name="xmark" size={12} weight="bold" tintColor={palette.textSecondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 6,
    paddingHorizontal: 20,
    paddingTop: 22,
  },
  title: {
    flexShrink: 1,
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  close: {
    alignItems: 'center',
    borderRadius: 15,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
});
