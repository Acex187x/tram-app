// From/To stop pickers as Apple Maps' Directions endpoint card (IMG_0080): a
// grouped card with two rows — a blue origin dot and a blue destination pin
// joined by a connecting line — and a circular swap button. Inline stop-name
// suggestions (with the serving lines) drop below. A content-layer card on a
// glass sheet, so it takes the standard grouped fill, not Liquid Glass.
import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';

import { InsetGroup } from '@/components/ui/Inset';
import { LineBadge } from '@/components/ui/LineBadge';
import { appleScheme, Radii } from '@/constants/theme';

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
  /** Fill the From field from the user's location (nearest stop). */
  onLocate?: () => void;
  /** Whether a location lookup is in flight (shows a spinner in the From field). */
  locating?: boolean;
  /** Focus the To field (keyboard up) as soon as the card mounts. */
  autoFocusTo?: boolean;
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
  onLocate,
  locating = false,
  autoFocusTo = false,
}: StopSearchCardProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);

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
        <View style={styles.dotCol}>
          {isFrom ? (
            <SymbolView name="location.fill" size={13} tintColor="#FFFFFF" style={styles.dotGlyph} />
          ) : (
            <SymbolView name="mappin" size={13} tintColor="#FFFFFF" style={styles.dotGlyph} />
          )}
          <View style={[styles.dot, { backgroundColor: c.blue }]} />
        </View>
        <TextInput
          ref={isFrom ? fromRef : toRef}
          value={isFrom ? from : to}
          onChangeText={isFrom ? onChangeFrom : onChangeTo}
          onFocus={() => setActiveField(field)}
          // Without this the suggestion list stays wedged open after any
          // dismissal that doesn't run through pickSuggestion/onSubmitEditing
          // (Find Routes, keyboardDismissMode, locate, swap). The functional
          // update keeps the From→To handoff safe when the new field's onFocus
          // lands before the old field's onBlur.
          onBlur={() => setActiveField((f) => (f === field ? null : f))}
          placeholder={isFrom ? 'My Location' : 'Choose destination'}
          placeholderTextColor={c.secondary}
          style={[styles.input, { color: c.text }]}
          autoFocus={!isFrom && autoFocusTo}
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
        {isFrom && onLocate && (
          <Pressable
            onPress={() => {
              Haptics.selectionAsync();
              onLocate();
            }}
            disabled={locating}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Use nearest stop to my location"
            style={({ pressed }) => [styles.locateButton, { opacity: pressed || locating ? 0.6 : 1 }]}
          >
            {locating ? (
              <ActivityIndicator size="small" color={c.blue} />
            ) : (
              <SymbolView name="location" size={17} weight="semibold" tintColor={c.blue} />
            )}
          </Pressable>
        )}
      </View>
    );
  };

  return (
    <InsetGroup style={styles.card}>
      <View style={styles.fieldsBlock}>
        <View style={styles.fieldsCol}>
          {renderField('from')}
          {/* Connecting line between the two endpoint dots. */}
          <View style={styles.connectorWrap} pointerEvents="none">
            <View style={[styles.connector, { backgroundColor: c.separator }]} />
          </View>
          <View style={[styles.fieldSeparator, { backgroundColor: c.separator }]} />
          {renderField('to')}
        </View>
        <Pressable
          onPress={handleSwap}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Swap stops"
          style={({ pressed }) => [
            styles.swapButton,
            { backgroundColor: c.fillTertiary, opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <SymbolView name="arrow.up.arrow.down" size={15} weight="semibold" tintColor={c.blue} />
        </Pressable>
      </View>

      {suggestions.length > 0 && (
        <View style={[styles.suggestions, { borderTopColor: c.separator }]}>
          {suggestions.map((name, i) => {
            const lines = linesFor(name);
            return (
              <Pressable
                key={name}
                onPress={() => pickSuggestion(name)}
                style={({ pressed }) => [
                  styles.suggestionRow,
                  i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.separator },
                  pressed && { backgroundColor: c.fillTertiary },
                ]}
              >
                <SymbolView name="mappin.circle.fill" size={22} tintColor={c.secondary} />
                <Text numberOfLines={1} style={[styles.suggestionName, { color: c.text }]}>
                  {name}
                </Text>
                {lines.length > 0 && (
                  <View style={styles.suggestionBadges}>
                    {lines.slice(0, MAX_BADGES).map((line) => (
                      <LineBadge key={line} line={line} size="sm" />
                    ))}
                    {lines.length > MAX_BADGES && (
                      <Text style={[styles.moreLines, { color: c.secondary }]}>
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
    </InsetGroup>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radii.group,
    borderCurve: 'continuous',
  },
  fieldsBlock: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  fieldsCol: {
    flex: 1,
  },
  fieldRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 48,
  },
  dotCol: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 22,
    width: 22,
  },
  dot: {
    borderRadius: 11,
    height: 22,
    width: 22,
  },
  dotGlyph: {
    position: 'absolute',
    zIndex: 1,
  },
  connectorWrap: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 10,
  },
  connector: {
    position: 'absolute',
    bottom: -13,
    top: -13,
    width: 2,
    borderRadius: 1,
  },
  fieldSeparator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 34,
  },
  input: {
    flex: 1,
    fontSize: 17,
    paddingVertical: 10,
  },
  locateButton: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 30,
    width: 30,
  },
  swapButton: {
    alignItems: 'center',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    marginLeft: 10,
    width: 34,
  },
  suggestions: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  suggestionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  suggestionName: {
    flexShrink: 1,
    fontSize: 16,
  },
  suggestionBadges: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    marginLeft: 'auto',
  },
  moreLines: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
});
