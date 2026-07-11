// From/To stop pickers in one Liquid Glass card: two text fields, a swap
// button, and inline stop-name suggestions (with the lines serving each stop).
import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { LineBadge } from '@/components/ui/LineBadge';
import { Colors, Spacing, Tram } from '@/constants/theme';

type Field = 'from' | 'to';

const MAX_BADGES = 6;

export interface StopSearchCardProps {
  from: string;
  to: string;
  onChangeFrom: (text: string) => void;
  onChangeTo: (text: string) => void;
  onSwap: () => void;
  /** Synchronous suggestion lookup (top N, diacritics-insensitive). */
  search: (query: string) => string[];
  /** Lines serving a stop name, for the suggestion badges. */
  linesFor: (name: string) => string[];
  /** Called when the user submits the To field from the keyboard. */
  onSubmit: () => void;
}

export function StopSearchCard({
  from,
  to,
  onChangeFrom,
  onChangeTo,
  onSwap,
  search,
  linesFor,
  onSubmit,
}: StopSearchCardProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  const separatorColor = scheme === 'dark' ? 'rgba(84,84,88,0.5)' : 'rgba(60,60,67,0.24)';

  const fromRef = useRef<TextInput>(null);
  const toRef = useRef<TextInput>(null);
  const [activeField, setActiveField] = useState<Field | null>(null);

  const query = activeField === 'from' ? from : activeField === 'to' ? to : '';
  const suggestions = useMemo(
    () => (activeField && query.trim().length > 0 ? search(query) : []),
    [activeField, query, search],
  );

  const pickSuggestion = (name: string) => {
    Haptics.selectionAsync();
    if (activeField === 'from') {
      onChangeFrom(name);
      if (to.trim().length === 0) {
        toRef.current?.focus(); // onFocus flips activeField to 'to'
      } else {
        setActiveField(null);
        Keyboard.dismiss();
      }
    } else if (activeField === 'to') {
      onChangeTo(name);
      setActiveField(null);
      Keyboard.dismiss();
    }
  };

  const handleSwap = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSwap();
  };

  const renderField = (field: Field) => {
    const isFrom = field === 'from';
    return (
      <View style={styles.fieldRow}>
        <SymbolView
          name={isFrom ? 'smallcircle.filled.circle' : 'mappin.circle.fill'}
          size={18}
          tintColor={isFrom ? Tram.pidRed : Tram.gold}
          style={styles.fieldIcon}
        />
        <TextInput
          ref={isFrom ? fromRef : toRef}
          value={isFrom ? from : to}
          onChangeText={isFrom ? onChangeFrom : onChangeTo}
          onFocus={() => setActiveField(field)}
          placeholder={isFrom ? 'From stop' : 'To stop'}
          placeholderTextColor={palette.textSecondary}
          style={[styles.input, { color: palette.text }]}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          returnKeyType={isFrom ? 'next' : 'search'}
          submitBehavior="submit"
          onSubmitEditing={() => {
            if (isFrom) {
              toRef.current?.focus();
            } else {
              setActiveField(null);
              onSubmit();
            }
          }}
          accessibilityLabel={isFrom ? 'From stop' : 'To stop'}
        />
      </View>
    );
  };

  return (
    <GlassPanel style={styles.card}>
      <View style={styles.fieldsBlock}>
        <View style={styles.fieldsCol}>
          {renderField('from')}
          <View style={[styles.fieldSeparator, { backgroundColor: separatorColor }]} />
          {renderField('to')}
        </View>
        <Pressable
          onPress={handleSwap}
          hitSlop={8}
          accessibilityLabel="Swap stops"
          style={({ pressed }) => [
            styles.swapButton,
            { backgroundColor: palette.backgroundElement, opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <SymbolView name="arrow.up.arrow.down" size={15} weight="semibold" tintColor={Tram.pidRed} />
        </Pressable>
      </View>

      {suggestions.length > 0 && (
        <View style={[styles.suggestions, { borderTopColor: separatorColor }]}>
          {suggestions.map((name, i) => {
            const lines = linesFor(name);
            return (
              <Pressable
                key={name}
                onPress={() => pickSuggestion(name)}
                style={({ pressed }) => [
                  styles.suggestionRow,
                  i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: separatorColor },
                  pressed && { backgroundColor: palette.backgroundSelected },
                ]}
              >
                <Text numberOfLines={1} style={[styles.suggestionName, { color: palette.text }]}>
                  {name}
                </Text>
                {lines.length > 0 && (
                  <View style={styles.suggestionBadges}>
                    {lines.slice(0, MAX_BADGES).map((line) => (
                      <LineBadge key={line} line={line} size="sm" />
                    ))}
                    {lines.length > MAX_BADGES && (
                      <Text style={[styles.moreLines, { color: palette.textSecondary }]}>
                        +{lines.length - MAX_BADGES}
                      </Text>
                    )}
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      )}
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    borderCurve: 'continuous',
  },
  fieldsBlock: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
  fieldsCol: {
    flex: 1,
  },
  fieldRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two + 2,
    minHeight: 46,
  },
  fieldIcon: {
    width: 18,
    height: 18,
  },
  fieldSeparator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 28,
  },
  input: {
    flex: 1,
    fontSize: 17,
    paddingVertical: 10,
  },
  swapButton: {
    alignItems: 'center',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    marginLeft: Spacing.two,
    width: 34,
  },
  suggestions: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  suggestionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 44,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  suggestionName: {
    flexShrink: 1,
    fontSize: 16,
  },
  suggestionBadges: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.one,
    marginLeft: 'auto',
  },
  moreLines: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
});
