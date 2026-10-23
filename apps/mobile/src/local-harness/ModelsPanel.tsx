import { useTranslation } from "react-i18next";
import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { refreshCindyAI } from './cindyAI';
import { evictDeviceProviders } from '@/device-link/deviceProvidersCache';
import { LOCAL_DEVICE_ID } from './destination';
import { useState } from "react";
import { Keyboard, Pressable, ScrollView, View } from "react-native";
import { Check } from "lucide-react-native";
import { Text, TextInput } from "@/components/AppText";
import { useTheme, useThemedStyles, spacing } from "@/theme";
import { useLocale } from "@/i18n/useLocale";
import { harnessMessages } from "./messages";
import { harnessStyles } from "./styles";
import {
  connectChatGPT,
  providers,
  saveProvider,
  removeProvider,
  type Provider,
} from "./providers";
import type { Protocol } from "./kernel";

type Props = {
  allProviders: Provider[];
  selected: string;
  availability: string;
  onSelect: (id: string) => void;
  onProvidersChange: (providers: Provider[]) => void;
  onDone: () => void;
  report: (error: unknown) => void;
};
export function ModelsPanel({
  allProviders,
  selected,
  availability,
  onSelect,
  onProvidersChange,
  onDone,
  report,
}: Props) {
  const { t } = useTranslation();
  const auth = useAuth();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useThemedStyles(harnessStyles);
  const { effectiveLocale } = useLocale();
  const m = harnessMessages(effectiveLocale);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [protocol, setProtocol] = useState<Protocol>("openai");
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };
  const action = (
    label: string,
    onPress: () => void,
    _icon?: undefined,
    testID?: string,
    disabled = false,
  ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      disabled={disabled || busy}
      onPress={onPress}
      style={[styles.button, { opacity: disabled || busy ? 0.4 : 1 }]}
    >
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
  return (
    <ScrollView
      contentContainerStyle={styles.body}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      <Text style={styles.small}>{t('session.local.modelHint')}</Text>
      {action(t(auth.isAuthenticated ? 'session.local.refreshCindyAI' : 'session.local.loginCindyAI'), () => {
        if (!auth.isAuthenticated) { router.push('/(auth)/login'); return; }
        void perform(async () => { await refreshCindyAI(); evictDeviceProviders(LOCAL_DEVICE_ID); onProvidersChange(await providers()); });
      }, undefined, 'local.cindy.connect')}
      {action(t('session.local.chatgpt'), () => void perform(async () => {
        await connectChatGPT();
        onProvidersChange(await providers());
      }), undefined, 'local.chatgpt.connect')}

      {allProviders.map((p) => (
        <View key={p.id} style={styles.card}>
          <Pressable
            testID={`local.model.${p.id}`}
            onPress={() => {
              onSelect(p.id);
              onDone();
            }}
            style={styles.row}
          >
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.text}>{p.name}</Text>
              <Text style={styles.small}>
                {p.protocol === "apple"
                  ? availability === "available"
                    ? m.localReady
                    : m.localUnavailable
                  : `${p.model} · ${new URL(p.endpoint).hostname}`}
              </Text>
            </View>
            {selected === p.id ? (
              <Check size={20} color={colors.textPrimary} />
            ) : null}
          </Pressable>
          {p.id !== "apple" && p.auth !== 'cindy'
            ? action(
                m.remove,
                () =>
                  void perform(async () => {
                    await removeProvider(p.id);
                    onProvidersChange(await providers());
                    if (selected === p.id) onSelect("apple");
                  }),
              )
            : null}
        </View>
      ))}
      {!adding ? (
        action(m.addModel, () => setAdding(true), undefined, "local.addModel")
      ) : (
        <View style={{ gap: spacing.md }}>
          <View style={styles.row}>
            {(["openai", "anthropic", "google"] as const).map((p) => (
              <Pressable
                key={p}
                onPress={() => setProtocol(p)}
                style={[
                  styles.button,
                  {
                    backgroundColor:
                      p === protocol ? colors.surfaceChip : "transparent",
                  },
                ]}
              >
                <Text style={styles.small}>
                  {p === "openai"
                    ? "OpenAI"
                    : p === "anthropic"
                      ? "Anthropic"
                      : "Google"}
                </Text>
              </Pressable>
            ))}
          </View>
          {(
            [
              { label: m.name, value: name, change: setName, id: "name" },
              {
                label: m.endpoint,
                value: endpoint,
                change: setEndpoint,
                id: "endpoint",
              },
              {
                label: m.model,
                value: model,
                change: setModel,
                id: "model",
              },
              { label: m.key, value: key, change: setKey, id: "key" },
            ] as const
          ).map((field) => (
            <View key={field.id} style={{ gap: spacing.xs }}>
              <Text style={styles.small}>{field.label}</Text>
              <TextInput
                accessibilityLabel={field.label}
                testID={`local.provider.${field.id}`}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                textContentType="none"
                returnKeyType="done"
                onSubmitEditing={Keyboard.dismiss}
                secureTextEntry={field.id === "key"}
                value={field.value}
                onChangeText={field.change}
                style={styles.field}
              />
            </View>
          ))}
          <Text style={styles.small}>
            {m.endpointHint} {m.credentials}
          </Text>
          {action(
            m.save,
            () =>
              void perform(async () => {
                const p = await saveProvider(
                  {
                    name,
                    endpoint: endpoint.trim(),
                    model: model.trim(),
                    protocol,
                    contextBytes: 48_000,
                  },
                  key,
                );
                setKey("");
                onProvidersChange(await providers());
                onSelect(p.id);
                setAdding(false);
                onDone();
              }),
            undefined,
            "local.provider.save",
            busy,
          )}
        </View>
      )}
    </ScrollView>
  );
}
