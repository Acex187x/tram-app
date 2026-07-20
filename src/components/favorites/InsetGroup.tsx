// Re-export shim: the canonical iOS grouped-inset kit now lives in
// src/components/ui/Inset.tsx. Kept so settings/favorites/rides/model-info keep
// compiling against the old import path until they migrate.
export {
  InsetGroup,
  InsetRow,
  SectionLabel,
  RowSeparator,
  InlineHint,
  type InsetRowProps,
} from '@/components/ui/Inset';
