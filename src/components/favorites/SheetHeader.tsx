// Re-export shim: the canonical Apple-Maps sheet header now lives in
// src/components/ui/SheetHeader.tsx. Kept so favorites/settings/rides/
// icon-preview keep compiling against the old import path until they migrate.
export { SheetHeader, type SheetHeaderProps } from '@/components/ui/SheetHeader';
