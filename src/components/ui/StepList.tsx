// The itinerary "Details" step list from IMG_0081: SF-symbol / line-badge step
// icons, a title + subtitle(s), an optional note row with a blue "More" link,
// hairline separators, and the inline dotted stop-timeline segment (a tinted
// dotted line joining fromStop → toStop with a "Ride k stops, m min" middle).
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Fragment } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { LineBadge } from '@/components/ui/LineBadge';
import { RowSeparator } from '@/components/ui/Inset';
import { Apple, appleScheme, Tram } from '@/constants/theme';

export type StepIcon =
  | { symbol: SFSymbol; /** Draw the symbol on a colored circle (Start/Arrive). */ circleTint?: string }
  | { lineBadge: string };

export interface StepTimeline {
  fromStop: string;
  toStop: string;
  /** Middle label, e.g. 'Ride 2 stops, 3 min'. */
  detail: string;
  /** Line color for the dotted timeline — defaults to PID red. */
  tint?: string;
  onPress?: () => void;
}

export interface Step {
  key: string;
  icon: StepIcon;
  title: string;
  subtitle?: string;
  /** e.g. 'Scheduled in 7, 19 min'. */
  note?: string;
  onMore?: () => void;
  timeline?: StepTimeline;
}

export function StepList({ steps }: { steps: Step[] }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);

  return (
    <View>
      {steps.map((step, i) => (
        <Fragment key={step.key}>
          {i > 0 && <RowSeparator inset={56} />}
          <View style={styles.step}>
            <View style={styles.gutter}>
              <StepIconView icon={step.icon} scheme={scheme} textColor={c.text} />
            </View>
            <View style={styles.content}>
              <Text style={[styles.title, { color: c.text }]}>{step.title}</Text>
              {step.subtitle != null && (
                <Text style={[styles.subtitle, { color: c.secondary }]}>{step.subtitle}</Text>
              )}
              {step.note != null && (
                <View style={styles.noteRow}>
                  <Text style={[styles.note, { color: c.text }]}>{step.note}</Text>
                  {step.onMore != null && (
                    <Pressable accessibilityRole="button" hitSlop={8} onPress={step.onMore}>
                      <Text style={[styles.more, { color: Apple.blue }]}>More</Text>
                    </Pressable>
                  )}
                </View>
              )}
              {step.timeline != null && (
                <TimelineBlock timeline={step.timeline} textColor={c.text} />
              )}
            </View>
          </View>
        </Fragment>
      ))}
    </View>
  );
}

function StepIconView({
  icon,
  scheme,
  textColor,
}: {
  icon: StepIcon;
  scheme: 'light' | 'dark';
  textColor: string;
}) {
  if ('lineBadge' in icon) {
    return <LineBadge line={icon.lineBadge} size="md" />;
  }
  if (icon.circleTint != null) {
    return (
      <View style={[styles.iconCircle, { backgroundColor: icon.circleTint }]}>
        <SymbolView name={icon.symbol} size={17} weight="semibold" tintColor="#FFFFFF" />
      </View>
    );
  }
  return <SymbolView name={icon.symbol} size={26} weight="regular" tintColor={textColor} />;
}

function TimelineBlock({ timeline, textColor }: { timeline: StepTimeline; textColor: string }) {
  const tint = timeline.tint ?? Tram.pidRed;
  const inner = (
    <View style={styles.timeline}>
      <View style={styles.timelineRail}>
        <View style={[styles.railDot, { backgroundColor: tint }]} />
        <View style={styles.railDots}>
          <View style={[styles.railTinyDot, { backgroundColor: tint }]} />
          <View style={[styles.railTinyDot, { backgroundColor: tint }]} />
          <View style={[styles.railTinyDot, { backgroundColor: tint }]} />
        </View>
        <View style={[styles.railDot, { backgroundColor: tint }]} />
      </View>
      <View style={styles.timelineText}>
        <Text style={[styles.stopName, { color: textColor }]}>{timeline.fromStop}</Text>
        <Text style={[styles.rideDetail, { color: tint }]}>{timeline.detail}</Text>
        <Text style={[styles.stopName, { color: textColor }]}>{timeline.toStop}</Text>
      </View>
    </View>
  );
  if (timeline.onPress == null) return inner;
  return (
    <Pressable accessibilityRole="button" onPress={timeline.onPress}>
      {inner}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  step: { flexDirection: 'row', gap: 14, paddingVertical: 14, paddingHorizontal: 4 },
  gutter: { width: 34, alignItems: 'center', paddingTop: 1 },
  iconCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: { flex: 1, gap: 3 },
  title: { fontSize: 19, fontWeight: '600' },
  subtitle: { fontSize: 15, fontWeight: '400', lineHeight: 20 },
  noteRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  note: { fontSize: 17, fontWeight: '400' },
  more: { fontSize: 17, fontWeight: '400' },

  timeline: { flexDirection: 'row', gap: 12, marginTop: 8 },
  timelineRail: { alignItems: 'center', width: 14 },
  railDot: { width: 12, height: 12, borderRadius: 6 },
  railDots: { flex: 1, justifyContent: 'space-evenly', alignItems: 'center', paddingVertical: 4 },
  railTinyDot: { width: 4, height: 4, borderRadius: 2 },
  timelineText: { flex: 1, justifyContent: 'space-between', gap: 10 },
  stopName: { fontSize: 19, fontWeight: '600' },
  rideDetail: { fontSize: 17, fontWeight: '400' },
});
