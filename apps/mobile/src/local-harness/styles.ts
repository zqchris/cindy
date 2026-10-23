import { StyleSheet } from "react-native";
import {
  type ThemeColors,
  textStyles,
  fontWeight,
  spacing,
  radius,
} from "@/theme";

export const harnessStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.surface },
    bar: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: spacing.lg,
      minHeight: 52,
      gap: spacing.sm,
    },
    body: {
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.lg,
      gap: spacing.lg,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      minHeight: 52,
    },
    title: {
      ...textStyles.title,
      fontWeight: fontWeight.semibold,
      color: colors.textPrimary,
    },
    text: { ...textStyles.body, color: colors.textPrimary },
    small: { ...textStyles.footnote, color: colors.textTertiary },
    button: {
      minHeight: 44,
      minWidth: 44,
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: spacing.md,
      borderRadius: radius.control,
    },
    field: {
      ...textStyles.body,
      color: colors.textPrimary,
      backgroundColor: colors.surfaceElevated,
      minHeight: 48,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.control,
    },
    bubble: {
      padding: spacing.md,
      backgroundColor: colors.surfaceElevated,
      borderRadius: radius.container,
      alignSelf: "flex-end",
      maxWidth: "92%",
    },
    card: {
      padding: spacing.lg,
      backgroundColor: colors.surfaceElevated,
      borderRadius: radius.container,
      gap: spacing.md,
    },
    tabs: {
      flexDirection: "row",
      justifyContent: "space-around",
      paddingVertical: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
  });
